import { describe, expect, it } from 'vitest';
import { applyAction, chooseBotAction, createMatch, getLegalMoves, pendingSeats, projectView, startHand, type GameState } from '@open-rummy/shared';
import { hintsFrom, planSet, targetMelds } from './moves';

/** Bots play whole hands; at every decision each hint must be playable through the UI path. */
describe('hints are reachable from the UI', () => {
  it('every extend/follow hint highlights its meld; every cut hint is a valid set', () => {
    const problems: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const players = [0, 1, 2, 3].map((i) => ({ name: `p${i}`, isBot: true, avatar: 'a' }));
      let s: GameState = createMatch({ players, seed, cfg: { instantWins: false } });
      const r0 = startHand(s, 0);
      if (!r0.ok) continue;
      s = r0.state;
      let x = seed * 9973;
      const rand = (): number => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
      for (let step = 0; step < 300 && (s.phase === 'PORT' || s.phase === 'PLAY'); step++) {
        const seat = pendingSeats(s)[0];
        if (seat === undefined) break;
        const view = projectView(s, seat);
        if (s.phase === 'PLAY' && getLegalMoves(s, seat)) {
          for (const hnt of hintsFrom(view)) {
            if (hnt.kind === 'swap') continue;
            checked++;
            if (hnt.kind === 'cut') {
              if (!planSet(hnt.tiles, view.cfg)) problems.push(`seed ${seed} cut ${hnt.tiles}`);
            } else if (!targetMelds(view, hnt.tiles).some((m) => m.id === hnt.meldId)) {
              const m = view.melds.find((x) => x.id === hnt.meldId);
              problems.push(`seed ${seed} ${hnt.kind} ${hnt.tiles} -> ${m?.tiles.map((t) => `${t.tileId}=${t.rep.colour}${t.rep.rank}`).join(' ')}`);
            }
          }
        }
        const action = chooseBotAction(view, 'normal', rand);
        if (!action) break;
        const r = applyAction(s, seat, action, 0);
        if (!r.ok) break;
        s = r.state;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(problems.slice(0, 10)).toEqual([]);
  });
});
