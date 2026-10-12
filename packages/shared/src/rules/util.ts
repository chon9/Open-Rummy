/**
 * Shared low-level helpers for meld validation and move generation.
 * Kept out of the package index on purpose (internal API).
 */
import type { RulesConfig } from '../config';
import { tileFromId, type Rank, type Tile } from '../tiles';
import type { Meld } from '../types';

/** Highest represented value a run may reach: 14 (high ace) or 13 (K). */
export function runMaxValue(cfg: RulesConfig): number {
  return cfg.aceHigh ? 14 : 13;
}

/** Natural rank stood for by a run value (14 -> ace = 1). */
export function valueToRank(v: number): Rank {
  return (v === 14 ? 1 : v) as Rank;
}

/** Does a natural tile of `rank` fit run value `v`? (ace fits 1 and 14) */
export function rankFitsValue(rank: number, v: number): boolean {
  return rank === v || (rank === 1 && v === 14);
}

/** Parse a tile id without throwing; null for anything malformed. */
export function safeTile(id: unknown): Tile | null {
  if (typeof id !== 'string') return null;
  try {
    return tileFromId(id);
  } catch {
    return null;
  }
}

/** Ranks of all SET melds on the table (for the set-priority option). */
export function setRanksOnTable(melds: Meld[]): Set<number> {
  const ranks = new Set<number>();
  for (const m of melds) if (m.type === 'SET' && m.rank !== undefined) ranks.add(m.rank);
  return ranks;
}

/** Low / high represented values of a RUN meld. */
export function runBounds(meld: Meld): { lo: number; hi: number } {
  return { lo: meld.tiles[0].rep.rank, hi: meld.tiles[meld.tiles.length - 1].rep.rank };
}
