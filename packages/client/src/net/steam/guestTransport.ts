/**
 * Steam guest transport: a lobby member that is not the owner. It talks to the owner
 * only (the authoritative GameHost runs there), like OnlineTransport talks to the server:
 *
 * - `hello` (+ `set_avatar`) to the owner, repeated until `welcome` arrives;
 * - accepts messages ONLY from the current lobby owner's Steam id, validated before use;
 * - `game.serverNow` feeds a ClockSync so countdowns are corrected for clock skew;
 * - the host leaving (`left`, owner-changed, the owner leaving / unreachable, or silence)
 *   ends the session once with `onHostLeft`; a refused hello (full, started, version)
 *   ends it with `onRejected`, as does NOT_IN_ROOM at any time (the host lost contact with
 *   us and gave our seat to a bot).
 */
import { EMOTES, PROTOCOL_VERSION, type Action, type ErrorCode, type PlayerView, type RoomInfo, type SeatInfo } from '@open-rummy/shared';
import {
  DESKTOP_LIMITS,
  type LobbyEvent,
  type LobbyState,
  type OpenRummyDesktopBridge,
  type SteamGuestMessage,
  type SteamIdString,
  type SteamSelf,
  type Unsubscribe,
} from '../desktopBridge';
import type { Transport, TransportHandlers } from '../transport';
import { ClockSync, errorText } from '../online';
import { t } from '../../i18n';
import { parseHostMessage } from './validate';

export type HostLeftReason = 'left' | 'owner-changed' | 'unreachable' | 'timeout' | 'lobby-lost';

export interface SteamGuestOptions {
  bridge: OpenRummyDesktopBridge;
  self: SteamSelf;
  /** the lobby just joined */
  lobby: LobbyState;
  name: string;
  avatar: string;
  /** keepalive pings + host silence detection (default true; tests may turn it off) */
  keepalive?: boolean;
  /** resend hello this often until welcome (ms, default 2000) */
  helloRetryMs?: number;
}

export interface SteamGuestEvents {
  onWelcome?(): void;
  /** the table is gone; called once, the transport is disposed and the Steam lobby left */
  onHostLeft?(reason: HostLeftReason): void;
  /** the host refused us (ROOM_FULL / ALREADY_STARTED / VERSION); lobby left */
  onRejected?(code: ErrorCode, message: string): void;
}

const REJECT_CODES: ErrorCode[] = ['ROOM_FULL', 'ALREADY_STARTED', 'VERSION', 'NO_ROOM'];
const MAX_HELLO_TRIES = 8;

export class SteamGuestTransport implements Transport {
  readonly kind = 'steam' as const;
  readonly isHost = false;
  /** diagnostics: payloads dropped (wrong sender, malformed) */
  readonly stats = { rejected: 0, accepted: 0 };

  private handlers: TransportHandlers = { onGame: () => undefined };
  private extra: SteamGuestEvents = {};
  private readonly bridge: OpenRummyDesktopBridge;
  private readonly lobbyId: SteamIdString;
  private readonly ownerId: SteamIdString;
  private readonly clock = new ClockSync();
  private unsubs: Unsubscribe[] = [];
  private welcomed = false;
  private ended = false;
  private you = -1;
  private relaxed = false;
  private room: RoomInfo | null = null;
  private lastHeard = Date.now();
  private helloTries = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SteamGuestOptions) {
    this.bridge = opts.bridge;
    this.lobbyId = opts.lobby.lobbyId;
    this.ownerId = opts.lobby.ownerId;
    this.unsubs.push(this.bridge.steam.onMessage((from, data) => this.onPeerMessage(from, data)));
    this.unsubs.push(this.bridge.steam.onLobbyEvent((evt) => this.onLobbyEvent(evt)));
    if (opts.keepalive !== false) {
      this.keepaliveTimer = setInterval(() => this.keepalive(), DESKTOP_LIMITS.keepaliveMs);
    }
    this.sayHello();
  }

  get timersEnabled(): boolean {
    return !this.relaxed;
  }

  get lobby(): SteamIdString {
    return this.lobbyId;
  }

  get owner(): SteamIdString {
    return this.ownerId;
  }

  /** our seat (-1 until the host seated us) */
  get seat(): number {
    return this.you;
  }

  get currentRoom(): RoomInfo | null {
    return this.room;
  }

  get active(): boolean {
    return !this.ended;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  setEvents(e: SteamGuestEvents): void {
    this.extra = e;
  }

  setAvatar(avatar: string): void {
    this.post({ t: 'set_avatar', avatar });
  }

  // ----- Transport ------------------------------------------------------------------

  send(action: Action): void {
    if (!this.welcomed) {
      this.handlers.onError?.(t('net.notConnected'));
      return;
    }
    this.post({ t: 'action', action });
  }

  emote(id: string): void {
    if (!(EMOTES as readonly string[]).includes(id)) return;
    if (this.you >= 0) this.handlers.onEmote?.(this.you, id);
    this.post({ t: 'emote', id });
  }

  /** Leave the table and the Steam lobby (the host gives our seat to a bot). */
  leave(): void {
    if (this.ended) return;
    const bye: SteamGuestMessage = { t: 'leave_room' };
    const done = (): void => {
      void this.bridge.steam.leaveLobby();
    };
    this.bridge.steam.sendTo(this.ownerId, JSON.stringify(bye)).then(done, done);
    this.ended = true;
    this.dispose();
  }

  dispose(): void {
    this.ended = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  // ----- internals ------------------------------------------------------------------

  private post(msg: SteamGuestMessage): void {
    if (this.ended) return;
    this.bridge.steam.sendTo(this.ownerId, JSON.stringify(msg)).then(
      (r) => {
        if (!r.ok) console.warn(`[steam-guest] send failed: ${r.reason}`);
      },
      (err) => console.warn('[steam-guest] send failed', err),
    );
  }

  private sayHello(): void {
    if (this.ended || this.welcomed) return;
    if (this.helloTries >= MAX_HELLO_TRIES) {
      this.hostLeft('timeout');
      return;
    }
    this.helloTries++;
    this.post({ t: 'hello', v: PROTOCOL_VERSION, name: this.opts.name });
    this.post({ t: 'set_avatar', avatar: this.opts.avatar });
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      this.sayHello();
    }, this.opts.helloRetryMs ?? 2000);
  }

  private keepalive(): void {
    if (this.ended) return;
    if (Date.now() - this.lastHeard > DESKTOP_LIMITS.peerTimeoutMs) {
      this.hostLeft('timeout');
      return;
    }
    if (this.welcomed) this.post({ t: 'ping' });
  }

  /** End the session because the table is gone. Idempotent. */
  private hostLeft(reason: HostLeftReason): void {
    if (this.ended) return;
    console.info(`[steam-guest] session over: host ${reason}`);
    this.ended = true;
    this.dispose();
    void this.bridge.steam.leaveLobby();
    this.extra.onHostLeft?.(reason);
  }

  private localizeDeadline(view: PlayerView): PlayerView {
    if (!view.deadline || !this.clock.synced) return view;
    return { ...view, deadline: this.clock.toLocal(view.deadline) };
  }

  private onPeerMessage(from: SteamIdString, data: string): void {
    if (this.ended) return;
    if (from !== this.ownerId) {
      this.stats.rejected++;
      console.warn(`[steam-guest] dropped a message from ${from}: only the lobby owner may talk to guests`);
      return;
    }
    const msg = parseHostMessage(data);
    if (!msg) {
      this.stats.rejected++;
      console.warn('[steam-guest] dropped a malformed message from the host');
      return;
    }
    this.stats.accepted++;
    this.lastHeard = Date.now();
    switch (msg.t) {
      case 'welcome':
        if (msg.v !== PROTOCOL_VERSION) {
          this.reject('VERSION', 'version mismatch');
          return;
        }
        if (!this.welcomed) {
          this.welcomed = true;
          if (this.helloTimer) clearTimeout(this.helloTimer);
          this.helloTimer = null;
          this.extra.onWelcome?.();
        }
        return;
      case 'room':
        this.relaxed = msg.relaxed === true;
        this.you = msg.room.you;
        this.noticeChanges(this.room, msg.room);
        this.room = msg.room;
        this.handlers.onRoom?.(msg.room);
        return;
      case 'game':
        this.you = msg.view.you;
        if (typeof msg.serverNow === 'number') this.clock.sample(msg.serverNow);
        this.handlers.onGame(this.localizeDeadline(msg.view), msg.events);
        return;
      case 'emote':
        if (msg.seat !== this.you) this.handlers.onEmote?.(msg.seat, msg.id);
        return;
      case 'left':
        this.hostLeft('left');
        return;
      case 'error':
        // NOT_IN_ROOM: the host gave our seat to a bot (it lost contact with us) - the session is over
        if (msg.code === 'NOT_IN_ROOM' || (!this.welcomed && REJECT_CODES.includes(msg.code))) {
          this.reject(msg.code, msg.message);
          return;
        }
        this.handlers.onError?.(errorText(msg.code, msg.message));
        return;
      case 'pong':
        return;
    }
  }

  private reject(code: ErrorCode, message: string): void {
    if (this.ended) return;
    console.info(`[steam-guest] session over: refused by the host (${code})`);
    this.ended = true;
    this.dispose();
    void this.bridge.steam.leaveLobby();
    this.extra.onRejected?.(code, message);
  }

  /** In-game seat takeovers become a notice (the table only shows names). */
  private noticeChanges(prev: RoomInfo | null, next: RoomInfo): void {
    if (!prev || !next.started) return;
    next.seats.forEach((s: SeatInfo | null, i) => {
      const before = prev.seats[i];
      if (s && before && i !== next.you && !before.isBot && s.isBot) this.handlers.onNotice?.(t('steam.replacedByBot', { name: before.name }));
    });
  }

  private onLobbyEvent(evt: LobbyEvent): void {
    if (this.ended) return;
    switch (evt.type) {
      case 'owner-changed':
        if (evt.lobbyId === this.lobbyId && evt.ownerId !== this.ownerId) this.hostLeft('owner-changed');
        return;
      case 'member-left':
        if (evt.lobbyId === this.lobbyId && evt.steamId === this.ownerId) this.hostLeft('left');
        return;
      case 'p2p-failed':
        if (evt.steamId === this.ownerId) this.hostLeft('unreachable');
        return;
      case 'lobby-left':
        if (evt.lobbyId === this.lobbyId) this.hostLeft('lobby-lost');
        return;
      default:
        return;
    }
  }
}
