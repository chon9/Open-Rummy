/**
 * Real Steam backend (Electron MAIN process only). Owns the steamworks.js 0.4 native module.
 *
 * - Callbacks: steamworks.js `init()` already pumps `runCallbacks()` at 30 Hz (its index.js),
 *   so no extra pump is needed. P2P has no callback for data: this service polls the legacy
 *   ISteamNetworking queue every DESKTOP_LIMITS.p2pPollMs and drains up to maxPacketsPerTick.
 * - Lobby: one current lobby. Membership is reconciled from Steam (`getMembers`) on every
 *   LobbyChatUpdate / LobbyDataUpdate and diffed into member-joined / member-left /
 *   owner-changed events, so missed or reordered callbacks cannot desync the snapshot.
 * - P2P: sessions are accepted only from members of the current lobby (requests from a
 *   not-yet-known member are parked for 30 s and accepted when the member shows up);
 *   packets from non-members, oversized or non-UTF-8 packets are dropped; incoming
 *   messages are rate limited per peer (backend.ts).
 * - Nothing here throws to the caller: failures resolve `{ ok:false, reason }` and are logged.
 */
import { PROTOCOL_VERSION } from '@open-rummy/shared';
import {
  DESKTOP_LIMITS,
  LOBBY_GAME_TAG,
  LOBBY_KEYS,
  type CreateLobbyOptions,
  type LobbyMember,
  type LobbyState,
  type LobbySummary,
  type LobbyVisibility,
  type MemberLeaveReason,
  type SteamAvailability,
  type SteamIdString,
  type SteamResult,
  type SteamSelf,
} from '../../../packages/client/src/net/desktopBridge';
import { isLobbyKey, isLobbyValue, isPayload, isSteamIdString } from '../channels';
import { BaseSteamBackend, errMessage, fail, lobbySummaryFromData, type Logger, type SteamBackend } from './backend';

type SteamworksModule = typeof import('steamworks.js');
type SteamClient = ReturnType<SteamworksModule['init']>;
type Lobby = Awaited<ReturnType<SteamClient['matchmaking']['createLobby']>>;

/**
 * steamworks.js 0.4 SteamCallback / enum values (the typings declare const enums, which
 * isolatedModules cannot read, so the numbers are mirrored here).
 */
export const SteamCb = {
  PersonaStateChange: 0,
  SteamServersConnected: 1,
  SteamServersDisconnected: 2,
  SteamServerConnectFailure: 3,
  LobbyDataUpdate: 4,
  LobbyChatUpdate: 5,
  P2PSessionRequest: 6,
  P2PSessionConnectFail: 7,
  GameLobbyJoinRequested: 8,
} as const;
const LOBBY_TYPE: Record<LobbyVisibility, number> = { private: 0, friends: 1, public: 2, invisible: 3 };
const SEND_RELIABLE = 2;
/** ChatMemberStateChange: Entered 0, Left 1, Disconnected 2, Kicked 3, Banned 4 */
const LEAVE_REASON: Record<number, MemberLeaveReason> = { 1: 'left', 2: 'disconnected', 3: 'kicked', 4: 'banned' };

const LOBBY_OP_TIMEOUT_MS = 20_000;
const PENDING_SESSION_TTL_MS = 30_000;
const MAX_PENDING_SESSIONS = 32;

interface CurrentLobby {
  lobby: Lobby;
  id: SteamIdString;
  ownerId: SteamIdString;
  members: Set<SteamIdString>;
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, onLate: (v: T) => void): Promise<T> {
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(`timed out after ${ms} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        if (timedOut) onLate(v);
        else resolve(v);
      },
      (err) => {
        clearTimeout(t);
        if (!timedOut) reject(err);
      },
    );
  });
}

export class SteamService extends BaseSteamBackend implements SteamBackend {
  readonly kind = 'steam' as const;
  private sw: SteamworksModule | null = null;
  private client: SteamClient | null = null;
  private availability: SteamAvailability = { ok: false, reason: 'not initialised' };
  private self: SteamSelf | null = null;
  private current: CurrentLobby | null = null;
  private readonly pendingSessions = new Map<SteamIdString, number>();
  private readonly handles: Array<{ disconnect(): void }> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private disposed = false;
  private readonly version = String(PROTOCOL_VERSION);

  constructor(
    private readonly appId: number,
    log: Logger,
  ) {
    super(log);
  }

  /** Synchronous init (must run before app 'ready' so enableOverlay() can still add switches). Never throws. */
  initSync(): SteamAvailability {
    if (this.client) return this.available();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.sw = require('steamworks.js') as SteamworksModule;
    } catch (err) {
      this.availability = { ok: false, reason: `steamworks.js failed to load: ${errMessage(err)}` };
      return this.available();
    }
    try {
      // also starts runCallbacks() on a 30 Hz interval (steamworks.js index.js)
      this.client = this.sw.init(this.appId);
      this.availability = { ok: true, appId: this.client.utils.getAppId() };
      const id = this.client.localplayer.getSteamId();
      this.self = { steamId: id.steamId64.toString(), name: this.client.localplayer.getName() };
    } catch (err) {
      this.client = null;
      this.availability = { ok: false, reason: `Steam init failed (is Steam running and logged in?): ${errMessage(err)}` };
      return this.available();
    }
    try {
      this.registerCallbacks();
      this.pollTimer = setInterval(() => this.pollP2P(), DESKTOP_LIMITS.p2pPollMs);
    } catch (err) {
      this.log(`steam callback setup failed: ${errMessage(err)}`);
    }
    return this.available();
  }

  async init(): Promise<SteamAvailability> {
    return this.initSync();
  }

  /**
   * Must run BEFORE app 'ready' and before any BrowserWindow exists: appends the
   * in-process-gpu / disable-direct-composition switches and repaints every window
   * each frame so the overlay can draw. Only call when init succeeded.
   */
  enableOverlay(): void {
    if (!this.sw || !this.client) return;
    try {
      this.sw.electronEnableSteamOverlay();
    } catch (err) {
      this.log(`electronEnableSteamOverlay failed: ${errMessage(err)}`);
    }
  }

  available(): SteamAvailability {
    return { ...this.availability };
  }

  me(): SteamSelf | null {
    if (!this.client || !this.self) return null;
    try {
      // persona name can change while running; id cannot
      this.self.name = this.client.localplayer.getName();
    } catch {
      // keep the cached name
    }
    return { ...this.self };
  }

  // --- lobbies ---------------------------------------------------------------

  createLobby(opts: CreateLobbyOptions): Promise<SteamResult<LobbyState>> {
    return this.serial(async () => {
      const client = this.client;
      if (!client) return fail('unavailable');
      const visibility = opts.visibility ?? 'public';
      const max = opts.maxMembers ?? DESKTOP_LIMITS.maxLobbyMembers;
      this.leaveNow();
      let lobby: Lobby;
      try {
        lobby = await withTimeout(client.matchmaking.createLobby(LOBBY_TYPE[visibility] as never, max), LOBBY_OP_TIMEOUT_MS, (late) =>
          safeLeave(late),
        );
      } catch (err) {
        this.log(`createLobby failed: ${errMessage(err)}`);
        return fail('create-failed', err instanceof TimeoutError ? 'timed out' : errMessage(err));
      }
      try {
        const data: Record<string, string> = {};
        for (const [k, v] of Object.entries(opts.data ?? {})) if (v !== '') data[k] = v;
        data[LOBBY_KEYS.game] = LOBBY_GAME_TAG;
        data[LOBBY_KEYS.version] = this.version;
        if (!lobby.mergeFullData(data)) this.log('createLobby: some lobby data was not accepted by Steam');
        this.adopt(lobby);
        const state = this.snapshot();
        if (!state) return fail('create-failed', 'lobby vanished');
        this.emitLobby({ type: 'lobby-entered', lobby: state });
        return { ok: true, value: state };
      } catch (err) {
        this.log(`createLobby setup failed: ${errMessage(err)}`);
        this.leaveNow();
        return fail('create-failed', errMessage(err));
      }
    });
  }

  joinLobby(lobbyId: SteamIdString): Promise<SteamResult<LobbyState>> {
    return this.serial(async () => {
      const client = this.client;
      if (!client) return fail('unavailable');
      if (!isSteamIdString(lobbyId)) return fail('invalid', 'lobby id');
      if (this.current?.id === lobbyId) {
        const state = this.snapshot();
        if (state) return { ok: true, value: state };
      }
      this.leaveNow();
      let lobby: Lobby;
      try {
        lobby = await withTimeout(client.matchmaking.joinLobby(BigInt(lobbyId)), LOBBY_OP_TIMEOUT_MS, (late) => safeLeave(late));
      } catch (err) {
        this.log(`joinLobby failed: ${errMessage(err)}`);
        return fail('join-failed', err instanceof TimeoutError ? 'timed out' : errMessage(err));
      }
      try {
        const game = lobby.getData(LOBBY_KEYS.game);
        const version = lobby.getData(LOBBY_KEYS.version);
        const me = this.self?.steamId;
        const inside = lobby.getMembers().some((m) => m.steamId64.toString() === me);
        if (game !== LOBBY_GAME_TAG || version !== this.version || !inside) {
          safeLeave(lobby);
          const why = !inside ? 'not admitted' : game !== LOBBY_GAME_TAG ? 'not an Open Rummy lobby' : 'protocol version mismatch';
          return fail('join-failed', why);
        }
        this.adopt(lobby);
        const state = this.snapshot();
        if (!state) return fail('join-failed', 'lobby vanished');
        this.emitLobby({ type: 'lobby-entered', lobby: state });
        return { ok: true, value: state };
      } catch (err) {
        this.log(`joinLobby setup failed: ${errMessage(err)}`);
        safeLeave(lobby);
        this.current = null;
        return fail('join-failed', errMessage(err));
      }
    });
  }

  leaveLobby(): Promise<void> {
    return this.serial(async () => {
      this.leaveNow();
    });
  }

  async currentLobby(): Promise<LobbyState | null> {
    return this.snapshot();
  }

  async lobbyMembers(): Promise<LobbyMember[]> {
    return this.snapshot()?.members ?? [];
  }

  async listLobbies(): Promise<SteamResult<LobbySummary[]>> {
    const client = this.client;
    if (!client) return fail('unavailable');
    try {
      const lobbies = await withTimeout(client.matchmaking.getLobbies(), LOBBY_OP_TIMEOUT_MS, () => {});
      const rows: LobbySummary[] = [];
      for (const l of lobbies) {
        try {
          if (l.getData(LOBBY_KEYS.game) !== LOBBY_GAME_TAG || l.getData(LOBBY_KEYS.version) !== this.version) continue;
          rows.push(lobbySummaryFromData(l.id.toString(), l.getFullData()));
        } catch {
          // a lobby that vanished mid-iteration is skipped
        }
      }
      return { ok: true, value: rows };
    } catch (err) {
      this.log(`listLobbies failed: ${errMessage(err)}`);
      return fail('unknown', err instanceof TimeoutError ? 'timed out' : errMessage(err));
    }
  }

  async setLobbyData(key: string, value: string): Promise<SteamResult> {
    return this.setLobbyDataMany({ [key]: value });
  }

  async setLobbyDataMany(data: Record<string, string>): Promise<SteamResult> {
    const owned = this.ownedLobby();
    if (!owned.ok) return owned;
    const lobby = owned.lobby;
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!isLobbyKey(k) || !isLobbyValue(v)) return fail('invalid', 'lobby data');
      if (v !== '') set[k] = v;
    }
    try {
      let ok = true;
      for (const [k, v] of Object.entries(data)) if (v === '' && lobby.getData(k) !== null) ok = lobby.deleteData(k) && ok;
      if (Object.keys(set).length > 0) ok = lobby.mergeFullData(set) && ok;
      return ok ? { ok: true } : fail('unknown', 'Steam refused some lobby data');
    } catch (err) {
      return fail('unknown', errMessage(err));
    }
  }

  async getLobbyData(key: string): Promise<string | null> {
    if (!this.current || !isLobbyKey(key)) return null;
    try {
      return this.current.lobby.getData(key);
    } catch {
      return null;
    }
  }

  async setLobbyJoinable(joinable: boolean): Promise<SteamResult> {
    const owned = this.ownedLobby();
    if (!owned.ok) return owned;
    try {
      return owned.lobby.setJoinable(joinable) ? { ok: true } : fail('unknown', 'Steam refused setJoinable');
    } catch (err) {
      return fail('unknown', errMessage(err));
    }
  }

  async openInviteDialog(): Promise<SteamResult> {
    const client = this.client;
    if (!client) return fail('unavailable');
    if (!this.current) return fail('not-in-lobby');
    try {
      client.overlay.activateInviteDialog(BigInt(this.current.id));
      return { ok: true };
    } catch (err) {
      return fail('unknown', errMessage(err));
    }
  }

  /** steamworks.js 0.4 has no friends/avatar API */
  async avatarDataUrl(): Promise<string | null> {
    return null;
  }

  // --- P2P -------------------------------------------------------------------

  async sendTo(steamId: SteamIdString, data: string): Promise<SteamResult> {
    const client = this.client;
    if (!client) return fail('unavailable');
    if (!this.current) return fail('not-in-lobby');
    if (!isSteamIdString(steamId) || !isPayload(data)) return fail('invalid', 'bad peer or payload');
    if (steamId === this.self?.steamId || !this.isMember(steamId)) return fail('invalid', 'peer is not a lobby member');
    try {
      return client.networking.sendP2PPacket(BigInt(steamId), SEND_RELIABLE as never, Buffer.from(data, 'utf8'))
        ? { ok: true }
        : fail('send-failed');
    } catch (err) {
      return fail('send-failed', errMessage(err));
    }
  }

  async broadcast(data: string): Promise<SteamResult> {
    if (!this.client) return fail('unavailable');
    if (!this.current) return fail('not-in-lobby');
    if (!isPayload(data)) return fail('invalid', 'payload');
    let result: SteamResult = { ok: true };
    for (const m of this.current.members) {
      if (m === this.self?.steamId) continue;
      const r = await this.sendTo(m, data);
      if (!r.ok) result = r;
    }
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.leaveNow();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const h of this.handles.splice(0)) {
      try {
        h.disconnect();
      } catch {
        // already gone
      }
    }
    this.lobbyListeners.clear();
    this.messageListeners.clear();
  }

  // --- internals -------------------------------------------------------------

  private adopt(lobby: Lobby): void {
    const members = new Set(lobby.getMembers().map((m) => m.steamId64.toString()));
    this.current = { lobby, id: lobby.id.toString(), ownerId: lobby.getOwner().steamId64.toString(), members };
    this.limiter.clear();
    for (const m of members) this.acceptPendingSession(m);
  }

  private snapshot(): LobbyState | null {
    const cur = this.current;
    if (!cur) return null;
    try {
      const me = this.self?.steamId;
      const limit = cur.lobby.getMemberLimit();
      return {
        lobbyId: cur.id,
        ownerId: cur.ownerId,
        members: [...cur.members].map((id) => ({ steamId: id, isOwner: id === cur.ownerId, isMe: id === me })),
        maxMembers: limit === null ? null : Number(limit),
        data: cur.lobby.getFullData(),
      };
    } catch (err) {
      this.log(`lobby snapshot failed: ${errMessage(err)}`);
      return null;
    }
  }

  /** leaves synchronously (no serialisation): used inside serial ops, on kick and on dispose */
  private leaveNow(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    safeLeave(cur.lobby);
    this.emitLobby({ type: 'lobby-left', lobbyId: cur.id, reason: 'self' });
  }

  private ownedLobby(): { ok: true; lobby: Lobby } | { ok: false; reason: 'unavailable' | 'not-in-lobby' | 'not-owner' } {
    if (!this.client) return { ok: false, reason: 'unavailable' };
    const cur = this.current;
    if (!cur) return { ok: false, reason: 'not-in-lobby' };
    let owner = cur.ownerId;
    try {
      owner = cur.lobby.getOwner().steamId64.toString();
    } catch {
      // keep the cached owner
    }
    if (owner !== this.self?.steamId) return { ok: false, reason: 'not-owner' };
    return { ok: true, lobby: cur.lobby };
  }

  /** cached membership, refreshed from Steam on a miss (P2P can beat LobbyChatUpdate) */
  private isMember(steamId: SteamIdString): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (cur.members.has(steamId)) return true;
    this.reconcile('left');
    return this.current?.members.has(steamId) ?? false;
  }

  /** diff Steam's member list / owner against the cache and emit events for the changes */
  private reconcile(leaveReason: MemberLeaveReason, changedUser?: SteamIdString): void {
    const cur = this.current;
    if (!cur) return;
    let fresh: Set<SteamIdString>;
    let owner: SteamIdString;
    try {
      fresh = new Set(cur.lobby.getMembers().map((m) => m.steamId64.toString()));
      owner = cur.lobby.getOwner().steamId64.toString();
    } catch (err) {
      this.log(`lobby reconcile failed: ${errMessage(err)}`);
      return;
    }
    const me = this.self?.steamId;
    if (me && !fresh.has(me) && changedUser === me) {
      // Steam removed us (kicked/banned/disconnected)
      this.current = null;
      safeLeave(cur.lobby);
      this.emitLobby({ type: 'lobby-left', lobbyId: cur.id, reason: leaveReason });
      return;
    }
    for (const id of fresh) {
      if (!cur.members.has(id)) {
        cur.members.add(id);
        this.acceptPendingSession(id);
        if (id !== me) this.emitLobby({ type: 'member-joined', lobbyId: cur.id, steamId: id });
      }
    }
    for (const id of [...cur.members]) {
      if (!fresh.has(id) && id !== me) {
        cur.members.delete(id);
        this.emitLobby({ type: 'member-left', lobbyId: cur.id, steamId: id, reason: id === changedUser ? leaveReason : 'left' });
      }
    }
    if (owner !== cur.ownerId) {
      const previousOwnerId = cur.ownerId;
      cur.ownerId = owner;
      this.emitLobby({ type: 'owner-changed', lobbyId: cur.id, ownerId: owner, previousOwnerId });
    }
  }

  private acceptPendingSession(steamId: SteamIdString): void {
    const at = this.pendingSessions.get(steamId);
    if (at === undefined) return;
    this.pendingSessions.delete(steamId);
    if (Date.now() - at > PENDING_SESSION_TTL_MS || steamId === this.self?.steamId) return;
    try {
      this.client?.networking.acceptP2PSession(BigInt(steamId));
    } catch (err) {
      this.log(`acceptP2PSession failed: ${errMessage(err)}`);
    }
  }

  private pollP2P(): void {
    const client = this.client;
    if (!client) return;
    try {
      for (let i = 0; i < DESKTOP_LIMITS.maxPacketsPerTick; i++) {
        const size = client.networking.isP2PPacketAvailable();
        if (!size) break;
        const pkt = client.networking.readP2PPacket(size);
        const from = pkt.steamId.steamId64.toString();
        if (pkt.size > DESKTOP_LIMITS.maxP2PMessageBytes || pkt.data.length > DESKTOP_LIMITS.maxP2PMessageBytes) continue;
        const cur = this.current;
        if (!cur || from === this.self?.steamId || !this.isMember(from)) continue;
        let text: string;
        try {
          text = this.decoder.decode(pkt.data.subarray(0, pkt.size));
        } catch {
          continue; // not UTF-8
        }
        this.deliverMessage(from, text, from === cur.ownerId);
      }
    } catch (err) {
      this.log(`p2p poll failed: ${errMessage(err)}`);
    }
  }

  /** typed wrapper: the steamworks.js typings key callbacks by a const enum (see SteamCb) */
  private on<T>(cb: number, handler: (value: T) => void): void {
    if (!this.client) return;
    const register = this.client.callback.register as unknown as (c: number, h: (value: T) => void) => { disconnect(): void };
    const safe = (value: T): void => {
      try {
        handler(value);
      } catch (err) {
        this.log(`steam callback ${cb} failed: ${errMessage(err)}`);
      }
    };
    this.handles.push(register(cb, safe));
  }

  private registerCallbacks(): void {
    this.on<{ lobby_steam_id: bigint; friend_steam_id: bigint }>(SteamCb.GameLobbyJoinRequested, (v) => {
      const lobbyId = v.lobby_steam_id.toString();
      const friendId = v.friend_steam_id.toString();
      if (!isSteamIdString(lobbyId)) return;
      this.emitLobby(isSteamIdString(friendId) ? { type: 'join-requested', lobbyId, friendId } : { type: 'join-requested', lobbyId });
    });
    this.on(SteamCb.SteamServersConnected, () => this.emitLobby({ type: 'steam-connection', connected: true }));
    this.on(SteamCb.SteamServersDisconnected, () => this.emitLobby({ type: 'steam-connection', connected: false }));

    this.on<{ lobby: bigint; user_changed: bigint; making_change: bigint; member_state_change: number }>(SteamCb.LobbyChatUpdate, (v) => {
      if (!this.current || v.lobby.toString() !== this.current.id) return;
      const reason = LEAVE_REASON[v.member_state_change] ?? 'left';
      this.reconcile(reason, v.user_changed.toString());
    });

    this.on<{ lobby: bigint; member: bigint; success: boolean }>(SteamCb.LobbyDataUpdate, (v) => {
      const cur = this.current;
      if (!cur || v.lobby.toString() !== cur.id || !v.success) return;
      this.reconcile('left');
      if (v.member === v.lobby && this.current === cur) {
        this.emitLobby({ type: 'data-updated', lobbyId: cur.id, data: cur.lobby.getFullData() });
      }
    });

    this.on<{ remote: bigint }>(SteamCb.P2PSessionRequest, (v) => {
      const remote = v.remote.toString();
      if (this.isMember(remote) && remote !== this.self?.steamId) {
        this.client?.networking.acceptP2PSession(v.remote);
        return;
      }
      // maybe a member whose LobbyChatUpdate has not arrived yet: park it briefly
      const now = Date.now();
      for (const [id, at] of this.pendingSessions) if (now - at > PENDING_SESSION_TTL_MS) this.pendingSessions.delete(id);
      if (this.pendingSessions.size < MAX_PENDING_SESSIONS) this.pendingSessions.set(remote, now);
    });

    this.on<{ remote: bigint; error: number }>(SteamCb.P2PSessionConnectFail, (v) => {
      const remote = v.remote.toString();
      if (this.current?.members.has(remote)) this.emitLobby({ type: 'p2p-failed', steamId: remote, error: Number(v.error) });
    });
  }
}

function safeLeave(lobby: Lobby): void {
  try {
    lobby.leave();
  } catch {
    // already left / Steam gone
  }
}
