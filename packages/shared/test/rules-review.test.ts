/**
 * Adversarial rules review against docs/RULES.md (sections 1-13).
 *
 * Each block tries to refute one part of the spec with hand-built states.
 * The last block fuzzes getLegalMoves against brute-force enumerators that
 * only use the meld validators (validateExtend / validateFollow /
 * validateNewSet / validateNewRun / canSwapJoker), so the move generator and
 * the Dead / cut-precondition logic are checked independently of
 * rules/moves.ts.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, resolveRules, type RulesConfig } from '../src/config';
import {
  applyAction,
  applyTimeout,
  createMatch,
  detectInstant,
  getLegalMoves,
  nextHand,
  projectEvents,
  projectView,
  startHand,
} from '../src/engine';
import { canSwapJoker, validateExtend, validateFollow, validateNewRun, validateNewSet } from '../src/melds';
import { canPortHand } from '../src/rules/moves';
import { Rng } from '../src/rng';
import { COLOURS, buildTileSet, rankCode, tileFromId, tilePenalty, type Colour } from '../src/tiles';
import type { Action, EngineResult, GameEvent, GameState, LegalMoves, Meld } from '../src/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NOW = 500;

function players(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isBot: false, avatar: 'a' }));
}

/** Fresh match; dealer = last seat so the dealer's 下家 (firstSeat) is seat 0. */
function base(n: number, cfg: Partial<RulesConfig> = {}): GameState {
  return createMatch({ players: players(n), cfg: { ...cfg, players: n }, seed: 7, dealer: n - 1 });
}

function playState(hands: string[][], melds: Meld[] = [], cfg: Partial<RulesConfig> = {}, turn = 0): GameState {
  const s = base(hands.length, cfg);
  s.phase = 'PLAY';
  s.handNo = 1;
  s.firstSeat = 0;
  s.dealer = hands.length - 1;
  s.turn = turn;
  s.deadline = 1000;
  s.melds = structuredClone(melds);
  s.nextMeldId = 100;
  s.players.forEach((p, i) => {
    p.hand = [...hands[i]];
    p.ported = true;
  });
  return s;
}

function portState(hands: string[][], cfg: Partial<RulesConfig> = {}): GameState {
  const s = playState(hands, [], cfg);
  s.phase = 'PORT';
  s.turn = null;
  s.players.forEach((p) => (p.ported = false));
  return s;
}

/** An INSTANT-phase state with one (manually built) offer for `seat`; declining it opens the port. */
function instantState(hands: string[][], seat: number, dealer = hands.length - 1): GameState {
  const s = portState(hands);
  s.dealer = dealer;
  s.firstSeat = (dealer + 1) % hands.length;
  s.phase = 'INSTANT';
  s.instantOffers = [{ seat, kind: 'GAME_7', tiles: [] }];
  return s;
}

function run(id: string, ids: string[], cfg: RulesConfig = DEFAULT_RULES, owner = 0): Meld {
  const tiles = validateNewRun(ids, cfg);
  if (typeof tiles === 'string') throw new Error(`${ids.join(',')}: ${tiles}`);
  return { id, type: 'RUN', ownerSeat: owner, colour: tiles[0].rep.colour ?? undefined, tiles };
}

function set(id: string, ids: string[], cfg: RulesConfig = DEFAULT_RULES, owner = 0): Meld {
  const tiles = validateNewSet(ids, cfg);
  if (typeof tiles === 'string') throw new Error(`${ids.join(',')}: ${tiles}`);
  return { id, type: 'SET', ownerSeat: owner, rank: tiles[0].rep.rank as Meld['rank'], tiles };
}

function ok(r: EngineResult): { state: GameState; events: GameEvent[] } {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}
const act = (s: GameState, seat: number, a: Action) => ok(applyAction(s, seat, a, NOW));
function err(r: EngineResult): string {
  if (r.ok) throw new Error('expected an error');
  return r.error;
}
const types = (events: GameEvent[]) => events.map((e) => e.type);
const reps = (m: Meld) => m.tiles.map((t) => t.rep.rank);
const tid = (c: Colour, v: number, copy = 1) => `${c}${rankCode(v)}_${copy}`;

/** The full A..K..A red run, with jokers standing for the given values. */
function fullRedRun(id: string, jokerValues: number[]): Meld {
  let j = 1;
  const ids: string[] = [];
  for (let v = 1; v <= 14; v++) ids.push(jokerValues.includes(v) ? `JK_${j++}` : tid('R', v, v === 14 ? 2 : 1));
  return run(id, ids);
}

// ---------------------------------------------------------------------------
// §1 tile set and penalties
// ---------------------------------------------------------------------------

describe('§1 tiles', () => {
  it('112 distinct tiles; penalties A=15, 10/J/Q/K=10, 2-9 face, Joker 20', () => {
    const all = buildTileSet(2, 8);
    expect(all).toHaveLength(112);
    expect(new Set(all).size).toBe(112);
    expect(all.filter((t) => t.startsWith('JK_'))).toHaveLength(8);
    expect(tilePenalty('BA_2')).toBe(15);
    for (const id of ['R10_1', 'GJ_1', 'YQ_2', 'BK_1']) expect(tilePenalty(id)).toBe(10);
    for (let r = 2; r <= 9; r++) expect(tilePenalty(`Y${r}_1`)).toBe(r);
    expect(tilePenalty('JK_8')).toBe(20);
    expect(DEFAULT_RULES.jokerPenalty).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// §2 / §3 seating and deal
// ---------------------------------------------------------------------------

describe('§2-3 seating and deal', () => {
  it('first to act is the dealer 下家; deal order follows (s+1) % N; 3p deals 20 and keeps 52', () => {
    const r = ok(startHand(createMatch({ players: players(4), seed: 99, dealer: 2 }), NOW));
    expect(r.state.firstSeat).toBe(3);
    const deals = r.events.filter((e): e is Extract<GameEvent, { type: 'DEAL' }> => e.type === 'DEAL');
    expect(deals.map((d) => d.seat)).toEqual([3, 0, 1, 2]);
    expect(r.state.players.every((p) => p.hand.length === 20)).toBe(true);
    const three = ok(startHand(createMatch({ players: players(3), seed: 5, dealer: 0 }), NOW)).state;
    expect(three.players.every((p) => p.hand.length === 20)).toBe(true);
    expect(three.deadWall).toHaveLength(52);
  });

  it('play passes to the next seat (s+1) % N', () => {
    const r345 = run('m1', ['R3_1', 'R4_1', 'R5_1']);
    const s = playState([['B2_1'], ['B3_1'], ['R6_1', 'Y9_1'], ['R2_1', 'G9_1']], [r345], {}, 2);
    const r = act(s, 2, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.turn).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §5 instant wins
// ---------------------------------------------------------------------------

describe('§5 instant wins', () => {
  it('jokers never count toward 7 / 8 identical', () => {
    const six = ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'JK_1', 'JK_2', 'GK_1', 'R9_1'];
    expect(detectInstant(six, DEFAULT_RULES, 0)).toBeNull();
    const seven = ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'G5_1', 'JK_1', 'GK_1', 'R9_1'];
    expect(detectInstant(seven, DEFAULT_RULES, 0)?.kind).toBe('GAME_7');
  });

  function twoSevens(): GameState {
    // dealer 1 -> firstSeat 2; seat 3 is nearer in turn order (distance 1) than seat 1 (distance 3)
    const s = instantState(
      [
        ['B2_1', 'Y9_1'],
        ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'G5_1', 'B9_1'],
        ['G2_1', 'R9_1'],
        ['R6_1', 'R6_2', 'B6_1', 'B6_2', 'Y6_1', 'Y6_2', 'G6_1', 'G9_1'],
      ],
      1,
      1,
    );
    s.instantOffers = [
      { seat: 1, kind: 'GAME_7', tiles: [s.players[1].hand.slice(0, 7)] },
      { seat: 3, kind: 'GAME_7', tiles: [s.players[3].hand.slice(0, 7)] },
    ];
    return s;
  }

  it('equal priority: the seat earlier in turn order from the dealer 下家 wins; others score full hands', () => {
    let s = twoSevens();
    s = act(s, 1, { type: 'DECLARE_INSTANT', declare: true }).state;
    expect(s.phase).toBe('INSTANT'); // waits on seat 3, earlier in turn order
    const r = act(s, 3, { type: 'DECLARE_INSTANT', declare: true });
    expect(r.state.lastResult).toMatchObject({ kind: 'GAME_7', winnerSeat: 3 });
    expect(r.state.lastResult!.rankings.find((x) => x.seat === 3)!.chipsDelta).toBe(3 * 240);
    expect(r.state.lastResult!.rankings.find((x) => x.seat === 1)!.points).toBe(5 * 7 + 9);

    let d = twoSevens();
    d = act(d, 3, { type: 'DECLARE_INSTANT', declare: false }).state;
    const r2 = act(d, 1, { type: 'DECLARE_INSTANT', declare: true });
    expect(r2.state.lastResult).toMatchObject({ kind: 'GAME_7', winnerSeat: 1 });
  });
});

// ---------------------------------------------------------------------------
// §6 port
// ---------------------------------------------------------------------------

describe('§6 port', () => {
  it('a run whose two naturals are split by several Jokers is a legal port (regression: false 全餐)', () => {
    // R5 J J R8 is a valid run with exactly 2 naturals, but no 3-tile window of it holds 2 naturals.
    const hand = ['R5_1', 'JK_1', 'JK_2', 'R8_1', 'B2_1', 'Y9_1', 'GK_1'];
    expect(typeof validateNewRun(['R5_1', 'JK_1', 'JK_2', 'R8_1'], DEFAULT_RULES)).not.toBe('string');
    expect(canPortHand(hand, DEFAULT_RULES)).toBe(true);
    expect(canPortHand(['R2_1', 'JK_1', 'JK_2', 'JK_3', 'R6_1'], DEFAULT_RULES)).toBe(true);
    expect(canPortHand(['RJ_1', 'JK_1', 'JK_2', 'RA_1'], DEFAULT_RULES)).toBe(true); // J Q K A(high)
    expect(canPortHand(['RJ_1', 'JK_1', 'JK_2', 'RA_1'], { ...DEFAULT_RULES, aceHigh: false })).toBe(false);
    expect(canPortHand(['R5_1', 'JK_1', 'R8_1'], DEFAULT_RULES)).toBe(false); // needs two jokers

    const s = portState([hand, ['B3_1', 'B4_1', 'B5_1', 'Y2_1'], ['G3_1', 'G4_1', 'G5_1', 'R2_1']]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.canPort).toBe(true);
    expect(legal.dead).toBe(false);
    expect(legal.portCandidates.length).toBeGreaterThan(0);
    // the timeout auto-port finds that port instead of 全餐
    const t = ok(applyTimeout(s, 1000));
    expect(t.state.players[0].status).toBe('ALIVE');
    expect(t.state.players[0].ported).toBe(true);
  });

  it('the port phase start does not mark a split-natural port hand as 全餐 (regression)', () => {
    const s = instantState(
      [
        ['R5_1', 'JK_1', 'JK_2', 'R8_1', 'B2_1'],
        ['B9_1', 'B10_1', 'BJ_1', 'Y2_2'],
        ['G3_1', 'G4_1', 'G5_1', 'R2_1'],
        ['Y3_1', 'Y4_1', 'Y6_1'],
      ],
      1,
    );
    const r = act(s, 1, { type: 'DECLARE_INSTANT', declare: false });
    expect(r.state.phase).toBe('PORT');
    expect(r.state.players[0].status).toBe('ALIVE');
    expect(r.state.players[3].status).toBe('QUANCAN'); // Y3 Y4 Y6 without a joker: truly no port
    const p = act(r.state, 0, { type: 'PORT', melds: [['R5_1', 'JK_1', 'JK_2', 'R8_1']] });
    expect(p.events).toContainEqual({ type: 'PORT_SUBMITTED', seat: 0 });
  });

  it('new run after port (option) with split naturals is listed and recognised (regression)', () => {
    const cfg = { newRunsAfterPort: true };
    const full = fullRedRun('m1', []);
    const s = playState([['B5_1', 'JK_1', 'JK_2', 'B8_1'], ['Y2_1'], ['G2_1']], [full], cfg);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.dead).toBe(false);
    expect(legal.newRuns).toContainEqual(['B5_1', 'JK_1', 'JK_2', 'B8_1']);
  });

  it('several runs in one port; sets refused by default; nothing visible until everyone submitted', () => {
    let s = portState([
      ['R2_1', 'R3_1', 'R4_1', 'B7_1', 'B8_1', 'B9_1', 'Y9_1', 'G9_1', 'R5_1'],
      ['G2_1', 'G3_1', 'G4_1', 'G9_2'],
      ['Y2_1', 'Y3_1', 'Y4_1', 'Y9_2'],
    ]);
    expect(err(applyAction(s, 0, { type: 'PORT', melds: [['B9_1', 'Y9_1', 'G9_1']] }, NOW))).toBeTypeOf('string');
    expect(err(applyAction(s, 0, { type: 'PORT', melds: [['R2_1', 'JK_1', 'JK_2']] }, NOW))).toBeTypeOf('string');
    s = act(s, 0, { type: 'PORT', melds: [['R2_1', 'R3_1', 'R4_1'], ['B7_1', 'B8_1', 'B9_1']] }).state;
    expect(s.melds).toHaveLength(0);
    for (const seat of [1, 2, -1]) {
      const v = JSON.stringify(projectView(s, seat));
      expect(v).not.toContain('R2_1');
      expect(v).not.toContain('B7_1');
    }
    s = act(s, 1, { type: 'PORT', melds: [['G2_1', 'G3_1', 'G4_1']] }).state;
    const r = act(s, 2, { type: 'PORT', melds: [['Y2_1', 'Y3_1', 'Y4_1']] });
    expect(r.state.melds).toHaveLength(4);
    expect(r.state.phase).toBe('PLAY');
  });

  it('simultaneous 全餐 players share one Dead order, so tie-break 3 (turn order) decides (regression)', () => {
    // seats 1 and 2 cannot port and hold 11 points in 2 tiles each; seat 0 ports out (天糊).
    const s = instantState(
      [
        ['R2_1', 'R3_1', 'R4_1'],
        ['B2_1', 'Y9_1'],
        ['G2_1', 'R9_1'],
        ['Y5_1', 'Y6_1', 'Y7_1', 'GK_1'],
      ],
      3,
    );
    let t = act(s, 3, { type: 'DECLARE_INSTANT', declare: false }).state;
    expect(t.players[1].status).toBe('QUANCAN');
    expect(t.players[2].status).toBe('QUANCAN');
    expect(t.players[1].deadOrder).toBe(t.players[2].deadOrder);
    t = act(t, 3, { type: 'PORT', melds: [['Y5_1', 'Y6_1', 'Y7_1']] }).state;
    const r = act(t, 0, { type: 'PORT', melds: [['R2_1', 'R3_1', 'R4_1']] });
    expect(r.state.lastResult!.kind).toBe('TIANHU');
    expect(r.state.lastResult!.rankings.map((x) => x.seat)).toEqual([0, 3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// §7 play phase
// ---------------------------------------------------------------------------

describe('§7 play', () => {
  const r345 = run('m1', ['R3_1', 'R4_1', 'R5_1']);

  it('斩 is blocked by any extend on any run, including one only reachable after a Joker swap', () => {
    const other = run('m2', ['B6_1', 'B7_1', 'B8_1'], DEFAULT_RULES, 2);
    const s = playState([['B9_1', 'Y9_1', 'G9_1', 'R9_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [r345, other]);
    expect(getLegalMoves(s, 0)!.cutBlocked).toBe(true);
    expect(err(applyAction(s, 0, { type: 'CUT', tiles: ['Y9_1', 'G9_1', 'R9_1'] }, NOW))).toBe('You must extend when you can');

    const rj = run('m1', ['R3_1', 'JK_1', 'R5_1']);
    const sw = playState([['R4_1', 'Y9_1', 'G9_1', 'B9_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [rj]);
    const legal = getLegalMoves(sw, 0)!;
    expect(legal.cutBlocked).toBe(true);
    expect(legal.cuts).toEqual([]);
    expect(legal.dead).toBe(false);
    expect(err(applyAction(sw, 0, { type: 'CUT', tiles: ['Y9_1', 'G9_1', 'B9_1'] }, NOW))).toBe('You must extend when you can');
  });

  it('跟斩 is always available when a matching set exists, even while 斩 is blocked', () => {
    const nines = set('m2', ['B9_1', 'Y9_1', 'G9_1']);
    const s = playState([['R6_1', 'R9_1', 'R9_2', 'B9_2'], ['B2_1'], ['Y2_1'], ['G2_1']], [r345, nines]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.cutBlocked).toBe(true);
    expect(legal.follows.some((f) => f.meldId === 'm2')).toBe(true);
    const r = act(s, 0, { type: 'FOLLOW_CUT', meldId: 'm2', tiles: ['R9_1', 'R9_2'] });
    expect(r.state.melds[1].tiles).toHaveLength(5); // duplicate colours allowed
  });

  it('swap needs the exact represented tile: run = same colour and rank, set = same rank any colour', () => {
    const rj = run('m1', ['R3_1', 'JK_1', 'R5_1']);
    const sj = set('m2', ['B9_1', 'Y9_1', 'JK_2']);
    const qk = run('m3', ['YQ_1', 'YK_1', 'JK_3']); // the joker stands for the high ace
    expect(reps(qk)).toEqual([12, 13, 14]);
    expect(canSwapJoker(rj, 'JK_1', 'B4_1')).toBe(false);
    expect(canSwapJoker(rj, 'JK_1', 'R5_2')).toBe(false);
    expect(canSwapJoker(rj, 'JK_1', 'R4_2')).toBe(true);
    expect(canSwapJoker(sj, 'JK_2', 'R9_1')).toBe(true);
    expect(canSwapJoker(sj, 'JK_2', 'B9_2')).toBe(true);
    expect(canSwapJoker(sj, 'JK_2', 'R8_1')).toBe(false);
    expect(canSwapJoker(qk, 'JK_3', 'YA_2')).toBe(true);
    expect(canSwapJoker(qk, 'JK_3', 'RA_2')).toBe(false);
    expect(canSwapJoker(rj, 'R3_1', 'R3_2')).toBe(false); // not a joker
  });

  it('swap is free, the Joker is kept, reps never change; not allowed off-turn, in the port window, or before porting', () => {
    const rj = run('m1', ['R3_1', 'JK_1', 'R5_1']);
    const s = playState([['R4_1', 'R6_1', 'B2_1'], ['R7_1'], ['Y2_1'], ['G2_1']], [rj]);
    expect(err(applyAction(s, 1, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' }, NOW))).toBe(
      'Not your turn',
    );
    const sw = act(s, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' });
    expect(sw.state.turn).toBe(0);
    expect(sw.state.players[0].actionsThisTurn).toBe(0);
    expect(reps(sw.state.melds[0])).toEqual([3, 4, 5]);
    const e = act(sw.state, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(e.state.players[0].hand).toContain('JK_1');
    expect(e.state.turn).toBe(1);

    const port = portState([['R4_1', 'R6_1', 'R7_1', 'R8_1'], ['B3_1', 'B4_1', 'B5_1'], ['Y2_1', 'Y3_1', 'Y4_1']]);
    port.melds = [structuredClone(rj)];
    expect(err(applyAction(port, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' }, NOW))).toBe(
      'Not your turn',
    );
    const seq = playState([['R4_1', 'R6_1', 'R7_1', 'R8_1'], ['B3_1'], ['Y2_1']], [rj], { portTiming: 'sequential' });
    seq.phase = 'PORT';
    seq.players[0].ported = false;
    expect(err(applyAction(seq, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' }, NOW))).toBe(
      'You must port first',
    );
  });

  it('the first turn skips a 全餐 dealer 下家, and Dead players are skipped', () => {
    const s = instantState(
      [
        ['B2_1', 'Y9_1'],
        ['G2_1', 'G3_1', 'G4_1', 'G5_1', 'B9_1'],
        ['Y2_1', 'Y3_1', 'Y4_1', 'Y9_2'],
        ['R2_1', 'R3_1', 'R4_1', 'R6_1'],
      ],
      1,
    );
    let t = act(s, 1, { type: 'DECLARE_INSTANT', declare: false }).state;
    expect(t.players[0].status).toBe('QUANCAN');
    t = act(t, 1, { type: 'PORT', melds: [['G2_1', 'G3_1', 'G4_1']] }).state;
    t = act(t, 2, { type: 'PORT', melds: [['Y2_1', 'Y3_1', 'Y4_1']] }).state;
    const r = act(t, 3, { type: 'PORT', melds: [['R2_1', 'R3_1', 'R4_1']] });
    expect(r.state.turn).toBe(1); // seat 0 is out; seat 1 can extend G2-G4 with G5
    const e = act(r.state, 1, { type: 'EXTEND', meldId: r.state.melds[0].id, low: [], high: ['G5_1'] });
    // seat 2 holds Y9 only -> Dead; seat 3 holds R6 -> extends R2-R4? no (R5 missing) -> Dead; seat 1 B9 -> Dead
    expect(e.state.phase).toBe('HAND_END');
    expect(e.events.filter((x) => x.type === 'PLAYER_DEAD').map((x) => (x.type === 'PLAYER_DEAD' ? x.seat : -1))).toEqual([2, 3, 1]);
  });

  it('a lone alive player keeps taking turns', () => {
    const r345b = run('m1', ['R3_1', 'R4_1', 'R5_1']);
    const s = playState([['R6_1', 'R7_1', 'B2_1'], ['Y9_1'], ['G9_1']], [r345b]);
    s.players[1].status = 'DEAD';
    s.players[1].deadOrder = 1;
    s.players[2].status = 'QUANCAN';
    s.players[2].deadOrder = 1;
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.turn).toBe(0);
    expect(r.state.phase).toBe('PLAY');
  });

  it('emptying the hand by 斩 or 跟斩 is Game牌', () => {
    const full = fullRedRun('m1', []);
    const cut = playState([['B9_1', 'Y9_1', 'G9_1'], ['B2_1'], ['Y2_1']], [full]);
    const r = act(cut, 0, { type: 'CUT', tiles: ['B9_1', 'Y9_1', 'G9_1'] });
    expect(types(r.events)).toEqual(['MELD_CREATED', 'GAME_PAI', 'HAND_END']);
    expect(r.state.lastResult!.kind).toBe('GAME');

    const nines = set('m2', ['B9_1', 'Y9_1', 'G9_1']);
    const fol = playState([['R9_1', 'JK_1'], ['B2_1'], ['Y2_1']], [full, nines]);
    const f = act(fol, 0, { type: 'FOLLOW_CUT', meldId: 'm2', tiles: ['R9_1', 'JK_1'] });
    expect(types(f.events)).toEqual(['SET_FOLLOWED', 'GAME_PAI', 'HAND_END']);
  });

  describe('Dead detection considers Joker-swap sequences (regression)', () => {
    // A full A..A red run (no open end) whose jokers stand for 2 and 3; no sets on the table.
    // With 1 natural required (option), B5 + two retrieved jokers is a legal 斩, but only after BOTH swaps.
    const cfg: Partial<RulesConfig> = { minNaturalsInNewMeld: 1 };
    const full = fullRedRun('m1', [2, 3]);

    it('legal moves are not Dead and list the first swap; the sequence is accepted', () => {
      const s = playState([['R2_1', 'R3_1', 'B5_1'], ['B2_1'], ['Y2_1']], [full], cfg);
      const legal = getLegalMoves(s, 0)!;
      expect(legal.dead).toBe(false);
      expect(legal.swaps.length).toBe(2);
      let t = act(s, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R2_1' }).state;
      expect(getLegalMoves(t, 0)!.dead).toBe(false);
      t = act(t, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_2', withTileId: 'R3_1' }).state;
      const r = act(t, 0, { type: 'CUT', tiles: ['B5_1', 'JK_1', 'JK_2'] });
      expect(r.state.lastResult?.kind).toBe('GAME');
    });

    it('turn start does not mark the player Dead; the timeout auto-play finds the swap path', () => {
      // seat 2 has no move and times out (Dead), handing the turn to seat 0
      const s = playState([['R2_1', 'R3_1', 'B5_1'], ['B2_1'], ['Y9_1']], [full], cfg, 2);
      s.players[1].status = 'DEAD';
      s.players[1].deadOrder = 1;
      s.deadCounter = 1;
      const t = ok(applyTimeout(s, 1000));
      expect(t.state.players[2].status).toBe('DEAD');
      expect(t.state.players[0].status).toBe('ALIVE');
      expect(t.state.turn).toBe(0);
      const auto = ok(applyTimeout(t.state, t.state.deadline!));
      expect(types(auto.events)).toEqual(['TIMEOUT', 'JOKER_SWAPPED', 'JOKER_SWAPPED', 'MELD_CREATED', 'GAME_PAI', 'HAND_END']);
    });
  });
});

// ---------------------------------------------------------------------------
// §8 meld definitions
// ---------------------------------------------------------------------------

describe('§8 melds', () => {
  const cfg = DEFAULT_RULES;

  it('ace low or high, never wrapping; aceHigh off forbids Q-K-A', () => {
    expect(reps(run('a', ['RA_1', 'R2_1', 'R3_1']))).toEqual([1, 2, 3]);
    expect(reps(run('a', ['RQ_1', 'RK_1', 'RA_1']))).toEqual([12, 13, 14]);
    expect(validateNewRun(['RK_1', 'RA_1', 'R2_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['RK_1', 'JK_1', 'R2_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['JK_1', 'RA_1', 'R2_1'], cfg)).toBeTypeOf('string'); // joker would be K -> wrap
    expect(validateNewRun(['RQ_1', 'RK_1', 'RA_1'], { ...cfg, aceHigh: false })).toBeTypeOf('string');
    const low = run('a', ['RA_1', 'R2_1', 'R3_1']);
    expect(validateExtend(low, ['RK_1'], [], cfg, [low])).toBeTypeOf('string');
    expect(validateExtend(low, ['JK_1'], [], cfg, [low])).toBeTypeOf('string');
    const high = run('b', ['RQ_1', 'RK_1', 'RA_1']);
    expect(validateExtend(high, [], ['R2_1'], cfg, [high])).toBeTypeOf('string');
    expect(validateExtend(high, [], ['JK_1'], cfg, [high])).toBeTypeOf('string');
    const jqk = run('c', ['RJ_1', 'RQ_1', 'RK_1']);
    expect(validateExtend(jqk, [], ['RA_1'], { ...cfg, aceHigh: false }, [jqk])).toBeTypeOf('string');
  });

  it('the 14-length A..K..A run is reachable by extending both ends in one action, and nothing goes past it', () => {
    const mid = run('m1', ['R2_1', 'R3_1', 'R4_1', 'R5_1', 'R6_1', 'R7_1', 'R8_1', 'R9_1', 'R10_1', 'RJ_1', 'RQ_1', 'RK_1']);
    const s = playState([['RA_1', 'RA_2', 'JK_1', 'B2_1'], ['Y2_1'], ['G2_1']], [mid]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.extends).toContainEqual({ meldId: 'm1', low: ['RA_1'], high: ['RA_2'] });
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: ['RA_1'], high: ['RA_2'] });
    const m = r.state.melds[0];
    expect(m.tiles).toHaveLength(14);
    expect(reps(m)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(validateExtend(m, ['JK_1'], [], cfg, [m])).toBeTypeOf('string');
    expect(validateExtend(m, [], ['JK_1'], cfg, [m])).toBeTypeOf('string');
    expect(validateNewRun([...m.tiles.map((t) => t.tileId), 'JK_2'], cfg)).toBeTypeOf('string');
  });

  it('a Joker added at an end takes the end the player chooses, and keeps that rep', () => {
    const s = playState([['JK_1', 'B2_1'], ['Y2_1'], ['G2_1']], [run('m1', ['R5_1', 'R6_1', 'R7_1'])]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.extends).toContainEqual({ meldId: 'm1', low: ['JK_1'], high: [] });
    expect(legal.extends).toContainEqual({ meldId: 'm1', low: [], high: ['JK_1'] });
    const lo = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: ['JK_1'], high: [] }).state.melds[0];
    expect(lo.tiles[0]).toEqual({ tileId: 'JK_1', rep: { colour: 'R', rank: 4 } });
    const hi = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['JK_1'] }).state.melds[0];
    expect(hi.tiles[3]).toEqual({ tileId: 'JK_1', rep: { colour: 'R', rank: 8 } });
    // in a new run a joker stands where it is placed
    expect(reps(run('x', ['JK_2', 'R5_2', 'R6_2']))).toEqual([4, 5, 6]);
    expect(reps(run('x', ['R5_2', 'JK_2', 'R7_2']))).toEqual([5, 6, 7]);
  });

  it('min 2 naturals on creation (port, 斩, new run) but not on extension or 跟斩', () => {
    expect(validateNewRun(['R5_1', 'JK_1', 'JK_2'], cfg)).toBeTypeOf('string');
    expect(validateNewSet(['B9_1', 'JK_1', 'JK_2'], cfg)).toBeTypeOf('string');
    const full = fullRedRun('m9', []);
    const s = playState([['B9_1', 'JK_1', 'JK_2', 'Y2_1'], ['G2_1'], ['Y3_1']], [full]);
    expect(err(applyAction(s, 0, { type: 'CUT', tiles: ['B9_1', 'JK_1', 'JK_2'] }, NOW))).toMatch(/natural/);
    const r5 = run('m1', ['R5_1', 'R6_1', 'R7_1']);
    const nines = set('m2', ['B9_2', 'Y9_1', 'G9_1']);
    const e = playState([['JK_1', 'JK_2', 'Y2_1'], ['G2_1'], ['Y3_1']], [r5, nines]);
    expect(act(e, 0, { type: 'EXTEND', meldId: 'm1', low: ['JK_1'], high: ['JK_2'] }).state.melds[0].tiles).toHaveLength(5);
    expect(act(e, 0, { type: 'FOLLOW_CUT', meldId: 'm2', tiles: ['JK_1'] }).state.melds[1].tiles).toHaveLength(4);
  });

  it('sets: any colours, duplicates allowed, no size cap by default', () => {
    expect(validateNewSet(['B9_1', 'B9_2', 'Y9_1'], cfg)).not.toBeTypeOf('string');
    const all9 = COLOURS.flatMap((c) => [`${c}9_1`, `${c}9_2`]);
    expect(validateNewSet([...all9, 'JK_1', 'JK_2'], cfg)).not.toBeTypeOf('string');
    expect(validateNewSet(['B9_1', 'B8_1', 'Y9_1'], cfg)).toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// §9 / §10 scoring, ranking, payouts
// ---------------------------------------------------------------------------

describe('§9-10 scoring and payouts', () => {
  const r345 = run('m1', ['R3_1', 'R4_1', 'R5_1']);

  it('tie-breaks: fewer tiles, then later Dead (alive beats Dead), then turn order from the dealer 下家', () => {
    // seat 0 extends with R6 and then everyone is Dead (lowest-points end)
    // seat 1: 5 pts in 1 tile; seat 2: 5 pts in 2 tiles; seat 3: 5 pts in 2 tiles, Dead later than seat 2
    const s = playState([['R6_1', 'BK_1', 'YK_1'], ['B5_1'], ['Y2_1', 'Y3_1'], ['G2_1', 'G3_1']], [r345]);
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    const res = r.state.lastResult!;
    expect(res.kind).toBe('LOWEST');
    expect(res.rankings.map((x) => x.seat)).toEqual([1, 3, 2, 0]);
    expect(res.rankings.map((x) => x.chipsDelta)).toEqual([30 + 60 + 90, -30, -60, -90]);

  });

  it('3-player ladder is 3u / 6u; 天糊 pays 48u; payments are capped at the payer chips', () => {
    const s = playState([['R6_1', 'BK_1'], ['B5_1'], ['Y2_1', 'Y3_1']], [r345]);
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.lastResult!.rankings.map((x) => x.chipsDelta)).toEqual([90, -30, -60]);

    const p = portState([['R2_1', 'R3_1', 'R4_1'], ['G2_1', 'G3_1', 'G4_1', 'G9_1'], ['Y2_1', 'Y3_1', 'Y4_1', 'R9_1']]);
    p.players[1].chips = 100;
    let t = act(p, 1, { type: 'PORT', melds: [['G2_1', 'G3_1', 'G4_1']] }).state;
    t = act(t, 2, { type: 'PORT', melds: [['Y2_1', 'Y3_1', 'Y4_1']] }).state;
    const w = act(t, 0, { type: 'PORT', melds: [['R2_1', 'R3_1', 'R4_1']] }).state;
    expect(w.lastResult!.kind).toBe('TIANHU');
    expect(w.players.map((x) => x.chips)).toEqual([1000 + 100 + 480, 0, 1000 - 480]);
    const n = ok(nextHand(w, NOW));
    expect(n.state.phase).toBe('MATCH_END'); // bankruptcy ends the match after that hand
  });

  it('a Joker left in hand counts 20 for 全餐 / Dead players', () => {
    const s = playState([['R6_1', 'BK_1'], ['JK_1', 'B9_1'], ['Y2_1']], [r345]);
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    // seat 1 holds a joker: it can extend the run, so it is not Dead; it plays and so on
    expect(r.state.turn).toBe(1);
    const q = playState([['R6_1', 'BK_1'], ['B2_1'], ['Y2_1']], [r345]);
    q.players[1].hand = ['JK_1', 'B9_1'];
    q.players[1].status = 'QUANCAN';
    q.players[1].deadOrder = 1;
    q.deadCounter = 1;
    const r2 = act(q, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r2.state.lastResult!.rankings.find((x) => x.seat === 1)!.points).toBe(29);
  });
});

// ---------------------------------------------------------------------------
// §10-12 match length, dealer rotation, options
// ---------------------------------------------------------------------------

describe('§10-12 match settings', () => {
  it('handsPerMatch defaults: 4p = 8, 3p = 6; explicit value kept', () => {
    expect(resolveRules({ players: 4 }).handsPerMatch).toBe(8);
    expect(resolveRules({ players: 3 }).handsPerMatch).toBe(6);
    expect(resolveRules().handsPerMatch).toBe(8);
    expect(resolveRules({ players: 3, handsPerMatch: 2 }).handsPerMatch).toBe(2);
    expect(createMatch({ players: players(3), seed: 1 }).cfg.handsPerMatch).toBe(6);
    expect(createMatch({ players: players(4), seed: 1 }).cfg.handsPerMatch).toBe(8);
  });

  it('dealer rotates to the 下家 by default and to the winner when toggled', () => {
    const r345 = run('m1', ['R3_1', 'R4_1', 'R5_1']);
    const end = (cfg: Partial<RulesConfig>) => {
      const s = playState([['B2_1'], ['B3_1'], ['R6_1'], ['G2_1']], [r345], cfg, 2);
      s.dealer = 0;
      s.firstSeat = 1;
      return act(s, 2, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] }).state;
    };
    expect(ok(nextHand(end({}), NOW)).state.dealer).toBe(1);
    expect(ok(nextHand(end({ dealerRotation: 'winner' }), NOW)).state.dealer).toBe(2);
    const n = ok(nextHand(end({}), NOW)).state;
    expect(n.firstSeat).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

function collectStrings(x: unknown, out: Set<string>): Set<string> {
  if (typeof x === 'string') out.add(x);
  else if (Array.isArray(x)) for (const v of x) collectStrings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) collectStrings(v, out);
  return out;
}

describe('projection', () => {
  it('views and events never carry another seat hand, pending port, offer tiles or the dead wall', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = ok(startHand(createMatch({ players: players(4), seed, dealer: seed % 4 }), NOW));
      let s = r.state;
      const evs = r.events;
      // submit one port (if in the port window) so a pending port exists
      if (s.phase === 'PORT') {
        const seat = s.players.find((p) => p.status === 'ALIVE')!.seat;
        const legal = getLegalMoves(s, seat);
        if (legal?.portCandidates[0]) s = act(s, seat, { type: 'PORT', melds: [legal.portCandidates[0]] }).state;
      }
      for (let v = -1; v < 4; v++) {
        const strings = collectStrings(projectView(s, v), new Set());
        const evStrings = collectStrings(projectEvents(evs, v), new Set());
        const tableIds = new Set(s.melds.flatMap((m) => m.tiles.map((t) => t.tileId)));
        for (const id of s.deadWall) expect(strings.has(id) || evStrings.has(id)).toBe(false);
        for (const p of s.players) {
          if (p.seat === v) continue;
          for (const id of p.hand) {
            if (tableIds.has(id)) continue;
            expect(strings.has(id), `seat ${v} sees ${id} of seat ${p.seat}`).toBe(false);
            expect(evStrings.has(id), `seat ${v} events show ${id} of seat ${p.seat}`).toBe(false);
          }
          for (const id of (p.pendingPort ?? []).flat()) expect(strings.has(id)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz: getLegalMoves vs brute-force enumerators
// ---------------------------------------------------------------------------

interface Pos {
  hand: string[];
  melds: Meld[];
}

const uniq = (xs: string[]) => [...new Set(xs)];

function bruteExtends(pos: Pos, cfg: RulesConfig): { meldId: string; side: 'low' | 'high' }[] {
  const out: { meldId: string; side: 'low' | 'high' }[] = [];
  for (const m of pos.melds) {
    if (m.type !== 'RUN') continue;
    let low = false;
    let high = false;
    for (const t of uniq(pos.hand)) {
      if (!low && typeof validateExtend(m, [t], [], cfg, pos.melds) !== 'string') low = true;
      if (!high && typeof validateExtend(m, [], [t], cfg, pos.melds) !== 'string') high = true;
    }
    if (low) out.push({ meldId: m.id, side: 'low' });
    if (high) out.push({ meldId: m.id, side: 'high' });
  }
  return out;
}

function bruteFollows(pos: Pos, cfg: RulesConfig): string[] {
  return pos.melds
    .filter((m) => m.type === 'SET' && pos.hand.some((t) => typeof validateFollow(m, [t], cfg) !== 'string'))
    .map((m) => m.id);
}

function bruteCut(pos: Pos, cfg: RulesConfig): boolean {
  const h = pos.hand;
  for (let a = 0; a < h.length; a++)
    for (let b = a + 1; b < h.length; b++)
      for (let c = b + 1; c < h.length; c++) if (typeof validateNewSet([h[a], h[b], h[c]], cfg) !== 'string') return true;
  return false;
}

function bruteSwaps(pos: Pos, cfg: RulesConfig): { meldId: string; jokerTileId: string; withTileId: string; post: Pos }[] {
  if (cfg.jokerSwap === 'off') return [];
  const out: { meldId: string; jokerTileId: string; withTileId: string; post: Pos }[] = [];
  for (const m of pos.melds) {
    for (const slot of m.tiles) {
      if (!tileFromId(slot.tileId).joker) continue;
      for (const id of uniq(pos.hand)) {
        const t = tileFromId(id);
        if (t.joker || !canSwapJoker(m, slot.tileId, id)) continue;
        if (m.type === 'SET' && cfg.setCapFourDistinct) {
          const cols = m.tiles.map((x) => tileFromId(x.tileId)).filter((x) => !x.joker).map((x) => x.colour);
          if (cols.includes(t.colour)) continue;
        }
        const nm: Meld = { ...m, tiles: m.tiles.map((x) => (x.tileId === slot.tileId ? { tileId: id, rep: x.rep } : x)) };
        out.push({
          meldId: m.id,
          jokerTileId: slot.tileId,
          withTileId: id,
          post: { hand: [...pos.hand.filter((x) => x !== id), slot.tileId], melds: pos.melds.map((x) => (x.id === m.id ? nm : x)) },
        });
      }
    }
  }
  return out;
}

function bruteExtendPossible(pos: Pos, cfg: RulesConfig): boolean {
  return bruteExtends(pos, cfg).length > 0 || bruteSwaps(pos, cfg).some((s) => bruteExtends(s.post, cfg).length > 0);
}

function bruteCutAllowed(pos: Pos, cfg: RulesConfig): boolean {
  return !cfg.cutOnlyWhenCannotExtend || !bruteExtendPossible(pos, cfg);
}

function bruteDirect(pos: Pos, cfg: RulesConfig): boolean {
  return bruteExtends(pos, cfg).length > 0 || bruteFollows(pos, cfg).length > 0 || (bruteCut(pos, cfg) && bruteCutAllowed(pos, cfg));
}

function posKey(pos: Pos): string {
  return [...pos.hand].sort().join(',') + '|' + pos.melds.map((m) => m.tiles.map((t) => t.tileId).join(',')).join(';');
}

/** Alive = a primary action now, or after any sequence of Joker swaps. */
function bruteAlive(pos: Pos, cfg: RulesConfig, memo = new Map<string, boolean>()): boolean {
  const k = posKey(pos);
  const hit = memo.get(k);
  if (hit !== undefined) return hit;
  memo.set(k, false);
  const res = bruteDirect(pos, cfg) || bruteSwaps(pos, cfg).some((s) => bruteAlive(s.post, cfg, memo));
  memo.set(k, res);
  return res;
}

/** Random table + hand, biased toward tiles that interact with the table. */
function randomPos(rng: Rng, cfg: RulesConfig): Pos {
  const pool = new Set(rng.shuffle(buildTileSet(2, cfg.jokers)));
  const take = (id: string): boolean => pool.delete(id);
  const jokerFromPool = (): string | null => {
    for (const id of pool) if (id.startsWith('JK_')) return pool.delete(id) ? id : null;
    return null;
  };
  const natFromPool = (c: Colour, v: number): string | null => {
    for (const copy of [1, 2]) {
      const id = tid(c, v === 14 ? 1 : v, copy);
      if (take(id)) return id;
    }
    return null;
  };
  const maxV = cfg.aceHigh ? 14 : 13;
  const melds: Meld[] = [];
  const nRuns = rng.int(4);
  for (let i = 0; i < nRuns; i++) {
    const c = COLOURS[rng.int(4)];
    const L = 3 + rng.int(rng.next() < 0.2 ? maxV - 2 : 5);
    const s = 1 + rng.int(maxV - L + 1);
    const ids: string[] = [];
    for (let v = s; v < s + L; v++) {
      const id = (rng.next() < 0.2 ? jokerFromPool() : null) ?? natFromPool(c, v) ?? jokerFromPool();
      if (!id) break;
      ids.push(id);
    }
    const tiles = validateNewRun(ids, cfg);
    if (typeof tiles === 'string') continue;
    melds.push({ id: `m${melds.length + 1}`, type: 'RUN', ownerSeat: 1, colour: c, tiles });
  }
  const nSets = rng.int(3);
  for (let i = 0; i < nSets; i++) {
    const rank = 1 + rng.int(13);
    const ids: string[] = [];
    const n = 2 + rng.int(3);
    for (const c of rng.shuffle([...COLOURS, ...COLOURS])) {
      if (ids.length >= n) break;
      const id = natFromPool(c, rank);
      if (id) ids.push(id);
    }
    if (rng.next() < 0.4) {
      const j = jokerFromPool();
      if (j) ids.push(j);
    }
    const tiles = validateNewSet(ids, cfg);
    if (typeof tiles === 'string') continue;
    melds.push({ id: `m${melds.length + 1}`, type: 'SET', ownerSeat: 2, rank: tiles[0].rep.rank as Meld['rank'], tiles });
  }
  const hand: string[] = [];
  const size = 1 + rng.int(9);
  for (let i = 0; i < size * 3 && hand.length < size; i++) {
    const roll = rng.next();
    let id: string | null = null;
    if (roll < 0.25 && melds.length > 0) {
      const m = melds[rng.int(melds.length)];
      if (m.type === 'RUN') {
        const v = rng.next() < 0.5 ? m.tiles[0].rep.rank - 1 : m.tiles[m.tiles.length - 1].rep.rank + 1;
        if (v >= 1 && v <= 14) id = natFromPool(m.colour as Colour, v);
      } else id = natFromPool(COLOURS[rng.int(4)], m.rank as number);
    } else if (roll < 0.4 && melds.length > 0) {
      const slots = melds.flatMap((m) => m.tiles.filter((t) => tileFromId(t.tileId).joker).map((t) => ({ m, t })));
      if (slots.length > 0) {
        const { m, t } = slots[rng.int(slots.length)];
        id = natFromPool((t.rep.colour ?? COLOURS[rng.int(4)]) as Colour, m.type === 'SET' ? (m.rank as number) : t.rep.rank);
      }
    } else if (roll < 0.5) {
      id = jokerFromPool();
    } else if (roll < 0.62 && hand.length > 0) {
      const t = tileFromId(hand[rng.int(hand.length)]);
      if (!t.joker) id = natFromPool(COLOURS[rng.int(4)], t.rank as number); // pairs / triples for cuts
    }
    if (!id) {
      const rest = [...pool];
      id = rest[rng.int(rest.length)];
      pool.delete(id);
    }
    hand.push(id);
  }
  return { hand, melds };
}

function listedPrimaries(l: LegalMoves): Action[] {
  return [
    ...l.extends.map((e): Action => ({ type: 'EXTEND', ...e })),
    ...l.follows.map((f): Action => ({ type: 'FOLLOW_CUT', ...f })),
    ...l.cuts.map((c): Action => ({ type: 'CUT', tiles: c })),
    ...l.newRuns.map((r): Action => ({ type: 'NEW_RUN', tiles: r })),
  ];
}

const FUZZ_CFGS: Partial<RulesConfig>[] = [
  {},
  { minNaturalsInNewMeld: 1 },
  { aceHigh: false },
  { setCapFourDistinct: true },
  { setPriority: true },
  { cutOnlyWhenCannotExtend: false },
  { jokerSwap: 'off' },
  { minNaturalsInNewMeld: 1, setCapFourDistinct: true, jokers: 12 },
  { minNaturalsInNewMeld: 3 },
];

describe('fuzz: getLegalMoves agrees with brute force', () => {
  it('play positions: Dead, listed moves, cut precondition and swaps', { timeout: 60_000 }, () => {
    const rng = new Rng(20261013);
    let checked = 0;
    let deadSeen = 0;
    let swapOnly = 0;
    for (const partial of FUZZ_CFGS) {
      const cfg = resolveRules({ ...partial, players: 3 });
      for (let i = 0; i < 450; i++) {
        const pos = randomPos(rng, cfg);
        const s = playState([pos.hand, ['B2_2'], ['Y2_2']], pos.melds, { ...partial });
        // the filler tiles may collide with a generated tile; that is irrelevant for seat 0's moves
        const legal = getLegalMoves(s, 0)!;
        const ctx = `cfg=${JSON.stringify(partial)} hand=${pos.hand.join(',')} melds=${pos.melds
          .map((m) => m.tiles.map((t) => t.tileId).join(' '))
          .join(' | ')}`;
        const alive = bruteAlive(pos, cfg);
        const direct = bruteDirect(pos, cfg);
        expect(legal.dead, `dead mismatch: ${ctx}`).toBe(!alive);
        if (!alive) deadSeen++;
        if (alive && !direct) swapOnly++;

        const prim = listedPrimaries(legal);
        expect(prim.length > 0, `direct move exists but none listed: ${ctx}`).toBe(direct);
        for (const e of bruteExtends(pos, cfg)) {
          const hit = legal.extends.some((x) => x.meldId === e.meldId && (e.side === 'low' ? x.low.length > 0 : x.high.length > 0));
          expect(hit, `extend ${e.meldId}/${e.side} missing: ${ctx}`).toBe(true);
        }
        for (const id of bruteFollows(pos, cfg)) expect(legal.follows.some((f) => f.meldId === id), `follow ${id}: ${ctx}`).toBe(true);
        const cutOk = bruteCutAllowed(pos, cfg);
        expect(legal.cutBlocked, `cutBlocked: ${ctx}`).toBe(cfg.cutOnlyWhenCannotExtend && bruteExtendPossible(pos, cfg));
        if (bruteCut(pos, cfg) && cutOk) expect(legal.cuts.length > 0, `cut missing: ${ctx}`).toBe(true);
        if (!cutOk) expect(legal.cuts).toEqual([]);

        // swaps: listed iff the swap leaves the player alive (by natural kind)
        const kind = (id: string) => {
          const t = tileFromId(id);
          return `${t.colour}${t.rank}`;
        };
        for (const b of bruteSwaps(pos, cfg)) {
          const listed = legal.swaps.some((w) => w.meldId === b.meldId && w.jokerTileId === b.jokerTileId && kind(w.withTileId) === kind(b.withTileId));
          expect(listed, `swap ${b.jokerTileId}<-${b.withTileId} listed=${listed}: ${ctx}`).toBe(bruteAlive(b.post, cfg));
        }

        // soundness: every listed move is accepted
        for (const a of prim.slice(0, 12)) {
          const r = applyAction(s, 0, a, NOW);
          expect(r.ok, `listed ${JSON.stringify(a)} rejected (${r.ok ? '' : r.error}): ${ctx}`).toBe(true);
        }
        for (const w of legal.swaps.slice(0, 6)) {
          const r = applyAction(s, 0, { type: 'SWAP_JOKER', ...w }, NOW);
          expect(r.ok, `listed swap rejected: ${ctx}`).toBe(true);
        }
        // a timeout never throws, and marks the player Dead exactly when no move is reachable
        const t = ok(applyTimeout(s, 1000));
        const timedOutDead = t.events.some((e) => e.type === 'PLAYER_DEAD' && e.seat === 0 && e.reason === 'TIMEOUT');
        expect(timedOutDead, `timeout outcome: ${ctx}`).toBe(!alive);
        checked++;
      }
    }
    expect(checked).toBe(FUZZ_CFGS.length * 450);
    expect(deadSeen).toBeGreaterThan(20);
    expect(swapOnly).toBeGreaterThan(0);
  });

  it('closed tables (full A..A runs, no open end): Dead and swaps over swap sequences', { timeout: 60_000 }, () => {
    const rng = new Rng(4242);
    let multi = 0;
    for (const partial of [{ minNaturalsInNewMeld: 1 }, { minNaturalsInNewMeld: 1, setCapFourDistinct: true }, {}, { newRunsAfterPort: true, minNaturalsInNewMeld: 1 }]) {
      const cfg = resolveRules({ ...partial, players: 3, jokers: 12 });
      for (let i = 0; i < 300; i++) {
        const melds: Meld[] = [];
        let j = 1;
        const hand: string[] = [];
        const nRuns = 1 + rng.int(2);
        for (let k = 0; k < nRuns; k++) {
          const c = COLOURS[k * 2 + rng.int(2)];
          const ids: string[] = [];
          for (let v = 1; v <= 14; v++) {
            if (v !== 1 && v !== 14 && rng.next() < 0.25 && j <= 12) {
              ids.push(`JK_${j++}`);
              if (rng.next() < 0.6) hand.push(tid(c, v, 1)); // the natural the joker stands for
            } else ids.push(tid(c, v, v === 14 ? 2 : 1));
          }
          melds.push(run(`m${k + 1}`, ids, cfg));
        }
        const extra = rng.int(4);
        for (let e = 0; e < extra; e++) {
          const id = tid(COLOURS[rng.int(4)], 1 + rng.int(13), 2);
          if (!hand.includes(id) && !melds.some((m) => m.tiles.some((t) => t.tileId === id))) hand.push(id);
        }
        if (hand.length === 0) continue;
        const pos: Pos = { hand, melds };
        const s = playState([hand, ['B2_2'], ['Y2_2']], melds, partial);
        const legal = getLegalMoves(s, 0)!;
        const ctx = `cfg=${JSON.stringify(partial)} hand=${hand.join(',')}`;
        const alive = !cfg.newRunsAfterPort ? bruteAlive(pos, cfg) : !legal.dead; // brute has no new runs
        expect(legal.dead, `dead: ${ctx}`).toBe(!alive);
        if (alive && !bruteDirect(pos, cfg) && !bruteSwaps(pos, cfg).some((b) => bruteDirect(b.post, cfg))) multi++;
        if (!cfg.newRunsAfterPort) {
          for (const b of bruteSwaps(pos, cfg)) {
            const listed = legal.swaps.some((w) => w.meldId === b.meldId && w.jokerTileId === b.jokerTileId && w.withTileId.split('_')[0] === b.withTileId.split('_')[0]);
            expect(listed, `swap ${b.jokerTileId}<-${b.withTileId}: ${ctx}`).toBe(bruteAlive(b.post, cfg));
          }
        }
        const t = ok(applyTimeout(s, 1000));
        const timedOutDead = t.events.some((e) => e.type === 'PLAYER_DEAD' && e.seat === 0 && e.reason === 'TIMEOUT');
        expect(timedOutDead, `timeout: ${ctx}`).toBe(legal.dead);
      }
    }
    expect(multi).toBeGreaterThan(0);
  });

  it('port: canPortHand and port candidates agree with an exhaustive run search', { timeout: 60_000 }, () => {
    const rng = new Rng(77);
    for (const partial of [{}, { aceHigh: false }, { minNaturalsInNewMeld: 1 }, { minNaturalsInNewMeld: 3 }]) {
      const cfg = resolveRules({ ...partial, players: 3 });
      const maxV = cfg.aceHigh ? 14 : 13;
      for (let i = 0; i < 250; i++) {
        // mostly one colour plus jokers, so runs with gaps are common
        const c = COLOURS[rng.int(4)];
        const pool = rng.shuffle([...buildTileSet(2, 8).filter((id) => id.startsWith(c) || id.startsWith('JK_'))]);
        const hand = pool.slice(0, 3 + rng.int(4));
        const J = hand.filter((id) => id.startsWith('JK_'));
        // exhaustive: every start / length / joker mask, built from the hand and validated
        let exists = false;
        for (let s0 = 1; s0 <= maxV && !exists; s0++) {
          for (let L = 3; L <= hand.length && s0 + L - 1 <= maxV && !exists; L++) {
            for (let mask = 0; mask < 1 << L && !exists; mask++) {
              const used = new Set<string>();
              const ids: string[] = [];
              let jUsed = 0;
              for (let k = 0; k < L; k++) {
                if (mask & (1 << k)) {
                  if (jUsed >= J.length) break;
                  ids.push(J[jUsed++]);
                } else {
                  const v = s0 + k;
                  const nat = hand.find((id) => !used.has(id) && !id.startsWith('JK_') && tileFromId(id).rank === (v === 14 ? 1 : v));
                  if (!nat) break;
                  used.add(nat);
                  ids.push(nat);
                }
              }
              if (ids.length === L && typeof validateNewRun(ids, cfg) !== 'string') exists = true;
            }
          }
        }
        expect(canPortHand(hand, cfg), `canPort ${hand.join(',')} ${JSON.stringify(partial)}`).toBe(exists);
        const s = portState([hand, ['B2_2', 'B3_2', 'B4_2'], ['Y2_2', 'Y3_2', 'Y4_2']], partial);
        const legal = getLegalMoves(s, 0)!;
        expect(legal.canPort).toBe(exists);
        expect(legal.portCandidates.length > 0, `candidates ${hand.join(',')}`).toBe(exists);
        for (const cand of legal.portCandidates) expect(validateNewRun(cand, cfg)).not.toBeTypeOf('string');
      }
    }
  });
});
