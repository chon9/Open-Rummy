/**
 * Offline transport: runs a GameHost in the browser with you (seat 0) + bots.
 * Bots also emote now and then so the table feels alive.
 */
import {
  EMOTES,
  GameHost,
  createMatch,
  cryptoSeed,
  resolveRules,
  type Action,
  type BotLevel,
  type EmoteId,
  type GameEvent,
  type PlayerView,
  type RulesConfig,
} from '@open-rummy/shared';
import type { Transport, TransportHandlers } from './transport';
import { AVATARS } from '../avatars/catalog';
import { pick, t } from '../i18n';

export interface LocalOptions {
  name: string;
  avatar: string;
  cfg: Partial<RulesConfig>;
  botLevel: BotLevel;
  /** relaxed mode: no human deadlines */
  noTimers: boolean;
  /** start next hand automatically after cfg.handEndDelayMs; otherwise the UI calls advance() */
  autoNextHand: boolean;
}

/** The human is always seat 0 offline. */
const YOU = 0;

/** How a bot may answer an emote from the player. */
const EMOTE_REPLIES: Record<EmoteId, EmoteId[]> = {
  wave: ['wave', 'cheer'],
  laugh: ['laugh', 'think'],
  cheer: ['cheer', 'huat', 'wave'],
  cry: ['laugh', 'think', 'cheer'],
  angry: ['think', 'laugh', 'cry'],
  think: ['think', 'wave'],
  gg: ['gg', 'wave'],
  huat: ['huat', 'cheer', 'angry'],
};

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  private host: GameHost | null = null;
  private handlers: TransportHandlers = { onGame: () => undefined };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private botSeats: number[] = [];
  /** last time each bot emoted, to keep them from spamming */
  private lastEmote = new Map<number, number>();

  constructor(private readonly opts: LocalOptions) {}

  /** Relaxed mode (noTimers): the host never enforces human deadlines, so show none. */
  get timersEnabled(): boolean {
    return !this.opts.noTimers;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  /** Create the match and deal the first hand. Call after setHandlers(). */
  start(): void {
    if (this.host || this.disposed) return;
    const cfg = resolveRules(this.opts.cfg);
    const others = AVATARS.filter((a) => a.id !== this.opts.avatar);
    const pool = others.length ? others : AVATARS;
    const players = [{ name: this.opts.name || t('lobby.defaultName'), isBot: false, avatar: this.opts.avatar }];
    for (let i = 1; i < cfg.players; i++) {
      const def = pool[(i - 1) % Math.max(1, pool.length)];
      const name = def ? pick(def.nameZh, def.nameEn) : `${t('common.bot')} ${i}`;
      players.push({ name, isBot: true, avatar: def?.id ?? this.opts.avatar });
      this.botSeats.push(i);
    }
    const state = createMatch({ players, cfg: this.opts.cfg, seed: cryptoSeed() });
    this.host = new GameHost(
      state,
      {
        onUpdate: (seat, view, events) => {
          if (seat === YOU) this.deliver(view, events);
        },
      },
      {
        botLevel: this.opts.botLevel,
        noTimers: this.opts.noTimers,
        autoNextHand: this.opts.autoNextHand,
        botSeed: cryptoSeed(),
      },
    );
    this.host.start();
  }

  /** Deliver asynchronously so UI handlers never re-enter the host mid-update. */
  private deliver(view: PlayerView, events: GameEvent[]): void {
    queueMicrotask(() => {
      if (this.disposed) return;
      this.handlers.onGame(view, events);
      this.botBanter(events);
    });
  }

  send(action: Action): void {
    if (!this.host) return;
    let res: { ok: true } | { ok: false; error: string };
    try {
      res = this.host.submit(YOU, action);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) this.handlers.onError?.(t('err.illegal', { msg: res.error }));
  }

  emote(id: string): void {
    if (!(EMOTES as readonly string[]).includes(id)) return;
    this.handlers.onEmote?.(YOU, id);
    // sometimes a bot answers
    if (Math.random() < 0.55 && this.botSeats.length) {
      const seat = this.botSeats[Math.floor(Math.random() * this.botSeats.length)];
      const replies = EMOTE_REPLIES[id as EmoteId];
      this.botEmote(seat, replies[Math.floor(Math.random() * replies.length)], 700 + Math.random() * 1300);
    }
  }

  advance(): void {
    try {
      const phase = this.host?.state.phase;
      if (phase === 'HAND_END') this.host?.advance();
    } catch (err) {
      this.handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    try {
      this.host?.dispose();
    } catch {
      // host already torn down
    }
    this.host = null;
  }

  private botEmote(seat: number, id: EmoteId, delay: number): void {
    const now = Date.now();
    if (now - (this.lastEmote.get(seat) ?? 0) < 6000) return;
    this.lastEmote.set(seat, now);
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      if (!this.disposed) this.handlers.onEmote?.(seat, id);
    }, delay);
    this.timers.add(handle);
  }

  /** Bots react to big moments with an emote (purely cosmetic, local only). */
  private botBanter(events: GameEvent[]): void {
    const randomBot = (except?: number): number | null => {
      const seats = this.botSeats.filter((s) => s !== except);
      return seats.length ? seats[Math.floor(Math.random() * seats.length)] : null;
    };
    const choice = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
    for (const ev of events) {
      if (ev.type === 'GAME_PAI' || ev.type === 'INSTANT_WIN') {
        if (ev.seat === YOU) {
          const b = randomBot();
          if (b !== null && Math.random() < 0.7) this.botEmote(b, choice<EmoteId>(['cry', 'gg', 'angry']), 1400);
        } else if (Math.random() < 0.75) {
          this.botEmote(ev.seat, choice<EmoteId>(['huat', 'laugh', 'cheer']), 900);
        }
      } else if (ev.type === 'QUANCAN' && ev.seat === YOU) {
        const b = randomBot();
        if (b !== null && Math.random() < 0.35) this.botEmote(b, 'laugh', 1200);
      } else if (ev.type === 'QUANCAN' && ev.seat !== YOU && Math.random() < 0.4) {
        this.botEmote(ev.seat, 'cry', 1000);
      } else if (ev.type === 'MELD_CREATED' && ev.via === 'CUT' && ev.seat !== YOU && Math.random() < 0.2) {
        this.botEmote(ev.seat, 'laugh', 800);
      }
    }
  }
}
