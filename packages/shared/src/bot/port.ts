/**
 * Port (开牌) choice for the hard bot: search combinations of disjoint runs
 * (and sets, when allowed) and keep the one whose resulting position scores
 * best. The evaluator rewards shedding penalty points but also keeping tiles
 * that extend our own port runs later (future moves keep us alive).
 */
import type { RulesConfig } from '../config';
import type { Action } from '../types';
import { evaluate, type EvalCtx } from './eval';
import { genRunWindows, genSetMelds, materialiseWindow, type RunWindow } from './gen';
import { HandKinds, TilePool, penalty, simulate, valueRank, type Pos } from './model';

/** Upper bound on evaluated run combinations. */
const COMBO_LIMIT = 2500;
/** Upper bound on subsets kept per colour. */
const PER_COLOUR_LIMIT = 48;

interface Choice {
  windows: RunWindow[];
  jokers: number;
  shed: number;
}

function windowJokers(w: RunWindow): number {
  return w.steps.filter((s) => s.joker).length;
}

/** Rough penalty of a window's naturals (used only to order / trim options). */
function windowShed(w: RunWindow, cfg: RulesConfig): number {
  let sum = 0;
  for (const s of w.steps) {
    const r = valueRank(s.v);
    // jokers count half: shedding one is good, but it is also our most flexible tile
    sum += s.joker ? cfg.jokerPenalty * 0.5 : r === 1 ? 15 : r >= 10 ? 10 : r;
  }
  return sum;
}

/** All subsets of disjoint windows of one colour (bounded). */
function colourChoices(windows: RunWindow[], kinds: HandKinds, J: number, cfg: RulesConfig): Choice[] {
  const out: Choice[] = [];
  const used = new Map<number, number>();
  const pick: RunWindow[] = [];
  const dfs = (i: number, jokers: number) => {
    if (out.length >= PER_COLOUR_LIMIT * 4) return;
    if (i === windows.length) {
      out.push({ windows: [...pick], jokers, shed: pick.reduce((a, w) => a + windowShed(w, cfg), 0) });
      return;
    }
    const w = windows[i];
    const wj = windowJokers(w);
    let fits = jokers + wj <= J;
    if (fits) {
      for (const s of w.steps) {
        if (s.joker) continue;
        const r = valueRank(s.v);
        used.set(r, (used.get(r) ?? 0) + 1);
      }
      for (const s of w.steps) {
        if (!s.joker && (used.get(valueRank(s.v)) ?? 0) > kinds.count(w.colour, valueRank(s.v))) fits = false;
      }
      if (fits) {
        pick.push(w);
        dfs(i + 1, jokers + wj);
        pick.pop();
      }
      for (const s of w.steps) {
        if (s.joker) continue;
        const r = valueRank(s.v);
        used.set(r, (used.get(r) ?? 0) - 1);
      }
    }
    dfs(i + 1, jokers);
  };
  dfs(0, 0);
  out.sort((a, b) => b.shed - a.shed);
  // keep the empty choice so other colours can port alone
  const empty = out.find((c) => c.windows.length === 0);
  const trimmed = out.slice(0, PER_COLOUR_LIMIT);
  if (empty && !trimmed.includes(empty)) trimmed.push(empty);
  return trimmed;
}

/**
 * Search for the best port. `base` is the bot's hand plus the melds already
 * on the table (non-empty only in sequential port mode).
 */
export function searchPort(base: Pos, cfg: RulesConfig, ec: EvalCtx, seat: number, rand: () => number): string[][] | null {
  const kinds = new HandKinds(base.hand);
  const J = kinds.jokers.length;
  const windows = genRunWindows(cfg, kinds, Math.min(1, J));
  const byColour = new Map<string, RunWindow[]>();
  for (const w of windows) {
    const list = byColour.get(w.colour) ?? [];
    list.push(w);
    byColour.set(w.colour, list);
  }
  const lists: Choice[][] = [...byColour.values()].map((ws) => colourChoices(ws, kinds, J, cfg));

  // trim the longest list until the cartesian product is affordable
  const product = () => lists.reduce((a, l) => a * l.length, 1);
  while (product() > COMBO_LIMIT) {
    let longest = 0;
    for (let i = 1; i < lists.length; i++) if (lists[i].length > lists[longest].length) longest = i;
    const l = lists[longest];
    const empty = l.find((c) => c.windows.length === 0);
    const half = l.slice(0, Math.max(1, Math.ceil(l.length / 2)));
    if (empty && !half.includes(empty)) half.push(empty);
    if (half.length >= l.length) break;
    lists[longest] = half;
  }

  let best: string[][] | null = null;
  let bestScore = -Infinity;
  const consider = (melds: string[][]) => {
    if (melds.length === 0) return;
    const after = simulate(base, { type: 'PORT', melds }, cfg, seat);
    if (!after) return;
    const score = evaluate(after, ec) + rand() * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = melds;
    }
  };

  const idx = new Array<number>(lists.length).fill(0);
  for (;;) {
    let jokers = 0;
    const chosen: RunWindow[] = [];
    for (let i = 0; i < lists.length; i++) {
      const c = lists[i][idx[i]];
      jokers += c.jokers;
      chosen.push(...c.windows);
    }
    if (jokers <= J) {
      const pool = new TilePool(kinds);
      const melds: string[][] = [];
      let ok = true;
      for (const w of chosen) {
        const ids = materialiseWindow(pool, w);
        if (!ids) {
          ok = false;
          break;
        }
        melds.push(ids);
      }
      if (ok) {
        consider(melds);
        if (cfg.setAllowedAsPort) consider([...melds, ...greedySets(base.hand, melds, cfg)]);
      }
    }
    // odometer increment
    let k = 0;
    while (k < lists.length) {
      idx[k]++;
      if (idx[k] < lists[k].length) break;
      idx[k] = 0;
      k++;
    }
    if (k === lists.length) break;
  }
  // sets alone (no runs at all)
  if (cfg.setAllowedAsPort) consider(greedySets(base.hand, [], cfg));
  return best;
}

/** Disjoint sets from what the chosen runs leave, highest penalty first. */
function greedySets(hand: string[], runs: string[][], cfg: RulesConfig): string[][] {
  const taken = new Set(runs.flat());
  let rest = hand.filter((id) => !taken.has(id));
  const out: string[][] = [];
  for (;;) {
    const sets = genSetMelds(cfg, new HandKinds(rest)).sort((a, b) => penalty(b, cfg) - penalty(a, cfg));
    const s = sets[0];
    if (!s) break;
    out.push(s);
    const drop = new Set(s);
    rest = rest.filter((id) => !drop.has(id));
  }
  return out;
}

/** Make sure a port is accepted by the engine's validators, else null. */
export function checkedPort(base: Pos, melds: string[][] | null, cfg: RulesConfig, seat: number): Action | null {
  if (!melds || melds.length === 0) return null;
  const action: Action = { type: 'PORT', melds };
  return simulate(base, action, cfg, seat) ? action : null;
}
