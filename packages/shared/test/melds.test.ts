import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, resolveRules, type RulesConfig } from '../src/config';
import {
  canSwapJoker,
  isMeldValid,
  validateExtend,
  validateFollow,
  validateNewRun,
  validateNewSet,
} from '../src/melds';
import type { Meld, MeldTile } from '../src/types';

const cfg = DEFAULT_RULES;
const with_ = (p: Partial<RulesConfig>) => resolveRules(p);

function reps(r: MeldTile[] | string): number[] {
  if (typeof r === 'string') throw new Error(`expected tiles, got error: ${r}`);
  return r.map((t) => t.rep.rank);
}

function runMeld(id: string, ids: string[], c: RulesConfig = cfg): Meld {
  const tiles = validateNewRun(ids, c);
  if (typeof tiles === 'string') throw new Error(tiles);
  return { id, type: 'RUN', ownerSeat: 0, colour: tiles[0].rep.colour ?? undefined, tiles };
}

function setMeld(id: string, ids: string[], c: RulesConfig = cfg): Meld {
  const tiles = validateNewSet(ids, c);
  if (typeof tiles === 'string') throw new Error(tiles);
  return { id, type: 'SET', ownerSeat: 0, rank: tiles[0].rep.rank as Meld['rank'], tiles };
}

describe('validateNewRun', () => {
  it('accepts a plain run and fixes colour + ranks', () => {
    const r = validateNewRun(['R3_1', 'R4_1', 'R5_2'], cfg);
    expect(reps(r)).toEqual([3, 4, 5]);
    expect(typeof r !== 'string' && r.every((t) => t.rep.colour === 'R')).toBe(true);
  });

  it('ace low: A-2-3', () => {
    expect(reps(validateNewRun(['BA_1', 'B2_1', 'B3_1'], cfg))).toEqual([1, 2, 3]);
  });

  it('ace high: Q-K-A only when aceHigh', () => {
    expect(reps(validateNewRun(['BQ_1', 'BK_1', 'BA_1'], cfg))).toEqual([12, 13, 14]);
    expect(validateNewRun(['BQ_1', 'BK_1', 'BA_1'], with_({ aceHigh: false }))).toBeTypeOf('string');
  });

  it('no wrap: K-A-2 is illegal', () => {
    expect(validateNewRun(['BK_1', 'BA_1', 'B2_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['BQ_1', 'BK_1', 'BA_1', 'B2_1'], cfg)).toBeTypeOf('string');
  });

  it('the full 14-run A..K..A is legal, 15 is not', () => {
    const ids = ['GA_1', 'G2_1', 'G3_1', 'G4_1', 'G5_1', 'G6_1', 'G7_1', 'G8_1', 'G9_1', 'G10_1', 'GJ_1', 'GQ_1', 'GK_1', 'GA_2'];
    expect(reps(validateNewRun(ids, cfg))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(validateNewRun([...ids, 'JK_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['JK_1', ...ids], cfg)).toBeTypeOf('string');
    // without ace high the longest run is A..K (13)
    expect(validateNewRun(ids, with_({ aceHigh: false }))).toBeTypeOf('string');
    expect(reps(validateNewRun(ids.slice(0, 13), with_({ aceHigh: false })))).toHaveLength(13);
  });

  it('jokers in the middle and at either end take fixed reps', () => {
    expect(reps(validateNewRun(['R3_1', 'JK_1', 'R5_1'], cfg))).toEqual([3, 4, 5]);
    expect(reps(validateNewRun(['JK_1', 'R4_1', 'R5_1'], cfg))).toEqual([3, 4, 5]);
    expect(reps(validateNewRun(['R4_1', 'R5_1', 'JK_1'], cfg))).toEqual([4, 5, 6]);
    expect(reps(validateNewRun(['JK_1', 'R2_1', 'R3_1'], cfg))).toEqual([1, 2, 3]);
    expect(reps(validateNewRun(['RQ_1', 'RK_1', 'JK_2'], cfg))).toEqual([12, 13, 14]);
    expect(reps(validateNewRun(['R3_1', 'JK_1', 'JK_2', 'R6_1'], cfg))).toEqual([3, 4, 5, 6]);
  });

  it('jokers cannot run off either end', () => {
    expect(validateNewRun(['JK_1', 'RA_1', 'R2_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['RK_1', 'RA_1', 'JK_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['RQ_1', 'RK_1', 'JK_1'], with_({ aceHigh: false }))).toBeTypeOf('string');
  });

  it('minimum naturals', () => {
    expect(validateNewRun(['JK_1', 'JK_2', 'R5_1'], cfg)).toBe('A new meld needs at least 2 natural tiles');
    expect(reps(validateNewRun(['JK_1', 'JK_2', 'R5_1'], with_({ minNaturalsInNewMeld: 1 })))).toEqual([3, 4, 5]);
    expect(validateNewRun(['R4_1', 'JK_1', 'R6_1'], with_({ minNaturalsInNewMeld: 3 }))).toBeTypeOf('string');
    expect(validateNewRun(['JK_1', 'JK_2', 'JK_3'], with_({ minNaturalsInNewMeld: 1 }))).toBeTypeOf('string');
  });

  it('colours, length, duplicates, gaps, bad ids', () => {
    expect(validateNewRun(['R3_1', 'B4_1', 'R5_1'], cfg)).toBe('Run tiles must share one colour');
    expect(validateNewRun(['R3_1', 'R4_1'], cfg)).toBe('A run needs at least 3 tiles');
    expect(validateNewRun(['R3_1', 'R3_1', 'R4_1'], cfg)).toBe('Duplicate tile');
    expect(validateNewRun(['R3_1', 'R3_2', 'R4_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['R3_1', 'R5_1', 'R6_1'], cfg)).toBeTypeOf('string');
    expect(validateNewRun(['R5_1', 'R4_1', 'R3_1'], cfg)).toBeTypeOf('string'); // must be ordered low->high
    expect(validateNewRun(['XX', 'R4_1', 'R5_1'], cfg)).toBe('Unknown tile');
    expect(validateNewRun('nope' as unknown as string[], cfg)).toBeTypeOf('string');
  });
});

describe('validateNewSet', () => {
  it('accepts mixed and duplicate colours', () => {
    const s = validateNewSet(['R5_1', 'B5_1', 'Y5_1'], cfg);
    expect(reps(s)).toEqual([5, 5, 5]);
    expect(typeof s !== 'string' && s.every((t) => t.rep.colour === null)).toBe(true);
    expect(reps(validateNewSet(['R5_1', 'R5_2', 'B5_1'], cfg))).toEqual([5, 5, 5]);
  });

  it('no size cap by default', () => {
    const ids = ['RK_1', 'RK_2', 'BK_1', 'BK_2', 'YK_1', 'YK_2', 'GK_1', 'GK_2', 'JK_1'];
    expect(reps(validateNewSet(ids, cfg))).toHaveLength(9);
  });

  it('cap: 4 tiles, distinct colours', () => {
    const c = with_({ setCapFourDistinct: true });
    expect(validateNewSet(['R5_1', 'R5_2', 'B5_1'], c)).toBe('Set colours must be distinct');
    expect(validateNewSet(['R5_1', 'B5_1', 'Y5_1', 'G5_1', 'JK_1'], c)).toBe('A set holds at most 4 tiles');
    expect(reps(validateNewSet(['R5_1', 'B5_1', 'Y5_1', 'G5_1'], c))).toHaveLength(4);
  });

  it('jokers, min naturals, wrong ranks, size', () => {
    expect(reps(validateNewSet(['R5_1', 'B5_1', 'JK_1'], cfg))).toEqual([5, 5, 5]);
    expect(validateNewSet(['R5_1', 'JK_2', 'JK_1'], cfg)).toBeTypeOf('string');
    expect(reps(validateNewSet(['R5_1', 'JK_2', 'JK_1'], with_({ minNaturalsInNewMeld: 1 })))).toHaveLength(3);
    expect(validateNewSet(['R5_1', 'B6_1', 'Y5_1'], cfg)).toBe('Set tiles must share one rank');
    expect(validateNewSet(['R5_1', 'B5_1'], cfg)).toBe('A set needs at least 3 tiles');
  });
});

describe('validateExtend', () => {
  const r345 = runMeld('m1', ['R3_1', 'R4_1', 'R5_1']);

  it('single tiles at either end', () => {
    const hi = validateExtend(r345, [], ['R6_1'], cfg, [r345]);
    expect(typeof hi !== 'string' && hi.high.map((t) => t.rep.rank)).toEqual([6]);
    const lo = validateExtend(r345, ['R2_1'], [], cfg, [r345]);
    expect(typeof lo !== 'string' && lo.low.map((t) => t.rep.rank)).toEqual([2]);
  });

  it('several tiles, both ends, jokers fill gaps', () => {
    const r = validateExtend(r345, ['RA_1', 'R2_1'], ['R6_1', 'JK_1', 'R8_1'], cfg, [r345]);
    if (typeof r === 'string') throw new Error(r);
    expect(r.low.map((t) => t.rep.rank)).toEqual([1, 2]);
    expect(r.high.map((t) => t.rep.rank)).toEqual([6, 7, 8]);
    expect(r.high[1].rep.colour).toBe('R');
  });

  it('rejects wrong order, colour, gaps and empties', () => {
    expect(validateExtend(r345, ['R2_1', 'RA_1'], [], cfg, [r345])).toBeTypeOf('string');
    expect(validateExtend(r345, [], ['B6_1'], cfg, [r345])).toBe('Wrong colour for this run');
    expect(validateExtend(r345, [], ['R7_1'], cfg, [r345])).toBe('Tile does not continue the run');
    expect(validateExtend(r345, [], [], cfg, [r345])).toBe('No tiles to add');
    expect(validateExtend(r345, ['R2_1'], ['R2_1'], cfg, [r345])).toBe('Duplicate tile');
  });

  it('respects ace ends and no wrap', () => {
    const qka = runMeld('m2', ['RQ_1', 'RK_1', 'RA_1']);
    expect(validateExtend(qka, [], ['R2_1'], cfg, [qka])).toBeTypeOf('string');
    expect(validateExtend(qka, [], ['JK_1'], cfg, [qka])).toBe('Cannot extend above the high end');
    const a23 = runMeld('m3', ['RA_1', 'R2_1', 'R3_1']);
    expect(validateExtend(a23, ['JK_1'], [], cfg, [a23])).toBe('Cannot extend below the low end');
    const jqk = runMeld('m4', ['RJ_1', 'RQ_1', 'RK_1']);
    const ok = validateExtend(jqk, [], ['RA_2'], cfg, [jqk]);
    expect(typeof ok !== 'string' && ok.high[0].rep.rank).toBe(14);
    const noHigh = with_({ aceHigh: false });
    expect(validateExtend(runMeld('m5', ['RJ_1', 'RQ_1', 'RK_1'], noHigh), [], ['RA_2'], noHigh, [])).toBeTypeOf('string');
  });

  it('a 13-run extends to the full 14 with the second ace', () => {
    const ids = ['GA_1', 'G2_1', 'G3_1', 'G4_1', 'G5_1', 'G6_1', 'G7_1', 'G8_1', 'G9_1', 'G10_1', 'GJ_1', 'GQ_1', 'GK_1'];
    const m = runMeld('m6', ids);
    const r = validateExtend(m, [], ['GA_2'], cfg, [m]);
    expect(typeof r !== 'string' && r.high[0].rep.rank).toBe(14);
  });

  it('set priority locks ranks that have a set', () => {
    const c = with_({ setPriority: true });
    const s6 = setMeld('s1', ['B6_1', 'Y6_1', 'G6_1']);
    expect(validateExtend(r345, [], ['R6_1'], c, [r345, s6])).toBe('That rank is locked by a set');
    expect(validateExtend(r345, [], ['JK_1'], c, [r345, s6])).toBe('That rank is locked by a set');
    expect(typeof validateExtend(r345, ['R2_1'], [], c, [r345, s6])).not.toBe('string');
    expect(typeof validateExtend(r345, [], ['R6_1'], cfg, [r345, s6])).not.toBe('string');
  });

  it('rejects sets', () => {
    const s = setMeld('s2', ['B6_1', 'Y6_1', 'G6_1']);
    expect(validateExtend(s, [], ['R6_1'], cfg, [s])).toBe('Not a run');
  });
});

describe('validateFollow', () => {
  const s5 = setMeld('s1', ['R5_1', 'B5_1', 'Y5_1']);
  it('adds same-rank naturals and jokers', () => {
    expect(reps(validateFollow(s5, ['G5_1'], cfg))).toEqual([5]);
    expect(reps(validateFollow(s5, ['R5_2', 'JK_1'], cfg))).toEqual([5, 5]);
  });
  it('rejects wrong rank, empty, runs', () => {
    expect(validateFollow(s5, ['G6_1'], cfg)).toBe('Tile does not match the set rank');
    expect(validateFollow(s5, [], cfg)).toBe('No tiles to add');
    expect(validateFollow(runMeld('m1', ['R3_1', 'R4_1', 'R5_2']), ['R5_1'], cfg)).toBe('Not a set');
  });
  it('cap: total 4, colours distinct', () => {
    const c = with_({ setCapFourDistinct: true });
    expect(validateFollow(s5, ['R5_2'], c)).toBe('Set colours must be distinct');
    expect(reps(validateFollow(s5, ['G5_1'], c))).toEqual([5]);
    expect(validateFollow(s5, ['G5_1', 'JK_1'], c)).toBe('A set holds at most 4 tiles');
  });
});

describe('canSwapJoker', () => {
  it('runs need the exact colour and rank', () => {
    const m = runMeld('m1', ['R3_1', 'JK_1', 'R5_1']);
    expect(canSwapJoker(m, 'JK_1', 'R4_1')).toBe(true);
    expect(canSwapJoker(m, 'JK_1', 'R4_2')).toBe(true);
    expect(canSwapJoker(m, 'JK_1', 'B4_1')).toBe(false);
    expect(canSwapJoker(m, 'JK_1', 'R6_1')).toBe(false);
    expect(canSwapJoker(m, 'JK_2', 'R4_1')).toBe(false);
    expect(canSwapJoker(m, 'R3_1', 'R3_2')).toBe(false);
  });
  it('a high-ace joker takes an ace', () => {
    const m = runMeld('m2', ['RQ_1', 'RK_1', 'JK_3']);
    expect(canSwapJoker(m, 'JK_3', 'RA_1')).toBe(true);
  });
  it('sets take any colour of the rank', () => {
    const s = setMeld('s1', ['R5_1', 'B5_1', 'JK_1']);
    expect(canSwapJoker(s, 'JK_1', 'G5_2')).toBe(true);
    expect(canSwapJoker(s, 'JK_1', 'R5_2')).toBe(true);
    expect(canSwapJoker(s, 'JK_1', 'G6_2')).toBe(false);
  });
});

describe('isMeldValid', () => {
  it('validates placed melds', () => {
    expect(isMeldValid(runMeld('m1', ['R3_1', 'JK_1', 'R5_1']), cfg)).toBe(true);
    expect(isMeldValid(setMeld('s1', ['R5_1', 'B5_1', 'JK_1']), cfg)).toBe(true);
    const broken = runMeld('m2', ['R3_1', 'R4_1', 'R5_1']);
    broken.tiles[1] = { tileId: 'B4_1', rep: { colour: 'R', rank: 4 } };
    expect(isMeldValid(broken, cfg)).toBe(false);
    const gap = runMeld('m3', ['R3_1', 'R4_1', 'R5_1']);
    gap.tiles[2] = { tileId: 'R6_1', rep: { colour: 'R', rank: 6 } };
    expect(isMeldValid(gap, cfg)).toBe(false);
  });
});
