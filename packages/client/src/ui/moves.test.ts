import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, resolveRules, validateNewRun, type Meld, type PlayerView } from '@open-rummy/shared';
import { hintsFrom, jokerRep, needsSwapFirst, planExtend, planFollow, planRun, planSet, repLabel, suggestPort, suggestPorts } from './moves';

const cfg = resolveRules({});

function runMeld(ids: string[], colour: 'B' | 'R' | 'Y' | 'G', startRank: number): Meld {
  return {
    id: 'm1',
    type: 'RUN',
    ownerSeat: 0,
    colour,
    tiles: ids.map((tileId, i) => ({ tileId, rep: { colour, rank: startRank + i } })),
  };
}

describe('planRun', () => {
  it('orders a shuffled natural run low -> high', () => {
    expect(planRun(['R6_1', 'R4_1', 'R5_2'], cfg)).toEqual([['R4_1', 'R5_2', 'R6_1']]);
  });

  it('fills a gap with a joker', () => {
    const out = planRun(['R6_1', 'JK_1', 'R4_1'], cfg);
    expect(out).toEqual([['R4_1', 'JK_1', 'R6_1']]);
  });

  it('reports ambiguous spare joker placement', () => {
    const out = planRun(['G5_1', 'G6_1', 'JK_2'], cfg);
    expect(out.length).toBe(2);
    expect(out).toContainEqual(['JK_2', 'G5_1', 'G6_1']);
    expect(out).toContainEqual(['G5_1', 'G6_1', 'JK_2']);
  });

  it('treats an ace as high after K when needed (Q-K-A)', () => {
    expect(planRun(['BA_1', 'BQ_1', 'BK_1'], cfg)).toEqual([['BQ_1', 'BK_1', 'BA_1']]);
  });

  it('treats an ace as low (A-2-3)', () => {
    expect(planRun(['B3_1', 'BA_1', 'B2_1'], cfg)).toEqual([['BA_1', 'B2_1', 'B3_1']]);
  });

  it('never wraps K-A-2', () => {
    expect(planRun(['BK_1', 'BA_1', 'B2_1'], cfg)).toEqual([]);
  });

  it('rejects mixed colours and too few naturals', () => {
    expect(planRun(['R4_1', 'B5_1', 'R6_1'], cfg)).toEqual([]);
    expect(planRun(['R4_1', 'JK_1', 'JK_2'], cfg)).toEqual([]);
  });

  it('agrees with the engine validator', () => {
    for (const r of planRun(['Y9_1', 'JK_3', 'YJ_1', 'YQ_2'], cfg)) {
      expect(typeof validateNewRun(r, cfg)).not.toBe('string');
    }
  });
});

describe('planSet / planFollow', () => {
  it('accepts 3 of a rank in any colours', () => {
    expect(planSet(['B8_1', 'R8_1', 'Y8_2'], DEFAULT_RULES)).not.toBeNull();
    expect(planSet(['B8_1', 'R8_1', 'JK_1'], DEFAULT_RULES)).not.toBeNull();
    expect(planSet(['B8_1', 'R9_1', 'Y8_2'], DEFAULT_RULES)).toBeNull();
  });

  it('follows a set of the same rank', () => {
    const set: Meld = {
      id: 's1',
      type: 'SET',
      ownerSeat: 1,
      rank: 8,
      tiles: ['B8_1', 'R8_1', 'Y8_2'].map((tileId) => ({ tileId, rep: { colour: null, rank: 8 } })),
    };
    expect(planFollow(set, ['G8_1'], cfg)).toBe(true);
    expect(planFollow(set, ['G9_1'], cfg)).toBe(false);
  });
});

describe('planExtend', () => {
  const meld = runMeld(['Y5_1', 'Y6_1', 'Y7_1'], 'Y', 5);

  it('splits a selection into low and high ends', () => {
    const plans = planExtend(meld, ['Y8_2', 'Y4_1', 'Y9_1'], cfg, [meld], null);
    expect(plans).toEqual([{ low: ['Y4_1'], high: ['Y8_2', 'Y9_1'] }]);
  });

  it('uses the clicked end for a lone joker', () => {
    const lowFirst = planExtend(meld, ['JK_1'], cfg, [meld], 'low');
    expect(lowFirst[0]).toEqual({ low: ['JK_1'], high: [] });
    const highFirst = planExtend(meld, ['JK_1'], cfg, [meld], 'high');
    expect(highFirst[0]).toEqual({ low: [], high: ['JK_1'] });
  });

  it('rejects tiles of another colour or inside the run', () => {
    expect(planExtend(meld, ['R8_1'], cfg, [meld], null)).toEqual([]);
    expect(planExtend(meld, ['Y6_2'], cfg, [meld], null)).toEqual([]);
  });

  it('bridges a gap with a joker', () => {
    expect(planExtend(meld, ['Y9_1', 'JK_2'], cfg, [meld], null)).toEqual([{ low: [], high: ['JK_2', 'Y9_1'] }]);
  });
});

describe('suggestPort', () => {
  it('picks disjoint candidates with the most points first', () => {
    const picks = suggestPort(
      [
        ['R2_1', 'R3_1', 'R4_1'],
        ['RJ_1', 'RQ_1', 'RK_1'],
        ['R3_1', 'R4_1', 'R5_1'],
      ],
      cfg,
    );
    expect(picks[0]).toEqual(['RJ_1', 'RQ_1', 'RK_1']);
    expect(picks.length).toBe(2);
  });
});

describe('suggestPorts', () => {
  it('keeps jokers in hand when natural runs exist (playtest: no 10-J-JK-JK-A)', () => {
    const hand = ['G10_1', 'GJ_1', 'GA_1', 'JK_1', 'JK_2', 'B5_1', 'B6_1', 'B7_1', 'R9_1', 'R10_1', 'RJ_1', 'RQ_1'];
    const cands = [
      ['G10_1', 'GJ_1', 'JK_1', 'JK_2', 'GA_1'],
      ['R9_1', 'R10_1', 'RJ_1', 'RQ_1'],
      ['B5_1', 'B6_1', 'B7_1'],
      ['R9_1', 'R10_1', 'RJ_1'],
      ['JK_1', 'B5_1', 'B6_1', 'B7_1'],
    ];
    const best = suggestPort(cands, cfg, hand);
    expect(best.flat().some((id) => id.startsWith('JK'))).toBe(false);
    expect(best).toContainEqual(['R9_1', 'R10_1', 'RJ_1', 'RQ_1']);
    expect(best).toContainEqual(['B5_1', 'B6_1', 'B7_1']);
  });

  it('uses only one joker meld, with the fewest jokers, when no natural run exists', () => {
    const hand = ['G10_1', 'GJ_1', 'GA_1', 'JK_1', 'JK_2', 'B5_1', 'B7_1'];
    const cands = [
      ['G10_1', 'GJ_1', 'JK_1', 'JK_2', 'GA_1'],
      ['B5_1', 'JK_1', 'B7_1'],
      ['G10_1', 'GJ_1', 'JK_1'],
    ];
    const all = suggestPorts(cands, cfg, hand);
    expect(all[0].melds.length).toBe(1);
    expect(all[0].jokers).toBe(1);
    expect(all[0].melds[0]).toEqual(['G10_1', 'GJ_1', 'JK_1']);
    // alternatives exist for cycling, every one a single meld
    expect(all.length).toBe(3);
    expect(all.every((s) => s.melds.length === 1)).toBe(true);
  });

  it('realises a second copy of the same run from the hand', () => {
    const hand = ['B3_1', 'B4_1', 'B5_1', 'B3_2', 'B4_2', 'B5_2'];
    const best = suggestPort([['B3_1', 'B4_1', 'B5_1']], cfg, hand);
    expect(best.length).toBe(2);
    expect(new Set(best.flat()).size).toBe(6);
  });

  it('offers distinct alternatives ranked by points', () => {
    const hand = ['R3_1', 'R4_1', 'R5_1', 'R6_1'];
    const all = suggestPorts([['R3_1', 'R4_1', 'R5_1', 'R6_1'], ['R3_1', 'R4_1', 'R5_1'], ['R4_1', 'R5_1', 'R6_1']], cfg, hand);
    expect(all[0].melds).toEqual([['R3_1', 'R4_1', 'R5_1', 'R6_1']]);
    expect(all.length).toBe(3);
    expect(all[1].points).toBeLessThanOrEqual(all[0].points);
  });
});

describe('needsSwapFirst', () => {
  const base = { canPort: false, portCandidates: [], extends: [], cuts: [], follows: [], newRuns: [], swaps: [], cutBlocked: false, canEndTurn: false, dead: false };
  it('is true only when swaps exist and no primary move does', () => {
    const swap = { meldId: 'm1', jokerTileId: 'JK_1', withTileId: 'B6_1' };
    expect(needsSwapFirst({ ...base, swaps: [swap] })).toBe(true);
    expect(needsSwapFirst({ ...base, swaps: [swap], extends: [{ meldId: 'm1', low: [], high: ['B9_1'] }] })).toBe(false);
    expect(needsSwapFirst({ ...base, swaps: [swap], cuts: [['B6_1', 'R6_1', 'G6_1']], cutBlocked: true })).toBe(true);
    expect(needsSwapFirst(base)).toBe(false);
  });
});

describe('hintsFrom', () => {
  it('visits different targets before variants of the same target', () => {
    const view = {
      cfg,
      legal: {
        canPort: false,
        portCandidates: [],
        extends: [
          { meldId: 'a', low: [], high: ['B9_1'] },
          { meldId: 'a', low: [], high: ['B9_1', 'B10_1'] },
          { meldId: 'b', low: ['R2_1'], high: [] },
        ],
        cuts: [],
        follows: [],
        newRuns: [],
        swaps: [],
        cutBlocked: false,
        canEndTurn: false,
        dead: false,
      },
    } as unknown as PlayerView;
    const hints = hintsFrom(view);
    expect(hints.map((x) => x.meldId)).toEqual(['a', 'b', 'a']);
    expect(hints[0].tiles).toEqual(['B9_1', 'B10_1']);
  });
});

describe('jokerRep', () => {
  it('reads what a table joker stands for', () => {
    const m = runMeld(['B4_1', 'B5_1', 'JK_3', 'B7_1'], 'B', 4);
    const rep = jokerRep([m], 'm1', 'JK_3');
    expect(rep).toEqual({ colour: 'B', rank: 6 });
    expect(repLabel(rep!)).toBe('♠6');
  });
});

describe('suggestPorts maximality', () => {
  it('never offers a cover that leaves a disjoint candidate unused', () => {
    const hand = ['YJ_1', 'YQ_1', 'YK_1', 'G6_1', 'G7_1', 'G8_1', 'G3_1', 'G4_1'];
    const all = suggestPorts([['YJ_1', 'YQ_1', 'YK_1'], ['G6_1', 'G7_1', 'G8_1']], cfg, hand);
    expect(all.length).toBe(1);
    expect(all[0].melds.length).toBe(2);
  });
});
