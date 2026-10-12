/**
 * GameHost: drives a match in real time. Used both by the server (one per room)
 * and by the client for offline play vs bots. Owns the GameState, timers, bot turns,
 * auto-advance between hands, and fan-out of projected views/events per seat.
 *
 * Design notes
 *  - Every state change goes through `commit()`, which swaps in the new state,
 *    queues one projected update per seat and reschedules all timers.
 *  - Updates are delivered from a FIFO outbox. If a callback calls back into the
 *    host (e.g. a local transport submitting from inside onUpdate) the new state
 *    is applied immediately but its updates are queued behind the ones being
 *    delivered, so clients always observe versions in order and the stack never
 *    grows recursively.
 *  - Bots never act synchronously: they always run from a timer (even a 0 ms one),
 *    so a table of bots cannot recurse into itself.
 *  - Timer callbacks re-check the state when they fire and ignore themselves when
 *    stale (the state moved on, or the host was disposed).
 *  - Public methods never throw on bad input; engine errors are reported as ok:false.
 */
import { botThinkDelay, chooseBotAction, type BotLevel } from './bot';
import { applyAction, applyTimeout, nextHand, pendingSeats, projectEvents, projectView, startHand } from './engine';
import { Rng, cryptoSeed } from './rng';
import type { Action, EngineResult, GameEvent, GameState, PlayerView } from './types';

export interface TimerApi {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HostCallbacks {
  /** called for every seat after each change, with that seat's projected view and events */
  onUpdate(seat: number, view: PlayerView, events: GameEvent[]): void;
  /** optional: called when the match reaches MATCH_END */
  onMatchEnd?(state: GameState): void;
}

export interface HostOptions {
  botLevel?: BotLevel;
  /** bot thinking delay range override [min,max] ms (tests use [0,0]) */
  botDelayMs?: [number, number];
  timers?: TimerApi;
  /** automatically start next hand after cfg.handEndDelayMs (default true) */
  autoNextHand?: boolean;
  /** disable human deadlines (offline relaxed mode) */
  noTimers?: boolean;
  /** seed for bot randomness */
  botSeed?: number;
}

/** Default timers backed by the global (browser or Node) clock. */
const realTimers: TimerApi = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

type SubmitResult = { ok: true } | { ok: false; error: string };

interface PendingUpdate {
  seat: number;
  view: PlayerView;
  events: GameEvent[];
}

interface BotTimer {
  handle: unknown;
  /** identifies the decision the timer was scheduled for (see decisionKey) */
  key: string;
}

/** Suffix appended to a player's name when a bot permanently takes the seat. */
const BOT_SUFFIX = ' (Bot)';

export class GameHost {
  private st: GameState;
  private readonly cb: HostCallbacks;
  private readonly timers: TimerApi;
  private readonly botLevel: BotLevel;
  private readonly botDelay: [number, number] | null;
  private readonly autoNext: boolean;
  private readonly noTimers: boolean;
  private readonly rng: Rng;

  private disposed = false;
  private flushing = false;
  private readonly outbox: PendingUpdate[] = [];
  private matchEndPending = false;
  private matchEndNotified = false;

  private readonly botTimers = new Map<number, BotTimer>();
  private deadlineTimer: unknown = null;
  private nextHandTimer: unknown = null;

  constructor(state: GameState, callbacks: HostCallbacks, options: HostOptions = {}) {
    this.st = state;
    this.cb = callbacks;
    this.timers = options.timers ?? realTimers;
    this.botLevel = options.botLevel ?? 'normal';
    this.botDelay = options.botDelayMs ? normaliseRange(options.botDelayMs) : null;
    this.autoNext = options.autoNextHand !== false;
    this.noTimers = options.noTimers === true;
    this.rng = new Rng((options.botSeed ?? cryptoSeed()) >>> 0);
    // A host built on an already finished match must not report it again.
    this.matchEndNotified = state.phase === 'MATCH_END';
  }

  get state(): GameState {
    return this.st;
  }

  /**
   * Start the first hand (state must be in LOBBY). On a match that is already
   * running (e.g. restored state) this re-sends every seat's view and resumes timers.
   */
  start(): void {
    if (this.disposed) return;
    if (this.st.phase === 'LOBBY') {
      this.commit(this.safe(() => startHand(this.st, this.timers.now())));
      return;
    }
    this.queueAll([]);
    this.reschedule();
    this.flush();
  }

  /** Submit a human intent. */
  submit(seat: number, action: Action): SubmitResult {
    if (this.disposed) return { ok: false, error: 'Game is closed' };
    if (!this.validSeat(seat)) return { ok: false, error: 'Bad seat' };
    const res = this.safe(() => applyAction(this.st, seat, action, this.timers.now()));
    if (!res.ok) return { ok: false, error: res.error };
    this.commit(res);
    return { ok: true };
  }

  /** Mark seat (dis)connected; disconnected humans are auto-played by a bot until reconnect. */
  setConnected(seat: number, connected: boolean): void {
    if (this.disposed || !this.validSeat(seat)) return;
    if (this.st.players[seat].connected === connected) return;
    this.patchPlayer(seat, { connected });
  }

  /** Permanently convert a seat to a bot (player left). */
  replaceWithBot(seat: number, name?: string): void {
    if (this.disposed || !this.validSeat(seat)) return;
    const p = this.st.players[seat];
    const trimmed = name?.trim();
    const newName = trimmed ? trimmed : p.name.endsWith(BOT_SUFFIX) ? p.name : p.name + BOT_SUFFIX;
    if (p.isBot && p.connected && p.name === newName) return;
    this.patchPlayer(seat, { isBot: true, connected: true, name: newName });
  }

  /** Manually advance from HAND_END (when autoNextHand is false). */
  advance(): void {
    if (this.disposed || this.st.phase !== 'HAND_END') return;
    this.commit(this.safe(() => nextHand(this.st, this.timers.now())));
  }

  getView(seat: number): PlayerView {
    return projectView(this.st, seat);
  }

  /** Stop all timers and callbacks. The host is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAllTimers();
    this.outbox.length = 0;
  }

  // -------------------------------------------------------------------------
  // State changes and fan-out
  // -------------------------------------------------------------------------

  private validSeat(seat: number): boolean {
    return Number.isInteger(seat) && seat >= 0 && seat < this.st.players.length;
  }

  /** Run an engine call, converting unexpected throws into ok:false. */
  private safe(fn: () => EngineResult): EngineResult {
    try {
      return fn();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Host-side change to a player record (connection / bot takeover); bumps the version. */
  private patchPlayer(seat: number, patch: Partial<GameState['players'][number]>): void {
    const s: GameState = {
      ...this.st,
      players: this.st.players.map((p) => (p.seat === seat ? { ...p, ...patch } : p)),
      version: this.st.version + 1,
    };
    this.commit({ ok: true, state: s, events: [] });
  }

  private commit(res: EngineResult): void {
    if (!res.ok || this.disposed) return;
    const wasMatchEnd = this.st.phase === 'MATCH_END';
    this.st = res.state;
    this.queueAll(res.events);
    if (!wasMatchEnd && this.st.phase === 'MATCH_END' && !this.matchEndNotified) this.matchEndPending = true;
    this.reschedule();
    this.flush();
  }

  /** Project the current state and the given events for every seat into the outbox. */
  private queueAll(events: GameEvent[]): void {
    for (let seat = 0; seat < this.st.players.length; seat++) {
      this.outbox.push({ seat, view: projectView(this.st, seat), events: projectEvents(events, seat) });
    }
  }

  /** Deliver queued updates in order. Re-entrant calls just leave their updates queued. */
  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const u = this.outbox.shift();
        if (u) {
          try {
            this.cb.onUpdate(u.seat, u.view, u.events);
          } catch (e) {
            // A misbehaving consumer must not break the game loop.
            reportCallbackError('onUpdate', e);
          }
          continue;
        }
        if (this.matchEndPending && !this.disposed) {
          this.matchEndPending = false;
          this.matchEndNotified = true;
          try {
            this.cb.onMatchEnd?.(this.st);
          } catch (e) {
            reportCallbackError('onMatchEnd', e);
          }
          continue; // onMatchEnd may itself have queued updates
        }
        break;
      }
    } finally {
      this.flushing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private clearAllTimers(): void {
    for (const t of this.botTimers.values()) this.timers.clearTimeout(t.handle);
    this.botTimers.clear();
    this.clearDeadlineTimer();
    this.clearNextHandTimer();
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer !== null) this.timers.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private clearNextHandTimer(): void {
    if (this.nextHandTimer !== null) this.timers.clearTimeout(this.nextHandTimer);
    this.nextHandTimer = null;
  }

  /** Seats a bot plays right now: bots and disconnected humans. */
  private botControlled(seat: number): boolean {
    const p = this.st.players[seat];
    return p.isBot || !p.connected;
  }

  /**
   * Key of the decision a seat faces. Simultaneous decisions (port window,
   * instant prompt) keep one key while other seats answer, so a bot's thinking
   * timer is not restarted every time someone else submits. Turn decisions are
   * keyed by version: every change in a turn is a new decision.
   */
  private decisionKey(): string {
    const s = this.st;
    if (s.phase === 'INSTANT' || (s.phase === 'PORT' && s.turn === null)) return `${s.handNo}:${s.phase}`;
    return `v${s.version}`;
  }

  private reschedule(): void {
    if (this.disposed) return;
    const s = this.st;
    const pending = pendingSeats(s);
    const key = this.decisionKey();

    // Bot timers: keep those still valid for the same decision, drop the rest.
    for (const [seat, t] of this.botTimers) {
      if (!pending.includes(seat) || !this.botControlled(seat) || t.key !== key) {
        this.timers.clearTimeout(t.handle);
        this.botTimers.delete(seat);
      }
    }
    for (const seat of pending) {
      if (!this.botControlled(seat) || this.botTimers.has(seat)) continue;
      const handle = this.timers.setTimeout(() => this.onBotTimer(seat, key), this.thinkDelay());
      this.botTimers.set(seat, { handle, key });
    }

    // Deadline timer: rebuilt on every change (the deadline is absolute).
    this.clearDeadlineTimer();
    if (s.deadline !== null && pending.length > 0) {
      // In relaxed mode a human's decision waits forever; bots still get the
      // deadline as a safety net in case they fail to produce a move.
      const humanWaiting = pending.some((seat) => !this.botControlled(seat));
      if (!(this.noTimers && humanWaiting)) {
        const version = s.version;
        const ms = Math.max(0, s.deadline - this.timers.now());
        this.deadlineTimer = this.timers.setTimeout(() => this.onDeadline(version), ms);
      }
    }

    // Next hand.
    if (s.phase !== 'HAND_END') this.clearNextHandTimer();
    else if (this.autoNext && this.nextHandTimer === null) {
      // Keyed by hand number, not version: seat changes during the pause must
      // not cancel the countdown.
      const handNo = s.handNo;
      this.nextHandTimer = this.timers.setTimeout(() => {
        this.nextHandTimer = null;
        if (this.disposed || this.st.handNo !== handNo || this.st.phase !== 'HAND_END') return;
        this.advance();
      }, Math.max(0, s.cfg.handEndDelayMs));
    }
  }

  private thinkDelay(): number {
    const rand = () => this.rng.next();
    if (this.botDelay) {
      const [min, max] = this.botDelay;
      return Math.round(min + rand() * (max - min));
    }
    return botThinkDelay(this.botLevel, rand);
  }

  private onDeadline(version: number): void {
    this.deadlineTimer = null;
    if (this.disposed || this.st.version !== version) return;
    const s = this.st;
    if (s.deadline === null) return;
    // Fire at least at the deadline even if the clock is slightly behind.
    const now = Math.max(this.timers.now(), s.deadline);
    const res = this.safe(() => applyTimeout(s, now));
    if (res.ok) this.commit(res);
  }

  private onBotTimer(seat: number, key: string): void {
    const t = this.botTimers.get(seat);
    if (!t || t.key !== key) return;
    this.botTimers.delete(seat);
    if (this.disposed || key !== this.decisionKey()) return;
    if (!pendingSeats(this.st).includes(seat) || !this.botControlled(seat)) return;

    const view = projectView(this.st, seat);
    const now = this.timers.now();
    const candidates: Action[] = [];
    const chosen = chooseBotAction(view, this.botLevel, () => this.rng.next());
    if (chosen) candidates.push(chosen);
    candidates.push(...fallbackActions(view));
    for (const a of candidates) {
      const res = this.safe(() => applyAction(this.st, seat, a, now));
      if (res.ok) {
        this.commit(res);
        return;
      }
    }
    // Nothing worked. If this seat is the only one deciding, resolve it like a
    // timeout right away; otherwise the shared deadline will take care of it.
    const s = this.st;
    if (s.deadline !== null && pendingSeats(s).every((p) => this.botControlled(p))) {
      const res = this.safe(() => applyTimeout(s, Math.max(now, s.deadline as number)));
      if (res.ok) this.commit(res);
    }
  }
}

/** Simple listed moves to try when the bot's choice is rejected. */
function fallbackActions(view: PlayerView): Action[] {
  const legal = view.legal;
  if (!legal) return [];
  if (view.phase === 'INSTANT') return [{ type: 'DECLARE_INSTANT', declare: true }];
  const me = view.players[view.you];
  if (me && !me.ported) return legal.portCandidates.slice(0, 3).map((m) => ({ type: 'PORT', melds: [m] }));
  const out: Action[] = [];
  for (const e of legal.extends.slice(0, 3)) out.push({ type: 'EXTEND', ...e });
  for (const c of legal.cuts.slice(0, 3)) out.push({ type: 'CUT', tiles: c });
  for (const f of legal.follows.slice(0, 3)) out.push({ type: 'FOLLOW_CUT', ...f });
  for (const r of legal.newRuns.slice(0, 3)) out.push({ type: 'NEW_RUN', tiles: r });
  if (legal.canEndTurn) out.push({ type: 'END_TURN' });
  return out;
}

function normaliseRange([a, b]: [number, number]): [number, number] {
  const lo = Number.isFinite(a) ? Math.max(0, a) : 0;
  const hi = Number.isFinite(b) ? Math.max(0, b) : lo;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function reportCallbackError(where: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[GameHost] ${where} callback threw:`, e);
}
