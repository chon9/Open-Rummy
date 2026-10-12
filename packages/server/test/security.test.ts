/**
 * Adversarial tests: abuse limits, hostile input, information leaks, static file
 * hardening and game-flow edge cases. Each scenario starts its own in-process
 * server on an ephemeral port so limits can be set per test.
 */
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, resolveRules, type PlayerView, type ServerMessage } from '@open-rummy/shared';
import { startServer, type RunningServer, type StartOptions } from '../src/app';
import { loadConfig } from '../src/config';
import { KeyedLimiter, clientIp, limitKey } from '../src/limits';
import { RoomManager } from '../src/rooms';
import { SessionStore, parseClientMessage, sanitizeName, sanitizeRules } from '../src/session';
import { contentSecurityPolicy, resolveSafePath } from '../src/static';
import { Client, expectRejected, httpRequest, isError, isGame, isRoom, sleep } from './helpers';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmp: string;
let web: string;
const OUTSIDE_MARKER = 'SECURITY-OUTSIDE-MARKER';
const running: RunningServer[] = [];
const clients: Client[] = [];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-rummy-sec-'));
  web = path.join(tmp, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Open Rummy</title>');
  fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(web, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), OUTSIDE_MARKER);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(running.splice(0).map((s) => s.close()));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function boot(extra: Partial<StartOptions> = {}): Promise<{ port: number; url: string }> {
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: web,
    maxRooms: 50,
    allowedOrigins: [],
    production: false,
    quiet: true,
    maxConnsPerIp: 1000,
    maxRoomsPerIp: 1000,
    ...extra,
    limits: { connBurst: 1000, joinBurstPerSocket: 1000, joinBurstPerIp: 1000, ...extra.limits },
    rooms: { lobbyGraceMs: 200, hostOptions: { botDelayMs: [20, 40] }, ...extra.rooms },
  });
  running.push(s);
  return { port: s.port, url: `ws://127.0.0.1:${s.port}/ws` };
}

async function connect(url: string, opts?: { origin?: string; headers?: Record<string, string> }): Promise<Client> {
  const c = new Client(url, opts);
  clients.push(c);
  await c.open();
  return c;
}

type RoomMsg = Extract<ServerMessage, { t: 'room' }>;
type GameMsg = Extract<ServerMessage, { t: 'game' }>;

async function createRoom(c: Client, name = 'Host', cfg: object = {}): Promise<RoomMsg> {
  const p = c.next((m) => m.t === 'room');
  c.send({ t: 'create_room', name, avatar: 'mei', cfg });
  return (await p) as RoomMsg;
}

// ---------------------------------------------------------------------------
// Connection-level limits
// ---------------------------------------------------------------------------

describe('connection limits', () => {
  it('caps concurrent connections per IP and frees the slot on close', async () => {
    const { url } = await boot({ maxConnsPerIp: 2 });
    const a = await connect(url);
    await connect(url);
    expect(await expectRejected(url)).toMatch(/429/);
    await a.close();
    await sleep(50);
    const c = await connect(url);
    expect((await c.hello('Again')).t).toBe('welcome');
  });

  it('caps total connections', async () => {
    const { url } = await boot({ maxConnections: 2 });
    await connect(url);
    await connect(url);
    expect(await expectRejected(url)).toMatch(/503/);
  });

  it('rate limits new connections per IP', async () => {
    const { url } = await boot({ limits: { connBurst: 3, connRate: 0.01 } });
    for (let i = 0; i < 3; i++) await (await connect(url)).close();
    expect(await expectRejected(url)).toMatch(/429/);
  });

  it('closes sockets that never say hello', async () => {
    const { url } = await boot({ limits: { helloTimeoutMs: 150 } });
    const idle = await connect(url);
    const greeted = await connect(url);
    await greeted.hello('Fast');
    expect(await idle.waitClosed(2000)).toBe(1008);
    await sleep(200);
    expect(greeted.closed).toBe(false);
  });

  it('only trusts X-Forwarded-For when TRUST_PROXY is set', async () => {
    // Not trusted: both "clients" are 127.0.0.1, so the second one hits the per-IP cap.
    const plain = await boot({ maxConnsPerIp: 1 });
    await connect(plain.url, { headers: { 'X-Forwarded-For': '203.0.113.1' } });
    expect(await expectRejected(plain.url, { headers: { 'X-Forwarded-For': '203.0.113.2' } })).toMatch(/429/);

    // Trusted (one hop): the last entry is the client; a spoofed leftmost entry is ignored.
    const proxied = await boot({ maxConnsPerIp: 1, trustProxy: 1 });
    await connect(proxied.url, { headers: { 'X-Forwarded-For': '203.0.113.1' } });
    await connect(proxied.url, { headers: { 'X-Forwarded-For': '203.0.113.2' } });
    expect(await expectRejected(proxied.url, { headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.1' } })).toMatch(/429/);
  });

  it('enforces the origin allow-list case-insensitively and allows a missing Origin', async () => {
    const { url } = await boot({ allowedOrigins: ['https://rummy.example.com'] });
    expect(await expectRejected(url, { origin: 'https://evil.example.com' })).toMatch(/403/);
    expect(await expectRejected(url, { origin: 'https://rummy.example.com.evil.io' })).toMatch(/403/);
    await connect(url, { origin: 'https://Rummy.Example.com' });
    await connect(url);
  });

  it('closes every socket with 1001 on graceful shutdown', async () => {
    const { url } = await boot();
    const c = await connect(url);
    await c.hello('Bye');
    const srv = running.pop() as RunningServer;
    const closed = c.waitClosed(3000);
    await srv.close();
    expect(await closed).toBe(1001);
  });
});

describe('client address helpers', () => {
  const req = (remote: string, xff?: string): IncomingMessage =>
    ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

  it('resolves the client IP', () => {
    expect(clientIp(req('::ffff:10.0.0.5'), 0)).toBe('10.0.0.5');
    expect(clientIp(req('10.0.0.5', '1.2.3.4'), 0)).toBe('10.0.0.5');
    expect(clientIp(req('127.0.0.1', '6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(req('127.0.0.1', '6.6.6.6, 1.2.3.4, 10.0.0.1'), 2)).toBe('1.2.3.4');
    expect(clientIp(req('127.0.0.1', 'garbage'), 1)).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', ''), 1)).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', '[2001:db8::1]:443'), 1)).toBe('2001:db8::1');
  });

  it('groups IPv6 clients by /64', () => {
    expect(limitKey('2001:db8:1:2:aaaa::1')).toBe(limitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(limitKey('2001:db8:1:2::1')).not.toBe(limitKey('2001:db8:1:3::1'));
    expect(limitKey('1.2.3.4')).toBe('1.2.3.4');
  });

  it('forgets idle limiter keys', () => {
    const l = new KeyedLimiter(10, 2);
    l.take('a', 0);
    expect(l.size).toBe(1);
    l.gc(1000);
    expect(l.size).toBe(0);
  });

  it('reads the new env vars', () => {
    const cfg = loadConfig({ TRUST_PROXY: '1', MAX_CONNS_PER_IP: '7', MAX_ROOMS_PER_IP: '3', MAX_CONNECTIONS: '99' });
    expect(cfg).toMatchObject({ trustProxy: 1, maxConnsPerIp: 7, maxRoomsPerIp: 3, maxConnections: 99 });
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(1);
    expect(() => loadConfig({ MAX_CONNS_PER_IP: '-1' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Room limits
// ---------------------------------------------------------------------------

describe('room limits', () => {
  it('throttles join attempts per socket (room code guessing)', async () => {
    const { url } = await boot({ limits: { joinBurstPerSocket: 3, joinRatePerSocket: 0.01 } });
    const c = await connect(url);
    await c.hello('Guesser');
    for (let i = 0; i < 3; i++) {
      const p = c.next(isError('NO_ROOM'));
      c.send({ t: 'join_room', code: 'ABCDE' + String(i + 2), name: 'x', avatar: 'mei' });
      await p;
    }
    const p = c.next(isError('RATE_LIMIT'));
    c.send({ t: 'join_room', code: 'ABCDEF', name: 'x', avatar: 'mei' });
    await p;
  });

  it('throttles join attempts per IP across sockets', async () => {
    const { url } = await boot({ limits: { joinBurstPerIp: 2, joinRatePerIp: 0.01 } });
    const guess = async (): Promise<ServerMessage> => {
      const c = await connect(url);
      await c.hello('G');
      const p = c.next((m) => m.t === 'error');
      c.send({ t: 'join_room', code: 'ABCDEF', name: 'x', avatar: 'mei' });
      return p;
    };
    expect(await guess()).toMatchObject({ code: 'NO_ROOM' });
    expect(await guess()).toMatchObject({ code: 'NO_ROOM' });
    expect(await guess()).toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('caps live rooms per creating IP', async () => {
    const { url } = await boot({ maxRoomsPerIp: 2 });
    for (let i = 0; i < 2; i++) {
      const c = await connect(url);
      await c.hello('Maker');
      await createRoom(c);
    }
    const third = await connect(url);
    await third.hello('Maker3');
    const p = third.next(isError('SERVER'));
    third.send({ t: 'create_room', name: 'x', avatar: 'mei' });
    await p;
    // re-creating from a session that already owns a room replaces it (does not count twice)
    const again = clients[0];
    const r = again.next((m) => m.t === 'room');
    again.send({ t: 'create_room', name: 'x', avatar: 'mei' });
    await r;
  });

  it('evicts detached roomless sessions when the store is full, never seated ones', () => {
    const store = new SessionStore(2);
    const seated = store.create('a');
    const idle = store.create('b');
    expect(seated && idle).toBeTruthy();
    seated!.room = 'ABCDEF';
    const fresh = store.create('c');
    expect(fresh).not.toBeNull();
    expect(store.get(seated!.token)).toBe(seated);
    expect(store.get(idle!.token)).toBeUndefined();
    fresh!.room = 'GHJKMN';
    expect(store.create('d')).toBeNull(); // everything left is seated
  });
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

describe('hostile input', () => {
  it('survives malformed, nested, oversized and type-confused messages', async () => {
    const { url, port } = await boot();
    const c = await connect(url);
    await c.hello('Fuzz');
    await createRoom(c);
    const hostile: string[] = [
      '',
      'null',
      '"hello"',
      '{"t":null}',
      '{"t":{"toString":1}}',
      '{"t":"__proto__"}',
      '{"t":"constructor"}',
      '['.repeat(8000) + ']'.repeat(8000),
      '{"a":'.repeat(2500) + '1' + '}'.repeat(2500),
      JSON.stringify({ t: 'remove_seat', seat: -1 }),
      JSON.stringify({ t: 'remove_seat', seat: 1.5 }),
      JSON.stringify({ t: 'remove_seat', seat: '1' }),
      JSON.stringify({ t: 'remove_seat', seat: 1e308 }),
      JSON.stringify({ t: 'action', action: { type: 'CUT', tiles: [1, 2, 3] } }),
      JSON.stringify({ t: 'action', action: { type: 'CUT', tiles: [{ toString: 'x' }] } }),
      JSON.stringify({ t: 'action', action: { type: 'CUT', tiles: new Array(5000).fill(0) } }),
      JSON.stringify({ t: 'action', action: { type: 'PORT', melds: [[['B1_1']]] } }),
      JSON.stringify({ t: 'action', action: { type: 'EXTEND', meldId: 5, low: [], high: [] } }),
      JSON.stringify({ t: 'action', action: { type: 'SWAP_JOKER', meldId: 'm1', jokerTileId: null, withTileId: [] } }),
      JSON.stringify({ t: 'action', action: { type: '__proto__' } }),
      JSON.stringify({ t: 'emote', id: { length: 1 } }),
      JSON.stringify({ t: 'set_avatar', avatar: '../../etc/passwd' }),
      JSON.stringify({ t: 'join_room', code: ['ABCDEF'], name: 'x', avatar: 'mei' }),
      JSON.stringify({ t: 'hello', v: 1, name: 'x', token: '../../' }),
    ];
    for (const text of hostile) {
      expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
      const p = c.next((m) => m.t === 'error');
      c.ws.send(text);
      await expect(p, text.slice(0, 60)).resolves.toBeTruthy();
    }
    // binary frames are rejected too
    const pb = c.next(isError('BAD_MESSAGE'));
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await pb;
    // still alive and serving
    const pong = c.next((m) => m.t === 'pong');
    c.send({ t: 'ping' });
    await pong;
    expect((await httpRequest(port, '/healthz')).status).toBe(200);
  });

  it('closes the socket on frames over the size limit', async () => {
    const { url } = await boot();
    const c = await connect(url);
    c.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'x'.repeat(40_000) }));
    expect(await c.waitClosed()).toBe(1009);
  });

  it('ignores prototype-pollution keys in room config', async () => {
    const raw = '{"t":"create_room","name":"P","avatar":"mei","cfg":{"__proto__":{"players":3,"polluted":true},"constructor":{"prototype":{"polluted":true}},"players":4}}';
    const parsed = parseClientMessage(raw);
    expect(parsed?.t).toBe('create_room');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const { url } = await boot();
    const c = await connect(url);
    await c.hello('Proto');
    const p = c.next((m) => m.t === 'room');
    c.ws.send(raw);
    const room = ((await p) as RoomMsg).room;
    expect(room.cfg.players).toBe(4);
    expect(Object.keys(room.cfg).sort()).toEqual(Object.keys(resolveRules()).sort());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(sanitizeRules(JSON.parse('{"__proto__":{"handSize":99}}')).handSize).toBe(resolveRules().handSize);
  });

  it('strips control, bidi and zero-width characters from names everyone sees', async () => {
    const { url } = await boot();
    const host = await connect(url);
    await host.hello('H');
    const code = (await createRoom(host, `Ev${'\u202e'}il${'\u0007'}\u200b`)).room.code;
    const g = await connect(url);
    await g.hello('G');
    const seen = host.next(isRoom((r) => r.seats[1] !== null));
    g.send({ t: 'join_room', code, name: `\u0000\u0001${'\u2066'}Guest\n\r\t ${'x'.repeat(100)}`, avatar: 'kaya' });
    const room = ((await seen) as RoomMsg).room;
    expect(room.seats[0]?.name).toBe('Evil');
    expect(room.seats[1]?.name.startsWith('Guest x')).toBe(true);
    expect(Array.from(room.seats[1]?.name ?? '').length).toBeLessThanOrEqual(16);
    expect(sanitizeName('\u200b\u200b')).toBe('Player');
  });
});

// ---------------------------------------------------------------------------
// Information leaks
// ---------------------------------------------------------------------------

describe('information leaks', () => {
  it('never sends tokens to other clients and keeps hands and the dead wall private', async () => {
    const { url } = await boot();
    const a = await connect(url);
    const b = await connect(url);
    const wa = await a.hello('Alice');
    const wb = await b.hello('Bob');
    const code = (await createRoom(a, 'Alice', { players: 3 })).room.code;
    const joined = a.next(isRoom((r) => r.seats[1] !== null));
    b.send({ t: 'join_room', code, name: 'Bob', avatar: 'kaya' });
    await joined;
    const ga = a.next(isGame);
    const gb = b.next(isGame);
    a.send({ t: 'start_game' });
    const va = (await ga).view;
    const vb = (await gb).view;
    await sleep(300); // let a few bot moves flow

    for (const raw of a.raw) expect(raw).not.toContain(wb.token);
    for (const raw of b.raw) expect(raw).not.toContain(wa.token);
    for (const c of [a, b]) {
      for (const m of c.inbox) {
        if (m.t === 'room') {
          expect(JSON.stringify(m.room)).not.toMatch(/token/i);
          // seats carry exactly these public fields (no token, no session data)
          for (const s of m.room.seats) if (s) expect(Object.keys(s).sort()).toEqual(['avatar', 'connected', 'host', 'isBot', 'name', 'seat']);
        }
        if (m.t === 'game') {
          const v = m.view as PlayerView & Record<string, unknown>;
          expect(v.deadWall).toBeUndefined();
          expect(v.rng).toBeUndefined();
          for (const p of v.players as unknown as Record<string, unknown>[]) {
            expect(p.hand).toBeUndefined();
            expect(p.pendingPort).toBeUndefined();
          }
        }
      }
    }
    // the other human's initial hand never appears in full
    expect(b.raw.join('')).not.toContain(JSON.stringify(va.hand));
    expect(a.raw.join('')).not.toContain(JSON.stringify(vb.hand));
  });
});

// ---------------------------------------------------------------------------
// Static file hardening
// ---------------------------------------------------------------------------

describe('static files', () => {
  it('sends security headers including a CSP that fits the built client', async () => {
    const { port } = await boot();
    for (const p of ['/', '/assets/app.js', '/missing.png', '/healthz']) {
      const r = await httpRequest(port, p);
      expect(r.headers['x-content-type-options'], p).toBe('nosniff');
      expect(r.headers['referrer-policy'], p).toBe('strict-origin-when-cross-origin');
      expect(r.headers['x-frame-options'], p).toBe('SAMEORIGIN');
      expect(r.headers['content-security-policy'], p).toContain("script-src 'self'");
    }
    const csp = contentSecurityPolicy('rummy.example.com');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain('wss://rummy.example.com');
    expect(csp).not.toContain("'unsafe-eval'");
    // a hostile Host header is not reflected into the policy
    expect(contentSecurityPolicy("evil.com; script-src *")).not.toContain('evil');
  });

  it('allows only GET and HEAD', async () => {
    const { port } = await boot();
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'PATCH']) {
      const r = await httpRequest(port, '/', method);
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
    expect((await httpRequest(port, '/healthz', 'POST')).status).toBe(405);
    const head = await httpRequest(port, '/', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await httpRequest(port, '/healthz', 'HEAD')).body).toBe('');
  });

  it('blocks traversal, dotfiles, drive letters and odd request targets', async () => {
    const { port } = await boot();
    const attempts = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/%252e%252e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/assets%5c..%5c..%5csecret.txt',
      '/%5c%5c127.0.0.1%5cc$%5csecret.txt',
      '/%00/secret.txt',
      '/index.html%00.png',
      '/.env',
      '/assets/.%2e/.%2e/secret.txt',
      '/C:/Windows/win.ini',
      '/c%3a%5cwindows%5cwin.ini',
      '/index.html::$DATA',
      '//secret.txt',
    ];
    for (const p of attempts) {
      const r = await httpRequest(port, p);
      expect(r.body, p).not.toContain(OUTSIDE_MARKER);
      expect(r.body, p).not.toContain('SECRET=1');
    }
    expect((await httpRequest(port, '/.env')).status).toBe(400);
    expect(resolveSafePath(web, '/.git/config')).toBeNull();
    expect(resolveSafePath(web, '/.well-known/x')).not.toBeNull();
  });

  it('does not follow symlinks out of the web root', async () => {
    const link = path.join(web, 'assets', 'leak.txt');
    try {
      fs.symlinkSync(path.join(tmp, 'secret.txt'), link);
    } catch {
      return; // symlinks need extra privileges on Windows; nothing to test then
    }
    try {
      const { port } = await boot();
      const r = await httpRequest(port, '/assets/leak.txt');
      expect(r.status).toBe(404);
      expect(r.body).not.toContain(OUTSIDE_MARKER);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Game flow robustness
// ---------------------------------------------------------------------------

describe('game flow', () => {
  it('host leaving mid-game: seat becomes a bot and the host role transfers', async () => {
    const { url } = await boot();
    const a = await connect(url);
    const b = await connect(url);
    await a.hello('Alice');
    await b.hello('Bob');
    const code = (await createRoom(a, 'Alice', { players: 3 })).room.code;
    const joined = a.next(isRoom((r) => r.seats[1] !== null));
    b.send({ t: 'join_room', code, name: 'Bob', avatar: 'kaya' });
    await joined;
    const started = b.next(isGame);
    a.send({ t: 'start_game' });
    await started;

    // start twice
    let p = a.next(isError('ALREADY_STARTED'));
    a.send({ t: 'start_game' });
    await p;
    // join a started game
    const late = await connect(url);
    await late.hello('Late');
    p = late.next(isError('ALREADY_STARTED'));
    late.send({ t: 'join_room', code, name: 'Late', avatar: 'mei' });
    await p;

    const transferred = b.next(isRoom((r) => r.seats[0]?.isBot === true && r.seats[1]?.host === true));
    a.send({ t: 'leave_room' });
    const room = ((await transferred) as RoomMsg).room;
    expect(room.seats[0]?.host).toBe(false);
    expect(room.seats[0]?.connected).toBe(true);
    // game keeps flowing for Bob (bots act for seat 0 and seat 2)
    await b.next(isGame, 5000);

    // last human leaves: the room is cleaned up
    const left = b.next((m) => m.t === 'left');
    b.send({ t: 'leave_room' });
    await left;
    const probe = await connect(url);
    await probe.hello('Probe');
    p = probe.next(isError('NO_ROOM'));
    probe.send({ t: 'join_room', code, name: 'P', avatar: 'mei' });
    await p;
  });

  it('rejects actions from a seat that is not deciding', async () => {
    const { url } = await boot({ rooms: { hostOptions: { botDelayMs: [1500, 2000] } } });
    const a = await connect(url);
    await a.hello('Alice');
    await createRoom(a, 'Alice', { players: 3, instantWins: false, portTimerMs: 5000, turnTimerMs: 5000 });
    const g = a.next(isGame);
    a.send({ t: 'start_game' });
    let view = (await g).view;
    // Wait for a bot's turn; when the decision is ours, end the turn (or let the timer run out).
    while (!(view.phase === 'PLAY' && view.legal === null && view.turn !== view.you)) {
      if (view.phase === 'PLAY' && view.legal?.canEndTurn) a.send({ t: 'action', action: { type: 'END_TURN' } });
      view = ((await a.next(isGame, 15_000)) as GameMsg).view;
    }
    const p = a.next(isError('ILLEGAL'));
    a.send({ t: 'action', action: { type: 'END_TURN' } });
    await p;
    const p2 = a.next(isError('ILLEGAL'));
    a.send({ t: 'action', action: { type: 'CUT', tiles: [view.hand[0]] } });
    await p2;
  }, 40_000);

  it('after MATCH_END: actions and restarts are refused, resume works, leaving frees the room', async () => {
    const sessions = new SessionStore();
    const sent: { token: string; msg: ServerMessage }[] = [];
    const rooms = new RoomManager(sessions, (s, msg) => sent.push({ token: s.token, msg }), {
      maxRooms: 5,
      maxRoomsPerIp: 5,
      hostOptions: { botDelayMs: [0, 0] },
    });
    const host = sessions.create('Host')!;
    host.ip = '10.0.0.1';
    // host never attaches a socket: the game autoplays the seat like any disconnected human
    expect(rooms.create(host, 'Host', 'mei', sanitizeRules({ players: 3, handsPerMatch: 1, handEndDelayMs: 2000 }), 'easy').ok).toBe(true);
    expect(rooms.start(host).ok).toBe(true);
    const ended = await new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const done = sent.some((x) => x.msg.t === 'game' && x.msg.view.phase === 'MATCH_END');
        if (done || Date.now() - t0 > 20_000) {
          clearInterval(iv);
          resolve(done);
        }
      }, 50);
    });
    expect(ended).toBe(true);
    const gm = sent.find((x) => x.msg.t === 'game')!.msg as GameMsg;
    expect(typeof gm.serverNow).toBe('number');

    expect(rooms.action(host, { type: 'END_TURN' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    expect(rooms.action(host, { type: 'PORT', melds: [['B1_1', 'B2_1', 'B3_1']] })).toMatchObject({ ok: false, code: 'ILLEGAL' });
    expect(rooms.start(host)).toMatchObject({ ok: false, code: 'ALREADY_STARTED' });
    const other = sessions.create('Other')!;
    expect(rooms.join(other, host.room!, 'Other', 'kaya')).toMatchObject({ ok: false, code: 'ALREADY_STARTED' });

    // resume (reconnect with token) gets the room and the final view
    sent.length = 0;
    rooms.resume(host);
    expect(sent.some((x) => x.msg.t === 'room' && x.msg.room.started)).toBe(true);
    expect(sent.some((x) => x.msg.t === 'game' && x.msg.view.phase === 'MATCH_END' && x.msg.view.standings !== null)).toBe(true);

    // leaving frees the room, and a new one can be created
    expect(rooms.leave(host, true).ok).toBe(true);
    expect(rooms.roomCount).toBe(0);
    expect(rooms.create(host, 'Host', 'mei', sanitizeRules({}), 'easy').ok).toBe(true);
    rooms.disposeAll();
  }, 30_000);

  it('a kicked player can join the room again', async () => {
    const { url } = await boot();
    const host = await connect(url);
    await host.hello('Host');
    const code = (await createRoom(host)).room.code;
    const g = await connect(url);
    await g.hello('Guest');
    let seen = host.next(isRoom((r) => r.seats[1] !== null));
    g.send({ t: 'join_room', code, name: 'Guest', avatar: 'kaya' });
    await seen;
    const kicked = g.next((m) => m.t === 'left');
    host.send({ t: 'remove_seat', seat: 1 });
    await kicked;
    seen = g.next(isRoom((r) => r.you >= 0));
    g.send({ t: 'join_room', code, name: 'Guest', avatar: 'kaya' });
    await seen;
  });
});
