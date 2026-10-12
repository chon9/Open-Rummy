/**
 * OnlineTransport session-token lifecycle (node env, fake WebSocket/storage).
 * The token must be persisted only while we hold a seat, so a refresh after
 * leaving a room (or before joining one) never "resumes" a seatless session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@open-rummy/shared';

class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

class FakeWS {
  static OPEN = 1;
  static last: FakeWS | null = null;
  readyState = 1;
  sent: { t: string; token?: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  close(): void {
    this.readyState = 3;
  }
  recv(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const g = globalThis as Record<string, unknown>;
const storage = new FakeStorage();
const KEY = 'openrummy.session';
const room = { code: 'ABC234', seats: [{ seat: 0, name: 'A', avatar: 'x', host: true, isBot: false, connected: true }, null], cfg: { players: 2 }, you: 0, started: false };

beforeEach(() => {
  storage.clear();
  g.sessionStorage = storage;
  g.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
  g.location = { protocol: 'http:', host: '127.0.0.1:1' };
  g.WebSocket = FakeWS;
  FakeWS.last = null;
});

afterEach(() => {
  for (const k of ['sessionStorage', 'window', 'location', 'WebSocket']) delete g[k];
});

async function open(): Promise<{ t: import('../src/net/online').OnlineTransport; ws: FakeWS }> {
  const { OnlineTransport } = await import('../src/net/online');
  const t = new OnlineTransport('Tester');
  const ws = FakeWS.last!;
  ws.onopen?.();
  return { t, ws };
}

describe('OnlineTransport session token', () => {
  it('does not persist the token until a seat is held, then keeps it while seated', async () => {
    const { t, ws } = await open();
    ws.recv({ t: 'welcome', v: PROTOCOL_VERSION, token: 'tok-1', resumed: false });
    expect(storage.getItem(KEY)).toBeNull();
    ws.recv({ t: 'room', room });
    expect(storage.getItem(KEY)).toBe('tok-1');
    t.dispose();
  });

  it('forgets the stored token on leave and on the server confirmation', async () => {
    const { t, ws } = await open();
    ws.recv({ t: 'welcome', v: PROTOCOL_VERSION, token: 'tok-2', resumed: false });
    ws.recv({ t: 'room', room });
    t.leave();
    expect(storage.getItem(KEY)).toBeNull();
    expect(ws.sent.some((m) => m.t === 'leave_room')).toBe(true);
    ws.recv({ t: 'left' });
    expect(storage.getItem(KEY)).toBeNull();
    // joining another room on the same connection stores the token again
    ws.recv({ t: 'room', room: { ...room, code: 'XYZ789' } });
    expect(storage.getItem(KEY)).toBe('tok-2');
    t.dispose();
  });

  it('sends a stored token in hello so a refresh resumes the seat', async () => {
    storage.setItem(KEY, 'tok-3');
    const { t, ws } = await open();
    const hello = ws.sent.find((m) => m.t === 'hello');
    expect(hello?.token).toBe('tok-3');
    t.dispose();
  });
});
