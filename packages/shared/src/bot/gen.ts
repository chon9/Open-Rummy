/**
 * Candidate move generation for the bots. The engine's LegalMoves lists are
 * deliberately small (single tiles plus maximal chains); stronger bots also
 * want partial chains, e.g. extend by one tile and keep the next one as a
 * future move. Everything generated here is checked with the engine's meld
 * validators (via `simulate`) before it can be chosen.
 */
import type { RulesConfig } from '../config';
import { COLOURS, type Colour } from '../tiles';
import type { Action, LegalMoves } from '../types';
import { HandKinds, TilePool, actionKey, maxRunValue, valueRank, type Pos } from './model';

export interface Step {
  v: number;
  joker: boolean;
}

function lockedRanks(pos: Pos, cfg: RulesConfig): Set<number> {
  const locked = new Set<number>();
  if (cfg.setPriority) for (const m of pos.melds) if (m.type === 'SET' && m.rank !== undefined) locked.add(m.rank);
  return locked;
}

/**
 * Walk outward from a run end taking a natural when we hold one, else a joker
 * (at most `maxJ`). Every prefix of this walk is an extension option.
 */
function sidePath(kinds: HandKinds, c: Colour, start: number, dir: 1 | -1, inRange: (v: number) => boolean, maxJ: number): Step[] {
  const path: Step[] = [];
  const used = new Map<number, number>();
  let j = 0;
  for (let v = start; inRange(v); v += dir) {
    const r = valueRank(v);
    const u = used.get(r) ?? 0;
    if (kinds.count(c, r) > u) {
      used.set(r, u + 1);
      path.push({ v, joker: false });
    } else if (j < maxJ) {
      j++;
      path.push({ v, joker: true });
    } else break;
  }
  // trailing jokers beyond the last natural are fine (they extend the end)
  return path;
}

function materialise(pool: TilePool, c: Colour, steps: Step[]): string[] | null {
  const out: string[] = [];
  for (const s of steps) {
    const id = s.joker ? pool.takeJoker() : pool.take(c, valueRank(s.v));
    if (!id) return null;
    out.push(id);
  }
  return out;
}

/** All prefix x prefix extensions of every run on the table. */
export function genExtendActions(pos: Pos, cfg: RulesConfig, kinds: HandKinds): Action[] {
  const out: Action[] = [];
  const maxV = maxRunValue(cfg);
  const locked = lockedRanks(pos, cfg);
  const inRange = (v: number) => v >= 1 && v <= maxV && !locked.has(valueRank(v));
  const J = kinds.jokers.length;
  for (const m of pos.melds) {
    if (m.type !== 'RUN' || !m.colour) continue;
    const c = m.colour;
    const lo = m.tiles[0].rep.rank;
    const hi = m.tiles[m.tiles.length - 1].rep.rank;
    const lowPath = sidePath(kinds, c, lo - 1, -1, inRange, J);
    const highPath = sidePath(kinds, c, hi + 1, 1, inRange, J);
    for (let a = 0; a <= lowPath.length; a++) {
      const lowSteps = lowPath.slice(0, a);
      const lowJ = lowSteps.filter((s) => s.joker).length;
      for (let b = 0; b <= highPath.length; b++) {
        if (a + b === 0) continue;
        const highSteps = highPath.slice(0, b);
        if (lowJ + highSteps.filter((s) => s.joker).length > J) continue;
        const pool = new TilePool(kinds);
        const lowIds = materialise(pool, c, lowSteps);
        const highIds = materialise(pool, c, highSteps);
        if (!lowIds || !highIds) continue;
        out.push({ type: 'EXTEND', meldId: m.id, low: lowIds.reverse(), high: highIds });
      }
    }
  }
  return out;
}

export function genFollowActions(pos: Pos, cfg: RulesConfig, kinds: HandKinds): Action[] {
  const out: Action[] = [];
  for (const m of pos.melds) {
    if (m.type !== 'SET' || m.rank === undefined) continue;
    const room = cfg.setCapFourDistinct ? 4 - m.tiles.length : Infinity;
    if (room <= 0) continue;
    let nats = kinds.byRank.get(m.rank) ?? [];
    if (cfg.setCapFourDistinct) {
      const cols = new Set<string>();
      for (const mt of m.tiles) if (!mt.tileId.startsWith('JK_')) cols.add(mt.tileId[0]);
      nats = nats.filter((id) => {
        if (cols.has(id[0])) return false;
        cols.add(id[0]);
        return true;
      });
    }
    for (let k = 1; k <= Math.min(nats.length, room); k++) out.push({ type: 'FOLLOW_CUT', meldId: m.id, tiles: nats.slice(0, k) });
    for (let j = 1; j <= kinds.jokers.length; j++) {
      const tiles = [...nats, ...kinds.jokers.slice(0, j)];
      if (tiles.length <= room) out.push({ type: 'FOLLOW_CUT', meldId: m.id, tiles });
      if (j <= room) out.push({ type: 'FOLLOW_CUT', meldId: m.id, tiles: kinds.jokers.slice(0, j) });
    }
  }
  return out;
}

/** New sets of 3+ (all-natural prefixes, topped up with the fewest jokers needed). */
export function genSetMelds(cfg: RulesConfig, kinds: HandKinds): string[][] {
  const out: string[][] = [];
  const J = kinds.jokers;
  for (const ids0 of kinds.byRank.values()) {
    let ids = ids0;
    if (cfg.setCapFourDistinct) {
      const cols = new Set<string>();
      ids = ids.filter((id) => (cols.has(id[0]) ? false : (cols.add(id[0]), true)));
    }
    for (let k = Math.max(1, cfg.minNaturalsInNewMeld); k <= ids.length; k++) {
      const need = Math.max(0, 3 - k);
      if (need > J.length) continue;
      const tiles = [...ids.slice(0, k), ...J.slice(0, need)];
      if (cfg.setCapFourDistinct && tiles.length > 4) continue;
      out.push(tiles);
    }
  }
  return out;
}

/**
 * Candidate runs from the hand: from every natural start, walk up taking a
 * natural when held, else a joker (at most `maxJ`); every length >= 3 that
 * ends on a natural is a candidate.
 */
export function genRunMelds(cfg: RulesConfig, kinds: HandKinds, maxJ: number): string[][] {
  const out: string[][] = [];
  for (const w of genRunWindows(cfg, kinds, maxJ)) {
    const ids = materialise(new TilePool(kinds), w.colour, w.steps);
    if (ids) out.push(ids);
  }
  return out;
}

/** A candidate run expressed in values (materialised later with a shared pool). */
export interface RunWindow {
  colour: Colour;
  steps: Step[];
}

export function materialiseWindow(pool: TilePool, w: RunWindow): string[] | null {
  return materialise(pool, w.colour, w.steps);
}

export function genRunWindows(cfg: RulesConfig, kinds: HandKinds, maxJ: number): RunWindow[] {
  const out: RunWindow[] = [];
  const maxV = maxRunValue(cfg);
  for (const c of COLOURS) {
    for (let s = 1; s <= maxV - 2; s++) {
      if (kinds.count(c, valueRank(s)) === 0) continue;
      const steps: Step[] = [];
      const used = new Map<number, number>();
      let j = 0;
      let nat = 0;
      for (let v = s; v <= maxV; v++) {
        const r = valueRank(v);
        const u = used.get(r) ?? 0;
        if (kinds.count(c, r) > u) {
          used.set(r, u + 1);
          steps.push({ v, joker: false });
          nat++;
        } else if (j < maxJ) {
          j++;
          steps.push({ v, joker: true });
        } else break;
        if (steps.length >= 3 && !steps[steps.length - 1].joker && nat >= cfg.minNaturalsInNewMeld) {
          out.push({ colour: c, steps: [...steps] });
        }
      }
    }
  }
  return out;
}

/** Primary actions listed by the engine for this decision. */
export function legalPrimaries(legal: LegalMoves): Action[] {
  const out: Action[] = [];
  for (const e of legal.extends) out.push({ type: 'EXTEND', meldId: e.meldId, low: e.low, high: e.high });
  for (const c of legal.cuts) out.push({ type: 'CUT', tiles: c });
  for (const f of legal.follows) out.push({ type: 'FOLLOW_CUT', meldId: f.meldId, tiles: f.tiles });
  for (const r of legal.newRuns) out.push({ type: 'NEW_RUN', tiles: r });
  return out;
}

export interface GenOptions {
  /** cuts may be laid (the 斩 precondition holds) */
  cutAllowed: boolean;
  /** if set, every primary action must include this joker (jokerSwap 'useSameTurn') */
  mustUse: string | null;
}

/** Custom primary actions for a position (validity still to be checked by `simulate`). */
export function genPrimaries(pos: Pos, cfg: RulesConfig, opts: GenOptions): Action[] {
  const kinds = new HandKinds(pos.hand);
  const out: Action[] = [...genExtendActions(pos, cfg, kinds), ...genFollowActions(pos, cfg, kinds)];
  if (opts.cutAllowed) for (const t of genSetMelds(cfg, kinds)) out.push({ type: 'CUT', tiles: t });
  if (cfg.newRunsAfterPort) for (const t of genRunMelds(cfg, kinds, Math.min(2, kinds.jokers.length))) out.push({ type: 'NEW_RUN', tiles: t });
  const must = opts.mustUse;
  return must ? out.filter((a) => actionUses(a, must)) : out;
}

function actionUses(a: Action, id: string): boolean {
  switch (a.type) {
    case 'EXTEND':
      return a.low.includes(id) || a.high.includes(id);
    case 'CUT':
    case 'NEW_RUN':
    case 'FOLLOW_CUT':
      return a.tiles.includes(id);
    default:
      return false;
  }
}

export function dedupe(actions: Action[]): Action[] {
  const seen = new Set<string>();
  const out: Action[] = [];
  for (const a of actions) {
    const k = actionKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}
