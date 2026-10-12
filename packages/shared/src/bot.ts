/**
 * AI bots. Bots only see their own PlayerView (own hand, public melds, public
 * hand counts / statuses, the rules and their legal moves): no cheating.
 *
 * Levels
 *  - easy:   ports one random candidate; plays mostly random legal moves.
 *  - normal: greedy. Ports disjoint natural runs (keeps jokers), plays the
 *            move shedding the most penalty, uses jokers reluctantly.
 *  - hard:   searches port partitions and scores every candidate move
 *            (including partial extensions and Joker-swap combos) with a
 *            position evaluator: penalty left, reserve of future moves,
 *            open slots handed to opponents (weighted by how close the
 *            nearest opponent is to emptying their hand). See bot/eval.ts.
 *
 * Every primary action returned is either taken verbatim from LegalMoves or
 * generated and checked with the engine's own meld validators; swaps always
 * come from LegalMoves.swaps.
 */
import type { RulesConfig } from './config';
import { HARD_WEIGHTS, evaluate, opponentPressure, reserveMoves, type EvalCtx } from './bot/eval';
import { dedupe, genPrimaries, legalPrimaries } from './bot/gen';
import { HandKinds, actionTiles, isJoker, penalty, simulate, type Pos } from './bot/model';
import { checkedPort, searchPort } from './bot/port';
import type { Action, LegalMoves, PlayerView } from './types';

export type BotLevel = 'easy' | 'normal' | 'hard';

/**
 * Choose an action for `view.you`. Returns null when the bot has nothing to decide.
 * `rand` returns [0,1). Must only return actions the engine accepts.
 */
export function chooseBotAction(view: PlayerView, level: BotLevel, rand: () => number): Action | null {
  try {
    return decideBotAction(view, level, rand);
  } catch {
    // Defensive: a bot bug must never stall a table. Fall back to the simplest
    // listed move; tests call decideBotAction directly so bugs still surface.
    return view.legal ? safeFallback(view, view.legal) : null;
  }
}

/** Thinking delay in ms for a bot of this level. */
export function botThinkDelay(level: BotLevel, rand: () => number): number {
  const [min, max] = level === 'easy' ? [600, 1400] : level === 'normal' ? [800, 2000] : [1000, 2600];
  return Math.round(min + rand() * (max - min));
}

/** Same as chooseBotAction but without the safety net (used by tests). */
export function decideBotAction(view: PlayerView, level: BotLevel, rand: () => number): Action | null {
  const legal = view.legal;
  if (!legal || view.you < 0) return null;
  if (view.phase === 'INSTANT') return view.instantOffer ? { type: 'DECLARE_INSTANT', declare: true } : null;
  const me = view.players[view.you];
  if (!me || me.status !== 'ALIVE') return null;
  if (!me.ported) return choosePort(view, legal, level, rand);
  if (view.phase !== 'PLAY' && view.phase !== 'PORT') return null;
  switch (level) {
    case 'easy':
      return playEasy(view, legal, rand);
    case 'normal':
      return playNormal(view, legal, rand);
    default:
      return playHard(view, legal, rand);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T>(xs: readonly T[], rand: () => number): T {
  return xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
}

function safeFallback(view: PlayerView, legal: LegalMoves): Action | null {
  if (view.phase === 'INSTANT') return view.instantOffer ? { type: 'DECLARE_INSTANT', declare: true } : null;
  const me = view.players[view.you];
  if (me && !me.ported) return legal.portCandidates[0] ? { type: 'PORT', melds: [legal.portCandidates[0]] } : null;
  const prim = legalPrimaries(legal);
  if (prim.length > 0) return prim[0];
  if (legal.canEndTurn) return { type: 'END_TURN' };
  if (legal.swaps.length > 0) return { type: 'SWAP_JOKER', ...legal.swaps[0] };
  return null;
}

/** Greedy shed score: natural penalty played, jokers count little (we prefer to keep them). */
function shedScore(a: Action, view: PlayerView): number {
  const tiles = actionTiles(a);
  if (tiles.length === view.hand.length) return 1000; // empties the hand
  let s = 0;
  for (const id of tiles) s += isJoker(id) ? 3 : penalty([id], view.cfg);
  return s;
}

function opponentsPressure(view: PlayerView): number {
  const counts = view.players.filter((p) => p.seat !== view.you && p.status === 'ALIVE').map((p) => p.handCount);
  return opponentPressure(counts);
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

function choosePort(view: PlayerView, legal: LegalMoves, level: BotLevel, rand: () => number): Action | null {
  if (!legal.canPort || legal.portCandidates.length === 0) return null;
  const cfg = view.cfg;
  const base: Pos = { hand: view.hand, melds: view.melds };
  if (level === 'easy') return { type: 'PORT', melds: [pick(legal.portCandidates, rand)] };
  if (level === 'hard') {
    const ec: EvalCtx = { cfg, w: HARD_WEIGHTS, pressure: opponentsPressure(view) };
    const found = checkedPort(base, searchPort(base, cfg, ec, view.you, rand), cfg, view.you);
    if (found) return found;
  }
  return greedyPort(base, legal, cfg, view.you);
}

/** Normal port: disjoint natural-only candidates, highest penalty first; jokers are kept. */
function greedyPort(base: Pos, legal: LegalMoves, cfg: RulesConfig, seat: number): Action {
  const natural = legal.portCandidates.filter((c) => !c.some(isJoker)).sort((a, b) => penalty(b, cfg) - penalty(a, cfg));
  const used = new Set<string>();
  const melds: string[][] = [];
  for (const c of natural) {
    if (c.some((id) => used.has(id))) continue;
    melds.push(c);
    for (const id of c) used.add(id);
  }
  const checked = checkedPort(base, melds, cfg, seat);
  if (checked) return checked;
  const best = [...legal.portCandidates].sort((a, b) => penalty(b, cfg) - penalty(a, cfg))[0];
  return { type: 'PORT', melds: [best] };
}

// ---------------------------------------------------------------------------
// Play: easy
// ---------------------------------------------------------------------------

function playEasy(view: PlayerView, legal: LegalMoves, rand: () => number): Action | null {
  const prim = legalPrimaries(legal);
  // unlimited mode: often stops after the first action
  if (legal.canEndTurn && (prim.length === 0 || rand() < 0.5)) return { type: 'END_TURN' };
  if (prim.length > 0) {
    if (rand() < 0.7) return pick(prim, rand);
    return bestBy(prim, (a) => shedScore(a, view), rand);
  }
  if (legal.swaps.length > 0) return { type: 'SWAP_JOKER', ...pick(legal.swaps, rand) };
  return null;
}

function bestBy<T>(xs: T[], score: (x: T) => number, rand: () => number): T {
  let best = xs[0];
  let bestS = -Infinity;
  for (const x of xs) {
    const s = score(x) + rand() * 0.01;
    if (s > bestS) {
      bestS = s;
      best = x;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Play: normal
// ---------------------------------------------------------------------------

function playNormal(view: PlayerView, legal: LegalMoves, rand: () => number): Action | null {
  const prim = legalPrimaries(legal);
  if (prim.length === 0) {
    if (legal.canEndTurn) return { type: 'END_TURN' };
    // only reachable through a Joker swap
    return legal.swaps.length > 0 ? { type: 'SWAP_JOKER', ...legal.swaps[0] } : null;
  }
  const best = bestBy(prim, (a) => shedScore(a, view), rand);
  if (legal.canEndTurn) {
    // unlimited mode: keep going unless the move would leave no future move
    const after = simulate({ hand: view.hand, melds: view.melds }, best, view.cfg, view.you);
    if (after && after.hand.length > 0 && reserveMoves(new HandKinds(after.hand), after.melds, view.cfg).moves === 0) {
      return { type: 'END_TURN' };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Play: hard
// ---------------------------------------------------------------------------

/** Cap on swaps examined with look-ahead. */
const SWAP_LOOKAHEAD = 24;

function playHard(view: PlayerView, legal: LegalMoves, rand: () => number): Action | null {
  const cfg = view.cfg;
  const pos: Pos = { hand: view.hand, melds: view.melds };
  const ec: EvalCtx = { cfg, w: HARD_WEIGHTS, pressure: opponentsPressure(view) };
  const cutAllowed = !legal.cutBlocked;
  // With 'useSameTurn' swaps the view does not say which retrieved Joker must
  // be used, so only the engine's own lists are trusted for direct moves.
  const custom = cfg.jokerSwap !== 'useSameTurn';

  let best: Action | null = null;
  let bestScore = -Infinity;
  const offer = (a: Action, score: number) => {
    const s = score + rand() * 0.01;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  };

  // Direct primary actions.
  const listed = legalPrimaries(legal);
  const direct = dedupe(custom ? [...listed, ...genPrimaries(pos, cfg, { cutAllowed, mustUse: null })] : listed);
  const listedKeys = new Set(listed);
  for (const a of direct) {
    const after = simulate(pos, a, cfg, view.you);
    if (!after) {
      // listed by the engine but not reproducible locally: still legal, score by shed
      if (listedKeys.has(a)) offer(a, -penalty(view.hand, cfg) + penalty(actionTiles(a), cfg));
      continue;
    }
    offer(a, evaluate(after, ec));
  }

  // Unlimited mode: stopping is an option.
  if (legal.canEndTurn) offer({ type: 'END_TURN' }, evaluate(pos, ec));

  // Joker swaps, scored by the best follow-up (swaps are free actions).
  for (const sw of legal.swaps.slice(0, SWAP_LOOKAHEAD)) {
    const swap: Action = { type: 'SWAP_JOKER', ...sw };
    const post = simulate(pos, swap, cfg, view.you);
    if (!post) continue;
    const mustUse = cfg.jokerSwap === 'useSameTurn' ? sw.jokerTileId : null;
    let follow = -Infinity;
    for (const a of genPrimaries(post, cfg, { cutAllowed, mustUse })) {
      const after = simulate(post, a, cfg, view.you);
      if (after) follow = Math.max(follow, evaluate(after, ec));
    }
    if (legal.canEndTurn && !mustUse) follow = Math.max(follow, evaluate(post, ec));
    if (follow > -Infinity) offer(swap, follow - 0.05); // tiny bias: swap only when it helps
  }

  if (best) return best;
  if (listed.length > 0) return listed[0];
  if (legal.canEndTurn) return { type: 'END_TURN' };
  if (legal.swaps.length > 0) return { type: 'SWAP_JOKER', ...legal.swaps[0] };
  return null;
}
