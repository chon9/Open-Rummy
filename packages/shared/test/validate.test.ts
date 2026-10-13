import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, TokenBucket, parseAction, parseClientMessage, sanitizeName, utf8Length } from '../src';

describe('shared inbound validation', () => {
  it('counts UTF-8 bytes like TextEncoder', () => {
    const enc = new TextEncoder();
    for (const s of ['', 'abc', '拉米麻将', 'aé€', '\u{1f004}x', '\ud800', '\ud800a', '\udc00']) {
      expect(utf8Length(s)).toBe(enc.encode(s).length);
    }
  });

  it('rejects frames over the byte cap even when the UTF-16 length fits', () => {
    const name = '麻'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3));
    const raw = JSON.stringify({ t: 'hello', v: 1, name });
    expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(parseClientMessage(raw)).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
  });

  it('drops unknown fields and sanitises names', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'action', seat: 3, action: { type: 'END_TURN', seat: 2 } }))).toEqual({
      t: 'action',
      action: { type: 'END_TURN' },
    });
    expect(sanitizeName(`a‮b​c`)).toBe('abc');
    expect(parseAction({ type: 'PORT', melds: [] })).toBeNull();
  });

  it('token bucket refills at its rate', () => {
    const b = new TokenBucket(2, 2, 0);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(500)).toBe(true);
    expect(b.isFull(1500)).toBe(true);
  });
});
