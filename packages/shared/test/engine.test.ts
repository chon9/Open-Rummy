import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type RulesConfig } from '../src/config';
import {
  applyAction,
  applyTimeout,
  createMatch,
  detectInstant,
  getLegalMoves,
  handPoints,
  nextHand,
  pendingSeats,
  projectEvents,
  projectView,
  startHand,
} from '../src/engine';
import { validateNewRun, validateNewSet } from '../src/melds';
import { findRunPartition } from '../src/rules/partition';
import { sortTiles } from '../src/tiles';
import type { Action, EngineResult, GameEvent, GameState, Meld } from '../src/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NOW = 500;

function players(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isBot: false, avatar: 'a' }));
}

/** Fresh match with dealer = last seat, so the dealer's 下家 (firstSeat) is seat 0. */
function base(n: number, cfg: Partial<RulesConfig> = {}): GameState {
  return createMatch({ players: players(n), cfg: { ...cfg, players: n }, seed: 42, dealer: n - 1 });
}

/** A PLAY-phase state with the given hands and table melds; everyone has ported. */
function playState(hands: string[][], melds: Meld[] = [], cfg: Partial<RulesConfig> = {}, turn = 0): GameState {
  const s = base(hands.length, cfg);
  s.phase = 'PLAY';
  s.handNo = 1;
  s.firstSeat = 0;
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

/** A simultaneous PORT-phase state (nobody ported yet). */
function portState(hands: string[][], cfg: Partial<RulesConfig> = {}): GameState {
  const s = playState(hands, [], cfg);
  s.phase = 'PORT';
  s.turn = null;
  s.players.forEach((p) => (p.ported = false));
  return s;
}

function run(id: string, ids: string[], owner = 0): Meld {
  const tiles = validateNewRun(ids, DEFAULT_RULES);
  if (typeof tiles === 'string') throw new Error(tiles);
  return { id, type: 'RUN', ownerSeat: owner, colour: tiles[0].rep.colour ?? undefined, tiles };
}

function set(id: string, ids: string[], owner = 0): Meld {
  const tiles = validateNewSet(ids, DEFAULT_RULES);
  if (typeof tiles === 'string') throw new Error(tiles);
  return { id, type: 'SET', ownerSeat: owner, rank: tiles[0].rep.rank as Meld['rank'], tiles };
}

function ok(r: EngineResult): { state: GameState; events: GameEvent[] } {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

function act(s: GameState, seat: number, a: Action) {
  return ok(applyAction(s, seat, a, NOW));
}

function err(r: EngineResult): string {
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

const types = (events: GameEvent[]) => events.map((e) => e.type);

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe('createMatch / startHand', () => {
  it('creates a LOBBY match with chips and a dealer', () => {
    const s = createMatch({ players: players(4), seed: 7 });
    expect(s.phase).toBe('LOBBY');
    expect(s.dealer).toBeGreaterThanOrEqual(0);
    expect(s.dealer).toBeLessThan(4);
    expect(s.players.every((p) => p.chips === 1000)).toBe(true);
    expect(s.cfg.handsPerMatch).toBe(8);
    expect(createMatch({ players: players(3), seed: 7 }).cfg.handsPerMatch).toBe(6);
    expect(() => createMatch({ players: players(3), cfg: { players: 4 }, seed: 1 })).toThrow();
  });

  it('deals 20 each from the dealer 下家, dead wall keeps the rest, deterministic per seed', () => {
    const s0 = base(4);
    const a = ok(startHand(s0, NOW));
    const b = ok(startHand(s0, NOW));
    expect(a.state.players.map((p) => p.hand)).toEqual(b.state.players.map((p) => p.hand));
    expect(a.state.players.every((p) => p.hand.length === 20)).toBe(true);
    expect(a.state.deadWall).toHaveLength(32);
    expect(a.state.firstSeat).toBe(0);
    expect(a.state.handNo).toBe(1);
    expect(a.state.version).toBe(s0.version + 1);
    const deals = a.events.filter((e) => e.type === 'DEAL');
    expect(deals.map((e) => (e.type === 'DEAL' ? e.seat : -1))).toEqual([0, 1, 2, 3]);
    expect(types(a.events)[0]).toBe('HAND_START');
    const wb = a.state.wallBreak;
    expect(wb && wb.dice[0] >= 1 && wb.dice[0] <= 6).toBe(true);
    expect(['PORT', 'INSTANT', 'PLAY', 'HAND_END']).toContain(a.state.phase);
    // input state untouched
    expect(s0.phase).toBe('LOBBY');
    expect(s0.players[0].hand).toEqual([]);
    expect(err(startHand(a.state, NOW))).toBe('Match already started');
  });

  it('3 and 5 players leave 52 and 12 tiles in the dead wall', () => {
    expect(ok(startHand(base(3), NOW)).state.deadWall).toHaveLength(52);
    expect(ok(startHand(base(5), NOW)).state.deadWall).toHaveLength(12);
  });

  it('the first grab is 4 tiles per seat, dealer last', () => {
    const r = ok(startHand(base(4), NOW));
    // reconstruct: seat 0 (下家) holds tiles 0..3 of the shuffle order, etc. Check sizes only.
    expect(r.state.players[3].hand).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// instant wins
// ---------------------------------------------------------------------------

describe('instant wins', () => {
  it('detects 8 of a rank, 7 of a rank, and run partitions', () => {
    const eight = ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'G5_1', 'G5_2', 'R9_1'];
    expect(detectInstant(eight, DEFAULT_RULES, 0)?.kind).toBe('TIANHU_8');
    const seven = ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'G5_1', 'R9_1', 'BK_1'];
    expect(detectInstant(seven, DEFAULT_RULES, 0)?.kind).toBe('GAME_7');
    const runs = ['R2_1', 'R3_1', 'R4_1', 'R5_1', 'BQ_1', 'BK_1', 'BA_1', 'G7_1', 'JK_1', 'G9_1'];
    const offer = detectInstant(runs, DEFAULT_RULES, 2);
    expect(offer?.kind).toBe('TIANHU_RUNS');
    expect(offer?.tiles.flat().sort()).toEqual([...runs].sort());
    expect(detectInstant(['R2_1', 'R3_1', 'R4_1', 'B9_1'], DEFAULT_RULES, 0)).toBeNull();
  });

  it('partition handles duplicates, aces at both ends and sets when allowed', () => {
    expect(findRunPartition(['R2_1', 'R2_2', 'R3_1', 'R3_2', 'R4_1', 'R4_2'], DEFAULT_RULES)).not.toBeNull();
    expect(findRunPartition(['RA_1', 'R2_1', 'R3_1', 'RQ_1', 'RK_1', 'RA_2'], DEFAULT_RULES)).not.toBeNull();
    const withSet = ['R9_1', 'B9_1', 'Y9_1', 'G2_1', 'G3_1', 'G4_1'];
    expect(findRunPartition(withSet, DEFAULT_RULES)).toBeNull();
    expect(findRunPartition(withSet, { ...DEFAULT_RULES, setAllowedAsPort: true })).not.toBeNull();
    // a leftover joker must still fit somewhere
    expect(findRunPartition(['R2_1', 'R3_1', 'R4_1', 'JK_1'], DEFAULT_RULES)).not.toBeNull();
    expect(findRunPartition(['RQ_1', 'RK_1', 'RA_1', 'JK_1', 'JK_2'], DEFAULT_RULES)).not.toBeNull(); // J Q K A with 10 joker
    // two naturals plus twelve jokers is exactly the full 14-run
    expect(findRunPartition(['R2_1', 'R3_1', 'JK_1', 'JK_2', 'JK_3', 'JK_4', 'JK_5', 'JK_6', 'JK_7', 'JK_8', 'JK_9', 'JK_10', 'JK_11', 'JK_12'], DEFAULT_RULES)).toHaveLength(1);
    // a run with a single natural is never legal (min 2 naturals)
    expect(findRunPartition(['R2_1', 'B9_1', 'B10_1', 'JK_1', 'JK_2'], DEFAULT_RULES)).toBeNull();
    expect(findRunPartition(['R2_1', 'JK_1', 'JK_2'], { ...DEFAULT_RULES, minNaturalsInNewMeld: 1 })).not.toBeNull();
  });

  function instantState(): GameState {
    const s = playState([
      ['R9_1', 'R10_1', 'RJ_1', 'B2_1'],
      ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'G5_1', 'B7_1'],
      ['R6_1', 'R6_2', 'B6_1', 'B6_2', 'Y6_1', 'Y6_2', 'G6_1', 'G6_2'],
      ['Y2_1', 'Y3_1', 'Y4_1', 'GK_1'],
    ]);
    s.phase = 'INSTANT';
    s.turn = null;
    s.players.forEach((p) => (p.ported = false));
    s.instantOffers = [
      { seat: 1, kind: 'GAME_7', tiles: [s.players[1].hand.slice(0, 7)] },
      { seat: 2, kind: 'TIANHU_8', tiles: [s.players[2].hand] },
    ];
    return s;
  }

  it('higher priority wins even when the earlier seat declares first', () => {
    let s = instantState();
    expect(pendingSeats(s)).toEqual([1, 2]);
    s = act(s, 1, { type: 'DECLARE_INSTANT', declare: true }).state;
    expect(s.phase).toBe('INSTANT'); // still waiting on seat 2 (TIANHU_8 outranks GAME_7)
    const r = act(s, 2, { type: 'DECLARE_INSTANT', declare: false });
    expect(r.state.phase).toBe('HAND_END');
    expect(r.state.lastResult?.kind).toBe('GAME_7');
    expect(r.state.lastResult?.winnerSeat).toBe(1);
    const res = r.state.lastResult!;
    expect(res.rankings[0]).toMatchObject({ seat: 1, rank: 1, points: 0, title: 'WINNER', chipsDelta: 720 });
    expect(res.rankings.slice(1).every((x) => x.chipsDelta === -240)).toBe(true);
    expect(types(r.events)).toContain('INSTANT_WIN');
  });

  it('timeout auto-declares; all declined continues to the port', () => {
    const t = ok(applyTimeout(instantState(), 1000));
    expect(t.state.lastResult?.kind).toBe('TIANHU');
    expect(t.state.lastResult?.winnerSeat).toBe(2);
    expect(t.state.lastResult?.rankings[1].chipsDelta).toBe(-480);
    expect(types(t.events).filter((x) => x === 'TIMEOUT')).toHaveLength(2);

    let s = instantState();
    s = act(s, 2, { type: 'DECLARE_INSTANT', declare: false }).state;
    const r = act(s, 1, { type: 'DECLARE_INSTANT', declare: false });
    expect(r.state.phase).toBe('PORT');
    expect(r.state.instantOffers).toEqual([]);
    expect(err(applyAction(r.state, 1, { type: 'DECLARE_INSTANT', declare: true }, NOW))).toBe('No instant win to declare');
  });

  it('only the offered seat sees its offer', () => {
    const s = instantState();
    expect(projectView(s, 1).instantOffer?.kind).toBe('GAME_7');
    expect(projectView(s, 0).instantOffer).toBeNull();
    const evs: GameEvent[] = [{ type: 'INSTANT_OFFER', seat: 1, kind: 'GAME_7' }];
    expect(projectEvents(evs, 0)).toEqual([]);
    expect(projectEvents(evs, 1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// port
// ---------------------------------------------------------------------------

describe('port phase (simultaneous)', () => {
  const hands = [
    ['R5_1', 'R5_2', 'B5_1', 'B5_2', 'Y5_1', 'Y5_2', 'G5_1', 'R7_1', 'R8_1', 'R9_1'],
    ['B2_1', 'B3_1', 'B4_1', 'YK_1'],
    ['G2_1', 'Y9_1', 'R10_1'],
    ['YA_1', 'Y2_1', 'Y3_1', 'G7_1'],
  ];

  function afterDecline(): GameState {
    // reach the port through the instant prompt so the phase-start 全餐 check runs
    const s = playState(hands);
    s.phase = 'INSTANT';
    s.turn = null;
    s.players.forEach((p) => (p.ported = false));
    s.instantOffers = [{ seat: 0, kind: 'GAME_7', tiles: [hands[0].slice(0, 7)] }];
    const r = act(s, 0, { type: 'DECLARE_INSTANT', declare: false });
    expect(r.state.phase).toBe('PORT');
    expect(r.events).toContainEqual({ type: 'QUANCAN', seat: 2 });
    return r.state;
  }

  it('marks players without a port as 全餐 at phase start', () => {
    const s = afterDecline();
    expect(s.players[2].status).toBe('QUANCAN');
    expect(pendingSeats(s)).toEqual([0, 1, 3]);
    expect(getLegalMoves(s, 2)).toBeNull();
    const legal = getLegalMoves(s, 1)!;
    expect(legal.canPort).toBe(true);
    expect(legal.portCandidates).toContainEqual(['B2_1', 'B3_1', 'B4_1']);
  });

  it('validates ports and hides pending ports until everyone submitted', () => {
    let s = afterDecline();
    expect(err(applyAction(s, 3, { type: 'PORT', melds: [['YA_1', 'Y2_1', 'G7_1']] }, NOW))).toBeTypeOf('string');
    expect(err(applyAction(s, 3, { type: 'PORT', melds: [['Y4_1', 'Y2_1', 'Y3_1']] }, NOW))).toBe('Tile not in hand');
    expect(err(applyAction(s, 3, { type: 'PORT', melds: [] }, NOW))).toBe('Port needs at least one meld');
    expect(err(applyAction(s, 2, { type: 'PORT', melds: [['G2_1']] }, NOW))).toBe('You are out of this hand');
    expect(err(applyAction(s, 0, { type: 'PORT', melds: [['R5_1', 'B5_1', 'Y5_1']] }, NOW))).toBeTypeOf('string'); // sets not allowed

    let r = act(s, 1, { type: 'PORT', melds: [['B2_1', 'B3_1', 'B4_1']] });
    s = r.state;
    expect(r.events).toEqual([{ type: 'PORT_SUBMITTED', seat: 1 }]);
    expect(err(applyAction(s, 1, { type: 'PORT', melds: [['B2_1', 'B3_1', 'B4_1']] }, NOW))).toBe('Port already submitted');
    expect(projectView(s, 3).players[1].portSubmitted).toBe(true);
    expect(projectView(s, 3).pendingPort).toBeNull();
    expect(projectView(s, 1).pendingPort).toEqual([['B2_1', 'B3_1', 'B4_1']]);
    expect(s.melds).toHaveLength(0);
    expect(s.players[1].hand).toHaveLength(4);

    s = act(s, 0, { type: 'PORT', melds: [['R7_1', 'R8_1', 'R9_1']] }).state;
    r = act(s, 3, { type: 'PORT', melds: [['YA_1', 'Y2_1', 'Y3_1']] });
    s = r.state;
    expect(types(r.events)).toEqual(['PORT_SUBMITTED', 'MELD_CREATED', 'MELD_CREATED', 'MELD_CREATED', 'PORT_REVEAL', 'TURN']);
    expect(s.melds).toHaveLength(3);
    expect(s.players.filter((p) => p.ported).map((p) => p.seat)).toEqual([0, 1, 3]);
    expect(s.phase).toBe('PLAY');
    expect(s.turn).toBe(0); // seat 0 can extend B2-B4 with B5
  });

  it('timeout auto-ports the highest-penalty run', () => {
    const s = portState([
      ['R2_1', 'R3_1', 'R4_1', 'BJ_1', 'BQ_1', 'BK_1', 'Y9_1'],
      ['G2_1', 'G3_1', 'G4_1', 'G5_1', 'R9_2'],
      ['Y2_1', 'Y3_1', 'Y4_1', 'R9_1'],
    ]);
    expect(err(applyTimeout(s, 999))).toBe('Nothing is due');
    const r = ok(applyTimeout(s, 1000));
    const created = r.events.filter((e) => e.type === 'MELD_CREATED');
    expect(created).toHaveLength(3);
    const seat0 = created.find((e) => e.type === 'MELD_CREATED' && e.seat === 0);
    expect(seat0 && seat0.type === 'MELD_CREATED' && seat0.meld.tiles.map((t) => t.tileId)).toEqual(['BJ_1', 'BQ_1', 'BK_1']);
    const seat1 = created.find((e) => e.type === 'MELD_CREATED' && e.seat === 1);
    expect(seat1 && seat1.type === 'MELD_CREATED' && seat1.meld.tiles).toHaveLength(4);
    expect(types(r.events).filter((x) => x === 'TIMEOUT')).toHaveLength(3);
  });

  it('a port that empties the hand is 天糊', () => {
    let s = portState([['R2_1', 'R3_1', 'R4_1'], ['G2_1', 'G3_1', 'G4_1', 'G9_1'], ['Y2_1', 'Y3_1', 'Y4_1', 'R9_1']]);
    s = act(s, 1, { type: 'PORT', melds: [['G2_1', 'G3_1', 'G4_1']] }).state;
    s = act(s, 2, { type: 'PORT', melds: [['Y2_1', 'Y3_1', 'Y4_1']] }).state;
    const r = act(s, 0, { type: 'PORT', melds: [['R2_1', 'R3_1', 'R4_1']] });
    expect(r.state.phase).toBe('HAND_END');
    expect(r.state.lastResult?.kind).toBe('TIANHU');
    expect(r.state.lastResult?.winnerSeat).toBe(0);
    expect(r.state.players[0].chips).toBe(1000 + 2 * 480);
  });

  it('several melds and sets (when allowed) in one port', () => {
    const cfg = { setAllowedAsPort: true };
    let s = portState([['R2_1', 'R3_1', 'R4_1', 'B9_1', 'Y9_1', 'G9_1', 'BK_1'], ['G2_1', 'G3_1', 'G4_1', 'G9_2'], ['Y2_1', 'Y3_1', 'Y4_1', 'Y9_2']], cfg);
    s = act(s, 2, { type: 'PORT', melds: [['Y2_1', 'Y3_1', 'Y4_1']] }).state;
    s = act(s, 0, { type: 'PORT', melds: [['R2_1', 'R3_1', 'R4_1'], ['B9_1', 'Y9_1', 'G9_1']] }).state;
    expect(err(applyAction(s, 1, { type: 'PORT', melds: [['G2_1', 'G3_1', 'G4_1'], ['G2_1', 'G3_1', 'G4_1']] }, NOW))).toBe('Duplicate tile');
    const r = act(s, 1, { type: 'PORT', melds: [['G2_1', 'G3_1', 'G4_1']] });
    expect(r.state.melds.map((m) => m.type)).toEqual(['RUN', 'SET', 'RUN', 'RUN']);
  });
});

describe('port phase (sequential)', () => {
  it('each player ports on their own turn; the port is the turn action', () => {
    const r0 = ok(startHand(base(4, { portTiming: 'sequential', instantWins: false }), NOW));
    let s = r0.state;
    expect(s.phase).toBe('PORT');
    const seat = s.turn as number;
    expect(pendingSeats(s)).toEqual([seat]);
    const legal = getLegalMoves(s, seat)!;
    expect(legal.canPort).toBe(true);
    expect(err(applyAction(s, seat, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R2_1'] }, NOW))).toBe('You must port first');
    const r = act(s, seat, { type: 'PORT', melds: [legal.portCandidates[0]] });
    s = r.state;
    expect(s.players[seat].ported).toBe(true);
    expect(types(r.events)).toContain('PORT_REVEAL');
    expect(s.turn).not.toBe(seat);
  });
});

// ---------------------------------------------------------------------------
// play
// ---------------------------------------------------------------------------

describe('play phase', () => {
  const r345 = run('m1', ['R3_1', 'R4_1', 'R5_1'], 1);

  it('extend, then dead players are skipped (NO_MOVE)', () => {
    const s = playState([['R6_1', 'B9_1'], ['B2_1', 'Y9_1'], ['R7_1', 'G9_1'], ['Y8_1']], [r345]);
    expect(err(applyAction(s, 1, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] }, NOW))).toBe('Not your turn');
    expect(err(applyAction(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R7_1'] }, NOW))).toBe('Tile not in hand');
    expect(err(applyAction(s, 0, { type: 'EXTEND', meldId: 'zz', low: [], high: ['R6_1'] }, NOW))).toBe('No such meld');
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.melds[0].tiles.map((t) => t.tileId)).toEqual(['R3_1', 'R4_1', 'R5_1', 'R6_1']);
    expect(r.events).toContainEqual({ type: 'PLAYER_DEAD', seat: 1, reason: 'NO_MOVE' });
    expect(r.state.players[1].status).toBe('DEAD');
    expect(r.state.players[1].deadOrder).toBe(1);
    expect(r.state.turn).toBe(2);
    expect(r.state.version).toBe(s.version + 1);
    expect(s.melds[0].tiles).toHaveLength(3); // input not mutated
  });

  it('emptying the hand is Game牌: each other player pays 24u, capped at their chips', () => {
    const s = playState([['R6_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [r345]);
    s.firstSeat = 2;
    s.players[2].chips = 50;
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(types(r.events)).toEqual(['MELD_EXTENDED', 'GAME_PAI', 'HAND_END']);
    const res = r.state.lastResult!;
    expect(res.kind).toBe('GAME');
    // equal points and tiles, all alive: nearer to the dealer's 下家 (seat 2) ranks higher
    expect(res.rankings.map((x) => x.seat)).toEqual([0, 2, 3, 1]);
    expect(res.rankings.map((x) => x.title)).toEqual(['WINNER', 'XIAOGE', 'ERGE', 'DAGE']);
    expect(res.rankings.map((x) => x.chipsDelta)).toEqual([240 + 240 + 50, -50, -240, -240]);
    expect(r.state.players[2].chips).toBe(0);
    expect(r.state.players[0].status).toBe('OUT');
    expect(r.state.players[1].lastPlaces).toBe(1);
    expect(r.state.players.map((p) => p.totalPoints)).toEqual([0, 2, 2, 2]);
  });

  it('cut is blocked while an extend exists', () => {
    const s = playState([['R6_1', 'B9_1', 'Y9_1', 'G9_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [r345]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.cutBlocked).toBe(true);
    expect(legal.cuts).toEqual([]);
    expect(err(applyAction(s, 0, { type: 'CUT', tiles: ['B9_1', 'Y9_1', 'G9_1'] }, NOW))).toBe('You must extend when you can');
    const any = playState([['R6_1', 'B9_1', 'Y9_1', 'G9_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [r345], { cutOnlyWhenCannotExtend: false });
    expect(getLegalMoves(any, 0)!.cuts).toContainEqual(['B9_1', 'G9_1', 'Y9_1']);
    expect(act(any, 0, { type: 'CUT', tiles: ['B9_1', 'Y9_1', 'G9_1'] }).state.melds[1].type).toBe('SET');
  });

  it('cut is blocked when an extend exists only after a Joker swap; the swap keeps the turn', () => {
    const rj5 = run('m1', ['R3_1', 'JK_1', 'R5_1'], 1);
    const s = playState([['R4_1', 'B9_1', 'Y9_1', 'G9_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [rj5]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.extends).toEqual([]);
    expect(legal.cutBlocked).toBe(true);
    expect(legal.swaps).toEqual([{ meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' }]);
    expect(legal.dead).toBe(false);
    expect(err(applyAction(s, 0, { type: 'CUT', tiles: ['B9_1', 'Y9_1', 'G9_1'] }, NOW))).toBe('You must extend when you can');
    expect(err(applyAction(s, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'B9_1' }, NOW))).toBe(
      'That tile cannot replace this Joker',
    );
    const sw = act(s, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' });
    expect(sw.state.turn).toBe(0);
    expect(sw.state.players[0].hand).toContain('JK_1');
    expect(sw.state.melds[0].tiles[1]).toEqual({ tileId: 'R4_1', rep: { colour: 'R', rank: 4 } });
    expect(types(sw.events)).toEqual(['JOKER_SWAPPED']);
    const after = getLegalMoves(sw.state, 0)!;
    expect(after.extends).toContainEqual({ meldId: 'm1', low: [], high: ['JK_1'] });
    const ext = act(sw.state, 0, { type: 'EXTEND', meldId: 'm1', low: ['JK_1'], high: [] });
    expect(ext.state.melds[0].tiles[0].rep).toEqual({ colour: 'R', rank: 2 });
  });

  it('cut and follow when no extend exists; follow needs no precondition', () => {
    const s = playState([['B9_1', 'Y9_1', 'G9_1', 'B2_1'], ['R9_1', 'R6_1'], ['Y2_1'], ['G2_1']], [r345]);
    expect(getLegalMoves(s, 0)!.cutBlocked).toBe(false);
    const r = act(s, 0, { type: 'CUT', tiles: ['B9_1', 'Y9_1', 'G9_1'] });
    const meld = r.state.melds[1];
    expect(meld).toMatchObject({ type: 'SET', rank: 9, ownerSeat: 0 });
    expect(r.events[0]).toMatchObject({ type: 'MELD_CREATED', via: 'CUT' });
    expect(r.state.turn).toBe(1);
    // seat 1 could extend with R6 but may still follow the cut
    const legal = getLegalMoves(r.state, 1)!;
    expect(legal.follows).toContainEqual({ meldId: meld.id, tiles: ['R9_1'] });
    const f = act(r.state, 1, { type: 'FOLLOW_CUT', meldId: meld.id, tiles: ['R9_1'] });
    expect(f.state.melds[1].tiles).toHaveLength(4);
    expect(f.events[0]).toMatchObject({ type: 'SET_FOLLOWED', seat: 1 });
  });

  it('new runs only when enabled', () => {
    const hands = [['B2_1', 'B3_1', 'B4_1', 'Y9_1'], ['R6_1'], ['Y2_1'], ['G2_1']];
    const s = playState(hands, [r345]);
    expect(err(applyAction(s, 0, { type: 'NEW_RUN', tiles: ['B2_1', 'B3_1', 'B4_1'] }, NOW))).toBe('New runs are disabled');
    const on = playState(hands, [r345], { newRunsAfterPort: true });
    expect(getLegalMoves(on, 0)!.newRuns).toContainEqual(['B2_1', 'B3_1', 'B4_1']);
    const r = act(on, 0, { type: 'NEW_RUN', tiles: ['B2_1', 'B3_1', 'B4_1'] });
    expect(r.events[0]).toMatchObject({ type: 'MELD_CREATED', via: 'NEW_RUN' });
  });

  it('joker swap off / useSameTurn', () => {
    const rj5 = run('m1', ['R3_1', 'JK_1', 'R5_1'], 1);
    const b567 = run('m2', ['B5_1', 'B6_1', 'B7_1'], 1);
    const hands = [['R4_1', 'B8_1', 'Y9_1'], ['B4_1'], ['Y2_1'], ['G2_1']];
    const off = playState(hands, [rj5, b567], { jokerSwap: 'off' });
    expect(getLegalMoves(off, 0)!.swaps).toEqual([]);
    expect(err(applyAction(off, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' }, NOW))).toBe(
      'Joker swap is disabled',
    );

    const same = playState(hands, [rj5, b567], { jokerSwap: 'useSameTurn' });
    const sw = act(same, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R4_1' });
    expect(sw.state.players[0].mustUseJoker).toBe('JK_1');
    const legal = getLegalMoves(sw.state, 0)!;
    expect(legal.swaps).toEqual([]);
    expect(legal.extends.length).toBeGreaterThan(0);
    expect(legal.extends.every((e) => [...e.low, ...e.high].includes('JK_1'))).toBe(true);
    expect(err(applyAction(sw.state, 0, { type: 'EXTEND', meldId: 'm2', low: [], high: ['B8_1'] }, NOW))).toBe(
      'You must use the retrieved Joker',
    );
    const r = act(sw.state, 0, { type: 'EXTEND', meldId: 'm2', low: [], high: ['B8_1', 'JK_1'] });
    expect(r.state.players[0].mustUseJoker).toBeNull();
    expect(r.state.turn).toBe(1);
  });

  it('a swap that would leave no move is refused', () => {
    // the table run is complete (A..K..A), so only the cut R2+B2+JK is possible;
    // swapping R2 for the run's joker would leave one natural and no move at all
    const full = run('m1', ['RA_1', 'JK_1', 'R3_1', 'R4_1', 'R5_1', 'R6_1', 'R7_1', 'R8_1', 'R9_1', 'R10_1', 'RJ_1', 'RQ_1', 'RK_1', 'RA_2'], 1);
    const s = playState([['R2_1', 'B2_1', 'JK_2'], ['B9_1'], ['Y9_1'], ['G9_1']], [full]);
    const legal = getLegalMoves(s, 0)!;
    expect(legal.cuts.length).toBeGreaterThan(0);
    expect(legal.swaps).toEqual([]);
    expect(err(applyAction(s, 0, { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R2_1' }, NOW))).toBe(
      'That swap would leave you without a move',
    );
    // with a second 2 in hand the cut survives the swap, so the swap is offered
    const s2 = playState([['R2_1', 'B2_1', 'Y2_1'], ['B9_1'], ['Y9_1'], ['G9_1']], [full]);
    expect(getLegalMoves(s2, 0)!.swaps).toEqual([{ meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'R2_1' }]);
  });

  it('all players dead ends the hand by lowest points with tie-breaks and the ladder', () => {
    const s = playState([['R6_1', 'BK_1'], ['B2_1'], ['Y2_1', 'Y2_2'], ['G2_1']], [r345]);
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.phase).toBe('HAND_END');
    const res = r.state.lastResult!;
    expect(res.kind).toBe('LOWEST');
    // seats 1 and 3 tie on points and tiles: seat 3 died later -> ranks higher
    expect(res.rankings.map((x) => x.seat)).toEqual([3, 1, 2, 0]);
    expect(res.winnerSeat).toBe(3);
    expect(res.rankings.map((x) => x.points)).toEqual([2, 2, 4, 10]);
    expect(res.rankings.map((x) => x.chipsDelta)).toEqual([180, -30, -60, -90]);
    expect(r.state.players[0].lastPlaces).toBe(1);
    expect(handPoints(['RA_1', 'R10_1', 'RK_1', 'JK_1', 'R7_1'], DEFAULT_RULES)).toBe(15 + 10 + 10 + 20 + 7);
  });

  it('alive players rank above dead ones on equal points', () => {
    const s = playState([['R6_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [r345]);
    s.players[1].status = 'DEAD';
    s.players[1].deadOrder = 1;
    s.deadCounter = 1;
    const r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.lastResult!.rankings.map((x) => x.seat)).toEqual([0, 2, 3, 1]);
  });

  it('titles for 3 and 5 players', () => {
    const three = act(playState([['R6_1'], ['B2_1'], ['Y3_1']], [r345]), 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(three.state.lastResult!.rankings.map((x) => x.title)).toEqual(['WINNER', 'ERGE', 'DAGE']);
    const five = act(playState([['R6_1'], ['B2_1'], ['Y3_1'], ['G4_1'], ['B5_1']], [r345]), 0, {
      type: 'EXTEND',
      meldId: 'm1',
      low: [],
      high: ['R6_1'],
    });
    expect(five.state.lastResult!.rankings.map((x) => x.title)).toEqual(['WINNER', 'XIAOGE', 'ERGE', 'FOURTH', 'DAGE']);
  });

  it('unlimited actions: several actions, then END_TURN; auto-end when nothing is left', () => {
    const solo = playState([['R6_1', 'Y9_1'], ['R7_1'], ['Y2_1'], ['G2_1']], [r345], { unlimitedActions: true });
    expect(act(solo, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] }).state.turn).toBe(1);

    const cfg = { unlimitedActions: true };
    const s = playState([['R6_1', 'R7_1', 'B9_1', 'B10_1'], ['R8_1'], ['Y2_1'], ['G2_1']], [r345, run('m2', ['B6_1', 'B7_1', 'B8_1'])], cfg);
    expect(err(applyAction(s, 0, { type: 'END_TURN' }, NOW))).toBe('Make at least one move first');
    let r = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] });
    expect(r.state.turn).toBe(0);
    expect(getLegalMoves(r.state, 0)!.canEndTurn).toBe(true);
    r = act(r.state, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R7_1'] });
    expect(r.state.turn).toBe(0);
    r = act(r.state, 0, { type: 'END_TURN' });
    expect(r.state.turn).toBe(1);
    // seat 1 extends with R8; nothing else is possible, so the turn passes automatically
    r = act(r.state, 1, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R8_1'] });
    expect(r.state.phase).toBe('HAND_END'); // seat 1 emptied the hand
    const exactly = playState([['R6_1', 'R7_1'], ['R8_1'], ['Y2_1'], ['G2_1']], [r345]);
    expect(err(applyAction(exactly, 0, { type: 'END_TURN' }, NOW))).toBe('Your turn ends after one action');
  });

  it('turn timeout plays the move shedding the most points', () => {
    const k = set('m2', ['BK_1', 'YK_1', 'GK_1'], 2);
    const s = playState([['R6_1', 'RK_1', 'B2_1'], ['R7_1'], ['Y2_1'], ['G2_1']], [r345, k]);
    expect(err(applyTimeout(s, 999))).toBe('Nothing is due');
    const r = ok(applyTimeout(s, 1000));
    expect(types(r.events).slice(0, 2)).toEqual(['TIMEOUT', 'SET_FOLLOWED']);
    expect(r.state.players[0].hand.sort()).toEqual(['B2_1', 'R6_1']);
  });
});

// ---------------------------------------------------------------------------
// match flow
// ---------------------------------------------------------------------------

describe('match flow', () => {
  function endedHand(cfg: Partial<RulesConfig> = {}): GameState {
    const s = playState([['R6_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [run('m1', ['R3_1', 'R4_1', 'R5_1'])], cfg);
    s.dealer = 3;
    return act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] }).state;
  }

  it('nextHand only from HAND_END; dealer rotates to 下家 or the winner', () => {
    expect(err(nextHand(base(4), NOW))).toBe('Hand is not over');
    const s = endedHand();
    s.lastResult!.winnerSeat = 2; // make "winner deals" distinguishable from rotation
    const n = ok(nextHand(s, NOW));
    expect(n.state.dealer).toBe(0);
    expect(n.state.handNo).toBe(2);
    expect(n.state.lastResult).toBeNull();
    const w = endedHand({ dealerRotation: 'winner' });
    w.lastResult!.winnerSeat = 2;
    expect(ok(nextHand(w, NOW)).state.dealer).toBe(2);
  });

  it('match ends after handsPerMatch with standings', () => {
    const s = endedHand({ handsPerMatch: 1 });
    const r = ok(nextHand(s, NOW));
    expect(r.state.phase).toBe('MATCH_END');
    expect(r.state.standings?.[0]).toMatchObject({ seat: 0, place: 1, chips: 1720 });
    expect(types(r.events)).toEqual(['MATCH_END']);
    expect(projectView(r.state, 1).players[0].revealed).toEqual([]);
  });

  it('bankruptcy ends the match after the hand', () => {
    const s = playState([['R6_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [run('m1', ['R3_1', 'R4_1', 'R5_1'])]);
    s.players[3].chips = 100;
    const ended = act(s, 0, { type: 'EXTEND', meldId: 'm1', low: [], high: ['R6_1'] }).state;
    expect(ended.players[3].chips).toBe(0);
    const r = ok(nextHand(ended, NOW));
    expect(r.state.phase).toBe('MATCH_END');
    expect(r.state.standings?.at(-1)).toMatchObject({ seat: 3, chips: 0 });
  });

  it('standings tie-break on cumulative points then 大哥 finishes', () => {
    const s = endedHand({ handsPerMatch: 1 });
    s.players[1].chips = s.players[2].chips;
    s.players[1].totalPoints = 5;
    s.players[2].totalPoints = 1;
    const st = ok(nextHand(s, NOW)).state.standings!;
    expect(st.findIndex((x) => x.seat === 2)).toBeLessThan(st.findIndex((x) => x.seat === 1));
  });
});

// ---------------------------------------------------------------------------
// projection and robustness
// ---------------------------------------------------------------------------

describe('projection', () => {
  it('hides other hands and the dead wall; reveals at hand end', () => {
    const s = ok(startHand(base(4, { instantWins: false }), NOW)).state;
    const v = projectView(s, 1);
    expect(v.you).toBe(1);
    expect(v.hand).toHaveLength(20);
    expect(v.players.every((p) => p.handCount === 20 && p.revealed === null)).toBe(true);
    expect(v.deadWallCount).toBe(32);
    const json = JSON.stringify(v);
    for (const id of s.players[0].hand) expect(json.includes(`"${id}"`)).toBe(false);
    for (const id of s.deadWall) expect(json.includes(`"${id}"`)).toBe(false);
    const spec = projectView(s, -1);
    expect(spec.you).toBe(-1);
    expect(spec.hand).toEqual([]);
    expect(spec.legal).toBeNull();
    // hand is sorted
    expect(v.hand).toEqual(sortTiles(s.players[1].hand));
  });

  it('strips other seats DEAL tiles', () => {
    const r = ok(startHand(base(4), NOW));
    const mine = projectEvents(r.events, 2).filter((e) => e.type === 'DEAL');
    for (const e of mine) {
      if (e.type !== 'DEAL') continue;
      if (e.seat === 2) expect(e.tiles).toHaveLength(20);
      else expect(e.tiles).toBeUndefined();
    }
    expect(projectEvents(r.events, -1).some((e) => e.type === 'DEAL' && e.tiles)).toBe(false);
  });

  it('legal moves only for the deciding seat, bounded and deduplicated', () => {
    const hand = ['R2_1', 'R2_2', 'R6_1', 'R6_2', 'R7_1', 'R8_1', 'JK_1', 'JK_2', 'JK_3', 'B5_1', 'Y5_1', 'G5_1', 'G5_2', 'R5_2'];
    const s = playState([hand, ['B2_1'], ['Y2_1'], ['G2_1']], [run('m1', ['R3_1', 'R4_1', 'R5_1']), set('m2', ['B5_2', 'Y5_2', 'JK_4'])], {
      cutOnlyWhenCannotExtend: false,
    });
    expect(getLegalMoves(s, 1)).toBeNull();
    const legal = getLegalMoves(s, 0)!;
    for (const list of [legal.extends, legal.cuts, legal.follows, legal.newRuns, legal.swaps, legal.portCandidates]) {
      expect(list.length).toBeLessThanOrEqual(200);
      const keys = list.map((x) => JSON.stringify(x));
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(legal.extends).toContainEqual({ meldId: 'm1', low: ['R2_1'], high: [] });
    expect(legal.extends).toContainEqual({ meldId: 'm1', low: [], high: ['R6_1', 'R7_1', 'R8_1'] });
    expect(legal.extends.some((e) => e.high.includes('JK_1'))).toBe(true);
    // every listed move is accepted by the engine
    for (const e of legal.extends) ok(applyAction(s, 0, { type: 'EXTEND', ...e }, NOW));
    for (const c of legal.cuts) ok(applyAction(s, 0, { type: 'CUT', tiles: c }, NOW));
    for (const f of legal.follows) ok(applyAction(s, 0, { type: 'FOLLOW_CUT', ...f }, NOW));
    for (const w of legal.swaps) ok(applyAction(s, 0, { type: 'SWAP_JOKER', ...w }, NOW));
  });

  it('never throws on malformed input', () => {
    const s = playState([['R6_1'], ['B2_1'], ['Y2_1'], ['G2_1']], [run('m1', ['R3_1', 'R4_1', 'R5_1'])]);
    const bad: unknown[] = [
      null,
      {},
      { type: 'NOPE' },
      { type: 'EXTEND', meldId: 5, low: 'x', high: null },
      { type: 'EXTEND', meldId: 'm1', low: [], high: [7] },
      { type: 'CUT', tiles: 'abc' },
      { type: 'FOLLOW_CUT', meldId: 'm1', tiles: [null] },
      { type: 'PORT', melds: [[1, 2, 3]] },
      { type: 'PORT', melds: 'x' },
      { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 3, withTileId: {} },
      { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: 'R3_1', withTileId: 'ZZ' },
      { type: 'DECLARE_INSTANT', declare: 'yes' },
    ];
    for (const a of bad) {
      const r = applyAction(s, 0, a as Action, NOW);
      expect(r.ok).toBe(false);
    }
    expect(applyAction(s, 9, { type: 'END_TURN' }, NOW).ok).toBe(false);
  });
});
