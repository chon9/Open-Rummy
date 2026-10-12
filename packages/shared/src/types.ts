import type { RulesConfig } from './config';
import type { Colour, Rank } from './tiles';

// ---------------------------------------------------------------------------
// Table melds
// ---------------------------------------------------------------------------

/** What a tile stands for on the table. For jokers this is fixed when placed. */
export interface Rep {
  /** null for tiles in a SET (colour is irrelevant) */
  colour: Colour | null;
  /** 1..14 inside runs (14 = high ace); 1..13 inside sets */
  rank: number;
}

export interface MeldTile {
  tileId: string;
  rep: Rep;
}

export interface Meld {
  id: string;
  type: 'RUN' | 'SET';
  /** seat that created it - display only, melds are shared */
  ownerSeat: number;
  /** RUN only */
  colour?: Colour;
  /** SET only */
  rank?: Rank;
  /** RUN: ordered low -> high by rep.rank. SET: in placement order. */
  tiles: MeldTile[];
}

// ---------------------------------------------------------------------------
// Game state (authoritative, never sent to clients as-is)
// ---------------------------------------------------------------------------

export type Phase = 'LOBBY' | 'INSTANT' | 'PORT' | 'PLAY' | 'HAND_END' | 'MATCH_END';

/**
 * ALIVE   - still playing
 * DEAD    - 盖牌: no legal move, out for the hand
 * QUANCAN - 全餐: failed the port, out for the hand
 * OUT     - emptied the hand (Game牌) or instant win
 */
export type PlayerStatus = 'ALIVE' | 'DEAD' | 'QUANCAN' | 'OUT';

export interface PlayerState {
  seat: number;
  name: string;
  isBot: boolean;
  /** avatar/character id chosen in the lobby (client cosmetic) */
  avatar: string;
  hand: string[];
  status: PlayerStatus;
  /** order in which the player went DEAD/QUANCAN this hand (for tie breaks), 0 = not dead */
  deadOrder: number;
  /** has completed the port this hand */
  ported: boolean;
  /** simultaneous port: submitted but not yet revealed (array of runs/sets as ordered tile id lists) */
  pendingPort: string[][] | null;
  /** instant win: player answered the declare prompt */
  instantAnswered: boolean;
  chips: number;
  /** cumulative hand points across the match */
  totalPoints: number;
  /** number of 大哥 (last place) finishes - tie break */
  lastPlaces: number;
  /** count of primary actions taken in the current turn (unlimitedActions mode) */
  actionsThisTurn: number;
  /** joker retrieved this turn that must be used this turn (jokerSwap = 'useSameTurn') */
  mustUseJoker: string | null;
  connected: boolean;
}

export type InstantKind = 'TIANHU_8' | 'TIANHU_RUNS' | 'GAME_7';

export interface InstantOffer {
  seat: number;
  kind: InstantKind;
  /** partition (for TIANHU_RUNS) or the matching tiles, for display */
  tiles: string[][];
}

export interface WallBreak {
  dice: [number, number];
  /** seat whose wall is broken */
  wallSeat: number;
  /** stack index counted from that wall's right end */
  stack: number;
}

export type HandEndKind = 'GAME' | 'GAME_7' | 'TIANHU' | 'LOWEST';

export interface HandRanking {
  seat: number;
  rank: number; // 1-based
  /** e.g. 'WINNER' | 'XIAOGE' | 'ERGE' | 'DAGE' */
  title: RankTitle;
  points: number;
  tiles: string[];
  chipsDelta: number;
  status: PlayerStatus;
}

export type RankTitle = 'WINNER' | 'XIAOGE' | 'ERGE' | 'DAGE' | 'FOURTH';

export interface HandResult {
  handNo: number;
  kind: HandEndKind;
  winnerSeat: number;
  rankings: HandRanking[];
}

export interface MatchStanding {
  seat: number;
  name: string;
  chips: number;
  totalPoints: number;
  place: number;
}

export interface GameState {
  cfg: RulesConfig;
  /** RNG state (seeded, deterministic) */
  rng: number;
  phase: Phase;
  handNo: number; // 1-based, 0 before first hand
  dealer: number;
  wallBreak: WallBreak | null;
  players: PlayerState[];
  melds: Meld[];
  deadWall: string[];
  /** seat to act in PLAY (or sequential PORT), null otherwise */
  turn: number | null;
  /** absolute ms deadline for the current decision (turn, port window, instant prompt) */
  deadline: number | null;
  instantOffers: InstantOffer[];
  /** ranked seats order used for this hand: dealer's 下家 first */
  firstSeat: number;
  nextMeldId: number;
  deadCounter: number;
  lastResult: HandResult | null;
  standings: MatchStanding[] | null;
  /** monotonically increasing version, bumped on every applied change */
  version: number;
}

// ---------------------------------------------------------------------------
// Actions (player intents). Tiles in run lists are ORDERED low -> high.
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'DECLARE_INSTANT'; declare: boolean }
  /** melds: each an ordered tile list. Runs low->high; jokers placed where they stand. */
  | { type: 'PORT'; melds: string[][] }
  /** add tiles below (`low`, ordered low->high, ending adjacent to the meld) and/or above (`high`, ordered low->high) a RUN */
  | { type: 'EXTEND'; meldId: string; low: string[]; high: string[] }
  /** 斩: create a new SET of >=3 same rank */
  | { type: 'CUT'; tiles: string[] }
  /** 跟斩: add same-rank tiles (or jokers) to an existing SET */
  | { type: 'FOLLOW_CUT'; meldId: string; tiles: string[] }
  /** new run after port (only when cfg.newRunsAfterPort) */
  | { type: 'NEW_RUN'; tiles: string[] }
  /** replace a table joker with the natural tile it represents; joker goes to hand */
  | { type: 'SWAP_JOKER'; meldId: string; jokerTileId: string; withTileId: string }
  /** end turn (only meaningful when cfg.unlimitedActions) */
  | { type: 'END_TURN' };

export type ActionType = Action['type'];

// ---------------------------------------------------------------------------
// Events (for animation / log). Hidden information is filtered per seat by projectEvents().
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'HAND_START'; handNo: number; dealer: number; wallBreak: WallBreak; firstSeat: number }
  /** tiles is only populated for the receiving seat's own hand after projection */
  | { type: 'DEAL'; seat: number; count: number; tiles?: string[] }
  | { type: 'INSTANT_OFFER'; seat: number; kind: InstantKind }
  | { type: 'INSTANT_WIN'; seat: number; kind: InstantKind; tiles: string[][] }
  | { type: 'PORT_SUBMITTED'; seat: number }
  | { type: 'PORT_REVEAL'; ports: { seat: number; meldIds: string[] }[] }
  | { type: 'QUANCAN'; seat: number }
  | { type: 'MELD_CREATED'; seat: number; meld: Meld; via: 'PORT' | 'CUT' | 'NEW_RUN' }
  | { type: 'MELD_EXTENDED'; seat: number; meldId: string; low: MeldTile[]; high: MeldTile[] }
  | { type: 'SET_FOLLOWED'; seat: number; meldId: string; added: MeldTile[] }
  | { type: 'JOKER_SWAPPED'; seat: number; meldId: string; jokerTileId: string; withTileId: string }
  | { type: 'TURN'; seat: number; deadline: number | null }
  | { type: 'TIMEOUT'; seat: number }
  | { type: 'PLAYER_DEAD'; seat: number; reason: 'NO_MOVE' | 'TIMEOUT' }
  | { type: 'GAME_PAI'; seat: number }
  | { type: 'HAND_END'; result: HandResult }
  | { type: 'MATCH_END'; standings: MatchStanding[] };

// ---------------------------------------------------------------------------
// Legal moves for the seat to act (computed by the engine, sent in the view)
// ---------------------------------------------------------------------------

export interface LegalMoves {
  /** PORT phase: can this seat form at least one legal port meld */
  canPort: boolean;
  /** suggested port meld candidates (each ordered); a client/bot may combine disjoint ones */
  portCandidates: string[][];
  /** each entry is one legal EXTEND (single-end, single tile variants plus maximal chains) */
  extends: { meldId: string; low: string[]; high: string[] }[];
  /** legal 斩 sets (maximal per rank plus 3-tile variants) */
  cuts: string[][];
  follows: { meldId: string; tiles: string[] }[];
  newRuns: string[][];
  swaps: { meldId: string; jokerTileId: string; withTileId: string }[];
  /** cut is blocked by the 'cut only when cannot extend' rule */
  cutBlocked: boolean;
  /** can END_TURN now (unlimitedActions mode after >=1 action) */
  canEndTurn: boolean;
  /** no primary action is possible even after swaps -> engine will mark DEAD */
  dead: boolean;
}

// ---------------------------------------------------------------------------
// Per-seat projected view (what the client sees)
// ---------------------------------------------------------------------------

export interface PublicPlayer {
  seat: number;
  name: string;
  isBot: boolean;
  avatar: string;
  status: PlayerStatus;
  handCount: number;
  ported: boolean;
  portSubmitted: boolean;
  chips: number;
  totalPoints: number;
  connected: boolean;
  /** revealed hand at HAND_END, otherwise null */
  revealed: string[] | null;
}

export interface PlayerView {
  /** the viewing seat, or -1 for a spectator */
  you: number;
  cfg: RulesConfig;
  phase: Phase;
  handNo: number;
  dealer: number;
  firstSeat: number;
  wallBreak: WallBreak | null;
  turn: number | null;
  deadline: number | null;
  players: PublicPlayer[];
  melds: Meld[];
  deadWallCount: number;
  /** own hand (sorted), empty for spectator */
  hand: string[];
  /** own pending port (simultaneous port submitted but not revealed) */
  pendingPort: string[][] | null;
  /** own instant-win offer, if any */
  instantOffer: InstantOffer | null;
  /** legal moves for `you` when it is your decision, else null */
  legal: LegalMoves | null;
  lastResult: HandResult | null;
  standings: MatchStanding[] | null;
  version: number;
}

export type EngineResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };
