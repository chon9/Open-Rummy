/**
 * 天糊 (Heavenly win) partition check (docs/RULES.md §5, §15): does the whole
 * hand split exactly into valid runs (plus sets when sets may be ported),
 * with jokers as wildcards and every meld holding the minimum naturals?
 *
 * Backtracking exact cover: always place the lowest remaining natural tile
 * (colour order, then rank) into some meld, memoising failed positions.
 * Inside a run, other positions use a natural when one is available and a
 * joker otherwise. That greedy choice can in rare constructed cases miss a
 * partition that needs a joker in place of an available natural; the search
 * also stops after a node budget. Both only ever under-report a 天糊.
 */
import type { RulesConfig } from '../config';
import { COLOURS, tileFromId, type Colour } from '../tiles';

const NODE_BUDGET = 200_000;

export function findRunPartition(hand: string[], cfg: RulesConfig): string[][] | null {
  if (hand.length < 3) return null;
  const maxV = cfg.aceHigh ? 14 : 13;
  const minN = cfg.minNaturalsInNewMeld;
  // kinds[ci * 13 + (rank - 1)] = ids still unplaced
  const kinds: string[][] = Array.from({ length: 52 }, () => []);
  const jokers: string[] = [];
  for (const id of [...hand].sort()) {
    const t = tileFromId(id);
    if (t.joker) jokers.push(id);
    else kinds[COLOURS.indexOf(t.colour as Colour) * 13 + (t.rank as number) - 1].push(id);
  }
  const failed = new Set<string>();
  const melds: string[][] = [];
  let nodes = 0;
  let aborted = false;

  const stateKey = () => kinds.map((k) => k.length).join('') + '|' + jokers.length;

  const search = (): boolean => {
    if (++nodes > NODE_BUDGET) {
      aborted = true;
      return false;
    }
    const first = kinds.findIndex((k) => k.length > 0);
    if (first < 0) return jokers.length === 0;
    const sk = stateKey();
    if (failed.has(sk)) return false;

    const ci = Math.floor(first / 13);
    const rank = (first % 13) + 1;

    // --- runs containing this natural at value `pos` (an ace may sit at 1 or 14)
    const positions = rank === 1 && cfg.aceHigh ? [1, 14] : [rank];
    for (const pos of positions) {
      for (let s = 1; s <= pos; s++) {
        for (let e = Math.max(pos, s + 2); e <= maxV; e++) {
          // plan the run: chosen natural at pos, others natural-if-available else joker
          const plan: number[] = []; // kind index or -1 for joker
          let jNeed = 0;
          let nat = 0;
          const usedCount = new Map<number, number>();
          for (let v = s; v <= e; v++) {
            const r = v === 14 ? 1 : v;
            const ki = ci * 13 + r - 1;
            const u = usedCount.get(ki) ?? 0;
            if (v === pos || u < kinds[ki].length) {
              if (u >= kinds[ki].length) {
                plan.length = 0;
                break;
              }
              usedCount.set(ki, u + 1);
              plan.push(ki);
              nat++;
            } else {
              plan.push(-1);
              jNeed++;
            }
          }
          if (plan.length !== e - s + 1 || jNeed > jokers.length || nat < minN) continue;
          if (tryMeld(plan)) return true;
          if (aborted) return false;
        }
      }
    }

    // --- sets of this rank (only when sets may be ported)
    if (cfg.setAllowedAsPort) {
      const counts = COLOURS.map((_, c) => kinds[c * 13 + rank - 1].length);
      const choice = [0, 0, 0, 0];
      const rec = (c: number): boolean => {
        if (c === 4) {
          const k = choice.reduce((a, b) => a + b, 0);
          if (choice[ci] < 1 || k < minN) return false;
          if (cfg.setCapFourDistinct && choice.some((x) => x > 1)) return false;
          const jMax = cfg.setCapFourDistinct ? Math.min(jokers.length, 4 - k) : jokers.length;
          for (let j = Math.max(0, 3 - k); j <= jMax; j++) {
            const plan: number[] = [];
            choice.forEach((n, cc) => {
              for (let i = 0; i < n; i++) plan.push(cc * 13 + rank - 1);
            });
            for (let i = 0; i < j; i++) plan.push(-1);
            if (tryMeld(plan)) return true;
            if (aborted) return false;
          }
          return false;
        }
        for (let n = 0; n <= counts[c]; n++) {
          choice[c] = n;
          if (rec(c + 1)) return true;
          if (aborted) return false;
        }
        choice[c] = 0;
        return false;
      };
      if (rec(0)) return true;
    }

    if (!aborted) failed.add(sk);
    return false;
  };

  /** Place a planned meld, recurse, and undo on failure. */
  const tryMeld = (plan: number[]): boolean => {
    const ids = plan.map((ki) => (ki < 0 ? (jokers.pop() as string) : (kinds[ki].pop() as string)));
    melds.push(ids);
    if (search()) return true;
    melds.pop();
    for (let i = plan.length - 1; i >= 0; i--) {
      const ki = plan[i];
      if (ki < 0) jokers.push(ids[i]);
      else kinds[ki].push(ids[i]);
    }
    return false;
  };

  return search() ? melds.map((m) => [...m]) : null;
}
