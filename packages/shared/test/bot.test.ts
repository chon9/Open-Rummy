/**
 * Bot tests: thousands of bot-vs-bot hands through the real engine across all
 * three levels and the rule presets. Every action a bot returns must be
 * accepted (ok:true), matches must terminate, and hard must clearly beat easy.
 */
import { describe, expect, it } from 'vitest';
import { botThinkDelay, chooseBotAction, decideBotAction, type BotLevel } from '../src/bot';
import { PENANG_CLASSIC, type RulesConfig } from '../src/config';
import { applyAction, applyTimeout, createMatch, nextHand, pendingSeats, projectView, startHand } from '../src/engine';
import { Rng } from '../src/rng';
import type { GameState } from '../src/types';

const MAX_STEPS = 60_000;
const LEVELS: BotLevel[] = ['easy', 'normal', 'hard'];

interface MatchResult {
  hands: number;
  actions: number;
  /** decisions where the bot returned null and the timeout had to resolve it */
  nulls: number;
  /** hand wins per seat */
  wins: number[];
  /** summed hand points per seat */
  points: number[];
  games: number;
}

/** Play a full match with one bot level per seat; throws on any rejected bot action. */
function playMatch(levels: BotLevel[], cfg: Partial<RulesConfig>, seed: number): MatchResult {
  const rng = new Rng(seed ^ 0x5bd1e995);
  const rand = () => rng.next();
  let now = 1_000_000;
  let s: GameState = createMatch({
    players: levels.map((l, i) => ({ name: `${l}${i}`, isBot: true, avatar: 'x' })),
    cfg: { ...cfg, players: levels.length },
    seed,
  });
  const started = startHand(s, now);
  if (!started.ok) throw new Error(started.error);
  s = started.state;
  const out: MatchResult = {
    hands: 0,
    actions: 0,
    nulls: 0,
    wins: levels.map(() => 0),
    points: levels.map(() => 0),
    games: 0,
  };
  let steps = 0;
  while (s.phase !== 'MATCH_END') {
    if (++steps > MAX_STEPS) throw new Error(`match ${seed} did not terminate`);
    now += 10;
    let res;
    if (s.phase === 'HAND_END') {
      const r = s.lastResult;
      if (!r) throw new Error('HAND_END without result');
      out.hands++;
      out.wins[r.winnerSeat]++;
      if (r.kind === 'GAME') out.games++;
      for (const rk of r.rankings) out.points[rk.seat] += rk.points;
      res = nextHand(s, now);
    } else {
      const pending = pendingSeats(s);
      if (pending.length === 0) throw new Error(`no pending seat in ${s.phase}`);
      const seat = pending[0];
      const view = projectView(s, seat);
      const action = decideBotAction(view, levels[seat], rand);
      if (s.phase === 'INSTANT' && action) {
        // instant wins are always declared
        expect(action).toEqual({ type: 'DECLARE_INSTANT', declare: true });
      }
      if (action) {
        res = applyAction(s, seat, action, now);
        if (!res.ok) {
          throw new Error(`${levels[seat]} bot action rejected (${res.error}): ${JSON.stringify(action)} cfg=${JSON.stringify(cfg)} seed=${seed}`);
        }
        out.actions++;
      } else {
        out.nulls++;
        now = Math.max(now, s.deadline ?? now);
        res = applyTimeout(s, now);
      }
    }
    if (!res.ok) throw new Error(res.error);
    s = res.state;
  }
  return out;
}

/** Let the vitest worker answer RPC heartbeats between long synchronous matches. */
const yieldToRunner = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function randomLevels(n: number, rng: Rng): BotLevel[] {
  return Array.from({ length: n }, () => LEVELS[rng.int(3)]);
}

describe('botThinkDelay', () => {
  it('stays inside the per-level ranges', () => {
    const rng = new Rng(7);
    const ranges: Record<BotLevel, [number, number]> = { easy: [600, 1400], normal: [800, 2000], hard: [1000, 2600] };
    for (const level of LEVELS) {
      const [min, max] = ranges[level];
      const seen: number[] = [];
      for (let i = 0; i < 500; i++) seen.push(botThinkDelay(level, () => rng.next()));
      expect(Math.min(...seen)).toBeGreaterThanOrEqual(min);
      expect(Math.max(...seen)).toBeLessThanOrEqual(max);
      expect(new Set(seen).size).toBeGreaterThan(50); // randomised
    }
    expect(botThinkDelay('easy', () => 0)).toBe(600);
    expect(botThinkDelay('hard', () => 0.999999)).toBe(2600);
  });
});

describe('chooseBotAction', () => {
  it('returns null when it is not the bot decision (other seat, spectator)', () => {
    const s0 = createMatch({
      players: [0, 1, 2, 3].map((i) => ({ name: `P${i}`, isBot: true, avatar: 'x' })),
      cfg: { instantWins: false },
      seed: 99,
      dealer: 0,
    });
    const r = startHand(s0, 0);
    if (!r.ok) throw new Error(r.error);
    // simultaneous port: every seat decides; after seat 1 ports it has nothing to decide
    const view1 = projectView(r.state, 1);
    const port = chooseBotAction(view1, 'hard', () => 0.5);
    expect(port?.type).toBe('PORT');
    const r2 = applyAction(r.state, 1, port as NonNullable<typeof port>, 1);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    for (const level of LEVELS) {
      expect(chooseBotAction(projectView(r2.state, 1), level, () => 0.5)).toBeNull();
      expect(chooseBotAction(projectView(r2.state, -1), level, () => 0.5)).toBeNull();
    }
  });

  it('is deterministic for the same view and random stream', () => {
    const s0 = createMatch({
      players: [0, 1, 2, 3].map((i) => ({ name: `P${i}`, isBot: true, avatar: 'x' })),
      cfg: { instantWins: false },
      seed: 4242,
    });
    const r = startHand(s0, 0);
    if (!r.ok) throw new Error(r.error);
    for (const seat of pendingSeats(r.state)) {
      const v = projectView(r.state, seat);
      for (const level of LEVELS) {
        const a = new Rng(1);
        const b = new Rng(1);
        expect(chooseBotAction(v, level, () => a.next())).toEqual(chooseBotAction(v, level, () => b.next()));
      }
    }
  });
});

const PRESETS: { name: string; cfg: Partial<RulesConfig>; players: number; matches: number }[] = [
  { name: 'default 4p', cfg: {}, players: 4, matches: 60 },
  { name: 'PENANG_CLASSIC 4p', cfg: PENANG_CLASSIC, players: 4, matches: 30 },
  { name: 'default 3p', cfg: {}, players: 3, matches: 40 },
  { name: 'default 5p', cfg: {}, players: 5, matches: 25 },
  { name: 'PENANG_CLASSIC 3p', cfg: PENANG_CLASSIC, players: 3, matches: 15 },
];

const VARIANTS: Partial<RulesConfig>[] = [
  { jokerSwap: 'useSameTurn' },
  { jokerSwap: 'off', newRunsAfterPort: true },
  { setCapFourDistinct: true, cutOnlyWhenCannotExtend: false },
  { setPriority: true, setAllowedAsPort: true },
  { aceHigh: false, minNaturalsInNewMeld: 1 },
  { unlimitedActions: true, jokerSwap: 'useSameTurn', newRunsAfterPort: true },
  { portTiming: 'sequential', minNaturalsInNewMeld: 3, jokers: 12 },
  { dealerRotation: 'winner', instantWins: false, jokers: 6 },
  { handSize: 25, players: 3 },
];

describe('bots play legal complete matches', () => {
  let totalHands = 0;
  for (const preset of PRESETS) {
    it(`${preset.name}: ${preset.matches} matches with mixed levels`, async () => {
      const rng = new Rng(preset.players * 1000 + preset.matches);
      let hands = 0;
      let actions = 0;
      let nulls = 0;
      for (let i = 0; i < preset.matches; i++) {
        await yieldToRunner();
        const m = playMatch(randomLevels(preset.players, rng), preset.cfg, 10_000 + i * 7919);
        hands += m.hands;
        actions += m.actions;
        nulls += m.nulls;
      }
      totalHands += hands;
      console.log(`[bot] ${preset.name}: ${hands} hands, ${actions} bot actions accepted, ${nulls} null decisions`);
      expect(hands).toBeGreaterThanOrEqual(preset.matches);
      expect(nulls).toBe(0);
    }, 600_000);
  }

  it('rule toggles: every bot level stays legal', async () => {
    let hands = 0;
    let nulls = 0;
    for (const [i, v] of VARIANTS.entries()) {
      const players = v.players ?? 4;
      for (let k = 0; k < 6; k++) {
        await yieldToRunner();
        // each level gets at least one seat
        const levels = Array.from({ length: players }, (_, s) => LEVELS[(s + k) % 3]);
        const m = playMatch(levels, v, 70_000 + i * 101 + k);
        hands += m.hands;
        nulls += m.nulls;
      }
    }
    totalHands += hands;
    console.log(`[bot] toggles: ${hands} hands, ${nulls} null decisions; total legality hands so far ${totalHands}`);
    expect(nulls).toBe(0);
  }, 600_000);
});

describe('bot strength', () => {
  /** 2 vs 2 at alternating seats, swapping seats every match to cancel seat bias. */
  async function headToHead(a: BotLevel, b: BotLevel, cfg: Partial<RulesConfig>, matches: number, seed: number) {
    let winsA = 0;
    let hands = 0;
    let ptsA = 0;
    let ptsB = 0;
    for (let i = 0; i < matches; i++) {
      await yieldToRunner();
      const levels: BotLevel[] = i % 2 ? [a, b, a, b] : [b, a, b, a];
      const m = playMatch(levels, cfg, seed + i * 7919);
      hands += m.hands;
      levels.forEach((l, s) => {
        if (l === a) {
          winsA += m.wins[s];
          ptsA += m.points[s];
        } else ptsB += m.points[s];
      });
    }
    return { share: winsA / hands, hands, avgA: ptsA / hands / 2, avgB: ptsB / hands / 2 };
  }

  it('hard clearly beats easy (default rules and Penang Classic)', async () => {
    const def = await headToHead('hard', 'easy', {}, 60, 1234);
    const pen = await headToHead('hard', 'easy', PENANG_CLASSIC, 30, 5678);
    const fmt = (r: typeof def) =>
      `${(r.share * 100).toFixed(1)}% of ${r.hands} hands won by hard (2 hard vs 2 easy; 50% = parity); avg hand points hard ${r.avgA.toFixed(1)} vs easy ${r.avgB.toFixed(1)}`;
    console.log(`[bot] hard vs easy, default: ${fmt(def)}`);
    console.log(`[bot] hard vs easy, Penang Classic: ${fmt(pen)}`);
    expect(def.share).toBeGreaterThan(0.62);
    expect(pen.share).toBeGreaterThan(0.62);
    expect(def.avgA).toBeLessThan(def.avgB);
  }, 600_000);

  it('normal beats easy and hard beats normal', async () => {
    const ne = await headToHead('normal', 'easy', {}, 40, 999);
    const hn = await headToHead('hard', 'normal', {}, 40, 31337);
    console.log(`[bot] normal vs easy, default: ${(ne.share * 100).toFixed(1)}% of ${ne.hands} hands won by normal`);
    console.log(`[bot] hard vs normal, default: ${(hn.share * 100).toFixed(1)}% of ${hn.hands} hands won by hard`);
    expect(ne.share).toBeGreaterThan(0.52);
    expect(hn.share).toBeGreaterThan(0.52);
  }, 600_000);
});
