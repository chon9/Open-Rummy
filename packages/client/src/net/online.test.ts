import { describe, expect, it } from 'vitest';
import { ClockSync, parseServerMessage } from './online';

describe('ClockSync', () => {
  it('maps server deadlines into the local clock using the least-delayed sample', () => {
    const c = new ClockSync();
    expect(c.synced).toBe(false);
    // server clock is 5000ms ahead of ours; messages arrive after 40ms and 10ms
    c.sample(105_000, 100_040);
    c.sample(106_000, 101_010);
    expect(c.offset).toBe(-4990);
    expect(c.toLocal(110_000)).toBe(105_010);
  });

  it('forgets old samples beyond its window', () => {
    const c = new ClockSync(2);
    c.sample(1000, 0); // offset -1000 (old, server was ahead)
    c.sample(1000, 2000); // +1000
    c.sample(1000, 2100); // +1100
    expect(c.offset).toBe(1000);
  });
});

describe('parseServerMessage game.serverNow', () => {
  const view = { phase: 'PLAY', you: 0, players: [], melds: [], hand: [], cfg: {} };
  it('keeps a numeric serverNow and tolerates its absence', () => {
    const a = parseServerMessage(JSON.stringify({ t: 'game', view, events: [], serverNow: 123 }));
    expect(a && a.t === 'game' && a.serverNow).toBe(123);
    const b = parseServerMessage(JSON.stringify({ t: 'game', view, events: [] }));
    expect(b?.t).toBe('game');
  });

  it('drops a malformed serverNow instead of trusting it', () => {
    const m = parseServerMessage(JSON.stringify({ t: 'game', view, events: [], serverNow: 'soon' }));
    expect(m?.t).toBe('game');
    expect((m as { serverNow?: unknown }).serverNow).toBeUndefined();
  });
});
