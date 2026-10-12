/**
 * RoomManager: rooms with 6-character codes, seats, host controls, bots, one
 * GameHost per started room, per-seat fan-out and idle-room garbage collection.
 *
 * Seat ownership is tracked by session token, never by socket, so a dropped
 * connection can resume the same seat. All mutations end with a room broadcast
 * so every client sees an up-to-date RoomInfo (with its own `you`).
 */
import { randomInt } from 'node:crypto';
import {
  GameHost,
  createMatch,
  cryptoSeed,
  type Action,
  type BotLevel,
  type ErrorCode,
  type HostOptions,
  type RoomInfo,
  type RulesConfig,
  type SeatInfo,
  type ServerMessage,
  ROOM_CODE_LENGTH,
} from '@open-rummy/shared';
import { ROOM_CODE_ALPHABET, type Session, type SessionStore } from './session';

/** Malaysian-flavoured names for bots. */
export const BOT_NAMES = [
  'Ah Beng',
  'Mei Ling',
  'Uncle Lim',
  'Siti',
  'Ravi',
  'Aunty Rose',
  'Kok Wai',
  'Nurul',
  'Ah Seng',
  'Farah',
  'Muthu',
  'Jia Hui',
];

/**
 * Avatar ids bundled with the client (packages/client/src/avatars/catalog.ts).
 * Bots pick from these; human picks are only shape-checked since they are cosmetic.
 */
export const BOT_AVATARS = ['mei', 'kaya', 'pandan', 'lingling', 'rambutan'];

/** Minimum gap between emotes from one session. */
const EMOTE_INTERVAL_MS = 1000;

export interface RoomManagerOptions {
  maxRooms: number;
  /** live rooms one client address may have created at a time (default unlimited) */
  maxRoomsPerIp?: number;
  /** a room with no connected human for this long is closed (default 10 min) */
  idleRoomMs?: number;
  /** a finished match is closed this long after MATCH_END (default 10 min) */
  finishedRoomMs?: number;
  /** a human who drops in the lobby keeps the seat this long (default 15 s) */
  lobbyGraceMs?: number;
  /** extra GameHost options (tests shorten bot delays) */
  hostOptions?: Omit<HostOptions, 'botLevel'>;
}

/** Sends a message to a session if it has a socket. */
export type SendFn = (session: Session, msg: ServerMessage) => void;

interface SeatEntry {
  name: string;
  avatar: string;
  isBot: boolean;
  /** owning session token; null for bots */
  token: string | null;
  /** lobby: drop timer while a human is disconnected */
  dropTimer: ReturnType<typeof setTimeout> | null;
  /** a human who left mid-game and was replaced by a bot (freed on restart) */
  replaced?: boolean;
}

interface Room {
  code: string;
  cfg: RulesConfig;
  botLevel: BotLevel;
  seats: (SeatEntry | null)[];
  hostToken: string | null;
  game: GameHost | null;
  /** last time a human connected/disconnected/acted */
  lastHumanActivity: number;
  finishedAt: number | null;
  /** limit key of the creating client (per-IP room cap) */
  creatorIp: string;
}

export type Result = { ok: true } | { ok: false; code: ErrorCode; message: string };
const OK: Result = { ok: true };
const fail = (code: ErrorCode, message: string): Result => ({ ok: false, code, message });

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly idleRoomMs: number;
  private readonly finishedRoomMs: number;
  private readonly lobbyGraceMs: number;

  constructor(
    private readonly sessions: SessionStore,
    private readonly send: SendFn,
    private readonly opts: RoomManagerOptions,
  ) {
    this.idleRoomMs = opts.idleRoomMs ?? 10 * 60 * 1000;
    this.finishedRoomMs = opts.finishedRoomMs ?? 10 * 60 * 1000;
    this.lobbyGraceMs = opts.lobbyGraceMs ?? 15_000;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  // -------------------------------------------------------------------------
  // Lobby operations
  // -------------------------------------------------------------------------

  create(s: Session, name: string, avatar: string, cfg: RulesConfig, botLevel: BotLevel): Result {
    if (this.rooms.size >= this.opts.maxRooms) return fail('SERVER', 'Server is full, try again later');
    this.leave(s, false);
    const perIp = this.opts.maxRoomsPerIp;
    if (perIp !== undefined && s.ip && this.roomsCreatedBy(s.ip) >= perIp) {
      return fail('SERVER', 'Too many rooms from your network, close one first');
    }
    const code = this.newCode();
    if (!code) return fail('SERVER', 'Could not allocate a room code');
    s.name = name;
    const room: Room = {
      code,
      cfg,
      botLevel,
      seats: new Array<SeatEntry | null>(cfg.players).fill(null),
      hostToken: s.token,
      game: null,
      lastHumanActivity: Date.now(),
      finishedAt: null,
      creatorIp: s.ip,
    };
    room.seats[0] = { name, avatar, isBot: false, token: s.token, dropTimer: null };
    this.rooms.set(code, room);
    s.room = code;
    s.seat = 0;
    this.broadcastRoom(room);
    return OK;
  }

  join(s: Session, code: string, name: string, avatar: string): Result {
    const room = this.rooms.get(code);
    if (!room) return fail('NO_ROOM', 'Room not found');
    // Already seated here (e.g. a retried join): just resend the state.
    if (s.room === code && this.roomOf(s)) {
      this.resume(s);
      return OK;
    }
    if (room.game) return fail('ALREADY_STARTED', 'The game has already started');
    const seat = room.seats.findIndex((x) => x === null);
    if (seat < 0) return fail('ROOM_FULL', 'Room is full');
    this.leave(s, false);
    s.name = name;
    room.seats[seat] = { name, avatar, isBot: false, token: s.token, dropTimer: null };
    if (room.hostToken === null) room.hostToken = s.token;
    room.lastHumanActivity = Date.now();
    s.room = code;
    s.seat = seat;
    this.broadcastRoom(room);
    return OK;
  }

  setAvatar(s: Session, avatar: string): Result {
    const room = this.roomOf(s);
    if (!room) return fail('NOT_IN_ROOM', 'Not in a room');
    if (room.game) return fail('ALREADY_STARTED', 'The game has already started');
    const entry = room.seats[s.seat];
    if (entry) entry.avatar = avatar;
    this.broadcastRoom(room);
    return OK;
  }

  addBot(s: Session): Result {
    const room = this.hostRoom(s);
    if (!room.ok) return room;
    const r = room.room;
    const seat = r.seats.findIndex((x) => x === null);
    if (seat < 0) return fail('ROOM_FULL', 'Room is full');
    r.seats[seat] = this.makeBot(r);
    this.broadcastRoom(r);
    return OK;
  }

  removeSeat(s: Session, seat: number): Result {
    const room = this.hostRoom(s);
    if (!room.ok) return room;
    const r = room.room;
    if (seat < 0 || seat >= r.seats.length) return fail('BAD_MESSAGE', 'No such seat');
    if (seat === s.seat) return fail('BAD_MESSAGE', 'Use leave_room to leave');
    const entry = r.seats[seat];
    if (!entry) return OK;
    if (entry.token) {
      // Kicking a human: they get `left` and lose the seat.
      const other = this.sessions.get(entry.token);
      if (other) {
        other.room = null;
        other.seat = -1;
        this.send(other, { t: 'left' });
      }
    }
    this.clearSeat(r, seat);
    this.broadcastRoom(r);
    return OK;
  }

  start(s: Session): Result {
    const room = this.hostRoom(s);
    if (!room.ok) return room;
    const r = room.room;
    for (let i = 0; i < r.seats.length; i++) if (!r.seats[i]) r.seats[i] = this.makeBot(r);
    const seats = r.seats as SeatEntry[];
    for (const e of seats) {
      if (e.dropTimer) clearTimeout(e.dropTimer);
      e.dropTimer = null;
    }
    const state = createMatch({
      players: seats.map((e) => ({ name: e.name, isBot: e.isBot, avatar: e.avatar })),
      cfg: r.cfg,
      seed: cryptoSeed(),
    });
    // Humans who are momentarily disconnected start under autoplay.
    seats.forEach((e, i) => {
      if (e.token && !this.sessions.get(e.token)?.connected) state.players[i].connected = false;
    });
    const game = new GameHost(
      state,
      {
        onUpdate: (seat, view, events) => {
          const token = r.seats[seat]?.token;
          const target = token ? this.sessions.get(token) : undefined;
          if (target && target.room === r.code) this.send(target, { t: 'game', view, events, serverNow: Date.now() });
        },
        onMatchEnd: () => {
          r.finishedAt = Date.now();
        },
      },
      { ...this.opts.hostOptions, botLevel: r.botLevel },
    );
    r.game = game;
    // Room first (started: true), then the first game views from start().
    this.broadcastRoom(r);
    game.start();
    return OK;
  }

  /**
   * Host only, once the match has reached MATCH_END: dispose the GameHost and
   * return the same room (same code) to its lobby. Connected humans and bots
   * keep their seats; disconnected humans and humans who left mid-game (now
   * bots) are freed so the host can refill those seats.
   */
  restart(s: Session): Result {
    const r = this.roomOf(s);
    if (!r) return fail('NOT_IN_ROOM', 'Not in a room');
    if (r.hostToken !== s.token) return fail('NOT_HOST', 'Only the room host can do that');
    if (!r.game) return fail('ILLEGAL', 'The game has not started');
    if (r.game.state.phase !== 'MATCH_END') return fail('ALREADY_STARTED', 'The match is still in progress');
    r.game.dispose();
    r.game = null;
    r.finishedAt = null;
    r.lastHumanActivity = Date.now();
    for (let i = 0; i < r.seats.length; i++) {
      const e = r.seats[i];
      if (!e) continue;
      if (e.dropTimer) clearTimeout(e.dropTimer);
      e.dropTimer = null;
      if (e.replaced) {
        r.seats[i] = null;
        continue;
      }
      if (!e.token) continue;
      const other = this.sessions.get(e.token);
      if (other?.connected) continue;
      // Disconnected human: free the seat; a later resume finds no room.
      if (other && other.room === r.code) {
        other.room = null;
        other.seat = -1;
      }
      this.clearSeat(r, i);
    }
    this.broadcastRoom(r);
    return OK;
  }

  action(s: Session, action: Action): Result {
    const room = this.roomOf(s);
    if (!room) return fail('NOT_IN_ROOM', 'Not in a room');
    if (!room.game) return fail('ILLEGAL', 'The game has not started');
    room.lastHumanActivity = Date.now();
    const res = room.game.submit(s.seat, action);
    return res.ok ? OK : fail('ILLEGAL', res.error);
  }

  emote(s: Session, id: string): Result {
    const room = this.roomOf(s);
    if (!room) return fail('NOT_IN_ROOM', 'Not in a room');
    const now = Date.now();
    // Silently drop emote spam; it is cosmetic.
    if (now - s.lastEmote < EMOTE_INTERVAL_MS) return OK;
    s.lastEmote = now;
    for (const t of this.humanSessions(room)) this.send(t, { t: 'emote', seat: s.seat, id });
    return OK;
  }

  /**
   * Leave the current room. In the lobby the seat is freed; in a started game a
   * bot takes over permanently. `notify` sends `left` to the leaving session.
   */
  leave(s: Session, notify: boolean): Result {
    const room = this.roomOf(s);
    if (!room) {
      s.room = null;
      s.seat = -1;
      if (notify) this.send(s, { t: 'left' });
      return OK;
    }
    const seat = s.seat;
    s.room = null;
    s.seat = -1;
    if (room.game) {
      const entry = room.seats[seat];
      if (entry) {
        entry.token = null;
        entry.isBot = true;
        entry.replaced = true;
      }
      room.game.replaceWithBot(seat);
    } else {
      this.clearSeat(room, seat);
    }
    if (room.hostToken === s.token) room.hostToken = this.firstHumanToken(room);
    if (notify) this.send(s, { t: 'left' });
    if (this.firstHumanToken(room) === null) this.dispose(room);
    else this.broadcastRoom(room);
    return OK;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /** The session's socket closed. */
  disconnected(s: Session): void {
    const room = this.roomOf(s);
    if (!room) return;
    room.lastHumanActivity = Date.now();
    if (room.game) {
      room.game.setConnected(s.seat, false);
      this.broadcastRoom(room);
      return;
    }
    // Lobby: keep the seat briefly so a page refresh does not lose it.
    const entry = room.seats[s.seat];
    if (!entry) return;
    if (entry.dropTimer) clearTimeout(entry.dropTimer);
    entry.dropTimer = setTimeout(() => {
      entry.dropTimer = null;
      if (!s.connected && s.room === room.code && !room.game) this.leave(s, false);
    }, this.lobbyGraceMs);
    entry.dropTimer.unref?.();
    this.broadcastRoom(room);
  }

  /** The session (re)attached a socket: restore its seat and resend state. */
  resume(s: Session): void {
    const room = this.roomOf(s);
    if (!room) {
      s.room = null;
      s.seat = -1;
      return;
    }
    room.lastHumanActivity = Date.now();
    const entry = room.seats[s.seat];
    if (entry?.dropTimer) {
      clearTimeout(entry.dropTimer);
      entry.dropTimer = null;
    }
    if (room.game) {
      // Room first so the client routes to the table, then the game view.
      this.broadcastRoom(room, s.seat);
      const wasConnected = room.game.state.players[s.seat]?.connected;
      // setConnected pushes a fresh view to every seat (including this one).
      room.game.setConnected(s.seat, true);
      if (wasConnected) this.send(s, { t: 'game', view: room.game.getView(s.seat), events: [], serverNow: Date.now() });
      return;
    }
    this.broadcastRoom(room);
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /** Close idle and finished rooms. Called periodically. */
  sweep(now = Date.now()): void {
    for (const room of [...this.rooms.values()]) {
      const humans = this.humanTokens(room);
      const anyConnected = humans.some((t) => this.sessions.get(t)?.connected);
      if (humans.length === 0) this.dispose(room);
      else if (!anyConnected && now - room.lastHumanActivity > this.idleRoomMs) this.dispose(room);
      else if (room.finishedAt !== null && now - room.finishedAt > this.finishedRoomMs) this.dispose(room);
    }
  }

  disposeAll(): void {
    for (const room of [...this.rooms.values()]) this.dispose(room);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private dispose(room: Room): void {
    room.game?.dispose();
    room.game = null;
    for (const e of room.seats) if (e?.dropTimer) clearTimeout(e.dropTimer);
    for (const s of this.humanSessions(room)) {
      if (s.room !== room.code) continue;
      s.room = null;
      s.seat = -1;
      this.send(s, { t: 'left' });
    }
    this.rooms.delete(room.code);
  }

  private roomsCreatedBy(ip: string): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.creatorIp === ip) n++;
    return n;
  }

  private roomOf(s: Session): Room | null {
    if (s.room === null) return null;
    const room = this.rooms.get(s.room);
    if (!room || room.seats[s.seat]?.token !== s.token) return null;
    return room;
  }

  private hostRoom(s: Session): { ok: true; room: Room } | { ok: false; code: ErrorCode; message: string } {
    const room = this.roomOf(s);
    if (!room) return { ok: false, code: 'NOT_IN_ROOM', message: 'Not in a room' };
    if (room.hostToken !== s.token) return { ok: false, code: 'NOT_HOST', message: 'Only the room host can do that' };
    if (room.game) return { ok: false, code: 'ALREADY_STARTED', message: 'The game has already started' };
    return { ok: true, room };
  }

  private clearSeat(room: Room, seat: number): void {
    const e = room.seats[seat];
    if (e?.dropTimer) clearTimeout(e.dropTimer);
    room.seats[seat] = null;
    if (e?.token && room.hostToken === e.token) room.hostToken = this.firstHumanToken(room);
  }

  private humanTokens(room: Room): string[] {
    return room.seats.flatMap((e) => (e?.token ? [e.token] : []));
  }

  private firstHumanToken(room: Room): string | null {
    return this.humanTokens(room)[0] ?? null;
  }

  private humanSessions(room: Room): Session[] {
    return this.humanTokens(room).flatMap((t) => {
      const s = this.sessions.get(t);
      return s ? [s] : [];
    });
  }

  private makeBot(room: Room): SeatEntry {
    const used = new Set(room.seats.map((e) => e?.name));
    const usedAvatars = new Set(room.seats.map((e) => e?.avatar));
    const freeNames = BOT_NAMES.filter((n) => !used.has(n));
    const name = freeNames.length > 0 ? freeNames[randomInt(freeNames.length)] : `Bot ${randomInt(100, 1000)}`;
    const freeAvatars = BOT_AVATARS.filter((a) => !usedAvatars.has(a));
    const pool = freeAvatars.length > 0 ? freeAvatars : BOT_AVATARS;
    return { name, avatar: pool[randomInt(pool.length)], isBot: true, token: null, dropTimer: null };
  }

  private newCode(): string | null {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /** `resumingSeat` is reported as connected before the host has been told. */
  private seatInfos(room: Room, resumingSeat = -1): (SeatInfo | null)[] {
    const players = room.game?.state.players;
    return room.seats.map((e, seat) => {
      if (!e) return null;
      const p = players?.[seat];
      const session = e.token ? this.sessions.get(e.token) : undefined;
      return {
        seat,
        name: p?.name ?? e.name,
        isBot: p ? p.isBot : e.isBot,
        avatar: p?.avatar ?? e.avatar,
        connected: e.isBot || seat === resumingSeat ? true : p ? p.connected : session?.connected === true,
        host: e.token !== null && e.token === room.hostToken,
      };
    });
  }

  private broadcastRoom(room: Room, resumingSeat = -1): void {
    const seats = this.seatInfos(room, resumingSeat);
    for (const s of this.humanSessions(room)) {
      if (s.room !== room.code) continue;
      const info: RoomInfo = {
        code: room.code,
        seats,
        started: room.game !== null,
        cfg: room.cfg,
        botLevel: room.botLevel,
        you: s.seat,
      };
      this.send(s, { t: 'room', room: info });
    }
  }
}
