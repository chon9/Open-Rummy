import type { PlayerView } from '@open-rummy/shared';

/**
 * Identity of the local player's current decision. A choice picker opened under one
 * key is stale once the key changes: the turn passed (end turn or timeout), the phase
 * moved on (port timeout, hand end), our legal moves went away or the hand/table changed
 * under it. Other seats submitting simultaneous ports do not change it. The deadline is
 * left out on purpose: online it is re-mapped through a drifting clock offset.
 */
export function decisionKey(v: PlayerView): string {
  const melds = v.melds.map((m) => `${m.id}:${m.tiles.length}`).join(',');
  return `${v.handNo}|${v.phase}|${v.turn}|${v.legal ? 1 : 0}|${v.hand.join(',')}|${melds}`;
}
