/**
 * Common shape of the main-process Steam backends:
 * - SteamService (service.ts): the real Steam client through steamworks.js.
 * - MockSteamService (mock.ts): OPEN_RUMMY_STEAM=mock, a loopback relay on 127.0.0.1 so
 *   several Electron instances on one machine can test lobbies + P2P without Steam.
 *
 * main.ts only talks to `SteamBackend`; arguments reaching it were validated by main's IPC
 * handlers (channels.ts guards), but backends re-check what they depend on and never throw.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  CreateLobbyOptions,
  LobbyEvent,
  LobbyMember,
  LobbyState,
  LobbySummary,
  SteamAvailability,
  SteamFailure,
  SteamIdString,
  SteamResult,
  SteamSelf,
} from '../../../packages/client/src/net/desktopBridge';
import { LOBBY_KEYS } from '../../../packages/client/src/net/desktopBridge';
import { isSteamIdString } from '../channels';

export type PendingJoin = { lobbyId: SteamIdString; friendId?: SteamIdString };
export type MessageListener = (fromSteamId: SteamIdString, data: string) => void;
export type LobbyListener = (evt: LobbyEvent) => void;
export type Logger = (...args: unknown[]) => void;

export interface SteamBackend {
  readonly kind: 'steam' | 'mock';
  /** never rejects; the result is also what available() reports afterwards */
  init(): Promise<SteamAvailability>;
  available(): SteamAvailability;
  me(): SteamSelf | null;

  createLobby(opts: CreateLobbyOptions): Promise<SteamResult<LobbyState>>;
  joinLobby(lobbyId: SteamIdString): Promise<SteamResult<LobbyState>>;
  leaveLobby(): Promise<void>;
  currentLobby(): Promise<LobbyState | null>;
  lobbyMembers(): Promise<LobbyMember[]>;
  listLobbies(): Promise<SteamResult<LobbySummary[]>>;
  setLobbyData(key: string, value: string): Promise<SteamResult>;
  setLobbyDataMany(data: Record<string, string>): Promise<SteamResult>;
  getLobbyData(key: string): Promise<string | null>;
  setLobbyJoinable(joinable: boolean): Promise<SteamResult>;
  openInviteDialog(): Promise<SteamResult>;
  avatarDataUrl(steamId: SteamIdString): Promise<string | null>;
  sendTo(steamId: SteamIdString, data: string): Promise<SteamResult>;
  broadcast(data: string): Promise<SteamResult>;

  consumePendingJoin(): PendingJoin | null;
  /** `+connect_lobby <id>` (first launch argv or second-instance argv) */
  handleArgv(argv: readonly string[]): void;
  onLobbyEvent(cb: LobbyListener): () => void;
  onMessage(cb: MessageListener): () => void;
  /** leaves the lobby, stops timers; safe to call twice */
  dispose(): Promise<void>;
}

export const DEFAULT_APP_ID = 480; // Spacewar, Valve's public test app

/**
 * App id resolution: env OPEN_RUMMY_STEAM_APPID, then steam_appid.txt next to the
 * executable (packaged) / in desktop/ (dev) / in cwd, then 480.
 */
export function resolveAppId(appDir: string, exeDir: string): { appId: number; source: string } {
  const fromEnv = process.env.OPEN_RUMMY_STEAM_APPID?.trim();
  if (fromEnv && /^\d{1,10}$/.test(fromEnv) && Number(fromEnv) > 0) return { appId: Number(fromEnv), source: 'env' };
  for (const dir of [exeDir, appDir, process.cwd()]) {
    const file = path.join(dir, 'steam_appid.txt');
    try {
      const txt = fs.readFileSync(file, 'utf8').trim();
      if (/^\d{1,10}$/.test(txt) && Number(txt) > 0) return { appId: Number(txt), source: file };
    } catch {
      // not there, try the next location
    }
  }
  return { appId: DEFAULT_APP_ID, source: 'default' };
}

/** parses LOBBY_KEYS.seats ("taken/total") */
export function parseSeats(v: string | null | undefined): { taken: number | null; total: number | null } {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(v ?? '');
  return m ? { taken: Number(m[1]), total: Number(m[2]) } : { taken: null, total: null };
}

export function lobbySummaryFromData(lobbyId: SteamIdString, data: Record<string, string>): LobbySummary {
  const seats = parseSeats(data[LOBBY_KEYS.seats]);
  return {
    lobbyId,
    hostName: data[LOBBY_KEYS.hostName] ?? '',
    seatsTaken: seats.taken,
    seatsTotal: seats.total,
    started: data[LOBBY_KEYS.started] === '1',
    data: { ...data },
  };
}

export function fail(reason: SteamFailure, message?: string): { ok: false; reason: SteamFailure; message?: string } {
  return message === undefined ? { ok: false, reason } : { ok: false, reason, message };
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-peer token bucket for incoming P2P messages. */
export class PeerRateLimiter {
  private buckets = new Map<string, { tokens: number; at: number; dropped: number }>();
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {}

  /** true when the message may pass; `rate` overrides perSecond/burst for this peer (e.g. the host) */
  take(peer: string, now: number, rate?: { perSecond: number; burst: number }): boolean {
    const perSecond = rate?.perSecond ?? this.perSecond;
    const burst = rate?.burst ?? this.burst;
    let b = this.buckets.get(peer);
    if (!b) {
      b = { tokens: burst, at: now, dropped: 0 };
      this.buckets.set(peer, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    if (b.tokens < 1) {
      b.dropped++;
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  dropped(peer: string): number {
    return this.buckets.get(peer)?.dropped ?? 0;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** guests: 60 msg/s sustained, bursts of 120; the lobby owner (authoritative host) gets more headroom */
export const GUEST_RATE = { perSecond: 60, burst: 120 } as const;
export const OWNER_RATE = { perSecond: 400, burst: 800 } as const;

/** Listener plumbing, pending join requests, argv handling and incoming-message policing. */
export abstract class BaseSteamBackend {
  protected readonly lobbyListeners = new Set<LobbyListener>();
  protected readonly messageListeners = new Set<MessageListener>();
  protected readonly limiter = new PeerRateLimiter(GUEST_RATE.perSecond, GUEST_RATE.burst);
  private pendingJoin: PendingJoin | null = null;
  /** serialises create/join/leave so overlapping renderer calls cannot interleave */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(protected readonly log: Logger) {}

  onLobbyEvent(cb: LobbyListener): () => void {
    this.lobbyListeners.add(cb);
    return () => void this.lobbyListeners.delete(cb);
  }

  onMessage(cb: MessageListener): () => void {
    this.messageListeners.add(cb);
    return () => void this.messageListeners.delete(cb);
  }

  consumePendingJoin(): PendingJoin | null {
    const p = this.pendingJoin;
    this.pendingJoin = null;
    return p;
  }

  handleArgv(argv: readonly string[]): void {
    const i = argv.indexOf('+connect_lobby');
    const id = i >= 0 ? argv[i + 1] : undefined;
    if (isSteamIdString(id)) this.emitLobby({ type: 'join-requested', lobbyId: id });
  }

  protected emitLobby(evt: LobbyEvent): void {
    if (evt.type === 'join-requested') {
      this.pendingJoin = evt.friendId ? { lobbyId: evt.lobbyId, friendId: evt.friendId } : { lobbyId: evt.lobbyId };
    }
    if (evt.type === 'lobby-left' || evt.type === 'lobby-entered') this.limiter.clear();
    for (const cb of [...this.lobbyListeners]) {
      try {
        cb(evt);
      } catch (err) {
        this.log(`lobby listener failed: ${errMessage(err)}`);
      }
    }
  }

  /** rate-limits per peer then hands the payload to listeners (membership/size checked by the caller) */
  protected deliverMessage(from: SteamIdString, data: string, fromOwner: boolean): void {
    if (!this.limiter.take(from, Date.now(), fromOwner ? OWNER_RATE : GUEST_RATE)) {
      const n = this.limiter.dropped(from);
      if (n === 1 || n % 100 === 0) this.log(`p2p rate limit: dropped ${n} message(s) from a peer`);
      return;
    }
    for (const cb of [...this.messageListeners]) {
      try {
        cb(from, data);
      } catch (err) {
        this.log(`message listener failed: ${errMessage(err)}`);
      }
    }
  }

  protected serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.catch(() => undefined);
    return run;
  }
}
