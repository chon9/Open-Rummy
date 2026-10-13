/**
 * OPEN_RUMMY_STEAM=mock: Steam stand-in for testing lobbies + P2P with several Electron
 * instances on ONE machine, no Steam client needed.
 *
 * Loopback relay: the first instance to start binds a TCP server on 127.0.0.1:<port>
 * (env OPEN_RUMMY_MOCK_PORT, default 37651) holding one MockSteamWorld (mockWorld.ts);
 * every instance, the first included, connects to it as a client. Wire format is
 * newline-delimited JSON:
 *   client -> relay  {k:'hello', user:{steamId,name}} | {k:'req', id, op, args}
 *   relay  -> client {k:'welcome'} | {k:'res', id, result} | {k:'evt', evt} | {k:'msg', from, data}
 * If the relay-owning instance quits, the others see 'lobby-left' (reason 'disconnected')
 * and 'steam-connection' false, then one of them re-creates the relay (empty world) and
 * they reconnect.
 *
 * Identity: `--profile=N` -> steamId 76561198000000000+N, name "Mock Player N"
 * (main passes the profile; without one a pid-derived number is used).
 * `openInviteDialog()` sends 'join-requested' to every other connected instance (simulates
 * "invite accepted"), so the invite flow can be exercised too.
 */
import net from 'node:net';
import type {
  CreateLobbyOptions,
  LobbyEvent,
  LobbyMember,
  LobbyState,
  LobbySummary,
  SteamAvailability,
  SteamIdString,
  SteamResult,
  SteamSelf,
} from '../../../packages/client/src/net/desktopBridge';
import { isPayload, isSteamIdString } from '../channels';
import { BaseSteamBackend, errMessage, fail, type Logger, type SteamBackend } from './backend';
import { MockSteamWorld, type MockSink, type MockUser } from './mockWorld';

export const DEFAULT_MOCK_PORT = 37651;
const MOCK_APP_ID = 480;
const MAX_LINE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 3_000;
const RECONNECT_MS = 1_500;

const LOBBY_EVENT_TYPES = new Set<LobbyEvent['type']>([
  'lobby-entered',
  'lobby-left',
  'member-joined',
  'member-left',
  'owner-changed',
  'data-updated',
  'join-requested',
  'p2p-failed',
  'steam-connection',
]);

type Op =
  | 'createLobby'
  | 'joinLobby'
  | 'leaveLobby'
  | 'currentLobby'
  | 'lobbyMembers'
  | 'listLobbies'
  | 'setLobbyDataMany'
  | 'getLobbyData'
  | 'setLobbyJoinable'
  | 'openInviteDialog'
  | 'sendTo'
  | 'broadcast';
const OPS = new Set<Op>([
  'createLobby',
  'joinLobby',
  'leaveLobby',
  'currentLobby',
  'lobbyMembers',
  'listLobbies',
  'setLobbyDataMany',
  'getLobbyData',
  'setLobbyJoinable',
  'openInviteDialog',
  'sendTo',
  'broadcast',
]);

export function mockPort(): number {
  const raw = process.env.OPEN_RUMMY_MOCK_PORT?.trim();
  const n = raw && /^\d{2,5}$/.test(raw) ? Number(raw) : DEFAULT_MOCK_PORT;
  return n >= 1024 && n <= 65535 ? n : DEFAULT_MOCK_PORT;
}

export function mockIdentity(profile: number | null): MockUser {
  const n = profile ?? 1000 + (process.pid % 90000);
  return { steamId: (76561198000000000n + BigInt(n)).toString(), name: profile === null ? `Mock ${n}` : `Mock Player ${n}` };
}

/** newline-delimited JSON reader with a line size cap */
function lineReader(socket: net.Socket, onLine: (value: unknown) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES * 4) {
      socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      onLine(value);
    }
  });
}

function writeLine(socket: net.Socket, value: unknown): void {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(value) + '\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Relay server (lives in whichever instance bound the port first)
// ---------------------------------------------------------------------------

export class MockRelayServer {
  private readonly world = new MockSteamWorld({ autoInvite: true });
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly log: Logger) {}

  /** resolves true when this process now hosts the relay, false when the port is taken */
  listen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') this.log(`mock relay listen failed: ${err.message}`);
        resolve(false);
      });
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        this.server = server;
        server.on('error', (err) => this.log(`mock relay error: ${err.message}`));
        this.log(`mock relay listening on 127.0.0.1:${port}`);
        resolve(true);
      });
    });
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let user: MockUser | null = null;
    const sink: MockSink = {
      lobbyEvent: (evt) => writeLine(socket, { k: 'evt', evt }),
      message: (from, data) => writeLine(socket, { k: 'msg', from, data }),
    };
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (user) this.world.disconnect(user.steamId);
    });
    lineReader(socket, (msg) => {
      try {
        if (!isRecord(msg)) return;
        if (msg.k === 'hello' && !user) {
          const u = msg.user;
          if (!isRecord(u) || !isSteamIdString(u.steamId) || typeof u.name !== 'string' || u.name.length > 32) {
            socket.destroy();
            return;
          }
          user = { steamId: u.steamId, name: u.name };
          this.world.addUser(user, sink);
          writeLine(socket, { k: 'welcome' });
          return;
        }
        if (msg.k === 'req' && user && typeof msg.id === 'number' && typeof msg.op === 'string' && Array.isArray(msg.args)) {
          const result = OPS.has(msg.op as Op) ? this.dispatch(user.steamId, msg.op as Op, msg.args) : fail('invalid', 'unknown op');
          writeLine(socket, { k: 'res', id: msg.id, result: result === undefined ? null : result });
        }
      } catch (err) {
        this.log(`mock relay request failed: ${errMessage(err)}`);
      }
    });
  }

  private dispatch(me: SteamIdString, op: Op, args: unknown[]): unknown {
    const w = this.world;
    switch (op) {
      case 'createLobby':
        return w.createLobby(me, args[0]);
      case 'joinLobby':
        return w.joinLobby(me, args[0]);
      case 'leaveLobby':
        return w.leaveLobby(me);
      case 'currentLobby':
        return w.currentLobby(me);
      case 'lobbyMembers':
        return w.lobbyMembers(me);
      case 'listLobbies':
        return w.listLobbies(me);
      case 'setLobbyDataMany':
        return w.setLobbyDataMany(me, args[0]);
      case 'getLobbyData':
        return w.getLobbyData(me, args[0]);
      case 'setLobbyJoinable':
        return w.setLobbyJoinable(me, args[0]);
      case 'openInviteDialog':
        return w.openInviteDialog(me);
      case 'sendTo':
        return w.sendTo(me, args[0], args[1]);
      case 'broadcast':
        return w.broadcast(me, args[0]);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-instance backend (relay client)
// ---------------------------------------------------------------------------

export class MockSteamService extends BaseSteamBackend implements SteamBackend {
  readonly kind = 'mock' as const;
  private readonly user: MockUser;
  private readonly port = mockPort();
  private relay: MockRelayServer | null = null;
  private socket: net.Socket | null = null;
  private availability: SteamAvailability = { ok: false, reason: 'not initialised' };
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private lobbyId: SteamIdString | null = null;
  private ownerId: SteamIdString | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(profile: number | null, log: Logger) {
    super(log);
    this.user = mockIdentity(profile);
  }

  async init(): Promise<SteamAvailability> {
    try {
      await this.connect();
      this.availability = { ok: true, appId: MOCK_APP_ID };
      this.log(`mock steam connected as ${this.user.name} (id length ${this.user.steamId.length}) via 127.0.0.1:${this.port}${this.relay ? ' (relay host)' : ''}`);
    } catch (err) {
      this.availability = { ok: false, reason: `mock relay unavailable: ${errMessage(err)}` };
      this.scheduleReconnect();
    }
    return this.available();
  }

  available(): SteamAvailability {
    return { ...this.availability };
  }

  me(): SteamSelf | null {
    return this.availability.ok ? { ...this.user } : null;
  }

  createLobby(opts: CreateLobbyOptions): Promise<SteamResult<LobbyState>> {
    return this.serial(() => this.request<SteamResult<LobbyState>>('createLobby', [opts], fail('create-failed', 'mock relay')));
  }
  joinLobby(lobbyId: SteamIdString): Promise<SteamResult<LobbyState>> {
    return this.serial(() => this.request<SteamResult<LobbyState>>('joinLobby', [lobbyId], fail('join-failed', 'mock relay')));
  }
  async leaveLobby(): Promise<void> {
    await this.serial(() => this.request('leaveLobby', [], null));
  }
  currentLobby(): Promise<LobbyState | null> {
    return this.request<LobbyState | null>('currentLobby', [], null);
  }
  async lobbyMembers(): Promise<LobbyMember[]> {
    const r = await this.request<LobbyMember[] | null>('lobbyMembers', [], []);
    return Array.isArray(r) ? r : [];
  }
  listLobbies(): Promise<SteamResult<LobbySummary[]>> {
    return this.request<SteamResult<LobbySummary[]>>('listLobbies', [], fail('unknown', 'mock relay'));
  }
  setLobbyData(key: string, value: string): Promise<SteamResult> {
    return this.setLobbyDataMany({ [key]: value });
  }
  setLobbyDataMany(data: Record<string, string>): Promise<SteamResult> {
    return this.request<SteamResult>('setLobbyDataMany', [data], fail('unknown', 'mock relay'));
  }
  getLobbyData(key: string): Promise<string | null> {
    return this.request<string | null>('getLobbyData', [key], null);
  }
  setLobbyJoinable(joinable: boolean): Promise<SteamResult> {
    return this.request<SteamResult>('setLobbyJoinable', [joinable], fail('unknown', 'mock relay'));
  }
  openInviteDialog(): Promise<SteamResult> {
    return this.request<SteamResult>('openInviteDialog', [], fail('unknown', 'mock relay'));
  }
  async avatarDataUrl(): Promise<string | null> {
    return null;
  }
  sendTo(steamId: SteamIdString, data: string): Promise<SteamResult> {
    return this.request<SteamResult>('sendTo', [steamId, data], fail('send-failed', 'mock relay'));
  }
  broadcast(data: string): Promise<SteamResult> {
    return this.request<SteamResult>('broadcast', [data], fail('send-failed', 'mock relay'));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket && this.lobbyId) {
      // best effort: tell the relay before the socket goes (a close alone reads as 'disconnected')
      writeLine(this.socket, { k: 'req', id: this.nextId++, op: 'leaveLobby', args: [] });
    }
    this.socket?.end();
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(undefined);
    }
    this.pending.clear();
    // give the relay a moment to fan out 'member-left' before it closes with this process
    if (this.relay) await new Promise((r) => setTimeout(r, 50));
    this.relay?.close();
    this.relay = null;
    this.lobbyListeners.clear();
    this.messageListeners.clear();
  }

  // --- internals -------------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.relay) {
      const relay = new MockRelayServer(this.log);
      if (await relay.listen(this.port)) this.relay = relay;
    }
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ port: this.port, host: '127.0.0.1' });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('connect timeout'));
      }, CONNECT_TIMEOUT_MS);
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
    });
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('no welcome from relay'));
      }, CONNECT_TIMEOUT_MS);
      let welcomed = false;
      lineReader(socket, (msg) => {
        if (!welcomed) {
          if (isRecord(msg) && msg.k === 'welcome') {
            welcomed = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        this.onRelayMessage(msg);
      });
      socket.removeAllListeners('error');
      socket.on('error', (err) => this.log(`mock relay socket error: ${err.message}`));
      socket.on('close', () => {
        clearTimeout(timer);
        if (!welcomed) reject(new Error('relay closed'));
        if (this.socket === socket) this.onRelayLost();
      });
      writeLine(socket, { k: 'hello', user: this.user });
    });
    this.socket = socket;
  }

  private onRelayLost(): void {
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(undefined);
    }
    this.pending.clear();
    if (this.disposed) return;
    this.availability = { ok: false, reason: 'mock relay lost' };
    if (this.lobbyId) {
      const lobbyId = this.lobbyId;
      this.lobbyId = null;
      this.ownerId = null;
      this.emitLobby({ type: 'lobby-left', lobbyId, reason: 'disconnected' });
    }
    this.emitLobby({ type: 'steam-connection', connected: false });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    // jitter so two survivors do not race for the port in lockstep
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect().then(
          () => {
            this.availability = { ok: true, appId: MOCK_APP_ID };
            this.log(`mock steam reconnected${this.relay ? ' (relay host)' : ''}`);
            this.emitLobby({ type: 'steam-connection', connected: true });
          },
          () => this.scheduleReconnect(),
        );
      },
      RECONNECT_MS + Math.floor(Math.random() * 500),
    );
  }

  private onRelayMessage(msg: unknown): void {
    if (!isRecord(msg)) return;
    if (msg.k === 'res' && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.result);
      return;
    }
    if (msg.k === 'msg') {
      const { from, data } = msg;
      if (!isSteamIdString(from) || !isPayload(data) || !this.lobbyId) return;
      this.deliverMessage(from, data, from === this.ownerId);
      return;
    }
    if (msg.k === 'evt' && isRecord(msg.evt) && LOBBY_EVENT_TYPES.has(msg.evt.type as LobbyEvent['type'])) {
      const evt = msg.evt as unknown as LobbyEvent;
      if (evt.type === 'lobby-entered') {
        this.lobbyId = evt.lobby.lobbyId;
        this.ownerId = evt.lobby.ownerId;
      } else if (evt.type === 'lobby-left') {
        this.lobbyId = null;
        this.ownerId = null;
      } else if (evt.type === 'owner-changed') {
        this.ownerId = evt.ownerId;
      }
      this.emitLobby(evt);
    }
  }

  /** one relay round trip; resolves `fallback` when the relay is down or slow (never rejects) */
  private request<T>(op: Op, args: unknown[], fallback: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.availability.ok) {
      return Promise.resolve((fallback && isRecord(fallback) && 'ok' in fallback ? fail('unavailable') : fallback) as T);
    }
    return new Promise<T>((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fallback as T);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        timer,
        resolve: (v) => resolve((v === undefined ? fallback : v) as T),
      });
      writeLine(socket, { k: 'req', id, op, args });
    });
  }
}
