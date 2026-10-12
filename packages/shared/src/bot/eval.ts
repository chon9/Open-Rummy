/**
 * Static evaluation of a bot position (own hand + public table).
 *
 * Higher is better. The score combines:
 *  - the penalty points still in hand (what we pay if the hand ends now),
 *  - a "reserve": how many future turns we can surely act from our own hand
 *    (tiles chaining off open run ends, tiles that can follow a set, cut
 *    material, jokers). Running out of reserve means likely 盖牌 (Dead), which
 *    freezes the whole hand, so the first reserve moves are worth a lot,
 *  - exposure: open table slots whose tiles we do not hold, i.e. moves we hand
 *    to opponents. Weighted up when an opponent is close to emptying.
 */
import type { RulesConfig } from '../config';
import { tileFromId, type Colour } from '../tiles';
import type { Meld } from '../types';
import { HandKinds, kindKey, maxRunValue, penalty, valueRank, type Pos } from './model';

export interface Weights {
  /** bonus for emptying the hand (Game牌) */
  win: number;
  /** value of having at least one reserve move, as a fraction of the hand penalty, plus a floor */
  firstReserveFrac: number;
  firstReserveFloor: number;
  /** value of reserve moves 2..3 */
  midReserve: number;
  /** value of each reserve move beyond 3 */
  tailReserve: number;
  /** value of a tile that sits one gap away from an open run end */
  gap: number;
  /** cost per unseen tile that fits an open slot (helps opponents) */
  exposure: number;
  /** extra exposure multiplier at full pressure (an opponent nearly out) */
  pressureExposure: number;
  /** relative weight of set slots vs run slots for exposure (sets accept any colour) */
  setExposure: number;
  /** extra holding value per joker kept while the hand is still long */
  jokerHold: number;
}

export const HARD_WEIGHTS: Weights = {
  win: 400,
  firstReserveFrac: 0.5,
  firstReserveFloor: 6,
  midReserve: 5,
  tailReserve: 1,
  gap: 3,
  exposure: 0.8,
  pressureExposure: 2.5,
  setExposure: 0.5,
  jokerHold: 14,
};

export interface EvalCtx {
  cfg: RulesConfig;
  w: Weights;
  /** 0..1: how close the nearest alive opponent is to emptying the hand */
  pressure: number;
}

/** Pressure from the opponents' public hand counts. */
export function opponentPressure(counts: number[]): number {
  if (counts.length === 0) return 0;
  const min = Math.min(...counts);
  if (min <= 2) return 1;
  if (min <= 4) return 0.6;
  if (min <= 7) return 0.25;
  return 0;
}

/** Reserve moves available from `kinds` on `melds` (see file header). */
export function reserveMoves(kinds: HandKinds, melds: Meld[], cfg: RulesConfig): { moves: number; gaps: number; slots: number } {
  const maxV = maxRunValue(cfg);
  const locked = new Set<number>();
  if (cfg.setPriority) for (const m of melds) if (m.type === 'SET' && m.rank !== undefined) locked.add(m.rank);
  const inRange = (v: number) => v >= 1 && v <= maxV && !locked.has(valueRank(v));
  const demand = new Map<string, number>();
  const bump = (k: string, n = 1) => demand.set(k, (demand.get(k) ?? 0) + n);
  let gaps = 0;
  let slots = 0;

  for (const m of melds) {
    if (m.type === 'RUN' && m.colour) {
      const c = m.colour;
      const lo = m.tiles[0].rep.rank;
      const hi = m.tiles[m.tiles.length - 1].rep.rank;
      for (const [start, dir] of [
        [lo - 1, -1],
        [hi + 1, 1],
      ] as const) {
        if (!inRange(start)) continue;
        slots++;
        let v = start;
        const local = new Map<string, number>();
        while (inRange(v)) {
          const k = kindKey(c, valueRank(v));
          const u = local.get(k) ?? 0;
          if (kinds.count(c, valueRank(v)) <= u) break;
          local.set(k, u + 1);
          v += dir;
        }
        for (const [k, n] of local) bump(k, n);
        // one missing value, then a tile we hold: playable once someone fills the gap
        if (inRange(v) && inRange(v + dir) && kinds.count(c, valueRank(v + dir)) > 0) gaps++;
      }
    } else if (m.type === 'SET' && m.rank !== undefined) {
      const room = cfg.setCapFourDistinct ? 4 - m.tiles.length : Infinity;
      if (room <= 0) continue;
      slots++;
      const ids = kinds.byRank.get(m.rank) ?? [];
      for (const id of ids.slice(0, Math.min(ids.length, room))) {
        const t = tileFromId(id);
        bump(kindKey(t.colour as Colour, t.rank as number));
      }
    }
  }

  let moves = 0;
  for (const [k, n] of demand) moves += Math.min(n, kinds.byKind.get(k)?.length ?? 0);

  // cut material: a rank we could lay as a new set is one future move
  const J = kinds.jokers.length;
  for (const [r, ids] of kinds.byRank) {
    if (ids.length >= cfg.minNaturalsInNewMeld && ids.length + J >= 3 && ids.length >= 2) {
      // tiles already counted as run/set reserve are not double counted
      const spare = ids.filter((id) => {
        const t = tileFromId(id);
        return (demand.get(kindKey(t.colour as Colour, r)) ?? 0) === 0;
      }).length;
      if (spare + J >= 3 && spare >= cfg.minNaturalsInNewMeld) moves += 1;
    }
  }
  // each joker fits any open slot
  if (slots > 0) moves += J;
  return { moves, gaps, slots };
}

/** Unseen tiles (held by opponents or in the dead wall) that fit the open table slots. */
export function exposure(kinds: HandKinds, melds: Meld[], cfg: RulesConfig, setFactor: number): number {
  const maxV = maxRunValue(cfg);
  const tableKind = new Map<string, number>();
  const tableRank = new Map<number, number>();
  for (const m of melds) {
    for (const mt of m.tiles) {
      const t = tileFromId(mt.tileId);
      if (t.joker) continue;
      const k = kindKey(t.colour as Colour, t.rank as number);
      tableKind.set(k, (tableKind.get(k) ?? 0) + 1);
      tableRank.set(t.rank as number, (tableRank.get(t.rank as number) ?? 0) + 1);
    }
  }
  let e = 0;
  for (const m of melds) {
    if (m.type === 'RUN' && m.colour) {
      const lo = m.tiles[0].rep.rank;
      const hi = m.tiles[m.tiles.length - 1].rep.rank;
      for (const v of [lo - 1, hi + 1]) {
        if (v < 1 || v > maxV) continue;
        const r = valueRank(v);
        e += Math.max(0, 2 - kinds.count(m.colour, r) - (tableKind.get(kindKey(m.colour, r)) ?? 0));
      }
    } else if (m.type === 'SET' && m.rank !== undefined) {
      if (cfg.setCapFourDistinct && m.tiles.length >= 4) continue;
      e += setFactor * Math.max(0, 8 - kinds.rankCount(m.rank) - (tableRank.get(m.rank) ?? 0));
    }
  }
  return e;
}

export function evaluate(pos: Pos, ec: EvalCtx): number {
  const { cfg, w } = ec;
  if (pos.hand.length === 0) return w.win;
  const kinds = new HandKinds(pos.hand);
  const pen = penalty(pos.hand, cfg);
  const res = reserveMoves(kinds, pos.melds, cfg);
  const r = res.moves;
  let value = -pen;
  value += r >= 1 ? w.firstReserveFloor + w.firstReserveFrac * pen : 0;
  value += w.midReserve * Math.min(Math.max(r - 1, 0), 2);
  value += w.tailReserve * Math.max(r - 3, 0);
  value += w.gap * res.gaps;
  // jokers are flexible while the hand is long; near the end they are just 20 points
  if (pos.hand.length > 6) value += w.jokerHold * kinds.jokers.length;
  const exp = exposure(kinds, pos.melds, cfg, w.setExposure);
  value -= w.exposure * (1 + w.pressureExposure * ec.pressure) * exp;
  return value;
}
