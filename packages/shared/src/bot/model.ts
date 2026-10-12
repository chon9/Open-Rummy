/**
 * Bot-side position model: the bot's own hand plus the public table melds.
 * `simulate` applies a hypothetical action locally using the same meld
 * validators the engine uses, so plans can be scored before they are sent.
 * Nothing here touches hidden information.
 */
import type { RulesConfig } from '../config';
import { canSwapJoker, validateExtend, validateFollow, validateNewRun, validateNewSet } from '../melds';
import { tileFromId, tilePenalty, type Colour, type Rank } from '../tiles';
import type { Action, Meld, MeldTile } from '../types';

export interface Pos {
  hand: string[];
  melds: Meld[];
}

/** Kind key of a natural tile: colour + natural rank, e.g. "R1" for a red ace. */
export const kindKey = (c: Colour, r: number): string => `${c}${r}`;

/** Natural rank stood for by a run value (14 = high ace). */
export const valueRank = (v: number): number => (v === 14 ? 1 : v);

export const maxRunValue = (cfg: RulesConfig): number => (cfg.aceHigh ? 14 : 13);

/** Naturals of a hand grouped by kind and by rank, plus its jokers. */
export class HandKinds {
  readonly byKind = new Map<string, string[]>();
  readonly byRank = new Map<number, string[]>();
  readonly jokers: string[] = [];

  constructor(hand: readonly string[]) {
    for (const id of [...hand].sort()) {
      const t = tileFromId(id);
      if (t.joker) {
        this.jokers.push(id);
        continue;
      }
      push(this.byKind, kindKey(t.colour as Colour, t.rank as number), id);
      push(this.byRank, t.rank as number, id);
    }
  }
  count(c: Colour, r: number): number {
    return this.byKind.get(kindKey(c, r))?.length ?? 0;
  }
  rankCount(r: number): number {
    return this.byRank.get(r)?.length ?? 0;
  }
}

function push<K>(map: Map<K, string[]>, k: K, id: string): void {
  const list = map.get(k);
  if (list) list.push(id);
  else map.set(k, [id]);
}

/**
 * Hands out concrete tile ids for a plan expressed in kinds, never giving
 * the same id twice. Used to materialise generated runs / extensions.
 */
export class TilePool {
  private readonly used = new Map<string, number>();
  private jokersUsed = 0;
  constructor(private readonly kinds: HandKinds) {}

  take(c: Colour, r: number): string | null {
    const k = kindKey(c, r);
    const list = this.kinds.byKind.get(k);
    const u = this.used.get(k) ?? 0;
    if (!list || u >= list.length) return null;
    this.used.set(k, u + 1);
    return list[u];
  }
  takeJoker(): string | null {
    if (this.jokersUsed >= this.kinds.jokers.length) return null;
    return this.kinds.jokers[this.jokersUsed++];
  }
}

export function penalty(ids: readonly string[], cfg: RulesConfig): number {
  let sum = 0;
  for (const id of ids) sum += tilePenalty(id, cfg.jokerPenalty);
  return sum;
}

export function isJoker(id: string): boolean {
  return tileFromId(id).joker;
}

/** Tiles leaving the hand for a primary action (empty for swaps / END_TURN). */
export function actionTiles(a: Action): string[] {
  switch (a.type) {
    case 'EXTEND':
      return [...a.low, ...a.high];
    case 'CUT':
    case 'NEW_RUN':
    case 'FOLLOW_CUT':
      return a.tiles;
    case 'PORT':
      return a.melds.flat();
    default:
      return [];
  }
}

/** Stable identity of an action, for de-duplicating candidate lists. */
export function actionKey(a: Action): string {
  switch (a.type) {
    case 'EXTEND':
      return `E|${a.meldId}|${a.low.join(',')}|${a.high.join(',')}`;
    case 'CUT':
      return `C|${[...a.tiles].sort().join(',')}`;
    case 'FOLLOW_CUT':
      return `F|${a.meldId}|${[...a.tiles].sort().join(',')}`;
    case 'NEW_RUN':
      return `N|${a.tiles.join(',')}`;
    case 'SWAP_JOKER':
      return `S|${a.meldId}|${a.jokerTileId}|${a.withTileId}`;
    default:
      return a.type;
  }
}

let tmpMeldId = 0;
const newTmpId = (): string => `~bot${++tmpMeldId}`;

function removeFromHand(hand: readonly string[], ids: readonly string[]): string[] | null {
  const drop = new Set(ids);
  if (drop.size !== ids.length) return null;
  for (const id of ids) if (!hand.includes(id)) return null;
  return hand.filter((h) => !drop.has(h));
}

function newMeld(type: 'RUN' | 'SET', tiles: MeldTile[], seat: number): Meld {
  const m: Meld = { id: newTmpId(), type, ownerSeat: seat, tiles };
  if (type === 'RUN') m.colour = tiles[0].rep.colour as Colour;
  else m.rank = tiles[0].rep.rank as Rank;
  return m;
}

/** Validate one port / new-run meld the way the engine does. */
export function validatePortLike(ids: string[], cfg: RulesConfig, allowSet: boolean): { type: 'RUN' | 'SET'; tiles: MeldTile[] } | null {
  const run = validateNewRun(ids, cfg);
  if (typeof run !== 'string') return { type: 'RUN', tiles: run };
  if (allowSet) {
    const set = validateNewSet(ids, cfg);
    if (typeof set !== 'string') return { type: 'SET', tiles: set };
  }
  return null;
}

/**
 * Apply `a` to a local position. Returns null when the meld validators reject
 * it. Engine-only preconditions (turn order, the cut rule, mustUse) are the
 * caller's responsibility.
 */
export function simulate(pos: Pos, a: Action, cfg: RulesConfig, seat: number): Pos | null {
  switch (a.type) {
    case 'EXTEND': {
      const meld = pos.melds.find((m) => m.id === a.meldId);
      if (!meld) return null;
      const hand = removeFromHand(pos.hand, [...a.low, ...a.high]);
      if (!hand) return null;
      const v = validateExtend(meld, a.low, a.high, cfg, pos.melds);
      if (typeof v === 'string') return null;
      const next: Meld = { ...meld, tiles: [...v.low, ...meld.tiles, ...v.high] };
      return { hand, melds: pos.melds.map((m) => (m === meld ? next : m)) };
    }
    case 'FOLLOW_CUT': {
      const meld = pos.melds.find((m) => m.id === a.meldId);
      if (!meld) return null;
      const hand = removeFromHand(pos.hand, a.tiles);
      if (!hand) return null;
      const v = validateFollow(meld, a.tiles, cfg);
      if (typeof v === 'string') return null;
      const next: Meld = { ...meld, tiles: [...meld.tiles, ...v] };
      return { hand, melds: pos.melds.map((m) => (m === meld ? next : m)) };
    }
    case 'CUT': {
      const hand = removeFromHand(pos.hand, a.tiles);
      if (!hand) return null;
      const v = validateNewSet(a.tiles, cfg);
      if (typeof v === 'string') return null;
      return { hand, melds: [...pos.melds, newMeld('SET', v, seat)] };
    }
    case 'NEW_RUN': {
      const hand = removeFromHand(pos.hand, a.tiles);
      if (!hand) return null;
      const v = validateNewRun(a.tiles, cfg);
      if (typeof v === 'string') return null;
      return { hand, melds: [...pos.melds, newMeld('RUN', v, seat)] };
    }
    case 'PORT': {
      const hand = removeFromHand(pos.hand, a.melds.flat());
      if (!hand || a.melds.length === 0) return null;
      const added: Meld[] = [];
      for (const ids of a.melds) {
        const v = validatePortLike(ids, cfg, cfg.setAllowedAsPort);
        if (!v) return null;
        added.push(newMeld(v.type, v.tiles, seat));
      }
      return { hand, melds: [...pos.melds, ...added] };
    }
    case 'SWAP_JOKER': {
      const meld = pos.melds.find((m) => m.id === a.meldId);
      if (!meld || !pos.hand.includes(a.withTileId)) return null;
      if (!canSwapJoker(meld, a.jokerTileId, a.withTileId)) return null;
      const next: Meld = {
        ...meld,
        tiles: meld.tiles.map((mt) => (mt.tileId === a.jokerTileId ? { tileId: a.withTileId, rep: mt.rep } : mt)),
      };
      return {
        hand: [...pos.hand.filter((h) => h !== a.withTileId), a.jokerTileId],
        melds: pos.melds.map((m) => (m === meld ? next : m)),
      };
    }
    default:
      return { hand: pos.hand, melds: pos.melds };
  }
}
