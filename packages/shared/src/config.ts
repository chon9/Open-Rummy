/**
 * Rule options (docs/RULES.md §12). Defaults follow the Cari Makan rule cards
 * plus the documented [house rule choice]s.
 */
export interface RulesConfig {
  /** 3, 4 or 5 seats */
  players: number;
  /** tiles dealt to each player */
  handSize: number;
  jokers: number;
  jokerPenalty: number;
  /** allow a 3+ same-rank set as (part of) the port */
  setAllowedAsPort: boolean;
  /** 'simultaneous' = everyone ports together; 'sequential' = each on own first turn */
  portTiming: 'simultaneous' | 'sequential';
  /** 斩 precondition: only when no legal 接 move exists, or any time */
  cutOnlyWhenCannotExtend: boolean;
  /** lay brand new runs after the port */
  newRunsAfterPort: boolean;
  /** false = exactly one primary action per turn; true = any number (>=1) then END_TURN */
  unlimitedActions: boolean;
  /** 'off' | 'keep' (swap joker and keep it) | 'useSameTurn' */
  jokerSwap: 'off' | 'keep' | 'useSameTurn';
  /** natural tiles required when creating a new meld */
  minNaturalsInNewMeld: number;
  /** cap sets at 4 tiles of distinct colours */
  setCapFourDistinct: boolean;
  /** if a set of rank X exists, X can no longer be added to runs */
  setPriority: boolean;
  aceHigh: boolean;
  instantWins: boolean;
  dealerRotation: 'next' | 'winner';
  /** chips */
  startingChips: number;
  baseUnit: number;
  payoutLadder: number[]; // multiples of baseUnit paid by rank 2,3,4,...
  gamePaiPayout: number; // multiples of baseUnit paid by every other player
  tianhuPayout: number;
  /** hands per match (0 = unlimited) */
  handsPerMatch: number;
  /** timers in ms */
  portTimerMs: number;
  turnTimerMs: number;
  instantTimerMs: number;
  /** delay between hand end and next hand (host-driven) */
  handEndDelayMs: number;
}

export const DEFAULT_RULES: RulesConfig = {
  players: 4,
  handSize: 20,
  jokers: 8,
  jokerPenalty: 20,
  setAllowedAsPort: false,
  portTiming: 'simultaneous',
  cutOnlyWhenCannotExtend: true,
  newRunsAfterPort: false,
  unlimitedActions: false,
  jokerSwap: 'keep',
  minNaturalsInNewMeld: 2,
  setCapFourDistinct: false,
  setPriority: false,
  aceHigh: true,
  instantWins: true,
  dealerRotation: 'next',
  startingChips: 1000,
  baseUnit: 10,
  payoutLadder: [3, 6, 9, 12],
  gamePaiPayout: 24,
  tianhuPayout: 48,
  handsPerMatch: 8,
  portTimerMs: 30000,
  turnTimerMs: 20000,
  instantTimerMs: 8000,
  handEndDelayMs: 8000,
};

/** "Penang Classic" preset (RULES §12). */
export const PENANG_CLASSIC: Partial<RulesConfig> = {
  setAllowedAsPort: true,
  portTiming: 'sequential',
  cutOnlyWhenCannotExtend: false,
  newRunsAfterPort: true,
  unlimitedActions: true,
  jokerSwap: 'keep',
  dealerRotation: 'winner',
};

export function resolveRules(partial?: Partial<RulesConfig>): RulesConfig {
  const cfg: RulesConfig = { ...DEFAULT_RULES, ...(partial ?? {}) };
  cfg.players = Math.min(5, Math.max(3, Math.round(cfg.players)));
  if (!partial || partial.handsPerMatch === undefined) {
    cfg.handsPerMatch = cfg.players === 3 ? 6 : cfg.players * 2;
  }
  cfg.handSize = Math.min(25, Math.max(10, Math.round(cfg.handSize)));
  cfg.jokers = Math.min(12, Math.max(0, Math.round(cfg.jokers)));
  const total = 104 + cfg.jokers;
  if (cfg.players * cfg.handSize > total) cfg.handSize = Math.floor(total / cfg.players);
  cfg.minNaturalsInNewMeld = Math.min(3, Math.max(1, Math.round(cfg.minNaturalsInNewMeld)));
  return cfg;
}
