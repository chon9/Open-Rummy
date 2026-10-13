/**
 * Steam host transport: the lobby OWNER is the authority. It runs the shared GameHost
 * locally (like LocalTransport) and plays the server's role for the other lobby members
 * over Steam P2P (docs/DESKTOP.md section 6):
 *
 * - room phase: guests say `hello` (+ `set_avatar`), get a seat, `welcome` and per-receiver
 *   `room` messages; the host's own UI gets the same RoomInfo through `onRoom`.
 * - game: seat 0 is the host, joiners follow in seat order, bots fill the rest. GameHost's
 *   per-seat fan-out sends each remote seat ONLY its own projected view (`game`).
 * - every guest payload is validated (size, JSON, envelope, fields), rate limited, and only
 *   `hello` / `set_avatar` / `action` / `emote` / `leave_room` / `ping` are honoured. An action
 *   always applies to the sender's own seat (derived from its Steam id).
 * - a guest that leaves (or goes silent / unreachable) frees its seat before the game and is
 *   replaced by a bot during it; everyone gets a `room` update and the host a notice.
 * - `restart()` after MATCH_END returns everyone to the lobby (same semantics as the
 *   server's `restart_room`); `leave()` tells the guests the table is closed.
 */
import {
  EMOTES,
  GameHost,
  PROTOCOL_VERSION,
  createMatch,
  cryptoSeed,
  resolveRules,
  type Action,
  type BotLevel,
  type GameEvent,
  type HostOptions,
  type PlayerView,
  type RoomInfo,
  type RulesConfig,
  type SeatInfo,
  type ServerMessage,
} from '@open-rummy/shared';
import {
  DESKTOP_LIMITS,
  LOBBY_KEYS,
  type LobbyEvent,
  type LobbyState,
  type OpenRummyDesktopBridge,
  type SteamIdString,
  type SteamSelf,
  type Unsubscribe,
} from '../desktopBridge';
import type { Transport, TransportHandlers } from '../transport';
import { AVATARS } from '../../avatars/catalog';
import { pick, t } from '../../i18n';
import { TokenBucket, isSteamId, parseGuestMessage, sanitizeAvatar, utf8Length, type SteamRoomExtras } from './validate';

export interface SteamHostOptions {
  bridge: OpenRummyDesktopBridge;
  self: SteamSelf;
  /** the lobby this player just created (and owns) */
  lobby: LobbyState;
  name: string;
  avatar: string;
  cfg: Partial<RulesConfig>;
  botLevel: BotLevel;
  /** relaxed mode: no human deadlines for anyone at the table */
  relaxed: boolean;
  /** tests: GameHost overrides (bot delay, timers, seeds) */
  hostOptions?: Pick<HostOptions, 'botDelayMs' | 'timers' | 'botSeed' | 'autoNextHand'>;
  /** match seed (tests); random by default */
  seed?: number;
  /** keepalive / silence detection (default true; tests may turn it off) */
  keepalive?: boolean;
}

export interface SteamHostEvents {
  /** Steam removed us from our own lobby (or Steam went away): the table is gone */
  onLobbyLost?(): void;
}

type Occupant =
  | { kind: 'host'; name: string; avatar: string }
  | { kind: 'guest'; steamId: SteamIdString; name: string; avatar: string; connected: boolean }
  | { kind: 'bot'; name: string; avatar: string };

interface PeerState {
  bucket: TokenBucket;
  lastSeen: number;
  lastEmote: number;
}

/** Seconds between two relayed emotes of one guest. */
const EMOTE_GAP_MS = 1000;
/** Max ms a single member may be "unknown" before its hello is rejected (member list refresh). */
const MEMBER_REFRESH_MS = 2000;

export class SteamHostTransport implements Transport {
  readonly kind = 'steam' as const;
  readonly isHost = true;
  /** diagnostics: payloads rejected by validation / authorisation (tests assert on it) */
  readonly stats = { rejected: 0, accepted: 0 };

  private handlers: TransportHandlers = { onGame: () => undefined };
  private extra: SteamHostEvents = {};
  private readonly bridge: OpenRummyDesktopBridge;
  private readonly lobbyId: SteamIdString;
  private readonly selfId: SteamIdString;
  private cfgPartial: Partial<RulesConfig>;
  private cfg: RulesConfig;
  private botLevel: BotLevel;
  private relaxed: boolean;
  private seats: (Occupant | null)[];
  private members = new Set<SteamIdString>();
  /**
   * Members whose seat went to a bot during the game while they are still in the lobby
   * (P2P failure / silence). They are told so (NOT_IN_ROOM) instead of getting pongs,
   * so their client leaves instead of waiting on a table that no longer talks to it.
   */
  private dropped = new Set<SteamIdString>();
  private peers = new Map<SteamIdString, PeerState>();
  private game: GameHost | null = null;
  private disposed = false;
  private unsubs: Unsubscribe[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastMemberRefresh = 0;

  constructor(private readonly opts: SteamHostOptions) {
    this.bridge = opts.bridge;
    this.lobbyId = opts.lobby.lobbyId;
    this.selfId = opts.self.steamId;
    this.cfgPartial = { ...opts.cfg };
    this.cfg = resolveRules(this.cfgPartial);
    this.botLevel = opts.botLevel;
    this.relaxed = opts.relaxed;
    this.seats = Array.from({ length: this.cfg.players }, () => null);
    this.seats[0] = { kind: 'host', name: opts.name, avatar: opts.avatar };
    for (const m of opts.lobby.members) if (m.steamId !== this.selfId) this.members.add(m.steamId);

    this.unsubs.push(this.bridge.steam.onMessage((from, data) => this.onPeerMessage(from, data)));
    this.unsubs.push(this.bridge.steam.onLobbyEvent((evt) => this.onLobbyEvent(evt)));
    if (opts.keepalive !== false) {
      this.keepaliveTimer = setInterval(() => this.checkSilence(), Math.max(1000, DESKTOP_LIMITS.keepaliveMs / 2));
    }
    void this.refreshMembers();
    void this.bridge.steam.setLobbyJoinable(true);
    this.publishLobbyData();
  }

  /** Relaxed mode hides every countdown (and the host never enforces human deadlines). */
  get timersEnabled(): boolean {
    return !this.relaxed;
  }

  get started(): boolean {
    return this.game !== null;
  }

  get lobby(): SteamIdString {
    return this.lobbyId;
  }

  get rules(): { cfg: Partial<RulesConfig>; botLevel: BotLevel; relaxed: boolean } {
    return { cfg: { ...this.cfgPartial }, botLevel: this.botLevel, relaxed: this.relaxed };
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  setEvents(e: SteamHostEvents): void {
    this.extra = e;
  }

  /** Current RoomInfo as the host sees it (seat 0). */
  room(): RoomInfo {
    return this.roomFor(0);
  }

  // ----- room management (host UI only) -----------------------------------------

  /** Change rules / bot level / relaxed mode before the game. False when it would not fit the players present. */
  configure(cfg: Partial<RulesConfig>, botLevel: BotLevel, relaxed: boolean): boolean {
    if (this.game || this.disposed) return false;
    const next = resolveRules(cfg);
    const humans = this.seats.filter((s): s is Occupant => s !== null);
    if (next.players < humans.length) return false;
    this.cfgPartial = { ...cfg };
    this.cfg = next;
    this.botLevel = botLevel;
    this.relaxed = relaxed;
    this.seats = Array.from({ length: next.players }, (_, i) => humans[i] ?? null);
    this.broadcastRoom();
    this.publishLobbyData();
    return true;
  }

  /** The host's own character (room phase only). */
  setAvatar(avatar: string): void {
    const host = this.seats[0];
    if (this.game || !host) return;
    host.avatar = sanitizeAvatar(avatar, host.avatar);
    this.broadcastRoom();
  }

  /** Start the match: seats compacted (host 0, joiners in order), bots fill the rest. */
  start(): void {
    if (this.game || this.disposed) return;
    const humans = this.seats.filter((s): s is Occupant => s !== null && s.kind !== 'bot');
    const used = new Set(humans.map((h) => h.avatar));
    const pool = AVATARS.filter((a) => !used.has(a.id));
    const seats: Occupant[] = [...humans];
    for (let i = 0; seats.length < this.cfg.players; i++) {
      const def = (pool.length ? pool : AVATARS)[i % Math.max(1, (pool.length ? pool : AVATARS).length)];
      seats.push({ kind: 'bot', name: def ? pick(def.nameZh, def.nameEn) : `${t('common.bot')} ${seats.length}`, avatar: def?.id ?? 'mei' });
    }
    this.seats = seats;
    const state = createMatch({
      players: seats.map((s) => ({ name: s.name, isBot: s.kind === 'bot', avatar: s.avatar })),
      cfg: this.cfg,
      seed: this.opts.seed ?? cryptoSeed(),
    });
    const host = new GameHost(
      state,
      { onUpdate: (seat, view, events) => this.fanOut(seat, view, events) },
      {
        botLevel: this.botLevel,
        noTimers: this.relaxed,
        autoNextHand: this.opts.hostOptions?.autoNextHand ?? true,
        botSeed: this.opts.hostOptions?.botSeed ?? cryptoSeed(),
        botDelayMs: this.opts.hostOptions?.botDelayMs,
        timers: this.opts.hostOptions?.timers,
      },
    );
    this.game = host;
    void this.bridge.steam.setLobbyJoinable(false);
    this.broadcastRoom();
    this.publishLobbyData();
    host.start();
  }

  /** Host only, after MATCH_END: back to the lobby with the same members (rematch). */
  restart(): boolean {
    const g = this.game;
    if (!g || this.disposed || g.state.phase !== 'MATCH_END') return false;
    g.dispose();
    this.game = null;
    this.dropped.clear();
    const humans = this.seats.filter((s): s is Occupant => s !== null && (s.kind === 'host' || (s.kind === 'guest' && this.members.has(s.steamId))));
    this.seats = Array.from({ length: this.cfg.players }, (_, i) => humans[i] ?? null);
    void this.bridge.steam.setLobbyJoinable(true);
    this.broadcastRoom();
    this.publishLobbyData();
    return true;
  }

  /** Close the table for everyone and leave the Steam lobby. */
  leave(): void {
    if (this.disposed) return;
    const bye = JSON.stringify({ t: 'left' } satisfies ServerMessage);
    const done = (): void => {
      void this.bridge.steam.leaveLobby();
    };
    this.bridge.steam.broadcast(bye).then(done, done);
    this.dispose();
  }

  // ----- Transport ------------------------------------------------------------------

  send(action: Action): void {
    if (!this.game) return;
    const res = this.game.submit(0, action);
    if (!res.ok) this.handlers.onError?.(t('err.illegal', { msg: res.error }));
  }

  emote(id: string): void {
    if (!(EMOTES as readonly string[]).includes(id)) return;
    this.handlers.onEmote?.(0, id);
    this.sendToGuests({ t: 'emote', seat: 0, id });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    try {
      this.game?.dispose();
    } catch {
      // already torn down
    }
    this.game = null;
  }

  // ----- fan-out ----------------------------------------------------------------------

  private fanOut(seat: number, view: PlayerView, events: GameEvent[]): void {
    const occ = this.seats[seat];
    if (!occ || this.disposed) return;
    if (occ.kind === 'host') {
      // asynchronously, so UI handlers never re-enter the GameHost mid-update
      queueMicrotask(() => {
        if (!this.disposed) this.handlers.onGame(view, events);
      });
      return;
    }
    if (occ.kind !== 'guest' || !occ.connected) return;
    let payload = JSON.stringify({ t: 'game', view, events, serverNow: Date.now() } satisfies ServerMessage);
    if (utf8Length(payload) > DESKTOP_LIMITS.maxP2PMessageBytes) {
      // the view alone always fits; the client reconciles from it without the animations
      payload = JSON.stringify({ t: 'game', view, events: [], serverNow: Date.now() } satisfies ServerMessage);
    }
    this.sendRaw(occ.steamId, payload);
  }

  private sendRaw(to: SteamIdString, payload: string): void {
    this.bridge.steam.sendTo(to, payload).then(
      (r) => {
        if (!r.ok) console.warn(`[steam-host] send to ${to} failed: ${r.reason}`);
      },
      (err) => console.warn('[steam-host] send failed', err),
    );
  }

  private sendTo(to: SteamIdString, msg: ServerMessage & SteamRoomExtras): void {
    this.sendRaw(to, JSON.stringify(msg));
  }

  private sendToGuests(msg: ServerMessage, except?: SteamIdString): void {
    for (const s of this.seats) if (s?.kind === 'guest' && s.connected && s.steamId !== except) this.sendTo(s.steamId, msg);
  }

  private roomFor(you: number): RoomInfo {
    const seats: (SeatInfo | null)[] = this.seats.map((o, seat) =>
      o
        ? {
            seat,
            name: o.name,
            isBot: o.kind === 'bot',
            avatar: o.avatar,
            connected: o.kind === 'guest' ? o.connected : true,
            host: o.kind === 'host',
          }
        : null,
    );
    return { code: this.lobbyId, seats, started: this.game !== null, cfg: this.cfg, botLevel: this.botLevel, you };
  }

  private broadcastRoom(): void {
    if (this.disposed) return;
    this.seats.forEach((o, seat) => {
      if (o?.kind === 'guest' && o.connected) this.sendTo(o.steamId, { t: 'room', room: this.roomFor(seat), relaxed: this.relaxed });
    });
    const room = this.roomFor(0);
    queueMicrotask(() => {
      if (!this.disposed) this.handlers.onRoom?.(room);
    });
  }

  private publishLobbyData(): void {
    if (this.disposed) return;
    const taken = this.seats.filter((s) => s !== null).length;
    void this.bridge.steam
      .setLobbyDataMany({
        [LOBBY_KEYS.hostName]: this.opts.self.name.slice(0, 64) || this.opts.name,
        [LOBBY_KEYS.seats]: `${taken}/${this.cfg.players}`,
        [LOBBY_KEYS.started]: this.game ? '1' : '0',
        [LOBBY_KEYS.rules]: JSON.stringify(this.cfg),
        [LOBBY_KEYS.botLevel]: this.botLevel,
      })
      .catch((err) => console.warn('[steam-host] lobby data update failed', err));
  }

  // ----- inbound ------------------------------------------------------------------------

  private seatOf(steamId: SteamIdString): number {
    return this.seats.findIndex((s) => s?.kind === 'guest' && s.steamId === steamId);
  }

  private reject(from: SteamIdString, why: string): void {
    this.stats.rejected++;
    console.warn(`[steam-host] rejected message from ${from}: ${why}`);
  }

  private peer(from: SteamIdString): PeerState {
    let p = this.peers.get(from);
    if (!p) {
      p = { bucket: new TokenBucket(), lastSeen: Date.now(), lastEmote: 0 };
      this.peers.set(from, p);
    }
    return p;
  }

  private onPeerMessage(from: SteamIdString, data: string): void {
    if (this.disposed) return;
    if (!isSteamId(from) || from === this.selfId) return this.reject(String(from), 'bad sender');
    if (!this.members.has(from)) {
      // the member-joined event may still be in flight: refresh once, then decide
      if (Date.now() - this.lastMemberRefresh > MEMBER_REFRESH_MS) {
        void this.refreshMembers().then(() => {
          if (this.members.has(from)) this.onPeerMessage(from, data);
          else this.reject(from, 'not a lobby member');
        });
        return;
      }
      return this.reject(from, 'not a lobby member');
    }
    const peer = this.peer(from);
    if (!peer.bucket.take()) return this.reject(from, 'rate limit');
    const msg = parseGuestMessage(data);
    if (!msg) return this.reject(from, 'malformed');
    peer.lastSeen = Date.now();
    const seat = this.seatOf(from);
    switch (msg.t) {
      case 'hello':
        this.stats.accepted++;
        this.onHello(from, msg.v, msg.name);
        return;
      case 'ping':
        this.stats.accepted++;
        if (this.dropped.has(from)) this.sendSeatLost(from);
        else this.sendTo(from, { t: 'pong' });
        return;
      case 'set_avatar': {
        if (seat < 0) return this.reject(from, 'not seated');
        this.stats.accepted++;
        const occ = this.seats[seat];
        if (this.game || occ?.kind !== 'guest') return; // characters are fixed once the match runs
        occ.avatar = msg.avatar;
        this.broadcastRoom();
        return;
      }
      case 'action': {
        const occ = seat >= 0 ? this.seats[seat] : null;
        if (occ?.kind !== 'guest') {
          this.reject(from, 'action outside of a seat');
          if (this.dropped.has(from)) this.sendSeatLost(from);
          else this.sendTo(from, { t: 'error', code: 'NOT_IN_ROOM', message: 'Not seated' });
          return;
        }
        if (!this.game) {
          // seated, but between matches (e.g. a late action after the rematch): not fatal
          this.reject(from, 'action without a game');
          this.sendTo(from, { t: 'error', code: 'ILLEGAL', message: 'No game in progress' });
          return;
        }
        const res = this.game.submit(seat, msg.action);
        if (!res.ok) {
          this.reject(from, `illegal action: ${res.error}`);
          this.sendTo(from, { t: 'error', code: 'ILLEGAL', message: res.error });
          return;
        }
        this.stats.accepted++;
        return;
      }
      case 'emote': {
        if (seat < 0) return this.reject(from, 'not seated');
        const now = Date.now();
        if (now - peer.lastEmote < EMOTE_GAP_MS) return this.reject(from, 'emote rate limit');
        peer.lastEmote = now;
        this.stats.accepted++;
        this.handlers.onEmote?.(seat, msg.id);
        this.sendToGuests({ t: 'emote', seat, id: msg.id }, from);
        return;
      }
      case 'leave_room':
        this.stats.accepted++;
        this.guestGone(from, 'leave_room');
        return;
    }
  }

  private onHello(from: SteamIdString, v: number, name: string): void {
    if (v !== PROTOCOL_VERSION) {
      this.sendTo(from, { t: 'error', code: 'VERSION', message: `Protocol ${PROTOCOL_VERSION} required` });
      return;
    }
    const existing = this.seatOf(from);
    if (existing >= 0) {
      // repeated hello (retry, or the guest's client restarted its session): refresh the
      // name in the lobby, answer again and, mid-game, resend the seat's current view so
      // the guest is never left on a stale table
      const occ = this.seats[existing];
      if (occ?.kind === 'guest' && !this.game) occ.name = name;
      this.sendTo(from, { t: 'welcome', v: PROTOCOL_VERSION, token: '', resumed: this.game !== null });
      this.broadcastRoom();
      if (this.game) this.fanOut(existing, this.game.getView(existing), []);
      return;
    }
    if (this.game) {
      if (this.dropped.has(from)) {
        this.sendSeatLost(from);
        return;
      }
      this.sendTo(from, { t: 'error', code: 'ALREADY_STARTED', message: 'The game has already started' });
      return;
    }
    const free = this.seats.findIndex((s) => s === null);
    if (free < 0) {
      this.sendTo(from, { t: 'error', code: 'ROOM_FULL', message: 'The table is full' });
      return;
    }
    this.dropped.delete(from);
    const used = new Set(this.seats.map((s) => s?.avatar));
    const fallback = AVATARS.find((a) => !used.has(a.id))?.id ?? AVATARS[0]?.id ?? 'mei';
    this.seats[free] = { kind: 'guest', steamId: from, name, avatar: fallback, connected: true };
    this.peer(from).lastSeen = Date.now();
    this.sendTo(from, { t: 'welcome', v: PROTOCOL_VERSION, token: '', resumed: false });
    this.broadcastRoom();
    this.publishLobbyData();
  }

  private sendSeatLost(to: SteamIdString): void {
    this.sendTo(to, { t: 'error', code: 'NOT_IN_ROOM', message: 'Your seat was taken over by a bot' });
  }

  /** A guest left (said so / left the lobby), or the host lost contact with it (P2P failure / silence). */
  private guestGone(steamId: SteamIdString, why: 'leave_room' | 'member-left' | 'p2p-failed' | 'silent'): void {
    const seat = this.seatOf(steamId);
    this.peers.delete(steamId);
    if (seat < 0) return;
    const occ = this.seats[seat];
    if (occ?.kind !== 'guest') return;
    console.info(`[steam-host] seat ${seat}: guest gone (${why})${this.game ? ', a bot takes over' : ''}`);
    if (!this.game) {
      this.seats[seat] = null;
      this.handlers.onNotice?.(t('steam.memberLeft', { name: occ.name }));
    } else {
      const botName = `${occ.name} (${t('common.bot')})`;
      this.seats[seat] = { kind: 'bot', name: botName, avatar: occ.avatar };
      this.game.replaceWithBot(seat, botName);
      this.handlers.onNotice?.(t('steam.replacedByBot', { name: occ.name }));
      if (this.members.has(steamId) && (why === 'p2p-failed' || why === 'silent')) {
        // still in the lobby (P2P failure / silence): tell it, in case it can still hear us
        this.dropped.add(steamId);
        this.sendSeatLost(steamId);
      }
    }
    this.broadcastRoom();
    this.publishLobbyData();
  }

  private onLobbyEvent(evt: LobbyEvent): void {
    if (this.disposed) return;
    switch (evt.type) {
      case 'member-joined':
        if (evt.lobbyId === this.lobbyId && evt.steamId !== this.selfId) this.members.add(evt.steamId);
        return;
      case 'member-left':
        if (evt.lobbyId !== this.lobbyId) return;
        this.members.delete(evt.steamId);
        this.dropped.delete(evt.steamId);
        this.guestGone(evt.steamId, 'member-left');
        return;
      case 'p2p-failed':
        this.guestGone(evt.steamId, 'p2p-failed');
        return;
      case 'lobby-left':
        if (evt.lobbyId !== this.lobbyId) return;
        this.dispose();
        this.extra.onLobbyLost?.();
        return;
      default:
        return;
    }
  }

  private async refreshMembers(): Promise<void> {
    this.lastMemberRefresh = Date.now();
    try {
      const list = await this.bridge.steam.lobbyMembers();
      for (const m of list) if (m.steamId !== this.selfId) this.members.add(m.steamId);
    } catch (err) {
      console.warn('[steam-host] member refresh failed', err);
    }
  }

  private checkSilence(): void {
    if (this.disposed) return;
    const now = Date.now();
    for (const s of this.seats) {
      if (s?.kind !== 'guest') continue;
      const last = this.peers.get(s.steamId)?.lastSeen ?? now;
      if (now - last > DESKTOP_LIMITS.peerTimeoutMs) this.guestGone(s.steamId, 'silent');
    }
  }
}
