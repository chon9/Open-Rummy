/**
 * Client-side move planning: turns a free tile selection into concrete engine
 * actions (ordered runs, extend low/high split, follow, cut), and derives UI hints
 * (playable tiles, target melds, suggestions) from `view.legal`.
 *
 * The server/engine stays authoritative: these helpers only build candidates and
 * pre-check them with the shared validators. If a validator is unavailable (throws),
 * the structural checks here are used and the server has the final say.
 */
import {
  COLOUR_SUIT,
  isJokerId,
  rankCode,
  tileFromId,
  tilePenalty,
  validateExtend,
  validateFollow,
  validateNewRun,
  validateNewSet,
  type Action,
  type Colour,
  type LegalMoves,
  type Meld,
  type PlayerView,
  type RulesConfig,
} from '@open-rummy/shared';

type Check = { ok: true } | { ok: false; error: string } | { ok: null };

/** Run an engine validator: string result = error, anything else = ok, throw = unknown. */
function check(fn: () => unknown): Check {
  try {
    const r = fn();
    return typeof r === 'string' ? { ok: false, error: r } : { ok: true };
  } catch {
    return { ok: null };
  }
}

export function points(ids: string[], cfg: RulesConfig): number {
  return ids.reduce((s, id) => s + tilePenalty(id, cfg.jokerPenalty), 0);
}

interface Placed {
  id: string;
  v: number;
}

/**
 * Enumerate value assignments for natural tiles: an ace may be 1 (low) or 14 (high,
 * only when aceHigh). Returns [] when more than 2 aces are selected (no run has more).
 */
function aceAssignments(naturals: string[], cfg: RulesConfig): Placed[][] {
  const aces = naturals.filter((id) => tileFromId(id).rank === 1);
  if (aces.length > 2) return [];
  const base: Placed[] = naturals.filter((id) => tileFromId(id).rank !== 1).map((id) => ({ id, v: tileFromId(id).rank as number }));
  let combos: Placed[][] = [base];
  for (const ace of aces) {
    const next: Placed[][] = [];
    for (const c of combos) {
      next.push([...c, { id: ace, v: 1 }]);
      if (cfg.aceHigh) next.push([...c, { id: ace, v: 14 }]);
    }
    combos = next;
  }
  return combos.map((c) => [...c].sort((a, b) => a.v - b.v));
}

function hasDuplicateValues(ps: Placed[]): boolean {
  for (let i = 1; i < ps.length; i++) if (ps[i].v === ps[i - 1].v) return true;
  return false;
}

function sameColour(naturals: string[]): Colour | null {
  if (!naturals.length) return null;
  const c = tileFromId(naturals[0]).colour;
  return naturals.every((id) => tileFromId(id).colour === c) ? c : null;
}

/**
 * Order a selection into a NEW run (low -> high), placing jokers in gaps and,
 * when spare, at either end. Returns every distinct valid ordering: one = clear,
 * several = ambiguous joker placement (ask the player), none = not a run.
 */
export function planRun(sel: string[], cfg: RulesConfig): string[][] {
  const naturals = sel.filter((id) => !isJokerId(id));
  const jokers = sel.filter(isJokerId);
  if (sel.length < 3 || !sameColour(naturals)) return [];
  const maxV = cfg.aceHigh ? 14 : 13;
  const out = new Map<string, string[]>();
  for (const placed of aceAssignments(naturals, cfg)) {
    if (!placed.length || hasDuplicateValues(placed)) continue;
    const first = placed[0].v;
    const last = placed[placed.length - 1].v;
    const gaps = last - first + 1 - placed.length;
    const spare = jokers.length - gaps;
    if (spare < 0) continue;
    for (let below = 0; below <= spare; below++) {
      const lo = first - below;
      const hi = last + (spare - below);
      if (lo < 1 || hi > maxV) continue;
      const pool = [...jokers];
      const ordered: string[] = [];
      for (let v = lo; v <= hi; v++) {
        const nat = placed.find((p) => p.v === v);
        ordered.push(nat ? nat.id : pool.shift()!);
      }
      const key = ordered.map((id) => (isJokerId(id) ? 'J' : id)).join(',');
      if (out.has(key)) continue;
      if (check(() => validateNewRun(ordered, cfg)).ok === false) continue;
      out.set(key, ordered);
    }
  }
  return [...out.values()];
}

/** Can the selection form a NEW set (斩)? Returns the tiles if so. */
export function planSet(sel: string[], cfg: RulesConfig): string[] | null {
  if (sel.length < 3) return null;
  const naturals = sel.filter((id) => !isJokerId(id));
  if (naturals.length < cfg.minNaturalsInNewMeld) return null;
  const r = tileFromId(naturals[0]).rank;
  if (!naturals.every((id) => tileFromId(id).rank === r)) return null;
  return check(() => validateNewSet(sel, cfg)).ok === false ? null : [...sel];
}

export interface ExtendPlan {
  low: string[];
  high: string[];
}

/**
 * Split a selection into tiles placed below (`low`) and above (`high`) a RUN.
 * `end` (from the clicked end of the meld) decides where spare jokers go.
 * Results are ordered with the preferred end first.
 */
export function planExtend(
  meld: Meld,
  sel: string[],
  cfg: RulesConfig,
  melds: Meld[],
  end: 'low' | 'high' | null,
): ExtendPlan[] {
  if (meld.type !== 'RUN' || !sel.length || !meld.tiles.length) return [];
  const naturals = sel.filter((id) => !isJokerId(id));
  const jokers = sel.filter(isJokerId);
  if (naturals.some((id) => tileFromId(id).colour !== meld.colour)) return [];
  const lo = meld.tiles[0].rep.rank;
  const hi = meld.tiles[meld.tiles.length - 1].rep.rank;
  const maxV = cfg.aceHigh ? 14 : 13;
  const out = new Map<string, ExtendPlan>();

  for (const placed of naturals.length ? aceAssignments(naturals, cfg) : [[]]) {
    if (hasDuplicateValues(placed)) continue;
    if (placed.some((p) => p.v >= lo && p.v <= hi)) continue;
    const lowVals = placed.filter((p) => p.v < lo);
    const highVals = placed.filter((p) => p.v > hi);
    const gapsLow = lowVals.length ? lo - lowVals[0].v - lowVals.length : 0;
    const gapsHigh = highVals.length ? highVals[highVals.length - 1].v - hi - highVals.length : 0;
    const spare = jokers.length - gapsLow - gapsHigh;
    if (spare < 0) continue;
    for (let below = 0; below <= spare; below++) {
      const lowStart = (lowVals.length ? lowVals[0].v : lo) - below;
      const highEnd = (highVals.length ? highVals[highVals.length - 1].v : hi) + (spare - below);
      if (lowStart < 1 || highEnd > maxV) continue;
      const pool = [...jokers];
      const low: string[] = [];
      const high: string[] = [];
      for (let v = lowStart; v < lo; v++) low.push(placed.find((p) => p.v === v)?.id ?? pool.shift()!);
      for (let v = hi + 1; v <= highEnd; v++) high.push(placed.find((p) => p.v === v)?.id ?? pool.shift()!);
      if (!low.length && !high.length) continue;
      const key = `${low.map((id) => (isJokerId(id) ? 'J' : id)).join(',')}|${high.map((id) => (isJokerId(id) ? 'J' : id)).join(',')}`;
      if (out.has(key)) continue;
      if (check(() => validateExtend(meld, low, high, cfg, melds)).ok === false) continue;
      out.set(key, { low, high });
    }
  }
  const plans = [...out.values()];
  if (end && plans.length > 1) {
    // prefer plans that put tiles on the clicked end, the more the better
    const side = (p: ExtendPlan): number => (end === 'low' ? p.low.length : p.high.length);
    plans.sort((a, b) => side(b) - side(a));
  }
  return plans;
}

/** Can the selection follow (跟斩) this SET? */
export function planFollow(meld: Meld, sel: string[], cfg: RulesConfig): boolean {
  if (meld.type !== 'SET' || !sel.length) return false;
  if (!sel.every((id) => isJokerId(id) || tileFromId(id).rank === meld.rank)) return false;
  return check(() => validateFollow(meld, sel, cfg)).ok !== false;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

/** A legal EXTEND entry matching exactly the selected tiles, if the engine listed one. */
export function legalExtendFor(legal: LegalMoves, meldId: string, sel: string[]): ExtendPlan | null {
  const e = legal.extends.find((x) => x.meldId === meldId && sameSet([...x.low, ...x.high], sel));
  return e ? { low: e.low, high: e.high } : null;
}

/** Tile ids that take part in at least one legal move right now (for the glow). */
export function playableTiles(view: PlayerView, needsPort: boolean): Set<string> {
  const out = new Set<string>();
  const legal = view.legal;
  if (!legal) return out;
  const add = (ids: string[]): void => ids.forEach((id) => out.add(id));
  if (needsPort) {
    legal.portCandidates.forEach(add);
    return out;
  }
  legal.extends.forEach((e) => {
    add(e.low);
    add(e.high);
  });
  legal.follows.forEach((f) => add(f.tiles));
  if (!legal.cutBlocked) legal.cuts.forEach(add);
  legal.newRuns.forEach(add);
  legal.swaps.forEach((s) => out.add(s.withTileId));
  return out;
}

/** Melds the current selection can legally join (for the 3D highlight + target chips). */
export function targetMelds(view: PlayerView, sel: string[]): Meld[] {
  const legal = view.legal;
  if (!legal || !sel.length) return [];
  return view.melds.filter((m) => {
    if (m.type === 'RUN') {
      if (!legal.extends.some((e) => e.meldId === m.id)) return false;
      return !!legalExtendFor(legal, m.id, sel) || planExtend(m, sel, view.cfg, view.melds, null).length > 0;
    }
    if (!legal.follows.some((f) => f.meldId === m.id)) return false;
    return planFollow(m, sel, view.cfg);
  });
}

export type HintKind = 'extend' | 'follow' | 'cut' | 'newRun' | 'swap';

export interface Hint {
  kind: HintKind;
  tiles: string[];
  meldId: string | null;
  action: Action;
  points: number;
}

/** All legal primary moves as hints, best (most penalty points removed) first. */
export function hintsFrom(view: PlayerView): Hint[] {
  const legal = view.legal;
  if (!legal) return [];
  const cfg = view.cfg;
  const hints: Hint[] = [];
  for (const e of legal.extends) {
    const tiles = [...e.low, ...e.high];
    hints.push({ kind: 'extend', tiles, meldId: e.meldId, action: { type: 'EXTEND', meldId: e.meldId, low: e.low, high: e.high }, points: points(tiles, cfg) });
  }
  for (const f of legal.follows) {
    hints.push({ kind: 'follow', tiles: f.tiles, meldId: f.meldId, action: { type: 'FOLLOW_CUT', meldId: f.meldId, tiles: f.tiles }, points: points(f.tiles, cfg) });
  }
  if (!legal.cutBlocked) {
    for (const c of legal.cuts) hints.push({ kind: 'cut', tiles: c, meldId: null, action: { type: 'CUT', tiles: c }, points: points(c, cfg) });
  }
  for (const r of legal.newRuns) hints.push({ kind: 'newRun', tiles: r, meldId: null, action: { type: 'NEW_RUN', tiles: r }, points: points(r, cfg) });
  hints.sort((a, b) => b.points - a.points || b.tiles.length - a.tiles.length);
  // drop exact duplicates (same kind, target and tiles)
  const seen = new Set<string>();
  const unique = hints.filter((x) => {
    const key = `${x.kind}|${x.meldId ?? ''}|${[...x.tiles].sort().join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Diversify so repeated "hint" clicks visit different moves first: the best move
  // per (kind, target) in score order, then the remaining variants.
  const firstOfGroup: Hint[] = [];
  const rest: Hint[] = [];
  const groups = new Set<string>();
  for (const x of unique) {
    const g = `${x.kind}|${x.meldId ?? [...x.tiles].map(tileKind).sort().join(',')}`;
    if (groups.has(g)) rest.push(x);
    else {
      groups.add(g);
      firstOfGroup.push(x);
    }
  }
  const ordered = [...firstOfGroup, ...rest];
  // a swap is a free action: suggest it last (it is the only hint when a swap must come first)
  for (const s of legal.swaps) {
    ordered.push({ kind: 'swap', tiles: [s.withTileId], meldId: s.meldId, action: { type: 'SWAP_JOKER', ...s }, points: 0 });
  }
  return ordered;
}

/** Tile "kind" ignoring the copy: `B10`, `RA`..., or `JK` for any joker. */
function tileKind(id: string): string {
  return isJokerId(id) ? 'JK' : id.slice(0, id.lastIndexOf('_'));
}

function jokerCount(ids: string[]): number {
  return ids.reduce((n, id) => n + (isJokerId(id) ? 1 : 0), 0);
}

/** One port proposal: disjoint melds plus what it sheds. */
export interface PortSuggestion {
  melds: string[][];
  points: number;
  jokers: number;
}

/** Search budget for the disjoint-cover search (nodes visited). */
const PORT_SEARCH_NODES = 40000;

/**
 * Port suggestions, best first: sets of DISJOINT candidate melds maximising the
 * penalty points shed. Like the normal bot's greedyPort, jokers stay in hand
 * whenever any natural-only port exists; only when none does is a joker meld
 * used, and then a single meld with the fewest jokers.
 *
 * Candidates are matched by tile kind, so a second copy in `hand` can realise a
 * candidate the engine only listed with the first copy (e.g. two ♠3-4-5 runs).
 * Returns up to `max` distinct alternatives (for cycling on repeated clicks).
 */
export function suggestPorts(candidates: string[][], cfg: RulesConfig, hand?: string[], max = 6): PortSuggestion[] {
  const natural = candidates.filter((c) => jokerCount(c) === 0);
  const pool = natural.length ? natural : candidates;
  // dedupe by kind signature (copies of the same tiles make the same meld)
  const seenKinds = new Set<string>();
  const cands: { kinds: string[]; pts: number; jk: number }[] = [];
  for (const c of pool) {
    const kinds = c.map(tileKind);
    const sig = kinds.join(',');
    if (seenKinds.has(sig)) continue;
    seenKinds.add(sig);
    cands.push({ kinds, pts: points(c, cfg), jk: jokerCount(c) });
  }
  if (!cands.length) return [];
  cands.sort((a, b) => a.jk - b.jk || b.pts - a.pts || b.kinds.length - a.kinds.length);

  // available copies per kind (without a hand, the candidates' own tiles)
  const avail = new Map<string, string[]>();
  for (const id of new Set(hand && hand.length ? hand : candidates.flat())) {
    const k = tileKind(id);
    const list = avail.get(k);
    if (list) list.push(id);
    else avail.set(k, [id]);
  }
  const counts = new Map<string, number>();
  for (const [k, ids] of avail) counts.set(k, ids.length);
  const fits = (kinds: string[]): boolean => {
    const need = new Map<string, number>();
    for (const k of kinds) need.set(k, (need.get(k) ?? 0) + 1);
    for (const [k, n] of need) if ((counts.get(k) ?? 0) < n) return false;
    return true;
  };
  const take = (kinds: string[], d: number): void => {
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) - d);
  };

  // Without any natural meld a port needs just ONE joker meld: keep the other jokers.
  const single = !natural.length;
  const found = new Map<string, { picks: number[]; pts: number; jk: number }>();
  let nodes = 0;
  const picks: number[] = [];
  const dfs = (start: number, pts: number, jk: number): void => {
    if (++nodes > PORT_SEARCH_NODES) return;
    let extended = false;
    if (!(single && picks.length === 1)) {
      for (let i = start; i < cands.length; i++) {
        const c = cands[i];
        if (!fits(c.kinds)) continue;
        extended = true;
        take(c.kinds, 1);
        picks.push(i);
        dfs(i, pts + c.pts, jk + c.jk); // same index again: a second copy may fit
        picks.pop();
        take(c.kinds, -1);
        if (nodes > PORT_SEARCH_NODES) break;
      }
    }
    // only record MAXIMAL covers: no candidate at all (also before `start`) still fits
    const maximal = single || !cands.some((c) => fits(c.kinds));
    if (!extended && picks.length && maximal) {
      // maximal cover: record it once (order-free key)
      const key = picks
        .map((i) => cands[i].kinds.join(','))
        .sort()
        .join('|');
      if (!found.has(key)) found.set(key, { picks: [...picks], pts, jk });
    }
  };
  dfs(0, 0, 0);

  const ranked = [...found.values()].sort((a, b) => a.jk - b.jk || b.pts - a.pts || a.picks.length - b.picks.length);
  // realise each proposal with concrete tile ids
  return ranked.slice(0, max).map((r) => {
    const used = new Set<string>();
    const melds = r.picks.map((i) =>
      cands[i].kinds.map((k) => {
        const id = (avail.get(k) ?? []).find((x) => !used.has(x))!;
        used.add(id);
        return id;
      }),
    );
    return { melds, points: r.pts, jokers: r.jk };
  });
}

/** Best port suggestion (see suggestPorts). */
export function suggestPort(candidates: string[][], cfg: RulesConfig, hand?: string[]): string[][] {
  return suggestPorts(candidates, cfg, hand, 1)[0]?.melds ?? [];
}

/**
 * The player has joker swaps but no primary move until one is made (the engine
 * keeps them alive only because a swapped joker opens a move).
 */
export function needsSwapFirst(legal: LegalMoves | null | undefined): boolean {
  if (!legal || legal.dead || legal.canEndTurn || !legal.swaps.length) return false;
  const primaries = legal.extends.length + legal.follows.length + (legal.cutBlocked ? 0 : legal.cuts.length) + legal.newRuns.length;
  return primaries === 0;
}

/** What a table joker stands for (its fixed rep); null when not found. */
export function jokerRep(melds: Meld[], meldId: string, jokerTileId: string): { colour: Colour | null; rank: number } | null {
  const m = melds.find((x) => x.id === meldId);
  const tl = m?.tiles.find((x) => x.tileId === jokerTileId);
  if (!m || !tl) return null;
  return { colour: m.type === 'RUN' ? (tl.rep.colour ?? m.colour ?? null) : null, rank: tl.rep.rank };
}

/** Text for a represented tile, e.g. "♠6" (run) or "6" (set). */
export function repLabel(rep: { colour: Colour | null; rank: number }): string {
  return `${rep.colour ? COLOUR_SUIT[rep.colour] : ''}${rankCode(rep.rank)}`;
}

/** Compact meld label, e.g. "♥3-7" or "8 x4". */
export function meldLabel(m: Meld): string {
  if (m.type === 'RUN' && m.tiles.length) {
    const lo = m.tiles[0].rep.rank;
    const hi = m.tiles[m.tiles.length - 1].rep.rank;
    return `${m.colour ? COLOUR_SUIT[m.colour] : ''}${rankCode(lo)}-${rankCode(hi)}`;
  }
  return `${rankCode(m.rank ?? 0)} x${m.tiles.length}`;
}

/** Hand sorting: by colour (default engine order) or by rank. */
export function sortByRank(ids: string[]): string[] {
  const key = (id: string): number => {
    const tl = tileFromId(id);
    if (tl.joker) return 10000 + Number(id.slice(3));
    const colourIdx = ['B', 'R', 'Y', 'G'].indexOf(tl.colour as string);
    return (tl.rank as number) * 100 + colourIdx * 2 + (id.endsWith('_2') ? 1 : 0);
  };
  return [...ids].sort((a, b) => key(a) - key(b));
}
