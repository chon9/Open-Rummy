/**
 * Fuzz: play complete random matches with a random-legal-move driver and
 * check invariants after every step (tile conservation, meld validity, no
 * hidden-information leaks, legal moves always accepted, termination).
 */
import { describe, expect, it } from 'vitest';
import type { RulesConfig } from '../src/config';
import { PENANG_CLASSIC } from '../src/config';
import {
  applyAction,
  applyTimeout,
  createMatch,
  getLegalMoves,
  nextHand,
  pendingSeats,
  projectEvents,
  projectView,
  startHand,
} from '../src/engine';
import { isMeldValid } from '../src/melds';
import { Rng } from '../src/rng';
import { buildTileSet } from '../src/tiles';
import type { Action, GameEvent, GameState } from '../src/types';

const MAX_STEPS = 20000;

function collectStrings(x: unknown, out: Set<string>): Set<string> {
  if (typeof x === 'string') out.add(x);
  else if (Array.isArray(x)) for (const v of x) collectStrings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) collectStrings(v, out);
  return out;
}

/** Plain assertion (vitest `expect` is too slow for millions of checks). */
function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`invariant failed: ${msg}`);
}

const FULL_SETS = new Map<number, string>();
function fullSetKey(jokers: number): string {
  let k = FULL_SETS.get(jokers);
  if (!k) {
    k = buildTileSet(2, jokers).sort().join(',');
    FULL_SETS.set(jokers, k);
  }
  return k;
}

/**
 * `seenOnTable` holds tile ids that have been on the table this hand: a Joker
 * taken back by a swap is public knowledge, so it is not a leak.
 */
function checkInvariants(s: GameState, events: GameEvent[], seenOnTable: Set<string>): void {
  if (events.some((e) => e.type === 'HAND_START')) seenOnTable.clear();
  for (const m of s.melds) for (const t of m.tiles) seenOnTable.add(t.tileId);

  // tile conservation: hands + melds + dead wall = the full set, no duplicates
  const all: string[] = [...s.deadWall];
  for (const p of s.players) all.push(...p.hand);
  for (const m of s.melds) for (const t of m.tiles) all.push(t.tileId);
  check(new Set(all).size === all.length, 'duplicate tile');
  check(all.sort().join(',') === fullSetKey(s.cfg.jokers), 'tile set not conserved');

  // every meld on the table is valid
  for (const m of s.melds) check(isMeldValid(m, s.cfg), `invalid meld ${JSON.stringify(m)}`);

  // phase consistency
  if (s.phase === 'PLAY') {
    check(s.turn !== null, 'PLAY without turn');
    const p = s.players[s.turn as number];
    check(p.status === 'ALIVE' && p.ported, 'turn seat not alive/ported');
  }

  // no hidden-information leaks in views / events
  const reveal = s.phase === 'HAND_END' || s.phase === 'MATCH_END';
  for (let seat = -1; seat < s.players.length; seat++) {
    const view = projectView(s, seat);
    const strings = collectStrings(view, new Set());
    const evStrings = collectStrings(projectEvents(events, seat), new Set());
    for (const id of s.deadWall) check(!strings.has(id) && !evStrings.has(id), `dead wall tile ${id} leaked`);
    if (seat >= 0) check(view.hand.length === s.players[seat].hand.length, 'own hand size');
    if (reveal) continue;
    for (const p of s.players) {
      if (p.seat === seat) continue;
      for (const id of p.hand) {
        if (seenOnTable.has(id)) continue;
        check(!strings.has(id), `view of ${seat} leaks ${id} of ${p.seat}`);
        check(!evStrings.has(id), `events for ${seat} leak ${id} of ${p.seat}`);
      }
    }
  }
}

function pick<T>(rng: Rng, xs: T[]): T {
  return xs[rng.int(xs.length)];
}

/** Choose a random legal action for `seat`, or null to let the timeout resolve. */
function randomAction(s: GameState, seat: number, rng: Rng): Action | null {
  const legal = getLegalMoves(s, seat);
  check(legal !== null, 'pending seat without legal moves');
  if (!legal) return null;
  if (s.phase === 'INSTANT') return { type: 'DECLARE_INSTANT', declare: rng.next() < 0.5 };
  if (!s.players[seat].ported) {
    if (!legal.canPort) return null;
    // combine up to two disjoint candidates
    const first = pick(rng, legal.portCandidates);
    const melds = [first];
    if (rng.next() < 0.5) {
      const used = new Set(first);
      const rest = legal.portCandidates.filter((c) => c.every((id) => !used.has(id)));
      if (rest.length > 0) melds.push(pick(rng, rest));
    }
    return { type: 'PORT', melds };
  }
  const options: (() => Action)[] = [];
  if (legal.extends.length) options.push(() => ({ type: 'EXTEND', ...pick(rng, legal.extends) }));
  if (legal.cuts.length) options.push(() => ({ type: 'CUT', tiles: pick(rng, legal.cuts) }));
  if (legal.follows.length) options.push(() => ({ type: 'FOLLOW_CUT', ...pick(rng, legal.follows) }));
  if (legal.newRuns.length) options.push(() => ({ type: 'NEW_RUN', tiles: pick(rng, legal.newRuns) }));
  if (legal.swaps.length && rng.next() < 0.5) options.push(() => ({ type: 'SWAP_JOKER', ...pick(rng, legal.swaps) }));
  if (legal.canEndTurn) options.push(() => ({ type: 'END_TURN' }));
  if (options.length === 0) {
    // no listed move: either truly dead (the engine marks that at turn start) or a
    // swap-only path; the timeout auto-play resolves both.
    return null;
  }
  return pick(rng, options)();
}

interface MatchStats {
  steps: number;
  hands: number;
  actions: number;
  timeouts: number;
}

function playMatch(cfg: Partial<RulesConfig>, players: number, seed: number): MatchStats {
  const rng = new Rng(seed ^ 0x9e3779b9);
  let now = 1_000_000;
  let s = createMatch({
    players: Array.from({ length: players }, (_, i) => ({ name: `P${i}`, isBot: true, avatar: 'x' })),
    cfg: { ...cfg, players },
    seed,
  });
  const started = startHand(s, now);
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  s = started.state;
  const seenOnTable = new Set<string>();
  checkInvariants(s, started.events, seenOnTable);
  const stats: MatchStats = { steps: 0, hands: 1, actions: 0, timeouts: 0 };

  while (s.phase !== 'MATCH_END') {
    if (++stats.steps > MAX_STEPS) throw new Error(`match ${seed} did not terminate`);
    now += 100;
    let res;
    if (s.phase === 'HAND_END') {
      check(!applyTimeout(s, now).ok, 'timeout in HAND_END');
      res = nextHand(s, now);
      if (res.ok && res.state.phase !== 'MATCH_END') stats.hands++;
    } else {
      const pending = pendingSeats(s);
      check(pending.length > 0, `no pending seat in ${s.phase}`);
      let action: Action | null = null;
      let seat = -1;
      if (rng.next() >= 0.05) {
        seat = pick(rng, pending);
        action = randomAction(s, seat, rng);
      }
      if (action) {
        res = applyAction(s, seat, action, now);
        if (!res.ok) throw new Error(`legal ${JSON.stringify(action)} rejected: ${res.error}`);
        stats.actions++;
      } else {
        check(s.deadline !== null, 'decision without deadline');
        now = Math.max(now, s.deadline as number);
        res = applyTimeout(s, now);
        stats.timeouts++;
      }
    }
    if (!res.ok) throw new Error(res.error);
    check(res.state.version === s.version + 1, 'version bump');
    s = res.state;
    checkInvariants(s, res.events, seenOnTable);
  }
  expect(s.standings).not.toBeNull();
  expect(s.standings?.length).toBe(players);
  // chips are conserved across the match
  expect(s.players.reduce((a, p) => a + p.chips, 0)).toBe(players * s.cfg.startingChips);
  return stats;
}

/** Let the vitest worker answer its RPC heartbeats between long synchronous matches. */
const yieldToRunner = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const PRESETS: { name: string; cfg: Partial<RulesConfig>; players: number; matches: number }[] = [
  { name: 'default (4p)', cfg: {}, players: 4, matches: 100 },
  { name: 'PENANG_CLASSIC (4p)', cfg: PENANG_CLASSIC, players: 4, matches: 100 },
  { name: '3 players', cfg: {}, players: 3, matches: 50 },
  { name: '5 players', cfg: {}, players: 5, matches: 50 },
];

describe('fuzz: random complete matches', () => {
  for (const preset of PRESETS) {
    it(`${preset.name}: ${preset.matches} matches terminate with invariants intact`, async () => {
      let hands = 0;
      let actions = 0;
      for (let i = 0; i < preset.matches; i++) {
        await yieldToRunner();
        const st = playMatch(preset.cfg, preset.players, 1000 + i * 7919);
        hands += st.hands;
        actions += st.actions;
      }
      expect(hands).toBeGreaterThanOrEqual(preset.matches);
      expect(actions).toBeGreaterThan(0);
    }, 600_000);
  }

  it('other toggles: useSameTurn swaps, set cap, set priority, ace low only, simultaneous + unlimited', async () => {
    const variants: Partial<RulesConfig>[] = [
      { jokerSwap: 'useSameTurn' },
      { jokerSwap: 'off', newRunsAfterPort: true },
      { setCapFourDistinct: true, cutOnlyWhenCannotExtend: false },
      { setPriority: true, setAllowedAsPort: true },
      { aceHigh: false, minNaturalsInNewMeld: 1 },
      { unlimitedActions: true, jokerSwap: 'useSameTurn', newRunsAfterPort: true },
      { portTiming: 'sequential', minNaturalsInNewMeld: 3, jokers: 12 },
      { dealerRotation: 'winner', instantWins: false, handsPerMatch: 3 },
    ];
    for (const [i, v] of variants.entries()) {
      for (let k = 0; k < 4; k++) {
        await yieldToRunner();
        playMatch(v, 4, 50_000 + i * 101 + k);
      }
    }
  }, 600_000);
});
