/**
 * Tile model for Malaysian Rummy Mahjong (see docs/RULES.md §1).
 *
 * Tile ids:
 *   rank tiles  `${colour}${rankCode}_${copy}`  e.g. "R10_1", "BA_2", "GQ_1"
 *   jokers      `JK_${n}`                        e.g. "JK_1" .. "JK_8"
 */

export type Colour = 'B' | 'R' | 'Y' | 'G';
/** Natural rank 1..13 where 1 = A, 11 = J, 12 = Q, 13 = K. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export const COLOURS: readonly Colour[] = ['B', 'R', 'Y', 'G'];
export const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export const COLOUR_SUIT: Record<Colour, string> = { B: '♠', R: '♥', Y: '♦', G: '♣' };

export interface Tile {
  id: string;
  /** null for jokers */
  colour: Colour | null;
  /** null for jokers */
  rank: Rank | null;
  joker: boolean;
}

const RANK_CODES: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

export function rankCode(rank: number): string {
  // 14 is "high ace" when used as a represented rank inside a run
  if (rank === 14) return 'A';
  return RANK_CODES[rank] ?? String(rank);
}

export function parseRankCode(code: string): Rank | null {
  if (code === 'A') return 1;
  if (code === 'J') return 11;
  if (code === 'Q') return 12;
  if (code === 'K') return 13;
  const n = Number(code);
  if (Number.isInteger(n) && n >= 2 && n <= 10) return n as Rank;
  return null;
}

export function makeTileId(colour: Colour, rank: Rank, copy: number): string {
  return `${colour}${rankCode(rank)}_${copy}`;
}

const tileCache = new Map<string, Tile>();

/** Parse a tile id. Throws on malformed ids. */
export function tileFromId(id: string): Tile {
  const cached = tileCache.get(id);
  if (cached) return cached;
  let tile: Tile;
  if (/^JK_\d+$/.test(id)) {
    tile = { id, colour: null, rank: null, joker: true };
  } else {
    const m = /^([BRYG])(A|J|Q|K|10|[2-9])_(\d+)$/.exec(id);
    if (!m) throw new Error(`Bad tile id: ${id}`);
    const rank = parseRankCode(m[2]);
    if (rank === null) throw new Error(`Bad tile rank: ${id}`);
    tile = { id, colour: m[1] as Colour, rank, joker: false };
  }
  tileCache.set(id, tile);
  return tile;
}

export function isJokerId(id: string): boolean {
  return id.startsWith('JK_');
}

/** Build the full tile set: 4 colours x 13 ranks x `copies` + `jokers` jokers. */
export function buildTileSet(copies = 2, jokers = 8): string[] {
  const ids: string[] = [];
  for (const c of COLOURS) {
    for (const r of RANKS) {
      for (let k = 1; k <= copies; k++) ids.push(makeTileId(c, r, k));
    }
  }
  for (let j = 1; j <= jokers; j++) ids.push(`JK_${j}`);
  return ids;
}

/** Penalty points for a tile left in hand (RULES §1). */
export function tilePenalty(id: string, jokerPenalty = 20): number {
  const t = tileFromId(id);
  if (t.joker) return jokerPenalty;
  const r = t.rank as number;
  if (r === 1) return 15;
  if (r >= 10) return 10;
  return r;
}

/** Stable sort key used for hand display: colour, then rank, jokers last. */
export function tileSortKey(id: string): number {
  const t = tileFromId(id);
  if (t.joker) return 1000 + Number(id.slice(3));
  return COLOURS.indexOf(t.colour as Colour) * 100 + (t.rank as number) * 2 + (id.endsWith('_2') ? 1 : 0);
}

export function sortTiles(ids: string[]): string[] {
  return [...ids].sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

/** Human readable label, e.g. "♥10", "♠A", "JOKER". */
export function tileLabel(id: string): string {
  const t = tileFromId(id);
  if (t.joker) return 'JOKER';
  return `${COLOUR_SUIT[t.colour as Colour]}${rankCode(t.rank as number)}`;
}
