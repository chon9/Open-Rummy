/**
 * Move generation and move-existence checks for the play and port phases
 * (docs/RULES.md §6, §7, §15). Pure functions over a small context so the
 * engine can evaluate hypothetical positions (e.g. "after one Joker swap").
 */
import type { RulesConfig } from '../config';
import { COLOURS, RANKS, tileFromId, tilePenalty, type Colour } from '../tiles';
import type { Meld } from '../types';
import { canSwapJoker } from '../melds';
import { runBounds, runMaxValue, safeTile, setRanksOnTable, valueToRank } from './util';

/** Upper bound on any generated move list. */
export const LIST_CAP = 200;

export interface MoveCtx {
  cfg: RulesConfig;
  hand: string[];
  melds: Meld[];
  /** a retrieved joker that the next primary action must use (jokerSwap = 'useSameTurn') */
  mustUse: string | null;
  /** unlimitedActions mode and the player already acted: swaps need not enable a further action */
  acted: boolean;
}

export interface ExtendMove {
  meldId: string;
  low: string[];
  high: string[];
}
export interface FollowMove {
  meldId: string;
  tiles: string[];
}
export interface SwapMove {
  meldId: string;
  jokerTileId: string;
  withTileId: string;
}

// ---------------------------------------------------------------------------
// Hand index and tile pool
// ---------------------------------------------------------------------------

const key = (c: Colour, r: number): string => `${c}${r}`;

/** Naturals grouped by colour+rank, jokers listed with the preferred one first. */
export class HandIndex {
  readonly nat = new Map<string, string[]>();
  readonly byRank = new Map<number, string[]>();
  readonly jokers: string[] = [];

  constructor(hand: string[], preferJoker: string | null = null) {
    const sorted = [...hand].sort();
    for (const id of sorted) {
      const t = tileFromId(id);
      if (t.joker) {
        this.jokers.push(id);
        continue;
      }
      const k = key(t.colour as Colour, t.rank as number);
      const list = this.nat.get(k);
      if (list) list.push(id);
      else this.nat.set(k, [id]);
      const byR = this.byRank.get(t.rank as number);
      if (byR) byR.push(id);
      else this.byRank.set(t.rank as number, [id]);
    }
    if (preferJoker && this.jokers.includes(preferJoker)) {
      this.jokers.splice(this.jokers.indexOf(preferJoker), 1);
      this.jokers.unshift(preferJoker);
    }
  }

  first(c: Colour, r: number): string | null {
    return this.nat.get(key(c, r))?.[0] ?? null;
  }
  count(c: Colour, r: number): number {
    return this.nat.get(key(c, r))?.length ?? 0;
  }
  pool(): Pool {
    return new Pool(this);
  }
}

/** Consumable copy of a hand index, for building one move at a time. */
export class Pool {
  private readonly used = new Map<string, number>();
  private jokersUsed = 0;
  constructor(private readonly idx: HandIndex) {}

  has(c: Colour, r: number): boolean {
    return (this.used.get(key(c, r)) ?? 0) < this.idx.count(c, r);
  }
  take(c: Colour, r: number): string | null {
    const k = key(c, r);
    const u = this.used.get(k) ?? 0;
    const list = this.idx.nat.get(k);
    if (!list || u >= list.length) return null;
    this.used.set(k, u + 1);
    return list[u];
  }
  get jokersLeft(): number {
    return this.idx.jokers.length - this.jokersUsed;
  }
  takeJoker(): string | null {
    if (this.jokersLeft <= 0) return null;
    return this.idx.jokers[this.jokersUsed++];
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function penaltyOf(ids: string[], cfg: RulesConfig): number {
  let sum = 0;
  for (const id of ids) sum += tilePenalty(id, cfg.jokerPenalty);
  return sum;
}

/** Push a list entry once (by key), respecting LIST_CAP. */
function pushUnique<T>(out: T[], seen: Set<string>, k: string, item: T): void {
  if (out.length >= LIST_CAP || seen.has(k)) return;
  seen.add(k);
  out.push(item);
}

function setNaturalColours(meld: Meld): Colour[] {
  const out: Colour[] = [];
  for (const mt of meld.tiles) {
    const t = safeTile(mt.tileId);
    if (t && !t.joker) out.push(t.colour as Colour);
  }
  return out;
}

function setRoom(meld: Meld, cfg: RulesConfig): number {
  return cfg.setCapFourDistinct ? Math.max(0, 4 - meld.tiles.length) : Infinity;
}

// ---------------------------------------------------------------------------
// Existence checks (cheap; used for the Dead / 全餐 / cut-blocked rules)
// ---------------------------------------------------------------------------

/** Is there any single-tile extension (sufficient: any multi-tile extension starts with one). */
export function anyExtend(ctx: MoveCtx, idx = new HandIndex(ctx.hand, ctx.mustUse)): boolean {
  const { cfg } = ctx;
  const maxV = runMaxValue(cfg);
  const locked = cfg.setPriority ? setRanksOnTable(ctx.melds) : new Set<number>();
  const hasJoker = idx.jokers.length > 0;
  for (const m of ctx.melds) {
    if (m.type !== 'RUN' || !m.colour) continue;
    const { lo, hi } = runBounds(m);
    for (const v of [lo - 1, hi + 1]) {
      if (v < 1 || v > maxV || locked.has(valueToRank(v))) continue;
      if (ctx.mustUse) return true; // the retrieved joker fits any open end
      if (hasJoker || idx.count(m.colour, valueToRank(v)) > 0) return true;
    }
  }
  return false;
}

export function anyFollow(ctx: MoveCtx, idx = new HandIndex(ctx.hand, ctx.mustUse)): boolean {
  const { cfg } = ctx;
  for (const m of ctx.melds) {
    if (m.type !== 'SET' || m.rank === undefined) continue;
    if (setRoom(m, cfg) <= 0) continue;
    if (ctx.mustUse || idx.jokers.length > 0) return true;
    const ids = idx.byRank.get(m.rank) ?? [];
    if (!cfg.setCapFourDistinct && ids.length > 0) return true;
    const used = setNaturalColours(m);
    if (ids.some((id) => !used.includes(tileFromId(id).colour as Colour))) return true;
  }
  return false;
}

/** Can a set of `rank` be formed (ignoring the cut-precondition rule)? */
function setFormable(ctx: MoveCtx, idx: HandIndex, rank: number, needJoker: boolean): boolean {
  const { cfg } = ctx;
  const ids = idx.byRank.get(rank) ?? [];
  const usable = cfg.setCapFourDistinct ? new Set(ids.map((id) => tileFromId(id).colour)).size : ids.length;
  const J = idx.jokers.length;
  for (let k = cfg.minNaturalsInNewMeld; k <= usable; k++) {
    const jMin = Math.max(needJoker ? 1 : 0, 3 - k);
    const jMax = cfg.setCapFourDistinct ? Math.min(J, 4 - k) : J;
    if (jMin <= jMax) return true;
  }
  return false;
}

export function anyCutShape(ctx: MoveCtx, idx = new HandIndex(ctx.hand, ctx.mustUse)): boolean {
  for (const r of RANKS) if (setFormable(ctx, idx, r, !!ctx.mustUse)) return true;
  return false;
}

/**
 * Any new run formable from the hand (holding a joker when one must be used).
 * Every window length is tried: naturals split by several jokers (R5 J J R8)
 * form a legal run although no 3-tile window of it holds two naturals.
 * A window uses each natural value it can (one tile per value; the A at 1 and
 * at 14 are separate values, so two aces may both be used) and fills the rest
 * with jokers; with a joker required, the window must have a gap for it.
 */
function runFormable(ctx: MoveCtx, idx: HandIndex, needJoker: boolean): boolean {
  const { cfg } = ctx;
  const maxV = runMaxValue(cfg);
  const J = idx.jokers.length;
  const minN = cfg.minNaturalsInNewMeld;
  for (const c of COLOURS) {
    for (let s = 1; s <= maxV - 2; s++) {
      let nat = 0;
      let aces = 0;
      for (let L = 1; s + L - 1 <= maxV; L++) {
        const v = s + L - 1;
        const r = valueToRank(v);
        // a second ace (value 14 after value 1) needs a second ace tile
        const have = idx.count(c, r) - (r === 1 ? aces : 0);
        if (have > 0) {
          nat++;
          if (r === 1) aces++;
        }
        if (L < 3) continue;
        const need = L - nat;
        if (need <= J && nat >= minN && (!needJoker || need >= 1)) return true;
      }
    }
  }
  return false;
}

export function anyNewRun(ctx: MoveCtx, idx = new HandIndex(ctx.hand, ctx.mustUse)): boolean {
  if (!ctx.cfg.newRunsAfterPort) return false;
  return runFormable(ctx, idx, !!ctx.mustUse);
}

/** 全餐 check: can the hand make at least one legal port meld? */
export function canPortHand(hand: string[], cfg: RulesConfig): boolean {
  const ctx: MoveCtx = { cfg, hand, melds: [], mustUse: null, acted: false };
  const idx = new HandIndex(hand);
  if (runFormable(ctx, idx, false)) return true;
  if (cfg.setAllowedAsPort) return anyCutShape(ctx, idx);
  return false;
}

/** All raw joker swaps (exact rep match), deduplicated per natural kind, with the post-swap context. */
export function rawSwaps(ctx: MoveCtx): { move: SwapMove; post: MoveCtx }[] {
  const { cfg } = ctx;
  if (cfg.jokerSwap === 'off' || ctx.mustUse) return [];
  const out: { move: SwapMove; post: MoveCtx }[] = [];
  const naturals = [...new Set(ctx.hand)].filter((id) => !tileFromId(id).joker).sort();
  for (const m of ctx.melds) {
    for (const slot of m.tiles) {
      if (!tileFromId(slot.tileId).joker) continue;
      const kinds = new Set<string>();
      for (const id of naturals) {
        const t = tileFromId(id);
        const kind = `${t.colour}${t.rank}`;
        if (kinds.has(kind) || !canSwapJoker(m, slot.tileId, id)) continue;
        if (m.type === 'SET' && cfg.setCapFourDistinct && setNaturalColours(m).includes(t.colour as Colour)) continue;
        kinds.add(kind);
        const newMeld: Meld = {
          ...m,
          tiles: m.tiles.map((mt) => (mt.tileId === slot.tileId ? { tileId: id, rep: mt.rep } : mt)),
        };
        const post: MoveCtx = {
          cfg,
          hand: [...ctx.hand.filter((h) => h !== id), slot.tileId],
          melds: ctx.melds.map((mm) => (mm.id === m.id ? newMeld : mm)),
          mustUse: cfg.jokerSwap === 'useSameTurn' ? slot.tileId : null,
          acted: ctx.acted,
        };
        out.push({ move: { meldId: m.id, jokerTileId: slot.tileId, withTileId: id }, post });
      }
    }
  }
  return out;
}

/** 接 possible now or after one Joker swap (the cut-precondition test, RULES §7 / §13). */
export function extendPossible(ctx: MoveCtx): boolean {
  if (anyExtend(ctx)) return true;
  return rawSwaps(ctx).some((s) => anyExtend(s.post));
}

/** Is 斩 permitted by the precondition rule in this position? */
export function cutAllowed(ctx: MoveCtx): boolean {
  return !ctx.cfg.cutOnlyWhenCannotExtend || !extendPossible(ctx);
}

/** Any primary action available right now (no swap first). */
export function hasDirectPrimary(ctx: MoveCtx): boolean {
  const idx = new HandIndex(ctx.hand, ctx.mustUse);
  if (anyExtend(ctx, idx) || anyFollow(ctx, idx) || anyNewRun(ctx, idx)) return true;
  return anyCutShape(ctx, idx) && cutAllowed(ctx);
}

/**
 * A swap is legal when a primary action is still reachable afterwards (now or
 * after further swaps), or the player may already end the turn.
 */
export function swapKeepsMove(post: MoveCtx): boolean {
  if (post.acted && !post.mustUse) return true;
  return !isDead(post);
}

/** Legal swaps for this position. */
export function legalSwaps(ctx: MoveCtx): { move: SwapMove; post: MoveCtx }[] {
  return rawSwaps(ctx).filter((s) => swapKeepsMove(s.post));
}

function ctxKey(ctx: MoveCtx): string {
  const melds = ctx.melds.map((m) => m.tiles.map((t) => t.tileId).join(',')).join(';');
  return `${[...ctx.hand].sort().join(',')}|${melds}|${ctx.mustUse ?? ''}`;
}

/**
 * Dead / 盖牌 (RULES §7): no primary action now and none after any sequence of
 * Joker swaps. Under the default rules one swap always settles it (a retrieved
 * Joker extends any open run end or follows any set), so the deeper search
 * only runs when the table has neither; it ends because every swap removes a
 * Joker from the table, and positions are memoised.
 */
export function isDead(ctx: MoveCtx, memo = new Map<string, boolean>()): boolean {
  if (hasDirectPrimary(ctx)) return false;
  const k = ctxKey(ctx);
  const known = memo.get(k);
  if (known !== undefined) return known;
  memo.set(k, true);
  const swaps = rawSwaps(ctx);
  // cheap breadth-first pass before recursing
  const dead = !swaps.some((s) => hasDirectPrimary(s.post)) && !swaps.some((s) => !isDead(s.post, memo));
  memo.set(k, dead);
  return dead;
}

/**
 * Shortest sequence of legal swaps after which `ok(post)` holds (empty when it
 * holds already), or null. Used by the timeout auto-play.
 */
export function swapPath(ctx: MoveCtx, ok: (c: MoveCtx) => boolean): { moves: SwapMove[]; post: MoveCtx } | null {
  const seen = new Set<string>([ctxKey(ctx)]);
  let frontier: { moves: SwapMove[]; post: MoveCtx }[] = [{ moves: [], post: ctx }];
  while (frontier.length > 0) {
    for (const f of frontier) if (ok(f.post)) return f;
    const next: { moves: SwapMove[]; post: MoveCtx }[] = [];
    for (const f of frontier) {
      for (const s of legalSwaps(f.post)) {
        const k = ctxKey(s.post);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ moves: [...f.moves, s.move], post: s.post });
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generators (bounded, deduplicated lists)
// ---------------------------------------------------------------------------

type WalkMode = 'nat' | 'gap' | 'dump';

/**
 * Walk outward from one end of a run, taking tiles from `pool`.
 * 'nat'  - naturals only, stop at the first missing value
 * 'gap'  - also fill gaps with jokers when a natural lies beyond the gap
 * 'dump' - like 'gap', then append all remaining jokers as far as the range allows
 * Returns tiles in placement order low -> high.
 */
function walk(
  pool: Pool,
  colour: Colour,
  start: number,
  step: 1 | -1,
  mode: WalkMode,
  inRange: (v: number) => boolean,
): string[] {
  const seq: string[] = [];
  let v = start;
  while (inRange(v)) {
    const nat = pool.take(colour, valueToRank(v));
    if (nat) {
      seq.push(nat);
      v += step;
      continue;
    }
    if (mode === 'nat') break;
    let g = 0;
    let w = v;
    while (inRange(w) && !pool.has(colour, valueToRank(w))) {
      g++;
      w += step;
    }
    if (inRange(w) && g <= pool.jokersLeft) {
      for (let i = 0; i < g; i++) seq.push(pool.takeJoker() as string);
      v = w;
      continue;
    }
    if (mode === 'dump') {
      while (inRange(v) && pool.jokersLeft > 0) {
        seq.push(pool.takeJoker() as string);
        v += step;
      }
    }
    break;
  }
  return step === -1 ? seq.reverse() : seq;
}

export function genExtends(ctx: MoveCtx, idx: HandIndex): ExtendMove[] {
  const { cfg } = ctx;
  const out: ExtendMove[] = [];
  const seen = new Set<string>();
  const maxV = runMaxValue(cfg);
  const locked = cfg.setPriority ? setRanksOnTable(ctx.melds) : new Set<number>();
  const inRange = (v: number) => v >= 1 && v <= maxV && !locked.has(valueToRank(v));
  const add = (m: Meld, low: string[], high: string[]) => {
    if (low.length + high.length === 0) return;
    pushUnique(out, seen, `${m.id}|${low.join(',')}|${high.join(',')}`, { meldId: m.id, low, high });
  };

  for (const m of ctx.melds) {
    if (m.type !== 'RUN' || !m.colour) continue;
    const c = m.colour;
    const { lo, hi } = runBounds(m);
    // single tiles per end
    for (const [v, side] of [
      [lo - 1, 'low'],
      [hi + 1, 'high'],
    ] as const) {
      if (!inRange(v)) continue;
      const nat = idx.first(c, valueToRank(v));
      const single = [nat, idx.jokers[0]].filter((x): x is string => !!x);
      for (const id of single) add(m, side === 'low' ? [id] : [], side === 'high' ? [id] : []);
    }
    // chains per end, then both ends together
    for (const mode of ['nat', 'gap', 'dump'] as WalkMode[]) {
      const lowChain = walk(idx.pool(), c, lo - 1, -1, mode, inRange);
      const highChain = walk(idx.pool(), c, hi + 1, 1, mode, inRange);
      if (lowChain.length >= 2) add(m, lowChain, []);
      if (highChain.length >= 2) add(m, [], highChain);
      const shared = idx.pool();
      const bothLow = walk(shared, c, lo - 1, -1, mode, inRange);
      const bothHigh = walk(shared, c, hi + 1, 1, mode, inRange);
      if (bothLow.length > 0 && bothHigh.length > 0) add(m, bothLow, bothHigh);
    }
  }
  return out;
}

/** Candidate sets for 斩 (and for ports when sets are allowed). */
export function genSets(ctx: MoveCtx, idx: HandIndex): string[][] {
  const { cfg } = ctx;
  const out: string[][] = [];
  const seen = new Set<string>();
  const minN = cfg.minNaturalsInNewMeld;
  const cap = cfg.setCapFourDistinct;
  const J = idx.jokers;
  const add = (tiles: string[]) => {
    if (tiles.length < 3) return;
    const nats = tiles.filter((t) => !tileFromId(t).joker);
    if (nats.length < minN) return;
    if (cap && (tiles.length > 4 || new Set(nats.map((t) => tileFromId(t).colour)).size !== nats.length)) return;
    pushUnique(out, seen, [...tiles].sort().join(','), tiles);
  };
  for (const r of RANKS) {
    const ids = idx.byRank.get(r) ?? [];
    if (ids.length === 0) continue;
    // one id per colour first (distinct colours), then duplicates
    const distinct: string[] = [];
    const colours = new Set<string>();
    for (const id of ids) {
      const col = tileFromId(id).colour as string;
      if (!colours.has(col)) {
        colours.add(col);
        distinct.push(id);
      }
    }
    const all = cap ? distinct : ids;
    add(all);
    if (J.length > 0) add([...all, ...J.slice(0, cap ? Math.max(0, 4 - all.length) : J.length)]);
    // 3-tile variants: deduplicate by colour signature
    const sigSeen = new Set<string>();
    const sig = (xs: string[]) => xs.map((x) => (tileFromId(x).joker ? 'J' : tileFromId(x).colour)).sort().join('');
    const variant = (xs: string[]) => {
      const s = sig(xs);
      if (sigSeen.has(s)) return;
      sigSeen.add(s);
      add(xs);
    };
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        for (let c = b + 1; c < ids.length; c++) variant([ids[a], ids[b], ids[c]]);
        if (J.length >= 1) variant([ids[a], ids[b], J[0]]);
      }
      if (J.length >= 2) variant([ids[a], J[0], J[1]]);
    }
  }
  return out;
}

export function genFollows(ctx: MoveCtx, idx: HandIndex): FollowMove[] {
  const { cfg } = ctx;
  const out: FollowMove[] = [];
  const seen = new Set<string>();
  const add = (m: Meld, tiles: string[]) => {
    if (tiles.length === 0) return;
    pushUnique(out, seen, `${m.id}|${[...tiles].sort().join(',')}`, { meldId: m.id, tiles });
  };
  for (const m of ctx.melds) {
    if (m.type !== 'SET' || m.rank === undefined) continue;
    const room = setRoom(m, cfg);
    if (room <= 0) continue;
    const used = setNaturalColours(m);
    let nats = idx.byRank.get(m.rank) ?? [];
    if (cfg.setCapFourDistinct) {
      const cols = new Set<string>(used);
      nats = nats.filter((id) => {
        const col = tileFromId(id).colour as string;
        if (cols.has(col)) return false;
        cols.add(col);
        return true;
      });
    }
    const singleCols = new Set<string>();
    for (const id of nats) {
      const col = tileFromId(id).colour as string;
      if (singleCols.has(col)) continue;
      singleCols.add(col);
      add(m, [id]);
    }
    if (idx.jokers.length > 0) add(m, [idx.jokers[0]]);
    const allNat = nats.slice(0, room);
    if (allNat.length > 1) add(m, allNat);
    const withJ = [...nats, ...idx.jokers].slice(0, room);
    if (withJ.length > 1) add(m, withJ);
  }
  return out;
}

/**
 * Candidate runs from a hand: every maximal natural run, every 3-tile window
 * (with joker gap-fills), and maximal natural-ended runs with joker gap-fills.
 */
export function genRuns(ctx: MoveCtx, idx: HandIndex): string[][] {
  const { cfg } = ctx;
  const out: string[][] = [];
  const seen = new Set<string>();
  const maxV = runMaxValue(cfg);
  const minN = cfg.minNaturalsInNewMeld;
  const J = idx.jokers.length;
  for (const c of COLOURS) {
    const avail = (v: number) => v >= 1 && v <= maxV && idx.count(c, valueToRank(v)) > 0;
    const build = (s: number, L: number): string[] | null => {
      const pool = idx.pool();
      const ids: string[] = [];
      for (let v = s; v < s + L; v++) {
        const id = pool.take(c, valueToRank(v)) ?? pool.takeJoker();
        if (!id) return null;
        ids.push(id);
      }
      return ids;
    };
    for (let s = 1; s <= maxV - 2; s++) {
      let nat = 0;
      for (let L = 1; s + L - 1 <= maxV; L++) {
        if (avail(s + L - 1)) nat++;
        if (L < 3) continue;
        const need = L - nat;
        if (nat < minN || need > J) continue;
        const e = s + L - 1;
        const maximal = !avail(s - 1) && !avail(e + 1);
        const naturalEnds = avail(s) && avail(e);
        const keep = L === 3 || (need === 0 && maximal) || (need > 0 && naturalEnds && maximal);
        if (!keep) continue;
        const ids = build(s, L);
        if (!ids) continue;
        const nats = ids.filter((id) => !tileFromId(id).joker).length;
        if (nats < minN) continue; // two-ace windows may fall short of naturals
        pushUnique(out, seen, ids.join(','), ids);
        // a maximal natural run plus one joker at either end (useful when a joker must be used)
        if (need === 0 && maximal && J > 0 && L < 14) {
          if (s > 1) pushUnique(out, seen, `${idx.jokers[0]},${ids.join(',')}`, [idx.jokers[0], ...ids]);
          if (e < maxV) pushUnique(out, seen, `${ids.join(',')},${idx.jokers[0]}`, [...ids, idx.jokers[0]]);
        }
      }
    }
  }
  // Prefer longer, natural-only candidates first (stable for equal length).
  return out.sort((a, b) => b.length - a.length);
}

/** Does the move use the tile `id`? */
export function movesUse(tiles: string[], id: string | null): boolean {
  return id === null || tiles.includes(id);
}
