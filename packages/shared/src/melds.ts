/**
 * Meld validation (docs/RULES.md §8). Pure functions, no state.
 *
 * Runs are tile lists ordered low -> high. A run's represented values are
 * 1..14 where 1 is a low ace and 14 a high ace (only when cfg.aceHigh).
 * Sets carry the represented rank 1..13 and no colour.
 *
 * Every validator returns either the placed tiles (with fixed reps) or a
 * short English error string. Malformed input never throws.
 */
import type { RulesConfig } from './config';
import type { Colour, Rank, Tile } from './tiles';
import type { Meld, MeldTile } from './types';
import { rankFitsValue, runBounds, runMaxValue, safeTile, setRanksOnTable, valueToRank } from './rules/util';

/** Parse a list of ids; returns an error string on bad/duplicate ids. */
function parseTiles(ids: unknown): Tile[] | string {
  if (!Array.isArray(ids)) return 'Tiles must be a list';
  const seen = new Set<string>();
  const out: Tile[] = [];
  for (const id of ids) {
    const t = safeTile(id);
    if (!t) return 'Unknown tile';
    if (seen.has(t.id)) return 'Duplicate tile';
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// New melds
// ---------------------------------------------------------------------------

/**
 * Validate a NEW run given tile ids ordered low -> high (jokers placed where they stand).
 * Returns the tiles with fixed reps, or an error string.
 * Enforces: same colour naturals, consecutive, ace low (1) or high (14, only if cfg.aceHigh),
 * no wrap, length 3..14, at least cfg.minNaturalsInNewMeld naturals.
 */
export function validateNewRun(ids: string[], cfg: RulesConfig): MeldTile[] | string {
  const tiles = parseTiles(ids);
  if (typeof tiles === 'string') return tiles;
  const maxV = runMaxValue(cfg);
  if (tiles.length < 3) return 'A run needs at least 3 tiles';
  if (tiles.length > maxV) return `A run cannot be longer than ${maxV} tiles`;
  const naturals = tiles.filter((t) => !t.joker);
  if (naturals.length < cfg.minNaturalsInNewMeld) {
    return `A new meld needs at least ${cfg.minNaturalsInNewMeld} natural tiles`;
  }
  const colour = naturals[0].colour as Colour;
  if (naturals.some((t) => t.colour !== colour)) return 'Run tiles must share one colour';
  // Find the start value s so that every natural at index i stands for s + i.
  // Only all-ace naturals could be ambiguous, which the length bound resolves.
  for (let s = 1; s + tiles.length - 1 <= maxV; s++) {
    let ok = true;
    for (let i = 0; i < tiles.length && ok; i++) {
      const t = tiles[i];
      if (!t.joker && !rankFitsValue(t.rank as number, s + i)) ok = false;
    }
    if (ok) return tiles.map((t, i) => ({ tileId: t.id, rep: { colour, rank: s + i } }));
  }
  return 'Run tiles are not consecutive';
}

/** Validate a NEW set (斩): >=3 tiles, all naturals same rank, jokers allowed, min naturals, optional cap. */
export function validateNewSet(ids: string[], cfg: RulesConfig): MeldTile[] | string {
  const tiles = parseTiles(ids);
  if (typeof tiles === 'string') return tiles;
  if (tiles.length < 3) return 'A set needs at least 3 tiles';
  const naturals = tiles.filter((t) => !t.joker);
  if (naturals.length < cfg.minNaturalsInNewMeld) {
    return `A new meld needs at least ${cfg.minNaturalsInNewMeld} natural tiles`;
  }
  const rank = naturals[0].rank as Rank;
  if (naturals.some((t) => t.rank !== rank)) return 'Set tiles must share one rank';
  if (cfg.setCapFourDistinct) {
    if (tiles.length > 4) return 'A set holds at most 4 tiles';
    if (new Set(naturals.map((t) => t.colour)).size !== naturals.length) return 'Set colours must be distinct';
  }
  return tiles.map((t) => ({ tileId: t.id, rep: { colour: null, rank } }));
}

// ---------------------------------------------------------------------------
// Changes to existing melds
// ---------------------------------------------------------------------------

/**
 * Validate extending a RUN meld with `low` (ordered low->high, placed below the meld)
 * and `high` (ordered low->high, placed above). Returns the reps for low/high or an error.
 */
export function validateExtend(
  meld: Meld,
  low: string[],
  high: string[],
  cfg: RulesConfig,
  allMelds: Meld[],
): { low: MeldTile[]; high: MeldTile[] } | string {
  if (!meld || meld.type !== 'RUN' || !meld.colour || meld.tiles.length === 0) return 'Not a run';
  const lowT = parseTiles(low);
  if (typeof lowT === 'string') return lowT;
  const highT = parseTiles(high);
  if (typeof highT === 'string') return highT;
  if (lowT.length + highT.length === 0) return 'No tiles to add';
  if (lowT.some((t) => highT.some((h) => h.id === t.id))) return 'Duplicate tile';
  const onTable = new Set(meld.tiles.map((t) => t.tileId));
  if ([...lowT, ...highT].some((t) => onTable.has(t.id))) return 'Tile already in the meld';

  const colour = meld.colour;
  const maxV = runMaxValue(cfg);
  const { lo, hi } = runBounds(meld);
  const locked = cfg.setPriority ? setRanksOnTable(allMelds) : new Set<number>();

  const place = (t: Tile, v: number): MeldTile | string => {
    if (v < 1) return 'Cannot extend below the low end';
    if (v > maxV) return 'Cannot extend above the high end';
    if (!t.joker) {
      if (t.colour !== colour) return 'Wrong colour for this run';
      if (!rankFitsValue(t.rank as number, v)) return 'Tile does not continue the run';
    }
    if (locked.has(valueToRank(v))) return 'That rank is locked by a set';
    return { tileId: t.id, rep: { colour, rank: v } };
  };

  const lowOut: MeldTile[] = [];
  for (let i = 0; i < lowT.length; i++) {
    const r = place(lowT[i], lo - lowT.length + i);
    if (typeof r === 'string') return r;
    lowOut.push(r);
  }
  const highOut: MeldTile[] = [];
  for (let i = 0; i < highT.length; i++) {
    const r = place(highT[i], hi + 1 + i);
    if (typeof r === 'string') return r;
    highOut.push(r);
  }
  return { low: lowOut, high: highOut };
}

/** Validate adding tiles to a SET meld (跟斩). */
export function validateFollow(meld: Meld, ids: string[], cfg: RulesConfig): MeldTile[] | string {
  if (!meld || meld.type !== 'SET' || meld.rank === undefined) return 'Not a set';
  const tiles = parseTiles(ids);
  if (typeof tiles === 'string') return tiles;
  if (tiles.length === 0) return 'No tiles to add';
  const onTable = new Set(meld.tiles.map((t) => t.tileId));
  if (tiles.some((t) => onTable.has(t.id))) return 'Tile already in the meld';
  const rank = meld.rank;
  if (tiles.some((t) => !t.joker && t.rank !== rank)) return 'Tile does not match the set rank';
  if (cfg.setCapFourDistinct) {
    if (meld.tiles.length + tiles.length > 4) return 'A set holds at most 4 tiles';
    const colours = meld.tiles
      .map((mt) => safeTile(mt.tileId))
      .filter((t): t is Tile => !!t && !t.joker)
      .map((t) => t.colour);
    for (const t of tiles) {
      if (t.joker) continue;
      if (colours.includes(t.colour)) return 'Set colours must be distinct';
      colours.push(t.colour);
    }
  }
  return tiles.map((t) => ({ tileId: t.id, rep: { colour: null, rank } }));
}

/** Can `withTileId` replace joker `jokerTileId` in `meld`? (exact rep match; set: same rank any colour) */
export function canSwapJoker(meld: Meld, jokerTileId: string, withTileId: string): boolean {
  if (!meld || !Array.isArray(meld.tiles)) return false;
  const slot = meld.tiles.find((t) => t.tileId === jokerTileId);
  const joker = safeTile(jokerTileId);
  const natural = safeTile(withTileId);
  if (!slot || !joker || !joker.joker || !natural || natural.joker) return false;
  if (meld.type === 'RUN') {
    return natural.colour === slot.rep.colour && rankFitsValue(natural.rank as number, slot.rep.rank);
  }
  return natural.rank === meld.rank;
}

/**
 * Structural validity of a meld already on the table (used by tests and as a
 * defensive check). Does not apply the creation-only natural minimum.
 */
export function isMeldValid(meld: Meld, cfg: RulesConfig): boolean {
  if (!meld || !Array.isArray(meld.tiles)) return false;
  const tiles = meld.tiles.map((mt) => safeTile(mt.tileId));
  if (tiles.some((t) => !t)) return false;
  if (new Set(meld.tiles.map((t) => t.tileId)).size !== meld.tiles.length) return false;
  if (meld.type === 'RUN') {
    const maxV = runMaxValue(cfg);
    if (!meld.colour || meld.tiles.length < 3 || meld.tiles.length > maxV) return false;
    const start = meld.tiles[0].rep.rank;
    if (start < 1 || start + meld.tiles.length - 1 > maxV) return false;
    return meld.tiles.every((mt, i) => {
      const t = tiles[i] as Tile;
      if (mt.rep.rank !== start + i || mt.rep.colour !== meld.colour) return false;
      return t.joker || (t.colour === meld.colour && rankFitsValue(t.rank as number, mt.rep.rank));
    });
  }
  if (meld.type === 'SET') {
    if (meld.rank === undefined || meld.tiles.length < 3) return false;
    const naturals = tiles.filter((t) => !(t as Tile).joker) as Tile[];
    if (naturals.some((t) => t.rank !== meld.rank)) return false;
    if (meld.tiles.some((mt) => mt.rep.rank !== meld.rank)) return false;
    if (cfg.setCapFourDistinct) {
      if (meld.tiles.length > 4) return false;
      if (new Set(naturals.map((t) => t.colour)).size !== naturals.length) return false;
    }
    return true;
  }
  return false;
}
