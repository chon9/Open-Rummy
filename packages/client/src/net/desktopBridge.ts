/**
 * Desktop bridge CONTRACT (Electron build only). See docs/DESKTOP.md.
 *
 * The Electron main process owns Steam (steamworks.js native module). The preload
 * script exposes exactly this API on `window.openRummyDesktop` through
 * `contextBridge.exposeInMainWorld`. In the browser build the property is absent.
 *
 * Rules every implementation must follow:
 * - Every Steam id (user or lobby) crosses the bridge as a DECIMAL STRING of the
 *   64-bit id (bigint is not passable over contextBridge / IPC). Validate with
 *   `/^\d{1,20}$/` on both sides before calling `BigInt(id)`.
 * - Every method is async (IPC round trip to main) except event subscriptions.
 * - Failures never throw across the bridge for expected conditions: they resolve
 *   to `{ ok: false, reason }` (see `SteamResult`). Unexpected bugs may reject.
 * - P2P payloads are UTF-8 strings (JSON of ClientMessage / ServerMessage, see
 *   `SteamGuestMessage` / `SteamHostMessage`), at most `DESKTOP_LIMITS.maxP2PMessageBytes`
 *   bytes. Main drops oversized packets and packets from peers that are not members
 *   of the current lobby; the renderer must still validate every message it parses.
 *
 * This file is types plus a few contract constants: no runtime behaviour.
 */
import type { ClientMessage, ServerMessage } from '@open-rummy/shared';

// ---------------------------------------------------------------------------
// Contract constants (shared by preload/main and renderer)
// ---------------------------------------------------------------------------

/** Bumped when this contract changes incompatibly. `app.info().bridgeVersion` reports it. */
export const DESKTOP_BRIDGE_VERSION = 1;

export const DESKTOP_LIMITS = {
  /** max UTF-8 bytes of one P2P payload (Steam reliable limit is 1 MB; views are a few KB) */
  maxP2PMessageBytes: 64 * 1024,
  /** max packets main reads per poll tick (protects the main process from floods) */
  maxPacketsPerTick: 256,
  /** main polls the P2P queue at this interval (ms) */
  p2pPollMs: 16,
  /** max lobby data key / value lengths accepted by setLobbyData (Steam: 255 / 8192) */
  maxLobbyKeyLength: 64,
  maxLobbyValueLength: 4096,
  /** max lobby members: the largest rummy table (3-5 seats); the host refuses members beyond cfg.players */
  maxLobbyMembers: 5,
  /** guest -> host / host -> guest keepalive ({t:'ping'} / {t:'pong'}) */
  keepaliveMs: 10_000,
  /** a peer silent for this long is treated as gone */
  peerTimeoutMs: 30_000,
} as const;

/**
 * Lobby data keys written by the lobby OWNER (only the owner can set lobby data).
 * Lobbies under the shared Spacewar app id 480 must be filtered by `game` + `version`.
 */
export const LOBBY_KEYS = {
  /** always `LOBBY_GAME_TAG` */
  game: 'game',
  /** `PROTOCOL_VERSION` from @open-rummy/shared, as a decimal string */
  version: 'version',
  /** host display name (persona name) for the lobby browser */
  hostName: 'host',
  /** "taken/total", e.g. "2/4" (bots count as taken) */
  seats: 'seats',
  /** "0" lobby / "1" game in progress */
  started: 'started',
  /** JSON of the resolved RulesConfig (compact) */
  rules: 'rules',
  /** BotLevel of the room */
  botLevel: 'bot',
} as const;

export const LOBBY_GAME_TAG = 'open-rummy';

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** 64-bit Steam id as a decimal string, e.g. "76561197960287930". */
export type SteamIdString = string;

export type SteamResult<T = void> =
  | ({ ok: true } & (T extends void ? unknown : { value: T }))
  | { ok: false; reason: SteamFailure; message?: string };

export type SteamFailure =
  /** steamworks.js failed to load or init (Steam not running, not logged in, no app id) */
  | 'unavailable'
  /** no current lobby for an operation that needs one */
  | 'not-in-lobby'
  /** operation requires lobby ownership */
  | 'not-owner'
  /** lobby is full, gone, or Steam refused the join */
  | 'join-failed'
  | 'create-failed'
  /** bad argument (id format, size limit, unknown peer...) */
  | 'invalid'
  /** Steam refused to queue the packet */
  | 'send-failed'
  | 'unknown';

export interface SteamAvailability {
  ok: boolean;
  /** human readable reason when !ok, e.g. "Steam is not running" (never shown raw to players without i18n) */
  reason?: string;
  /** the app id Steam was initialised with (480 = Spacewar during development) */
  appId?: number;
}

export interface SteamSelf {
  steamId: SteamIdString;
  /** persona name; display only, never persist it */
  name: string;
}

export type LobbyVisibility = 'private' | 'friends' | 'public' | 'invisible';

export interface CreateLobbyOptions {
  /** default 'public' so the filtered lobby browser can find it; invites work for every type */
  visibility?: LobbyVisibility;
  /** 2..DESKTOP_LIMITS.maxLobbyMembers, default DESKTOP_LIMITS.maxLobbyMembers (5) */
  maxMembers?: number;
  /** initial lobby data (main always adds LOBBY_KEYS.game and LOBBY_KEYS.version) */
  data?: Record<string, string>;
}

export interface LobbyMember {
  steamId: SteamIdString;
  isOwner: boolean;
  isMe: boolean;
}

/** Snapshot of the lobby you are in. Member names are NOT available from steamworks.js 0.4 (no friends API): they travel in the P2P `hello`. */
export interface LobbyState {
  lobbyId: SteamIdString;
  ownerId: SteamIdString;
  members: LobbyMember[];
  maxMembers: number | null;
  data: Record<string, string>;
}

/** One row of the lobby browser (already filtered by game tag + version in main). */
export interface LobbySummary {
  lobbyId: SteamIdString;
  /** LOBBY_KEYS.hostName value, may be empty */
  hostName: string;
  /** parsed from LOBBY_KEYS.seats, null when missing/garbled */
  seatsTaken: number | null;
  seatsTotal: number | null;
  started: boolean;
  data: Record<string, string>;
}

export type MemberLeaveReason = 'left' | 'disconnected' | 'kicked' | 'banned';

export type LobbyEvent =
  /** you are now in this lobby (after createLobby / joinLobby resolved) */
  | { type: 'lobby-entered'; lobby: LobbyState }
  /** you left (leaveLobby) or Steam removed you */
  | { type: 'lobby-left'; lobbyId: SteamIdString; reason: 'self' | MemberLeaveReason }
  | { type: 'member-joined'; lobbyId: SteamIdString; steamId: SteamIdString }
  | { type: 'member-left'; lobbyId: SteamIdString; steamId: SteamIdString; reason: MemberLeaveReason }
  /** Steam moved ownership (e.g. the host left). v1 has no host migration: guests treat this as "host left". */
  | { type: 'owner-changed'; lobbyId: SteamIdString; ownerId: SteamIdString; previousOwnerId: SteamIdString }
  /** lobby data changed (full data after the change) */
  | { type: 'data-updated'; lobbyId: SteamIdString; data: Record<string, string> }
  /**
   * The player accepted an invite / clicked "Join game" in the Steam overlay or friends list
   * (GameLobbyJoinRequested), or the app was launched with `+connect_lobby <id>`.
   * The renderer decides whether to leave the current game and call joinLobby(lobbyId).
   */
  | { type: 'join-requested'; lobbyId: SteamIdString; friendId?: SteamIdString }
  /** P2PSessionConnectFail: the peer is unreachable (treat like a disconnect of that peer) */
  | { type: 'p2p-failed'; steamId: SteamIdString; error: number }
  /** connection to Steam servers changed (SteamServersConnected / Disconnected) */
  | { type: 'steam-connection'; connected: boolean };

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export interface DesktopAppInfo {
  appVersion: string;
  bridgeVersion: number;
  electronVersion: string;
  /** process.platform of the main process, e.g. 'win32' */
  platform: string;
  /** true when running from a packaged build (electron-builder), false in `npm start` */
  packaged: boolean;
  /**
   * WebSocket URL of the online (server) mode, already validated by main (`wss://`, or `ws://`
   * on loopback only; see net/serverUrl.ts). Default `wss://www.chon9.com/ws`; overridden by
   * `--server=<url>` or env OPEN_RUMMY_SERVER; null when disabled (`off`) or invalid, and then
   * the online mode is hidden. The page CSP allows exactly this origin.
   */
  onlineServerUrl: string | null;
}

export interface DesktopAppApi {
  info(): Promise<DesktopAppInfo>;
  quit(): Promise<void>;
  /** toggles and resolves to the new fullscreen state */
  toggleFullscreen(): Promise<boolean>;
}

export interface DesktopSteamApi {
  /** Whether steamworks.js initialised. Everything below resolves `{ok:false, reason:'unavailable'}` when not. */
  available(): Promise<SteamAvailability>;
  /** the logged-in Steam user; rejects-free: resolves null when Steam is unavailable */
  me(): Promise<SteamSelf | null>;

  // --- lobbies (only one current lobby at a time) ---------------------------
  /** creates a lobby you own; leaves any current lobby first. Emits 'lobby-entered'. */
  createLobby(opts?: CreateLobbyOptions): Promise<SteamResult<LobbyState>>;
  /** joins by decimal lobby id; leaves any current lobby first. Rejects lobbies whose game tag/version mismatch. Emits 'lobby-entered'. */
  joinLobby(lobbyId: SteamIdString): Promise<SteamResult<LobbyState>>;
  /** leaves the current lobby (no-op when none). Closes P2P sessions with its members. Emits 'lobby-left' reason 'self'. */
  leaveLobby(): Promise<void>;
  /** current lobby snapshot, null when not in one */
  currentLobby(): Promise<LobbyState | null>;
  /** members of the current lobby (empty when none) */
  lobbyMembers(): Promise<LobbyMember[]>;
  /** public lobbies of this game + protocol version (best effort under app id 480; see docs) */
  listLobbies(): Promise<SteamResult<LobbySummary[]>>;
  /** owner only. Key/value lengths limited by DESKTOP_LIMITS. Value '' deletes the key. */
  setLobbyData(key: string, value: string): Promise<SteamResult>;
  /** owner only: batch set (same rules), one LobbyDataUpdate for everyone */
  setLobbyDataMany(data: Record<string, string>): Promise<SteamResult>;
  getLobbyData(key: string): Promise<string | null>;
  /** owner only: whether new members may join (e.g. false once the game started and every seat is taken) */
  setLobbyJoinable(joinable: boolean): Promise<SteamResult>;
  /** opens the Steam overlay invite dialog for the current lobby (needs the overlay; see docs) */
  openInviteDialog(): Promise<SteamResult>;
  /**
   * Optional: avatar of a Steam user as a data: URL. steamworks.js 0.4 has no avatar API, so
   * implementations may omit it or resolve null. Callers must handle both.
   */
  avatarDataUrl?(steamId: SteamIdString): Promise<string | null>;

  // --- P2P (Steam relay, reliable + ordered per peer) ------------------------
  /** sends one payload to a member of the current lobby */
  sendTo(steamId: SteamIdString, data: string): Promise<SteamResult>;
  /** sends to every other member of the current lobby; result is ok only if all sends were queued */
  broadcast(data: string): Promise<SteamResult>;

  // --- events ---------------------------------------------------------------
  /**
   * The latest 'join-requested' not yet consumed (e.g. the game was launched by Steam with
   * `+connect_lobby <id>` before the renderer subscribed). Returns it once, then null.
   * Call at boot after subscribing to onLobbyEvent.
   */
  consumePendingJoin(): Promise<{ lobbyId: SteamIdString; friendId?: SteamIdString } | null>;

  /** P2P payloads from members of the current lobby, in arrival order per peer */
  onMessage(cb: (fromSteamId: SteamIdString, data: string) => void): Unsubscribe;
  onLobbyEvent(cb: (evt: LobbyEvent) => void): Unsubscribe;
}

export interface OpenRummyDesktopBridge {
  readonly app: DesktopAppApi;
  readonly steam: DesktopSteamApi;
}

// ---------------------------------------------------------------------------
// Messages carried over P2P (JSON strings in sendTo / onMessage)
// ---------------------------------------------------------------------------

/**
 * Guest -> host. The same envelopes the WebSocket server accepts; the host only honours
 * these kinds from guests (room management stays local to the host's own UI) and must
 * validate them like packages/server/src/session.ts `parseClientMessage` does.
 */
export type SteamGuestMessage = Extract<
  ClientMessage,
  { t: 'hello' } | { t: 'set_avatar' } | { t: 'action' } | { t: 'emote' } | { t: 'leave_room' } | { t: 'ping' }
>;

/** Steam-only extra fields the host adds to a `room` envelope (absent on the WebSocket server). */
export interface SteamRoomExtras {
  /**
   * true when the host chose relaxed mode: no decision deadlines are enforced and guests hide
   * every countdown (the WebSocket server is always timed, so it never sends this). Absent or
   * false = timed. Guests drop a non-boolean value.
   */
  relaxed?: boolean;
}

/**
 * Host -> guest. Same envelopes the WebSocket server sends, plus `relaxed` on `room`
 * (SteamRoomExtras). `game` carries ONLY the receiving seat's projected view (GameHost
 * per-seat fan-out), never another seat's. `left` doubles as "host closed the table".
 * `welcome.token` is unused (''). Errors: `VERSION`, `ROOM_FULL`, `ALREADY_STARTED` answer a
 * refused `hello`; `NOT_IN_ROOM` means the host gave this member's seat away (P2P failure or
 * silence) and ends the guest's session; `ILLEGAL` (a rejected action) is informational. The
 * host never sends `NOT_HOST` (guest room-management envelopes are dropped, not answered).
 */
export type SteamHostMessage = ServerMessage | (Extract<ServerMessage, { t: 'room' }> & SteamRoomExtras);

// ---------------------------------------------------------------------------
// Test double (implemented by a later agent, e.g. src/net/desktopMock.ts)
// ---------------------------------------------------------------------------

export interface MockSteamUser {
  steamId: SteamIdString;
  name: string;
}

export interface MockSteamNetwork {
  /** one bridge per simulated user, all wired to one in-memory Steam (lobbies + P2P) */
  readonly bridges: OpenRummyDesktopBridge[];
  readonly users: MockSteamUser[];
  /** deliver queued P2P packets and lobby callbacks (when created with manual delivery) */
  flush(): Promise<void>;
  /** simulate a crash / network loss of one user (members see 'member-left' reason 'disconnected') */
  disconnect(steamId: SteamIdString): void;
  /** simulate GameLobbyJoinRequested for a user (invite accepted in the overlay) */
  requestJoin(steamId: SteamIdString, lobbyId: SteamIdString, friendId?: SteamIdString): void;
}

export interface MockSteamNetworkOptions {
  /** default: generated ids/names "Player 1".."Player N" */
  users?: MockSteamUser[];
  /** true: messages/events are queued until flush(); false (default): delivered on a microtask */
  manualDelivery?: boolean;
  /** simulate Steam unavailable for every bridge */
  unavailable?: boolean;
}

/** Signature of the mock factory: `createMockSteamNetwork(4)` returns 4 wired bridges. */
export type CreateMockSteamNetwork = (userCount: number, opts?: MockSteamNetworkOptions) => MockSteamNetwork;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    /** present only inside the Electron desktop build */
    openRummyDesktop?: OpenRummyDesktopBridge;
  }
  /**
   * Compile-time flag defined (true) by desktop/vite.config.ts only. The web build does not
   * define it, so always guard: `typeof __DESKTOP__ !== 'undefined' && __DESKTOP__`.
   * Runtime detection: `window.openRummyDesktop !== undefined`.
   */
  const __DESKTOP__: boolean | undefined;
}
