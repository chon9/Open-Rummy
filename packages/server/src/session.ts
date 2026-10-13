/**
 * Sessions plus the inbound message validation used by the server.
 *
 * - A session is identified by a random token handed out in `welcome`. It
 *   survives socket drops so a client can resume its seat with `hello{token}`.
 * - Every inbound message is parsed defensively by `parseClientMessage` from
 *   @open-rummy/shared (size limit, JSON try/catch, strict shape checks, string
 *   length limits). The same validator guards the desktop build's Steam P2P host.
 *   Nothing from the wire is trusted; the engine then validates game semantics.
 */
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';

// Validation lives in packages/shared/src/validate.ts; re-exported for the server's modules and tests.
export {
  MAX_MESSAGE_BYTES,
  ROOM_CODE_ALPHABET,
  TokenBucket,
  normaliseRoomCode,
  parseAction,
  parseClientMessage,
  sanitizeAvatar,
  sanitizeBotLevel,
  sanitizeName,
  sanitizeRules,
} from '@open-rummy/shared';

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
