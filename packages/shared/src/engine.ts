/**
 * Rules engine (docs/RULES.md). Pure, deterministic reducer over GameState.
 * Every function returns a NEW state (never mutates the input).
 * `now` is an absolute ms timestamp supplied by the host, used for deadlines.
 *
 * Flow per hand: deal -> INSTANT (optional) -> PORT -> PLAY -> HAND_END.
 * In sequential port mode there is no separate port window: each player ports
 * on their own first turn (phase reads 'PORT' while the seat to act is unported).
 */
import type { RulesConfig } from './config';
import { resolveRules } from './config';
import { nextRandom } from './rng';
import { buildTileSet, sortTiles, tileFromId, tilePenalty } from './tiles';
import type {
  Action,
  EngineResult,
  GameEvent,
  GameState,
  HandEndKind,
  HandRanking,
  InstantKind,
  InstantOffer,
  LegalMoves,
  Meld,
  MeldTile,
  MatchStanding,
  PlayerState,
  PlayerView,
  PublicPlayer,
  RankTitle,
} from './types';
import { canSwapJoker, validateExtend, validateFollow, validateNewRun, validateNewSet } from './melds';
import {
  HandIndex,
  LIST_CAP,
  anyCutShape,
  canPortHand,
  cutAllowed,
  extendPossible,
  genExtends,
  genFollows,
  genRuns,
  genSets,
  isDead,
  legalSwaps,
  movesUse,
  penaltyOf,
  rawSwaps,
  swapKeepsMove,
  swapPath,
  type MoveCtx,
} from './rules/moves';
import { findRunPartition } from './rules/partition';

export interface MatchPlayerInit {
  name: string;
  isBot: boolean;
  avatar: string;
}

export interface CreateMatchOptions {
  players: MatchPlayerInit[];
  cfg?: Partial<RulesConfig>;
  seed: number;
  /** optional fixed first dealer (else rolled) */
  dealer?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Events = GameEvent[];

const fail = (error: string): EngineResult => ({ ok: false, error });

function rand(s: GameState): number {
  const [v, next] = nextRandom(s.rng);
  s.rng = next;
  return v;
}
function randInt(s: GameState, n: number): number {
  return Math.floor(rand(s) * n);
}
function rollD6(s: GameState): number {
  return 1 + randInt(s, 6);
}

const N = (s: GameState) => s.players.length;

/** Seats in turn order starting at `from`. */
function seatsFrom(s: GameState, from: number): number[] {
  return Array.from({ length: N(s) }, (_, i) => (from + i) % N(s));
}

/** Turn-order distance from the dealer's 下家 (tie-break and instant priority). */
function distance(s: GameState, seat: number): number {
  return (seat - s.firstSeat + N(s)) % N(s);
}

function isStringList(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

function moveCtx(s: GameState, seat: number): MoveCtx {
  const p = s.players[seat];
  return {
    cfg: s.cfg,
    hand: p.hand,
    melds: s.melds,
    mustUse: p.mustUseJoker,
    acted: s.cfg.unlimitedActions && p.actionsThisTurn > 0,
  };
}

/** Check that `ids` are distinct tiles in `hand`; returns an error or null. */
function checkInHand(hand: string[], ids: string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return 'Duplicate tile';
    seen.add(id);
    if (!hand.includes(id)) return 'Tile not in hand';
  }
  return null;
}

function removeFromHand(p: PlayerState, ids: string[]): void {
  const drop = new Set(ids);
  p.hand = p.hand.filter((id) => !drop.has(id));
}

function createMeld(s: GameState, seat: number, type: 'RUN' | 'SET', tiles: MeldTile[]): Meld {
  const meld: Meld = { id: `m${s.nextMeldId++}`, type, ownerSeat: seat, tiles };
  if (type === 'RUN') meld.colour = tiles[0].rep.colour ?? undefined;
  else meld.rank = tiles[0].rep.rank as Meld['rank'];
  s.melds.push(meld);
  removeFromHand(
    s.players[seat],
    tiles.map((t) => t.tileId),
  );
  return meld;
}

/** A port meld is a new run, or (when allowed) a new set. */
function validatePortMeld(ids: string[], cfg: RulesConfig): { type: 'RUN' | 'SET'; tiles: MeldTile[] } | string {
  const run = validateNewRun(ids, cfg);
  if (typeof run !== 'string') return { type: 'RUN', tiles: run };
  if (cfg.setAllowedAsPort) {
    const set = validateNewSet(ids, cfg);
    if (typeof set !== 'string') return { type: 'SET', tiles: set };
  }
  return run;
}

/**
 * Mark a seat Dead / 全餐. `batch` gives every seat marked in the same
 * simultaneous step (the port window) one shared Dead order, so the
 * "became Dead later" tie-break (RULES §9) does not invent an order between
 * them and the turn-order tie-break decides instead.
 */
function markOut(
  s: GameState,
  seat: number,
  status: 'DEAD' | 'QUANCAN',
  events: Events,
  reason?: 'NO_MOVE' | 'TIMEOUT',
  batch?: { order: number },
) {
  const p = s.players[seat];
  p.status = status;
  if (batch) {
    if (batch.order === 0) batch.order = ++s.deadCounter;
    p.deadOrder = batch.order;
  } else {
    p.deadOrder = ++s.deadCounter;
  }
  p.pendingPort = null;
  p.mustUseJoker = null;
  if (status === 'QUANCAN') events.push({ type: 'QUANCAN', seat });
  else events.push({ type: 'PLAYER_DEAD', seat, reason: reason ?? 'NO_MOVE' });
}

// ---------------------------------------------------------------------------
// Match / hand setup
// ---------------------------------------------------------------------------

/** Create a match in phase LOBBY. players.length must equal resolved cfg.players. */
export function createMatch(opts: CreateMatchOptions): GameState {
  const cfg = resolveRules({ ...(opts.cfg ?? {}), players: opts.cfg?.players ?? opts.players.length });
  if (opts.players.length !== cfg.players) {
    throw new Error(`createMatch: expected ${cfg.players} players, got ${opts.players.length}`);
  }
  const s: GameState = {
    cfg,
    rng: opts.seed >>> 0,
    phase: 'LOBBY',
    handNo: 0,
    dealer: 0,
    wallBreak: null,
    players: opts.players.map((p, seat) => ({
      seat,
      name: p.name,
      isBot: p.isBot,
      avatar: p.avatar,
      hand: [],
      status: 'ALIVE',
      deadOrder: 0,
      ported: false,
      pendingPort: null,
      instantAnswered: false,
      chips: cfg.startingChips,
      totalPoints: 0,
      lastPlaces: 0,
      actionsThisTurn: 0,
      mustUseJoker: null,
      connected: true,
    })),
    melds: [],
    deadWall: [],
    turn: null,
    deadline: null,
    instantOffers: [],
    firstSeat: 0,
    nextMeldId: 1,
    deadCounter: 0,
    lastResult: null,
    standings: null,
    version: 0,
  };
  if (opts.dealer !== undefined && Number.isInteger(opts.dealer) && opts.dealer >= 0 && opts.dealer < cfg.players) {
    s.dealer = opts.dealer;
  } else {
    // RULES §3.1: everyone rolls 2d6, highest deals, ties re-roll among the tied.
    let contenders = s.players.map((p) => p.seat);
    while (contenders.length > 1) {
      const rolls = contenders.map((seat) => ({ seat, total: rollD6(s) + rollD6(s) }));
      const best = Math.max(...rolls.map((r) => r.total));
      contenders = rolls.filter((r) => r.total === best).map((r) => r.seat);
    }
    s.dealer = contenders[0];
  }
  return s;
}

/** Shuffle, roll dice, deal, check instant wins; moves to INSTANT or PORT (or HAND_END). */
export function startHand(state: GameState, now: number): EngineResult {
  if (state.phase !== 'LOBBY') return fail('Match already started');
  const s = structuredClone(state);
  const events: Events = [];
  dealHand(s, now, events);
  s.version = state.version + 1;
  return { ok: true, state: s, events };
}

function dealHand(s: GameState, now: number, events: Events): void {
  const { cfg } = s;
  const n = N(s);
  s.handNo += 1;
  s.melds = [];
  s.deadCounter = 0;
  s.instantOffers = [];
  s.lastResult = null;
  s.standings = null;
  s.turn = null;
  s.deadline = null;
  for (const p of s.players) {
    p.hand = [];
    p.status = 'ALIVE';
    p.deadOrder = 0;
    p.ported = false;
    p.pendingPort = null;
    p.instantAnswered = false;
    p.actionsThisTurn = 0;
    p.mustUseJoker = null;
  }

  // Shuffle (Fisher-Yates with the state RNG).
  const tiles = buildTileSet(2, cfg.jokers);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = randInt(s, i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }

  // Wall break (flavour): count seats from the dealer as 1, T stacks in from the right.
  const dice: [number, number] = [rollD6(s), rollD6(s)];
  const total = dice[0] + dice[1];
  s.wallBreak = { dice, wallSeat: (s.dealer + ((total - 1) % n)) % n, stack: total };
  s.firstSeat = (s.dealer + 1) % n;
  events.push({ type: 'HAND_START', handNo: s.handNo, dealer: s.dealer, wallBreak: s.wallBreak, firstSeat: s.firstSeat });

  // Deal 4 tiles per grab from the dealer's 下家, dealer last in each round.
  const order = seatsFrom(s, s.firstSeat);
  let pos = 0;
  while (order.some((seat) => s.players[seat].hand.length < cfg.handSize)) {
    for (const seat of order) {
      const p = s.players[seat];
      const take = Math.min(4, cfg.handSize - p.hand.length);
      for (let k = 0; k < take; k++) p.hand.push(tiles[pos++]);
    }
  }
  s.deadWall = tiles.slice(pos);
  for (const seat of order) {
    events.push({ type: 'DEAL', seat, count: s.players[seat].hand.length, tiles: [...s.players[seat].hand] });
  }

  // Instant wins (RULES §5).
  if (cfg.instantWins) {
    for (const seat of order) {
      const offer = detectInstant(s.players[seat].hand, cfg, seat);
      if (offer) s.instantOffers.push(offer);
    }
  }
  if (s.instantOffers.length > 0) {
    s.phase = 'INSTANT';
    s.deadline = now + cfg.instantTimerMs;
    for (const o of s.instantOffers) events.push({ type: 'INSTANT_OFFER', seat: o.seat, kind: o.kind });
    return;
  }
  enterPort(s, now, events);
}

const INSTANT_PRIORITY: Record<InstantKind, number> = { TIANHU_8: 1, TIANHU_RUNS: 2, GAME_7: 3 };

/** Detect the best instant win for a dealt hand, or null. */
export function detectInstant(hand: string[], cfg: RulesConfig, seat: number): InstantOffer | null {
  const byRank = new Map<number, string[]>();
  for (const id of hand) {
    const t = tileFromId(id);
    if (t.joker) continue;
    const list = byRank.get(t.rank as number) ?? [];
    list.push(id);
    byRank.set(t.rank as number, list);
  }
  let seven: string[] | null = null;
  for (const ids of byRank.values()) {
    if (ids.length >= 8) return { seat, kind: 'TIANHU_8', tiles: [sortTiles(ids)] };
    if (ids.length === 7 && !seven) seven = sortTiles(ids);
  }
  const partition = findRunPartition(hand, cfg);
  if (partition) return { seat, kind: 'TIANHU_RUNS', tiles: partition };
  if (seven) return { seat, kind: 'GAME_7', tiles: [seven] };
  return null;
}

/** After the deal / instant prompt: open the port window (or begin sequential turns). */
function enterPort(s: GameState, now: number, events: Events): void {
  s.instantOffers = [];
  if (s.cfg.portTiming === 'sequential') {
    startTurn(s, s.firstSeat, now, events);
    return;
  }
  s.phase = 'PORT';
  s.turn = null;
  const batch = { order: 0 };
  for (const seat of seatsFrom(s, s.firstSeat)) {
    const p = s.players[seat];
    if (p.status === 'ALIVE' && !canPortHand(p.hand, s.cfg)) markOut(s, seat, 'QUANCAN', events, undefined, batch);
  }
  if (!s.players.some((p) => p.status === 'ALIVE')) {
    endHand(s, 'LOWEST', null, events);
    return;
  }
  s.deadline = now + s.cfg.portTimerMs;
}

/** Simultaneous port: reveal everyone's submitted melds once all have submitted. */
function revealPorts(s: GameState, now: number, events: Events): void {
  const ports: { seat: number; meldIds: string[] }[] = [];
  for (const seat of seatsFrom(s, s.firstSeat)) {
    const p = s.players[seat];
    if (p.status !== 'ALIVE' || !p.pendingPort) continue;
    const meldIds: string[] = [];
    for (const ids of p.pendingPort) {
      const v = validatePortMeld(ids, s.cfg);
      if (typeof v === 'string') throw new Error(`revealPorts: stored port became invalid: ${v}`);
      const meld = createMeld(s, seat, v.type, v.tiles);
      meldIds.push(meld.id);
      events.push({ type: 'MELD_CREATED', seat, meld: structuredClone(meld), via: 'PORT' });
    }
    p.pendingPort = null;
    p.ported = true;
    ports.push({ seat, meldIds });
  }
  events.push({ type: 'PORT_REVEAL', ports });
  const emptied = seatsFrom(s, s.firstSeat).filter((seat) => s.players[seat].status === 'ALIVE' && s.players[seat].hand.length === 0);
  if (emptied.length > 0) {
    for (const seat of emptied) s.players[seat].status = 'OUT';
    endHand(s, 'TIANHU', emptied[0], events);
    return;
  }
  startTurn(s, s.firstSeat, now, events);
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Give the turn to the first ALIVE seat at or after `from`. Unported seats
 * (sequential port) that cannot port become 全餐; ported seats with no
 * primary action (even after Joker swaps) become Dead. Ends the hand if
 * nobody is left.
 */
function startTurn(s: GameState, from: number, now: number, events: Events): void {
  for (const seat of seatsFrom(s, from)) {
    const p = s.players[seat];
    if (p.status !== 'ALIVE') continue;
    p.actionsThisTurn = 0;
    p.mustUseJoker = null;
    if (!p.ported) {
      if (!canPortHand(p.hand, s.cfg)) {
        markOut(s, seat, 'QUANCAN', events);
        continue;
      }
      s.phase = 'PORT';
    } else {
      if (isDead(moveCtx(s, seat))) {
        markOut(s, seat, 'DEAD', events, 'NO_MOVE');
        continue;
      }
      s.phase = 'PLAY';
    }
    s.turn = seat;
    s.deadline = now + (p.ported ? s.cfg.turnTimerMs : s.cfg.portTimerMs);
    events.push({ type: 'TURN', seat, deadline: s.deadline });
    return;
  }
  endHand(s, 'LOWEST', null, events);
}

/**
 * Bookkeeping after a primary action (or a sequential port): empty hand ends
 * the hand; otherwise the turn passes (exactly-one mode) or continues
 * (unlimited mode, auto-ending when nothing further is possible).
 */
function afterPrimary(s: GameState, seat: number, now: number, events: Events, viaPort: boolean): void {
  const p = s.players[seat];
  p.actionsThisTurn += 1;
  if (p.hand.length === 0) {
    p.status = 'OUT';
    if (viaPort) {
      endHand(s, 'TIANHU', seat, events);
    } else {
      events.push({ type: 'GAME_PAI', seat });
      endHand(s, 'GAME', seat, events);
    }
    return;
  }
  if (!s.cfg.unlimitedActions) {
    startTurn(s, (seat + 1) % N(s), now, events);
    return;
  }
  s.phase = 'PLAY';
  if (!p.mustUseJoker && isDead(moveCtx(s, seat))) {
    startTurn(s, (seat + 1) % N(s), now, events);
    return;
  }
  s.deadline = now + s.cfg.turnTimerMs;
}

// ---------------------------------------------------------------------------
// Hand end, scoring, payouts
// ---------------------------------------------------------------------------

/** Hand penalty points for a list of tile ids. */
export function handPoints(tiles: string[], cfg: RulesConfig): number {
  let sum = 0;
  for (const id of tiles) sum += tilePenalty(id, cfg.jokerPenalty);
  return sum;
}

function titlesFor(n: number): RankTitle[] {
  if (n === 3) return ['WINNER', 'ERGE', 'DAGE'];
  if (n === 4) return ['WINNER', 'XIAOGE', 'ERGE', 'DAGE'];
  return ['WINNER', 'XIAOGE', 'ERGE', 'FOURTH', 'DAGE'];
}

function endHand(s: GameState, kind: HandEndKind, winner: number | null, events: Events): void {
  const { cfg } = s;
  const n = N(s);
  const points = s.players.map((p) => (p.seat === winner ? 0 : handPoints(p.hand, cfg)));
  const deadKey = (p: PlayerState) => (p.deadOrder === 0 ? Infinity : p.deadOrder);
  const others = s.players
    .filter((p) => p.seat !== winner)
    .sort(
      (a, b) =>
        points[a.seat] - points[b.seat] ||
        a.hand.length - b.hand.length ||
        deadKey(b) - deadKey(a) || // died later (or alive) ranks higher
        distance(s, a.seat) - distance(s, b.seat),
    );
  const order = winner === null ? others : [s.players[winner], ...others];
  const winnerSeat = order[0].seat;
  const titles = titlesFor(n);

  // Chip payments, each capped at the payer's remaining chips.
  const u = cfg.baseUnit;
  const delta = new Array<number>(n).fill(0);
  order.forEach((p, i) => {
    if (i === 0) return;
    let owed: number;
    if (kind === 'GAME' || kind === 'GAME_7') owed = cfg.gamePaiPayout * u;
    else if (kind === 'TIANHU') owed = cfg.tianhuPayout * u;
    else {
      const ladder = cfg.payoutLadder;
      owed = (ladder[i - 1] ?? ladder[ladder.length - 1] ?? 0) * u;
    }
    const paid = Math.max(0, Math.min(owed, p.chips));
    delta[p.seat] -= paid;
    delta[winnerSeat] += paid;
  });

  const rankings: HandRanking[] = order.map((p, i) => ({
    seat: p.seat,
    rank: i + 1,
    title: titles[i],
    points: points[p.seat],
    tiles: sortTiles(p.hand),
    chipsDelta: delta[p.seat],
    status: p.status,
  }));
  for (const p of s.players) {
    p.chips += delta[p.seat];
    p.totalPoints += points[p.seat];
    p.pendingPort = null;
    p.mustUseJoker = null;
  }
  s.players[order[n - 1].seat].lastPlaces += 1;

  s.lastResult = { handNo: s.handNo, kind, winnerSeat, rankings };
  s.phase = 'HAND_END';
  s.turn = null;
  s.deadline = null;
  s.instantOffers = [];
  events.push({ type: 'HAND_END', result: structuredClone(s.lastResult) });
}

function computeStandings(s: GameState): MatchStanding[] {
  const sorted = [...s.players].sort(
    (a, b) => b.chips - a.chips || a.totalPoints - b.totalPoints || a.lastPlaces - b.lastPlaces || a.seat - b.seat,
  );
  return sorted.map((p, i) => ({ seat: p.seat, name: p.name, chips: p.chips, totalPoints: p.totalPoints, place: i + 1 }));
}

/** From HAND_END: start the next hand or end the match (MATCH_END). */
export function nextHand(state: GameState, now: number): EngineResult {
  if (state.phase !== 'HAND_END') return fail('Hand is not over');
  const s = structuredClone(state);
  const events: Events = [];
  const over =
    (s.cfg.handsPerMatch > 0 && s.handNo >= s.cfg.handsPerMatch) || s.players.some((p) => p.chips <= 0);
  if (over) {
    s.phase = 'MATCH_END';
    s.standings = computeStandings(s);
    s.turn = null;
    s.deadline = null;
    events.push({ type: 'MATCH_END', standings: structuredClone(s.standings) });
  } else {
    if (s.cfg.dealerRotation === 'winner' && s.lastResult) s.dealer = s.lastResult.winnerSeat;
    else s.dealer = (s.dealer + 1) % N(s);
    dealHand(s, now, events);
  }
  s.version = state.version + 1;
  return { ok: true, state: s, events };
}

// ---------------------------------------------------------------------------
// Instant prompt
// ---------------------------------------------------------------------------

/**
 * Resolve the instant prompt in priority order (kind priority, then turn order).
 * Declined offers have already been removed; an answered offer still present
 * was declared. Waits while a higher-priority seat has not answered.
 */
function resolveInstant(s: GameState, now: number, events: Events): void {
  const sorted = [...s.instantOffers].sort(
    (a, b) => INSTANT_PRIORITY[a.kind] - INSTANT_PRIORITY[b.kind] || distance(s, a.seat) - distance(s, b.seat),
  );
  for (const o of sorted) {
    if (!s.players[o.seat].instantAnswered) return; // still waiting on this seat
    events.push({ type: 'INSTANT_WIN', seat: o.seat, kind: o.kind, tiles: o.tiles.map((t) => [...t]) });
    s.players[o.seat].status = 'OUT';
    endHand(s, o.kind === 'GAME_7' ? 'GAME_7' : 'TIANHU', o.seat, events);
    return;
  }
  enterPort(s, now, events);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Common checks for in-turn play actions. Returns an error string or null. */
function playTurnError(s: GameState, seat: number, primary: boolean): string | null {
  if (s.phase !== 'PLAY' && s.phase !== 'PORT') return 'Not in play';
  if (s.turn !== seat) return 'Not your turn';
  const p = s.players[seat];
  if (p.status !== 'ALIVE') return 'You are out of this hand';
  if (!p.ported) return 'You must port first';
  if (primary && !s.cfg.unlimitedActions && p.actionsThisTurn > 0) return 'Already acted this turn';
  return null;
}

function mustUseError(p: PlayerState, ids: string[]): string | null {
  if (p.mustUseJoker && !ids.includes(p.mustUseJoker)) return 'You must use the retrieved Joker';
  return null;
}

function doPort(s: GameState, seat: number, melds: unknown, now: number, events: Events): string | null {
  const p = s.players[seat];
  const simultaneous = s.phase === 'PORT' && s.turn === null;
  const sequential = (s.phase === 'PORT' || s.phase === 'PLAY') && s.turn === seat;
  if (!simultaneous && !sequential) return 'You cannot port now';
  if (p.status !== 'ALIVE') return 'You are out of this hand';
  if (p.ported) return 'Already ported';
  if (p.pendingPort) return 'Port already submitted';
  if (!Array.isArray(melds) || melds.length === 0 || !melds.every(isStringList)) return 'Port needs at least one meld';
  const all = (melds as string[][]).flat();
  const handErr = checkInHand(p.hand, all);
  if (handErr) return handErr;
  const validated: { type: 'RUN' | 'SET'; tiles: MeldTile[] }[] = [];
  for (const ids of melds as string[][]) {
    const v = validatePortMeld(ids, s.cfg);
    if (typeof v === 'string') return v;
    validated.push(v);
  }
  if (simultaneous) {
    p.pendingPort = (melds as string[][]).map((m) => [...m]);
    events.push({ type: 'PORT_SUBMITTED', seat });
    const waiting = s.players.some((q) => q.status === 'ALIVE' && !q.pendingPort);
    if (!waiting) revealPorts(s, now, events);
    return null;
  }
  // Sequential: lay the melds immediately; the port is this turn's primary action.
  const meldIds: string[] = [];
  for (const v of validated) {
    const meld = createMeld(s, seat, v.type, v.tiles);
    meldIds.push(meld.id);
    events.push({ type: 'MELD_CREATED', seat, meld: structuredClone(meld), via: 'PORT' });
  }
  p.ported = true;
  events.push({ type: 'PORT_REVEAL', ports: [{ seat, meldIds }] });
  afterPrimary(s, seat, now, events, true);
  return null;
}

function doExtend(s: GameState, seat: number, a: Extract<Action, { type: 'EXTEND' }>, now: number, events: Events): string | null {
  const err = playTurnError(s, seat, true);
  if (err) return err;
  if (!isStringList(a.low) || !isStringList(a.high)) return 'Bad tiles';
  const p = s.players[seat];
  const meld = s.melds.find((m) => m.id === a.meldId);
  if (!meld) return 'No such meld';
  const ids = [...a.low, ...a.high];
  const handErr = checkInHand(p.hand, ids) ?? mustUseError(p, ids);
  if (handErr) return handErr;
  const v = validateExtend(meld, a.low, a.high, s.cfg, s.melds);
  if (typeof v === 'string') return v;
  meld.tiles = [...v.low, ...meld.tiles, ...v.high];
  removeFromHand(p, ids);
  p.mustUseJoker = null;
  events.push({ type: 'MELD_EXTENDED', seat, meldId: meld.id, low: v.low, high: v.high });
  afterPrimary(s, seat, now, events, false);
  return null;
}

function doCut(s: GameState, seat: number, tiles: unknown, now: number, events: Events): string | null {
  const err = playTurnError(s, seat, true);
  if (err) return err;
  if (!isStringList(tiles)) return 'Bad tiles';
  const p = s.players[seat];
  const handErr = checkInHand(p.hand, tiles) ?? mustUseError(p, tiles);
  if (handErr) return handErr;
  const v = validateNewSet(tiles, s.cfg);
  if (typeof v === 'string') return v;
  if (!cutAllowed(moveCtx(s, seat))) return 'You must extend when you can';
  const meld = createMeld(s, seat, 'SET', v);
  p.mustUseJoker = null;
  events.push({ type: 'MELD_CREATED', seat, meld: structuredClone(meld), via: 'CUT' });
  afterPrimary(s, seat, now, events, false);
  return null;
}

function doFollow(s: GameState, seat: number, a: Extract<Action, { type: 'FOLLOW_CUT' }>, now: number, events: Events): string | null {
  const err = playTurnError(s, seat, true);
  if (err) return err;
  if (!isStringList(a.tiles)) return 'Bad tiles';
  const p = s.players[seat];
  const meld = s.melds.find((m) => m.id === a.meldId);
  if (!meld) return 'No such meld';
  const handErr = checkInHand(p.hand, a.tiles) ?? mustUseError(p, a.tiles);
  if (handErr) return handErr;
  const v = validateFollow(meld, a.tiles, s.cfg);
  if (typeof v === 'string') return v;
  meld.tiles = [...meld.tiles, ...v];
  removeFromHand(p, a.tiles);
  p.mustUseJoker = null;
  events.push({ type: 'SET_FOLLOWED', seat, meldId: meld.id, added: v });
  afterPrimary(s, seat, now, events, false);
  return null;
}

function doNewRun(s: GameState, seat: number, tiles: unknown, now: number, events: Events): string | null {
  if (!s.cfg.newRunsAfterPort) return 'New runs are disabled';
  const err = playTurnError(s, seat, true);
  if (err) return err;
  if (!isStringList(tiles)) return 'Bad tiles';
  const p = s.players[seat];
  const handErr = checkInHand(p.hand, tiles) ?? mustUseError(p, tiles);
  if (handErr) return handErr;
  const v = validateNewRun(tiles, s.cfg);
  if (typeof v === 'string') return v;
  const meld = createMeld(s, seat, 'RUN', v);
  p.mustUseJoker = null;
  events.push({ type: 'MELD_CREATED', seat, meld: structuredClone(meld), via: 'NEW_RUN' });
  afterPrimary(s, seat, now, events, false);
  return null;
}

function doSwap(s: GameState, seat: number, a: Extract<Action, { type: 'SWAP_JOKER' }>, events: Events): string | null {
  if (s.cfg.jokerSwap === 'off') return 'Joker swap is disabled';
  const err = playTurnError(s, seat, false);
  if (err) return err;
  const p = s.players[seat];
  if (p.mustUseJoker) return 'Use the retrieved Joker first';
  if (typeof a.jokerTileId !== 'string' || typeof a.withTileId !== 'string') return 'Bad tiles';
  const meld = s.melds.find((m) => m.id === a.meldId);
  if (!meld) return 'No such meld';
  if (!p.hand.includes(a.withTileId)) return 'Tile not in hand';
  if (!canSwapJoker(meld, a.jokerTileId, a.withTileId)) return 'That tile cannot replace this Joker';
  // rawSwaps lists one entry per natural kind and also enforces the set cap's
  // distinct-colour rule, so the request must match one of its entries by kind.
  const natural = tileFromId(a.withTileId);
  const listed = rawSwaps(moveCtx(s, seat)).some((o) => {
    if (o.move.meldId !== meld.id || o.move.jokerTileId !== a.jokerTileId) return false;
    const t = tileFromId(o.move.withTileId);
    return t.colour === natural.colour && t.rank === natural.rank;
  });
  if (!listed) return 'That swap would break the set';
  const slot = meld.tiles.findIndex((t) => t.tileId === a.jokerTileId);
  const newTiles = meld.tiles.map((mt, i) => (i === slot ? { tileId: a.withTileId, rep: mt.rep } : mt));
  const post: MoveCtx = {
    ...moveCtx(s, seat),
    hand: [...p.hand.filter((h) => h !== a.withTileId), a.jokerTileId],
    melds: s.melds.map((m) => (m.id === meld.id ? { ...m, tiles: newTiles } : m)),
    mustUse: s.cfg.jokerSwap === 'useSameTurn' ? a.jokerTileId : null,
  };
  if (!swapKeepsMove(post)) return 'That swap would leave you without a move';
  meld.tiles = newTiles;
  p.hand = post.hand;
  p.mustUseJoker = post.mustUse;
  events.push({ type: 'JOKER_SWAPPED', seat, meldId: meld.id, jokerTileId: a.jokerTileId, withTileId: a.withTileId });
  return null;
}

function doEndTurn(s: GameState, seat: number, now: number, events: Events): string | null {
  if (!s.cfg.unlimitedActions) return 'Your turn ends after one action';
  const err = playTurnError(s, seat, false);
  if (err) return err;
  const p = s.players[seat];
  if (p.actionsThisTurn < 1) return 'Make at least one move first';
  if (p.mustUseJoker) return 'You must use the retrieved Joker';
  startTurn(s, (seat + 1) % N(s), now, events);
  return null;
}

function doDeclare(s: GameState, seat: number, declare: unknown, now: number, events: Events): string | null {
  if (s.phase !== 'INSTANT') return 'No instant win to declare';
  const p = s.players[seat];
  const offerIdx = s.instantOffers.findIndex((o) => o.seat === seat);
  if (offerIdx < 0 || p.instantAnswered) return 'No instant win to declare';
  p.instantAnswered = true;
  if (declare !== true) s.instantOffers.splice(offerIdx, 1);
  resolveInstant(s, now, events);
  return null;
}

/** Dispatch one action on a cloned state. Returns an error string or null. */
function dispatch(s: GameState, seat: number, action: Action, now: number, events: Events): string | null {
  switch (action.type) {
    case 'DECLARE_INSTANT':
      return doDeclare(s, seat, action.declare, now, events);
    case 'PORT':
      return doPort(s, seat, action.melds, now, events);
    case 'EXTEND':
      return doExtend(s, seat, action, now, events);
    case 'CUT':
      return doCut(s, seat, action.tiles, now, events);
    case 'FOLLOW_CUT':
      return doFollow(s, seat, action, now, events);
    case 'NEW_RUN':
      return doNewRun(s, seat, action.tiles, now, events);
    case 'SWAP_JOKER':
      return doSwap(s, seat, action, events);
    case 'END_TURN':
      return doEndTurn(s, seat, now, events);
    default:
      return 'Unknown action';
  }
}

/** Apply a player intent. Returns ok:false with a human readable error when illegal. */
export function applyAction(state: GameState, seat: number, action: Action, now: number): EngineResult {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) return fail('Bad seat');
  if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
    return fail('Bad action');
  }
  const s = structuredClone(state);
  const events: Events = [];
  const err = dispatch(s, seat, action, now, events);
  if (err) return fail(err);
  s.version = state.version + 1;
  return { ok: true, state: s, events };
}

// ---------------------------------------------------------------------------
// Timeouts / auto-play
// ---------------------------------------------------------------------------

/** The port candidate with the highest penalty total (ties: lowest tile ids). */
function bestPortMeld(hand: string[], cfg: RulesConfig): string[] | null {
  const ctx: MoveCtx = { cfg, hand, melds: [], mustUse: null, acted: false };
  const idx = new HandIndex(hand);
  const cands = [...genRuns(ctx, idx), ...(cfg.setAllowedAsPort ? genSets(ctx, idx) : [])];
  return pickBest(cands, (c) => c, cfg);
}

function pickBest<T>(items: T[], tilesOf: (t: T) => string[], cfg: RulesConfig): T | null {
  let best: T | null = null;
  let bestScore = -1;
  let bestKey = '';
  for (const it of items) {
    const tiles = tilesOf(it);
    const score = penaltyOf(tiles, cfg);
    const k = [...tiles].sort().join(',');
    if (score > bestScore || (score === bestScore && k < bestKey)) {
      best = it;
      bestScore = score;
      bestKey = k;
    }
  }
  return best;
}

/** All direct primary actions for a position, as concrete Actions. */
function primaryActions(ctx: MoveCtx): Action[] {
  const lists = generateLists(ctx);
  const out: Action[] = [];
  for (const e of lists.extends) out.push({ type: 'EXTEND', meldId: e.meldId, low: e.low, high: e.high });
  for (const c of lists.cuts) out.push({ type: 'CUT', tiles: c });
  for (const f of lists.follows) out.push({ type: 'FOLLOW_CUT', meldId: f.meldId, tiles: f.tiles });
  for (const r of lists.newRuns) out.push({ type: 'NEW_RUN', tiles: r });
  return out;
}

function actionTiles(a: Action): string[] {
  switch (a.type) {
    case 'EXTEND':
      return [...a.low, ...a.high];
    case 'CUT':
    case 'NEW_RUN':
    case 'FOLLOW_CUT':
      return a.tiles;
    default:
      return [];
  }
}

/** Server auto-play for the seat to act (RULES §7 turn timer). */
function autoPlay(s: GameState, seat: number, now: number, events: Events): void {
  const p = s.players[seat];
  if (s.cfg.unlimitedActions && p.actionsThisTurn > 0 && !p.mustUseJoker) {
    startTurn(s, (seat + 1) % N(s), now, events);
    return;
  }
  const ctx = moveCtx(s, seat);
  let plan: { swaps: Action[]; action: Action } | null = null;
  const direct = pickBest(primaryActions(ctx), actionTiles, s.cfg);
  if (direct) plan = { swaps: [], action: direct };
  else {
    // Reachable via one Joker swap: pick the best swap + action pair.
    let bestScore = -1;
    for (const sw of legalSwaps(ctx)) {
      const a = pickBest(primaryActions(sw.post), actionTiles, s.cfg);
      if (!a) continue;
      const score = penaltyOf(actionTiles(a), s.cfg);
      if (score > bestScore) {
        bestScore = score;
        plan = { swaps: [{ type: 'SWAP_JOKER', ...sw.move }], action: a };
      }
    }
    if (!plan) {
      // Only reachable after several swaps (rare rule options): shortest path.
      const path = swapPath(ctx, (c) => primaryActions(c).length > 0);
      const a = path ? pickBest(primaryActions(path.post), actionTiles, s.cfg) : null;
      if (path && a) plan = { swaps: path.moves.map((m): Action => ({ type: 'SWAP_JOKER', ...m })), action: a };
    }
  }
  if (!plan) {
    markOut(s, seat, 'DEAD', events, 'TIMEOUT');
    startTurn(s, (seat + 1) % N(s), now, events);
    return;
  }
  for (const a of [...plan.swaps, plan.action]) {
    const err = dispatch(s, seat, a, now, events);
    if (err) throw new Error(`autoPlay produced an illegal action (${a.type}): ${err}`);
  }
  // In unlimited mode a timeout still ends the turn after the auto action.
  if (s.cfg.unlimitedActions && s.phase === 'PLAY' && s.turn === seat) {
    startTurn(s, (seat + 1) % N(s), now, events);
  }
}

/**
 * Resolve an expired deadline (state.deadline <= now): auto-port / auto-declare / auto-play
 * best move / mark dead. Returns ok:false if nothing is due.
 */
export function applyTimeout(state: GameState, now: number): EngineResult {
  if (state.deadline === null || now < state.deadline) return fail('Nothing is due');
  const s = structuredClone(state);
  const events: Events = [];
  if (s.phase === 'INSTANT') {
    for (const o of s.instantOffers) {
      const p = s.players[o.seat];
      if (!p.instantAnswered) {
        p.instantAnswered = true; // auto-declare
        events.push({ type: 'TIMEOUT', seat: o.seat });
      }
    }
    resolveInstant(s, now, events);
  } else if (s.phase === 'PORT' && s.turn === null) {
    const batch = { order: 0 };
    for (const seat of seatsFrom(s, s.firstSeat)) {
      const p = s.players[seat];
      if (p.status !== 'ALIVE' || p.pendingPort) continue;
      events.push({ type: 'TIMEOUT', seat });
      const best = bestPortMeld(p.hand, s.cfg);
      if (best) {
        p.pendingPort = [best];
        events.push({ type: 'PORT_SUBMITTED', seat });
      } else {
        markOut(s, seat, 'QUANCAN', events, undefined, batch);
      }
    }
    if (s.players.some((p) => p.status === 'ALIVE')) revealPorts(s, now, events);
    else endHand(s, 'LOWEST', null, events);
  } else if ((s.phase === 'PORT' || s.phase === 'PLAY') && s.turn !== null) {
    const seat = s.turn;
    const p = s.players[seat];
    events.push({ type: 'TIMEOUT', seat });
    if (!p.ported) {
      const best = bestPortMeld(p.hand, s.cfg);
      if (best) {
        const err = doPort(s, seat, [best], now, events);
        if (err) throw new Error(`auto-port failed: ${err}`);
        if (s.cfg.unlimitedActions && s.turn === seat && (s.phase === 'PLAY' || s.phase === 'PORT')) {
          startTurn(s, (seat + 1) % N(s), now, events);
        }
      } else {
        markOut(s, seat, 'QUANCAN', events);
        startTurn(s, (seat + 1) % N(s), now, events);
      }
    } else {
      autoPlay(s, seat, now, events);
    }
  } else {
    return fail('Nothing is due');
  }
  s.version = state.version + 1;
  return { ok: true, state: s, events };
}

// ---------------------------------------------------------------------------
// Legal moves
// ---------------------------------------------------------------------------

interface Lists {
  extends: LegalMoves['extends'];
  cuts: string[][];
  follows: LegalMoves['follows'];
  newRuns: string[][];
}

/** Direct primary actions for a position (honours mustUse and the cut rule). */
function generateLists(ctx: MoveCtx): Lists {
  const idx = new HandIndex(ctx.hand, ctx.mustUse);
  const must = ctx.mustUse;
  const ext = genExtends(ctx, idx).filter((e) => movesUse([...e.low, ...e.high], must));
  const fol = genFollows(ctx, idx).filter((f) => movesUse(f.tiles, must));
  const runs = ctx.cfg.newRunsAfterPort ? genRuns(ctx, idx).filter((r) => movesUse(r, must)) : [];
  const cuts =
    anyCutShape(ctx, idx) && cutAllowed(ctx) ? genSets(ctx, idx).filter((c) => movesUse(c, must)) : [];
  return { extends: ext, cuts, follows: fol, newRuns: runs };
}

function emptyLegal(): LegalMoves {
  return {
    canPort: false,
    portCandidates: [],
    extends: [],
    cuts: [],
    follows: [],
    newRuns: [],
    swaps: [],
    cutBlocked: false,
    canEndTurn: false,
    dead: false,
  };
}

/** Legal moves for `seat` if it is that seat's decision now, else null. */
export function getLegalMoves(state: GameState, seat: number): LegalMoves | null {
  if (!pendingSeats(state).includes(seat)) return null;
  const s = state;
  const p = s.players[seat];
  const legal = emptyLegal();
  if (s.phase === 'INSTANT') return legal;
  if (!p.ported) {
    legal.canPort = canPortHand(p.hand, s.cfg);
    if (legal.canPort) {
      const ctx: MoveCtx = { cfg: s.cfg, hand: p.hand, melds: [], mustUse: null, acted: false };
      const idx = new HandIndex(p.hand);
      legal.portCandidates = [...genRuns(ctx, idx), ...(s.cfg.setAllowedAsPort ? genSets(ctx, idx) : [])].slice(
        0,
        LIST_CAP,
      );
    }
    legal.dead = !legal.canPort;
    return legal;
  }
  const ctx = moveCtx(s, seat);
  const lists = generateLists(ctx);
  legal.extends = lists.extends;
  legal.cuts = lists.cuts;
  legal.follows = lists.follows;
  legal.newRuns = lists.newRuns;
  legal.swaps = legalSwaps(ctx)
    .map((o) => o.move)
    .slice(0, LIST_CAP);
  legal.cutBlocked = s.cfg.cutOnlyWhenCannotExtend && extendPossible(ctx);
  legal.canEndTurn = s.cfg.unlimitedActions && p.actionsThisTurn > 0 && !p.mustUseJoker;
  legal.dead = !legal.canEndTurn && isDead(ctx);
  return legal;
}

/** Seats that must decide now (turn seat in PLAY; all pending in PORT/INSTANT). */
export function pendingSeats(state: GameState): number[] {
  if (state.phase === 'INSTANT') {
    return state.instantOffers.filter((o) => !state.players[o.seat].instantAnswered).map((o) => o.seat);
  }
  if (state.phase === 'PORT' && state.turn === null) {
    return state.players.filter((p) => p.status === 'ALIVE' && !p.pendingPort && !p.ported).map((p) => p.seat);
  }
  if ((state.phase === 'PORT' || state.phase === 'PLAY') && state.turn !== null) return [state.turn];
  return [];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Per-seat view with hidden information removed (seat -1 = spectator). */
export function projectView(state: GameState, seat: number): PlayerView {
  const you = Number.isInteger(seat) && seat >= 0 && seat < state.players.length ? seat : -1;
  const reveal = state.phase === 'HAND_END' || state.phase === 'MATCH_END';
  const players: PublicPlayer[] = state.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    isBot: p.isBot,
    avatar: p.avatar,
    status: p.status,
    handCount: p.hand.length,
    ported: p.ported,
    portSubmitted: p.pendingPort !== null,
    chips: p.chips,
    totalPoints: p.totalPoints,
    connected: p.connected,
    revealed: reveal ? sortTiles(p.hand) : null,
  }));
  const me = you >= 0 ? state.players[you] : null;
  const offer = me && state.phase === 'INSTANT' ? state.instantOffers.find((o) => o.seat === you) ?? null : null;
  return {
    you,
    cfg: structuredClone(state.cfg),
    phase: state.phase,
    handNo: state.handNo,
    dealer: state.dealer,
    firstSeat: state.firstSeat,
    wallBreak: state.wallBreak ? structuredClone(state.wallBreak) : null,
    turn: state.turn,
    deadline: state.deadline,
    players,
    melds: structuredClone(state.melds),
    deadWallCount: state.deadWall.length,
    hand: me ? sortTiles(me.hand) : [],
    pendingPort: me?.pendingPort ? me.pendingPort.map((m) => [...m]) : null,
    instantOffer: offer ? structuredClone(offer) : null,
    legal: you >= 0 ? getLegalMoves(state, you) : null,
    lastResult: state.lastResult ? structuredClone(state.lastResult) : null,
    standings: state.standings ? structuredClone(state.standings) : null,
    version: state.version,
  };
}

/** Remove hidden info from events for `seat` (e.g. DEAL tiles of other seats). */
export function projectEvents(events: GameEvent[], seat: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (const e of events) {
    if (e.type === 'DEAL') {
      if (e.seat === seat && e.tiles) out.push({ type: 'DEAL', seat: e.seat, count: e.count, tiles: [...e.tiles] });
      else out.push({ type: 'DEAL', seat: e.seat, count: e.count });
    } else if (e.type === 'INSTANT_OFFER') {
      // the offer reveals hand contents; only its owner sees it
      if (e.seat === seat) out.push({ ...e });
    } else {
      out.push(structuredClone(e));
    }
  }
  return out;
}
