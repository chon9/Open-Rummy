import { describe, expect, it } from 'vitest';
import { createMatch, getLegalMoves, isJokerId, startHand, validateNewRun, type GameState } from '@open-rummy/shared';
import { suggestPorts } from './moves';

/** Deal real hands and check suggestions against the engine's own port candidates. */
describe('suggestPorts on dealt hands', () => {
  it('returns disjoint valid runs from the hand, natural-only whenever possible', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const players = [0, 1, 2, 3].map((i) => ({ name: `p${i}`, isBot: true, avatar: 'a' }));
      let s: GameState = createMatch({ players, seed, cfg: { instantWins: false } });
      const started = startHand(s, 0);
      if (!started.ok) continue;
      s = started.state;
      if (s.phase !== 'PORT') continue;
      for (const p of s.players) {
        const legal = getLegalMoves(s, p.seat);
        if (!legal?.canPort) continue;
        const t0 = Date.now();
        const all = suggestPorts(legal.portCandidates, s.cfg, p.hand);
        expect(Date.now() - t0).toBeLessThan(500);
        expect(all.length).toBeGreaterThan(0);
        const hasNatural = legal.portCandidates.some((c) => !c.some(isJokerId));
        for (const sug of all) {
          const ids = sug.melds.flat();
          expect(new Set(ids).size).toBe(ids.length);
          for (const id of ids) expect(p.hand).toContain(id);
          for (const m of sug.melds) expect(typeof validateNewRun(m, s.cfg)).not.toBe('string');
          if (hasNatural) expect(sug.jokers).toBe(0);
          else expect(sug.melds.length).toBe(1);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
