/**
 * Sessions, rate limiting and inbound message validation.
 *
 * - A session is identified by a random token handed out in `welcome`. It
 *   survives socket drops so a client can resume its seat with `hello{token}`.
 * - Every inbound message is parsed defensively: size limit, JSON try/catch,
 *   strict shape checks and string length limits. Nothing from the wire is
 *   trusted; the engine then validates game semantics.
 */
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  EMOTES,
  MAX_NAME_LENGTH,
  ROOM_CODE_LENGTH,
  resolveRules,
  type Action,
  type BotLevel,
  type ClientMessage,
  type RulesConfig,
} from '@open-rummy/shared';

/** Maximum inbound message size in bytes (also enforced by ws maxPayload). */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Sessions without a socket and without a room are forgotten after this long. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class Session {
  /** socket currently attached (null while disconnected) */
  ws: WebSocket | null = null;
  /** room code the session is seated in, or null */
  room: string | null = null;
  seat = -1;
  /** last time the session had a socket attached (ms) */
  lastSeen = Date.now();
  /** last emote time, for the emote rate limit */
  lastEmote = 0;
  /** client address key of the most recent socket (per-IP limits) */
  ip = '';

  constructor(
    readonly token: string,
    public name: string,
  ) {}

  get connected(): boolean {
    return this.ws !== null;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly maxSessions = 20000) {}

  get size(): number {
    return this.sessions.size;
  }

  /** Create a fresh session, or null if the store is full. */
  create(name: string): Session | null {
    if (this.sessions.size >= this.maxSessions) this.gc(Date.now());
    // Still full: evict every detached session without a seat, whatever its age. Such a
    // session holds nothing worth resuming, and evicting them means connect/hello/close
    // loops cannot lock everyone else out until the idle timeout.
    if (this.sessions.size >= this.maxSessions) this.gc(Number.POSITIVE_INFINITY);
    if (this.sessions.size >= this.maxSessions) return null;
    const token = randomBytes(24).toString('base64url');
    const s = new Session(token, name);
    this.sessions.set(token, s);
    return s;
  }

  get(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  /** Forget idle sessions that hold neither a socket nor a seat. */
  gc(now: number): void {
    for (const [token, s] of this.sessions) {
      if (!s.connected && s.room === null && now - s.lastSeen > SESSION_IDLE_MS) this.sessions.delete(token);
    }
  }

  values(): IterableIterator<Session> {
    return this.sessions.values();
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Classic token bucket: `rate` tokens per second, up to `burst` stored. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate = 20,
    private readonly burst = 40,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** True once the bucket has refilled completely (the key can be forgotten). */
  isFull(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    return this.tokens + elapsed * this.rate >= this.burst;
  }
}

// ---------------------------------------------------------------------------
// Field sanitising
// ---------------------------------------------------------------------------

/** Room code alphabet: uppercase without the ambiguous 0/O/1/I/L. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const AVATAR_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TILE_ID_MAX = 12;
const MAX_TILES_PER_LIST = 40;
const MAX_MELDS_IN_PORT = 12;
const MELD_ID_MAX = 32;

export function normaliseRoomCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 16) return null;
  const code = v.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** C0/C1 controls, zero-width and bidi override characters (built from escapes to keep the source ASCII). */
const INVISIBLE_CHARS = new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]', 'g');

/** Trim, strip control characters, collapse whitespace, cap length (by code points). */
export function sanitizeName(v: unknown, fallback = 'Player'): string {
  if (typeof v !== 'string') return fallback;
  const cleaned = v.slice(0, 200).replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
  const capped = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return capped || fallback;
}

export function sanitizeAvatar(v: unknown, fallback = 'mei'): string {
  return typeof v === 'string' && AVATAR_RE.test(v) ? v : fallback;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}

type IntKey = { [K in keyof RulesConfig]: RulesConfig[K] extends number ? K : never }[keyof RulesConfig];
type BoolKey = { [K in keyof RulesConfig]: RulesConfig[K] extends boolean ? K : never }[keyof RulesConfig];

/** Whitelisted numeric rule options with their allowed bounds. */
const INT_BOUNDS: Partial<Record<IntKey, [number, number]>> = {
  players: [3, 5],
  handSize: [10, 25],
  jokers: [0, 12],
  jokerPenalty: [0, 100],
  minNaturalsInNewMeld: [1, 3],
  startingChips: [0, 1_000_000],
  baseUnit: [1, 1000],
  gamePaiPayout: [0, 1000],
  tianhuPayout: [0, 1000],
  handsPerMatch: [0, 40],
  portTimerMs: [5000, 120_000],
  turnTimerMs: [5000, 120_000],
  instantTimerMs: [3000, 60_000],
  handEndDelayMs: [2000, 30_000],
};

const BOOL_KEYS: BoolKey[] = [
  'setAllowedAsPort',
  'cutOnlyWhenCannotExtend',
  'newRunsAfterPort',
  'unlimitedActions',
  'setCapFourDistinct',
  'setPriority',
  'aceHigh',
  'instantWins',
];

/**
 * Turn a client-supplied partial config into a full, bounded RulesConfig.
 * Unknown keys are dropped, out-of-range numbers are clamped, wrong types ignored.
 */
export function sanitizeRules(raw: unknown): RulesConfig {
  const out: Partial<RulesConfig> = {};
  if (isObj(raw)) {
    for (const [key, [min, max]] of Object.entries(INT_BOUNDS) as [IntKey, [number, number]][]) {
      const n = clampInt(raw[key], min, max);
      if (n !== undefined) out[key] = n;
    }
    for (const key of BOOL_KEYS) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    if (raw.portTiming === 'simultaneous' || raw.portTiming === 'sequential') out.portTiming = raw.portTiming;
    if (raw.jokerSwap === 'off' || raw.jokerSwap === 'keep' || raw.jokerSwap === 'useSameTurn') out.jokerSwap = raw.jokerSwap;
    if (raw.dealerRotation === 'next' || raw.dealerRotation === 'winner') out.dealerRotation = raw.dealerRotation;
    // The ladder is indexed by finishing rank (2nd..5th), so it must have all 4 entries.
    const ladder = raw.payoutLadder;
    if (Array.isArray(ladder) && ladder.length === 4) {
      const vals = ladder.map((x) => clampInt(x, 0, 1000));
      if (vals.every((x): x is number => x !== undefined)) out.payoutLadder = vals;
    }
  }
  return resolveRules(out);
}

export function sanitizeBotLevel(v: unknown): BotLevel {
  return v === 'easy' || v === 'hard' ? v : 'normal';
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

function tileList(v: unknown, allowEmpty = false): v is string[] {
  return (
    Array.isArray(v) &&
    (allowEmpty || v.length > 0) &&
    v.length <= MAX_TILES_PER_LIST &&
    v.every((t) => isStr(t, TILE_ID_MAX))
  );
}

/** Shape-check a game action. Semantics are validated by the engine. */
export function parseAction(v: unknown): Action | null {
  if (!isObj(v) || typeof v.type !== 'string') return null;
  switch (v.type) {
    case 'DECLARE_INSTANT':
      return typeof v.declare === 'boolean' ? { type: 'DECLARE_INSTANT', declare: v.declare } : null;
    case 'PORT':
      return Array.isArray(v.melds) && v.melds.length > 0 && v.melds.length <= MAX_MELDS_IN_PORT && v.melds.every((m) => tileList(m))
        ? { type: 'PORT', melds: (v.melds as string[][]).map((m) => [...m]) }
        : null;
    case 'EXTEND':
      return isStr(v.meldId, MELD_ID_MAX) && tileList(v.low, true) && tileList(v.high, true) && v.low.length + v.high.length > 0
        ? { type: 'EXTEND', meldId: v.meldId, low: [...v.low], high: [...v.high] }
        : null;
    case 'CUT':
      return tileList(v.tiles) ? { type: 'CUT', tiles: [...v.tiles] } : null;
    case 'FOLLOW_CUT':
      return isStr(v.meldId, MELD_ID_MAX) && tileList(v.tiles) ? { type: 'FOLLOW_CUT', meldId: v.meldId, tiles: [...v.tiles] } : null;
    case 'NEW_RUN':
      return tileList(v.tiles) ? { type: 'NEW_RUN', tiles: [...v.tiles] } : null;
    case 'SWAP_JOKER':
      return isStr(v.meldId, MELD_ID_MAX) && isStr(v.jokerTileId, TILE_ID_MAX) && isStr(v.withTileId, TILE_ID_MAX)
        ? { type: 'SWAP_JOKER', meldId: v.meldId, jokerTileId: v.jokerTileId, withTileId: v.withTileId }
        : null;
    case 'END_TURN':
      return { type: 'END_TURN' };
    default:
      return null;
  }
}

/**
 * Parse one raw WebSocket frame into a ClientMessage. Returns null for anything
 * malformed. Free-text fields are sanitised here so handlers can use them directly.
 */
export function parseClientMessage(data: string): ClientMessage | null {
  if (data.length > MAX_MESSAGE_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(msg) || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'hello': {
      if (!isInt(msg.v)) return null;
      const out: ClientMessage = { t: 'hello', v: msg.v, name: sanitizeName(msg.name) };
      if (msg.token !== undefined) {
        if (typeof msg.token !== 'string' || !TOKEN_RE.test(msg.token)) return null;
        out.token = msg.token;
      }
      return out;
    }
    case 'create_room': {
      if (msg.cfg !== undefined && !isObj(msg.cfg)) return null;
      return {
        t: 'create_room',
        name: sanitizeName(msg.name),
        avatar: sanitizeAvatar(msg.avatar),
        cfg: sanitizeRules(msg.cfg),
        botLevel: sanitizeBotLevel(msg.botLevel),
      };
    }
    case 'join_room': {
      const code = normaliseRoomCode(msg.code);
      if (!code) return null;
      return { t: 'join_room', code, name: sanitizeName(msg.name), avatar: sanitizeAvatar(msg.avatar) };
    }
    case 'set_avatar':
      return typeof msg.avatar === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(msg.avatar) ? { t: 'set_avatar', avatar: msg.avatar } : null;
    case 'add_bot':
      return { t: 'add_bot' };
    case 'remove_seat':
      return isInt(msg.seat) && msg.seat >= 0 && msg.seat < 8 ? { t: 'remove_seat', seat: msg.seat } : null;
    case 'start_game':
      return { t: 'start_game' };
    case 'restart_room':
      return { t: 'restart_room' };
    case 'action': {
      const action = parseAction(msg.action);
      return action ? { t: 'action', action } : null;
    }
    case 'emote':
      return typeof msg.id === 'string' && (EMOTES as readonly string[]).includes(msg.id) ? { t: 'emote', id: msg.id } : null;
    case 'leave_room':
      return { t: 'leave_room' };
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}
