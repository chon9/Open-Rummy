import { describe, expect, it } from 'vitest';
import type { PlayerView } from '@open-rummy/shared';
import { decisionKey } from './decision';

const base = (): PlayerView =>
  ({
    you: 0,
    phase: 'PLAY',
    handNo: 1,
    turn: 0,
    deadline: 1000,
    hand: ['a', 'b', 'c'],
    melds: [{ id: 'm1', tiles: [{}, {}, {}] }],
    legal: {},
    players: [],
  }) as unknown as PlayerView;

describe('decisionKey', () => {
  it('is stable for the same decision even when the (re-mapped) deadline moves', () => {
    const a = base();
    const b = { ...base(), deadline: 1010, version: 7 } as PlayerView;
    expect(decisionKey(b)).toBe(decisionKey(a));
  });

  it('changes when the turn passes, the phase moves on or legal moves go away', () => {
    const k = decisionKey(base());
    expect(decisionKey({ ...base(), turn: 1, legal: null })).not.toBe(k);
    expect(decisionKey({ ...base(), turn: 1 })).not.toBe(k);
    expect(decisionKey({ ...base(), phase: 'HAND_END' })).not.toBe(k);
    expect(decisionKey({ ...base(), handNo: 2 })).not.toBe(k);
    expect(decisionKey({ ...base(), legal: null })).not.toBe(k);
  });

  it('changes when the hand or the table changed under an open picker', () => {
    const k = decisionKey(base());
    expect(decisionKey({ ...base(), hand: ['a', 'b'] })).not.toBe(k);
    const melds = [{ id: 'm1', tiles: [{}, {}, {}, {}] }] as unknown as PlayerView['melds'];
    expect(decisionKey({ ...base(), melds })).not.toBe(k);
  });
});
