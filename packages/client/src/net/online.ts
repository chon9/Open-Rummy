/**
 * Online transport: WebSocket client for the authoritative server.
 *
 * - same-origin `/ws` (ws: or wss: following the page protocol)
 * - `hello` handshake with a session token; it is kept in sessionStorage only while
 *   we hold a seat, so a refresh or dropped connection resumes the same seat
 * - heartbeat ping; a silent connection is closed and re-opened
 * - exponential reconnect with jitter
 * - every inbound message is validated before use (never trust the wire)
 */
import {
  EMOTES,
  HEARTBEAT_MS,
  MAX_NAME_LENGTH,
  PROTOCOL_VERSION,
  WS_PATH,
  type Action,
  type BotLevel,
  type PlayerView,
  type ClientMessage,
  type ErrorCode,
  type RoomInfo,
  type RulesConfig,
  type ServerMessage,
} from '@open-rummy/shared';
import type { Transport, TransportHandlers } from './transport';
import { t, tDyn } from '../i18n';

const TOKEN_KEY = 'openrummy.session';
const MAX_MESSAGE_CHARS = 1_000_000;

export type ConnState = 'connecting' | 'open' | 'closed';

export function loadToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: reconnect will just start a fresh session
  }
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${WS_PATH}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Structural validation of a server message. Returns null when malformed. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!isStr(raw) || raw.length > MAX_MESSAGE_CHARS) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(msg) || !isStr(msg.t)) return null;
  switch (msg.t) {
    case 'welcome':
      return isNum(msg.v) && isStr(msg.token) && typeof msg.resumed === 'boolean' ? (msg as unknown as ServerMessage) : null;
    case 'room': {
      const room = msg.room;
      if (!isObj(room) || !isStr(room.code) || !Array.isArray(room.seats) || !isObj(room.cfg) || !isNum(room.you)) return null;
      const seatsOk = room.seats.every((s) => s === null || (isObj(s) && isNum(s.seat) && isStr(s.name) && isStr(s.avatar)));
      return seatsOk ? (msg as unknown as ServerMessage) : null;
    }
    case 'game': {
      const v = msg.view;
      if (!isObj(v) || !Array.isArray(msg.events)) return null;
      if (!isStr(v.phase) || !isNum(v.you) || !Array.isArray(v.players) || !Array.isArray(v.melds) || !Array.isArray(v.hand) || !isObj(v.cfg)) return null;
      if (!v.hand.every(isStr)) return null;
      // serverNow is optional on the wire (older servers); drop a malformed value
      if (msg.serverNow !== undefined && !isNum(msg.serverNow)) delete msg.serverNow;
      return msg as unknown as ServerMessage;
    }
    case 'emote':
      return isNum(msg.seat) && isStr(msg.id) && (EMOTES as readonly string[]).includes(msg.id) ? (msg as unknown as ServerMessage) : null;
    case 'error':
      return isStr(msg.code) && isStr(msg.message) ? (msg as unknown as ServerMessage) : null;
    case 'left':
    case 'pong':
      return msg as unknown as ServerMessage;
    default:
      return null;
  }
}

/**
 * Server-to-local clock mapping from `serverNow` stamps on game messages.
 *
 * Each sample `local receive time - serverNow` equals the true offset plus the
 * one-way latency, so the smallest recent sample is the best estimate (least
 * delayed message). A window keeps it adaptive to clock adjustments.
 */
export class ClockSync {
  private samples: number[] = [];
  constructor(private readonly window = 16) {}

  /** Record a sample; returns the current offset estimate (local - server, ms). */
  sample(serverNow: number, localNow: number = Date.now()): number {
    this.samples.push(localNow - serverNow);
    if (this.samples.length > this.window) this.samples.shift();
    return this.offset;
  }

  /** local - server (ms); 0 until a sample arrived. */
  get offset(): number {
    return this.samples.length ? Math.min(...this.samples) : 0;
  }

  get synced(): boolean {
    return this.samples.length > 0;
  }

  /** Convert a server timestamp to the local clock. */
  toLocal(serverMs: number): number {
    return serverMs + this.offset;
  }
}

export interface OnlineEvents {
  /** handshake done; `resumed` = the server restored a previous session (seat) */
  onWelcome?(resumed: boolean): void;
  /** the server confirmed we left the room */
  onLeft?(): void;
}

export class OnlineTransport implements Transport {
  readonly kind = 'online' as const;
  /** online decisions are always timed by the server */
  readonly timersEnabled = true;
  private readonly clock = new ClockSync();
  private ws: WebSocket | null = null;
  private handlers: TransportHandlers = { onGame: () => undefined };
  private extra: OnlineEvents = {};
  /** messages queued until the handshake completes */
  private outbox: ClientMessage[] = [];
  private ready = false;
  private disposed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private state: ConnState = 'closed';
  /** our seat in the current room (-1 = none); used to suppress echoed emotes */
  private you = -1;
  private fatal = false;
  /** session token of the live connection (kept in memory even while sessionStorage is cleared) */
  private token: string | null = null;
  private readonly onBrowserOnline = (): void => this.reconnectNow();

  constructor(private name: string) {
    window.addEventListener('online', this.onBrowserOnline);
    this.connect();
  }

  get connection(): ConnState {
    return this.state;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
    h.onConnection?.(this.state);
  }

  setEvents(e: OnlineEvents): void {
    this.extra = e;
  }

  setName(name: string): void {
    this.name = name.slice(0, MAX_NAME_LENGTH);
  }

  // ----- lobby -------------------------------------------------------------

  createRoom(avatar: string, cfg: Partial<RulesConfig>, botLevel: BotLevel): void {
    this.post({ t: 'create_room', name: this.name, avatar, cfg, botLevel });
  }

  joinRoom(code: string, avatar: string): void {
    this.post({ t: 'join_room', code: code.trim().toUpperCase(), name: this.name, avatar });
  }

  setAvatar(avatar: string): void {
    this.post({ t: 'set_avatar', avatar });
  }

  addBot(): void {
    this.post({ t: 'add_bot' });
  }

  removeSeat(seat: number): void {
    this.post({ t: 'remove_seat', seat });
  }

  startGame(): void {
    this.post({ t: 'start_game' });
  }

  /** Host only, after MATCH_END: return the room to its lobby for a rematch. */
  restartRoom(): void {
    this.post({ t: 'restart_room' });
  }

  leave(): void {
    this.post({ t: 'leave_room' });
    // An explicit leave ends the seat: a later refresh must not silently "resume" a
    // session that has no room. The token is stored again when we join a room.
    saveToken(null);
  }

  // ----- Transport -----------------------------------------------------------

  send(action: Action): void {
    this.post({ t: 'action', action });
  }

  emote(id: string): void {
    if (!(EMOTES as readonly string[]).includes(id)) return;
    // show our own emote at once; the server echo is ignored (see onMessage)
    if (this.you >= 0) this.handlers.onEmote?.(this.you, id);
    this.post({ t: 'emote', id });
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('online', this.onBrowserOnline);
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        // already closed
      }
    }
  }

  /** Forget the session token (e.g. after leaving a finished match). */
  forgetSession(): void {
    saveToken(null);
  }

  // ----- connection management ------------------------------------------------

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.handlers.onConnection?.(s);
  }

  private connect(): void {
    if (this.disposed || this.fatal) return;
    this.ready = false;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastSeen = Date.now();
      const hello: Extract<ClientMessage, { t: 'hello' }> = { t: 'hello', v: PROTOCOL_VERSION, name: this.name };
      const token = loadToken() ?? this.token;
      if (token) hello.token = token;
      this.raw(hello);
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearTimers();
      this.setState('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles the reconnect
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.fatal || this.reconnectTimer) return;
    // 0.5s, 1s, 2s ... capped at 15s, with +-25% jitter
    const base = Math.min(15000, 500 * Math.pow(2, this.attempt));
    const delay = base * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.disposed || this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) return;
      if (Date.now() - this.lastSeen > HEARTBEAT_MS * 2.5) {
        // dead connection: force close, onclose schedules the reconnect
        try {
          this.ws.close(4000, 'timeout');
        } catch {
          // ignore
        }
        return;
      }
      this.raw({ t: 'ping' });
    }, HEARTBEAT_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Send now if the handshake is done, else queue. */
  private post(msg: ClientMessage): void {
    if (this.ready) this.raw(msg);
    else {
      // keep only the latest lobby intents; actions sent while offline are dropped (stale)
      if (msg.t === 'action' || msg.t === 'emote' || msg.t === 'ping') {
        this.handlers.onError?.(t('net.notConnected'));
        return;
      }
      this.outbox.push(msg);
      if (this.outbox.length > 10) this.outbox.shift();
    }
  }

  private raw(msg: ClientMessage): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    } catch {
      // socket closing: onclose will reconnect
    }
  }

  /** Rewrite the view's deadline from server time into the local clock. */
  private localizeDeadline(view: PlayerView): PlayerView {
    if (!view.deadline || !this.clock.synced) return view;
    return { ...view, deadline: this.clock.toLocal(view.deadline) };
  }

  private onMessage(data: unknown): void {
    this.lastSeen = Date.now();
    const msg = parseServerMessage(data);
    if (!msg) {
      console.warn('[online] dropped malformed message');
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        if (msg.v !== PROTOCOL_VERSION) {
          this.fatal = true;
          this.handlers.onError?.(t('err.VERSION'));
          return;
        }
        // Keep the token in memory; it is persisted only while we hold a seat (room/game
        // messages below), so a refresh outside a room never probes a seatless session.
        // A seated resume is always followed by a 'room' message that stores it again.
        this.token = msg.token;
        saveToken(null);
        this.ready = true;
        this.attempt = 0;
        this.setState('open');
        const queued = this.outbox.splice(0);
        for (const m of queued) this.raw(m);
        this.extra.onWelcome?.(msg.resumed);
        break;
      }
      case 'room':
        this.you = msg.room.you;
        if (this.token) saveToken(this.token);
        this.handlers.onRoom?.(msg.room as RoomInfo);
        break;
      case 'game': {
        this.you = msg.view.you;
        if (this.token) saveToken(this.token);
        if (isNum(msg.serverNow)) this.clock.sample(msg.serverNow);
        this.handlers.onGame(this.localizeDeadline(msg.view), msg.events);
        break;
      }
      case 'emote':
        if (msg.seat !== this.you) this.handlers.onEmote?.(msg.seat, msg.id);
        break;
      case 'left':
        this.you = -1;
        saveToken(null);
        this.extra.onLeft?.();
        break;
      case 'error':
        if (msg.code === 'VERSION') this.fatal = true;
        this.handlers.onError?.(errorText(msg.code, msg.message));
        break;
      case 'pong':
        break;
    }
  }
}

/** Localized text for a server error code (falls back to the server's message). */
export function errorText(code: ErrorCode, message: string): string {
  if (code === 'ILLEGAL') return t('err.illegal', { msg: message });
  return tDyn(`err.${code}`, undefined, message);
}
