import { describe, expect, it } from 'vitest';
import { chooseBotAction } from '../src/bot';
import type { RulesConfig } from '../src/config';
import { createMatch, pendingSeats } from '../src/engine';
import { GameHost, type HostOptions, type TimerApi } from '../src/host';
import { sortTiles } from '../src/tiles';
import type { GameEvent, GameState, PlayerView } from '../src/types';

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic TimerApi: time only moves when the test advances it. */
class FakeClock implements TimerApi {
  private t = 1_000_000;
  private seq = 0;
  private queue: FakeTimer[] = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn };
    this.queue.push(timer);
    return timer.id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((x) => x.id !== handle);
  }
  get pending(): number {
    return this.queue.length;
  }
  /** Run the earliest due timer (advancing time to it). Returns false if none is due by `limit`. */
  step(limit = Infinity): boolean {
    if (this.queue.length === 0) return false;
    let next = this.queue[0];
    for (const x of this.queue) if (x.at < next.at || (x.at === next.at && x.id < next.id)) next = x;
    if (next.at > limit) return false;
    this.queue = this.queue.filter((x) => x !== next);
    this.t = Math.max(this.t, next.at);
    next.fn();
    return true;
  }
  /** Advance time by `ms`, running every timer that falls due. */
  advance(ms: number): void {
    const target = this.t + ms;
    while (this.step(target));
    this.t = target;
  }
  /** Run timers until `done()` or no timers remain; fails after `maxSteps`. */
  runUntil(done: () => boolean, maxSteps = 200_000): void {
    let steps = 0;
    while (!done() && this.step()) {
      if (++steps > maxSteps) throw new Error('runUntil: too many steps');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Update {
  seat: number;
  view: PlayerView;
  events: GameEvent[];
}

function makeState(humans: number[], cfg: Partial<RulesConfig> = {}, seed = 7, n = 4): GameState {
  const players = Array.from({ length: n }, (_, i) => ({
    name: `P${i}`,
    isBot: !humans.includes(i),
    avatar: 'a',
  }));
  return createMatch({ players, cfg: { players: n, ...cfg }, seed, dealer: n - 1 });
}

/**
 * Builds a host on a fake clock and checks every update for hidden-information
 * leaks and in-order delivery.
 */
function setup(
  state: GameState,
  opts: HostOptions = {},
  onUpdate?: (host: GameHost, u: Update) => void,
) {
  const clock = new FakeClock();
  const updates: Update[] = [];
  const lastVersion = new Map<number, number>();
  let matchEnds = 0;
  const leaks: string[] = [];
  const holder: { host?: GameHost } = {};
  const host = new GameHost(
    state,
    {
      onUpdate(seat, view, events) {
        updates.push({ seat, view, events });
        if (view.you !== seat) leaks.push(`view.you ${view.you} != seat ${seat}`);
        const prev = lastVersion.get(seat) ?? -1;
        if (view.version < prev) leaks.push(`version went backwards for seat ${seat}`);
        lastVersion.set(seat, view.version);
        const reveal = view.phase === 'HAND_END' || view.phase === 'MATCH_END';
        for (const p of view.players) {
          if (!reveal && p.revealed !== null) leaks.push(`seat ${seat} sees revealed hand of ${p.seat}`);
          if ('hand' in (p as object)) leaks.push('PublicPlayer carries a hand');
        }
        if (view.instantOffer && view.instantOffer.seat !== seat) leaks.push('foreign instant offer');
        for (const e of events) {
          if (e.type === 'DEAL' && e.seat !== seat && e.tiles) leaks.push(`seat ${seat} sees DEAL tiles of ${e.seat}`);
          if (e.type === 'INSTANT_OFFER' && e.seat !== seat) leaks.push('foreign INSTANT_OFFER event');
        }
        const h = holder.host;
        // When the update is current, the hand must be exactly the seat's own hand.
        if (h && h.state.version === view.version) {
          const own = sortTiles(h.state.players[seat].hand);
          if (JSON.stringify(own) !== JSON.stringify(view.hand)) leaks.push(`seat ${seat} hand mismatch`);
        }
        if (h && onUpdate) onUpdate(h, { seat, view, events });
      },
      onMatchEnd() {
        matchEnds++;
      },
    },
    { timers: clock, botDelayMs: [0, 0], botSeed: 1, botLevel: 'normal', ...opts },
  );
  holder.host = host;
  return {
    host,
    clock,
    updates,
    leaks,
    get matchEnds() {
      return matchEnds;
    },
  };
}

const FAST: Partial<RulesConfig> = { handsPerMatch: 2, handEndDelayMs: 500 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GameHost', () => {
  it('plays full 4-bot matches to MATCH_END with fake timers', () => {
    for (const seed of [1, 2, 3]) {
      const t = setup(makeState([], FAST, seed), { botDelayMs: [100, 900] });
      t.host.start();
      t.clock.runUntil(() => t.host.state.phase === 'MATCH_END');
      expect(t.host.state.phase).toBe('MATCH_END');
      expect(t.host.state.handNo).toBe(2);
      expect(t.matchEnds).toBe(1);
      expect(t.leaks).toEqual([]);
      // every seat received the MATCH_END event
      for (let seat = 0; seat < 4; seat++) {
        expect(t.updates.some((u) => u.seat === seat && u.events.some((e) => e.type === 'MATCH_END'))).toBe(true);
      }
      // a bot table never waits for a deadline: no timeouts happened
      expect(t.updates.some((u) => u.events.some((e) => e.type === 'TIMEOUT'))).toBe(false);
      expect(t.clock.pending).toBe(0);
      t.host.dispose();
    }
  });

  it('plays a 3-player match with the Penang Classic style options', () => {
    const t = setup(
      makeState([], { ...FAST, portTiming: 'sequential', unlimitedActions: true, newRunsAfterPort: true }, 11, 3),
      { botLevel: 'hard' },
    );
    t.host.start();
    t.clock.runUntil(() => t.host.state.phase === 'MATCH_END');
    expect(t.host.state.phase).toBe('MATCH_END');
    expect(t.leaks).toEqual([]);
    t.host.dispose();
  });

  it('fans out one update per seat per change', () => {
    const t = setup(makeState([0, 1, 2, 3], FAST));
    t.host.start();
    expect(t.updates.map((u) => u.seat)).toEqual([0, 1, 2, 3]);
    expect(t.updates.every((u) => u.view.version === t.host.state.version)).toBe(true);
    expect(t.updates.every((u) => u.events.some((e) => e.type === 'HAND_START'))).toBe(true);
    t.host.dispose();
  });

  it('times out an idle human with timers and auto-plays the seat', () => {
    const t = setup(makeState([0], { ...FAST, handsPerMatch: 1 }));
    t.host.start();
    t.clock.runUntil(() => t.host.state.phase === 'MATCH_END');
    expect(t.host.state.phase).toBe('MATCH_END');
    const timeouts = t.updates.filter((u) => u.seat === 0).flatMap((u) => u.events.filter((e) => e.type === 'TIMEOUT'));
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((e) => e.type === 'TIMEOUT' && e.seat === 0)).toBe(true);
    expect(t.leaks).toEqual([]);
    t.host.dispose();
  });

  it('noTimers waits for the human, then continues once they act', () => {
    const rand = mulberry(99);
    const t = setup(makeState([0], FAST), { noTimers: true });
    t.host.start();
    let waits = 0;
    for (let guard = 0; guard < 5000 && t.host.state.phase !== 'MATCH_END'; guard++) {
      t.clock.runUntil(() => onlyHumanPending(t.host.state) || t.host.state.phase === 'MATCH_END');
      if (isOver(t.host.state)) break; // helper avoids TS narrowing across the loop
      // The human is deciding: an hour passes and nothing happens.
      const v = t.host.state.version;
      t.clock.advance(3_600_000);
      expect(t.host.state.version).toBe(v);
      expect(pendingSeats(t.host.state)).toContain(0);
      waits++;
      const action = chooseBotAction(t.host.getView(0), 'normal', rand);
      expect(action).not.toBeNull();
      expect(t.host.submit(0, action!)).toEqual({ ok: true });
    }
    expect(waits).toBeGreaterThan(0);
    expect(t.host.state.phase).toBe('MATCH_END');
    expect(t.updates.some((u) => u.events.some((e) => e.type === 'TIMEOUT'))).toBe(false);
    expect(t.leaks).toEqual([]);
    t.host.dispose();
  });

  it('is re-entrancy safe when a client submits from inside onUpdate', () => {
    const rand = mulberry(5);
    let depth = 0;
    let maxDepth = 0;
    const t = setup(makeState([0], FAST), { noTimers: true }, (host, u) => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      // Act only on the current view, as a client would.
      if (u.seat === 0 && u.view.legal && u.view.version === host.state.version) {
        const a = chooseBotAction(u.view, 'normal', rand);
        if (a) host.submit(0, a);
      }
      depth--;
    });
    t.host.start();
    t.clock.runUntil(() => t.host.state.phase === 'MATCH_END');
    expect(t.host.state.phase).toBe('MATCH_END');
    expect(maxDepth).toBe(1); // updates are never delivered recursively
    expect(t.leaks).toEqual([]);
    t.host.dispose();
  });

  it('auto-plays a disconnected human until they reconnect', () => {
    const slow: Partial<RulesConfig> = { ...FAST, portTimerMs: 600_000, turnTimerMs: 600_000, instantTimerMs: 600_000 };
    const t = setup(makeState([0], slow));
    t.host.start();
    t.host.setConnected(0, false);
    const last = t.updates[t.updates.length - 1];
    expect(last.view.players[0].connected).toBe(false);
    // well before any deadline the seat keeps being played by the bot
    t.clock.runUntil(() => t.host.state.handNo === 2 || t.host.state.phase === 'MATCH_END');
    expect(t.clock.now()).toBeLessThan(1_000_000 + 600_000);
    expect(t.updates.some((u) => u.events.some((e) => e.type === 'TIMEOUT'))).toBe(false);

    t.host.setConnected(0, true);
    expect(t.updates[t.updates.length - 1].view.players[0].connected).toBe(true);
    if (t.host.state.phase !== 'MATCH_END') {
      // reconnected human is waited for (until the long deadline)
      t.clock.runUntil(() => onlyHumanPending(t.host.state) || t.host.state.phase === 'MATCH_END');
      if (onlyHumanPending(t.host.state)) {
        const v = t.host.state.version;
        t.clock.advance(60_000);
        expect(t.host.state.version).toBe(v);
      }
    }
    expect(t.leaks).toEqual([]);
    t.host.dispose();
  });

  it('replaceWithBot converts a seat permanently', () => {
    const t = setup(makeState([0, 1], FAST), { noTimers: true });
    t.host.start();
    t.host.replaceWithBot(0);
    t.host.replaceWithBot(1, 'Robo');
    expect(t.host.state.players[0].name).toBe('P0 (Bot)');
    expect(t.host.state.players[0].isBot).toBe(true);
    expect(t.host.state.players[1].name).toBe('Robo');
    t.host.replaceWithBot(0); // no double suffix
    expect(t.host.state.players[0].name).toBe('P0 (Bot)');
    t.clock.runUntil(() => t.host.state.phase === 'MATCH_END');
    expect(t.host.state.phase).toBe('MATCH_END');
    t.host.dispose();
  });

  it('never throws on illegal input', () => {
    const t = setup(makeState([0, 1, 2, 3], FAST));
    t.host.start();
    const n = t.updates.length;
    expect(t.host.submit(0, { type: 'END_TURN' }).ok).toBe(false);
    expect(t.host.submit(9, { type: 'END_TURN' }).ok).toBe(false);
    expect(t.host.submit(-1, { type: 'END_TURN' }).ok).toBe(false);
    expect(t.host.submit(0, null as never).ok).toBe(false);
    expect(t.host.submit(0, { type: 'PORT', melds: 'x' } as never).ok).toBe(false);
    expect(t.host.submit(0, { type: 'NOPE' } as never).ok).toBe(false);
    expect(() => t.host.setConnected(42, false)).not.toThrow();
    expect(() => t.host.replaceWithBot(-3)).not.toThrow();
    expect(() => t.host.advance()).not.toThrow(); // not at HAND_END: ignored
    t.host.start(); // already started: re-sends views, does not restart
    expect(t.host.state.handNo).toBe(1);
    expect(t.updates.length).toBe(n + 4);
    t.host.dispose();
  });

  it('autoNextHand=false waits at HAND_END until advance()', () => {
    const t = setup(makeState([], FAST), { autoNextHand: false });
    t.host.start();
    t.clock.runUntil(() => t.host.state.phase === 'HAND_END');
    expect(t.host.state.phase).toBe('HAND_END');
    t.clock.advance(3_600_000);
    expect(t.host.state.phase).toBe('HAND_END');
    expect(t.host.state.handNo).toBe(1);
    t.host.advance();
    expect(t.host.state.handNo).toBe(2);
    t.clock.runUntil(() => t.host.state.phase === 'HAND_END');
    t.host.advance();
    expect(t.host.state.phase).toBe('MATCH_END');
    expect(t.matchEnds).toBe(1);
    t.host.dispose();
  });

  it('dispose stops everything', () => {
    const t = setup(makeState([0], FAST), { botDelayMs: [500, 500] });
    t.host.start();
    t.clock.advance(1000);
    expect(t.clock.pending).toBeGreaterThan(0);
    t.host.dispose();
    expect(t.clock.pending).toBe(0);
    const n = t.updates.length;
    const v = t.host.state.version;
    t.clock.advance(10_000_000);
    expect(t.updates.length).toBe(n);
    expect(t.host.state.version).toBe(v);
    expect(t.host.submit(0, { type: 'END_TURN' }).ok).toBe(false);
    t.host.setConnected(0, false);
    t.host.advance();
    t.host.start();
    expect(t.clock.pending).toBe(0);
    expect(t.updates.length).toBe(n);
  });

  it('ignores stale timers after the state moved on', () => {
    // Human with timers: submit just before the deadline; the old deadline timer must not fire on the new decision.
    const t = setup(makeState([0], { ...FAST, portTiming: 'sequential' }));
    t.host.start();
    t.clock.runUntil(() => pendingSeats(t.host.state).includes(0) || t.host.state.phase === 'HAND_END');
    if (pendingSeats(t.host.state).includes(0)) {
      const deadline = t.host.state.deadline!;
      t.clock.advance(deadline - t.clock.now() - 1);
      const a = chooseBotAction(t.host.getView(0), 'normal', mulberry(3));
      expect(t.host.submit(0, a!).ok).toBe(true);
      const timeoutsBefore = t.updates.filter((u) => u.events.some((e) => e.type === 'TIMEOUT')).length;
      t.clock.advance(1); // the old deadline instant
      const timeoutsAfter = t.updates.filter((u) => u.events.some((e) => e.type === 'TIMEOUT')).length;
      expect(timeoutsAfter).toBe(timeoutsBefore);
    }
    t.host.dispose();
  });
});

function isOver(s: GameState): boolean {
  return s.phase === 'MATCH_END';
}

/** Seat 0 (the human) is the only seat left to decide: bots have already acted. */
function onlyHumanPending(s: GameState): boolean {
  const p = pendingSeats(s);
  return p.length === 1 && p[0] === 0;
}

/** Tiny seeded PRNG for test-side "human" choices. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
