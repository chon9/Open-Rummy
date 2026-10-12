import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type PlayerView, type ServerMessage } from '@open-rummy/shared';
import { startServer, type RunningServer } from '../src/app';
import { normaliseRoomCode, parseClientMessage, sanitizeName, sanitizeRules } from '../src/session';
import { resolveSafePath } from '../src/static';
import { Client, httpGet, isError, isGame, isRoom } from './helpers';


// ---------------------------------------------------------------------------
// Fixture: temp web root with a secret file next to (outside) it
// ---------------------------------------------------------------------------

let server: RunningServer;
let tmp: string;
let wsUrl: string;
const clients: Client[] = [];
const OUTSIDE_MARKER = 'TOP-OUTSIDE_MARKER-OUTSIDE-WEBROOT';

async function connect(origin?: string): Promise<Client> {
  const c = new Client(wsUrl, origin ? { origin } : undefined);
  clients.push(c);
  await c.open();
  return c;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-rummy-test-'));
  const web = path.join(tmp, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(web, 'avatars'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Open Rummy</title>');
  fs.writeFileSync(path.join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(web, 'avatars', 'mei.vrm'), Buffer.from([0x67, 0x6c, 0x54, 0x46]));
  fs.writeFileSync(path.join(tmp, 'secret.txt'), OUTSIDE_MARKER);

  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    webRoot: web,
    maxRooms: 10,
    allowedOrigins: ['http://allowed.example'],
    production: false,
    quiet: true,
    // every test client connects from 127.0.0.1: the per-IP limits are exercised in security.test.ts
    maxConnsPerIp: 1000,
    maxRoomsPerIp: 1000,
    limits: { connBurst: 1000, joinBurstPerSocket: 1000, joinBurstPerIp: 1000 },
    rooms: { lobbyGraceMs: 200, hostOptions: { botDelayMs: [50, 100] } },
  });
  wsUrl = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('http', () => {
  it('serves /healthz', async () => {
    const r = await httpGet(server.port, '/healthz');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { ok: boolean; rooms: number; players: number; uptime: number };
    expect(body.ok).toBe(true);
    expect(typeof body.rooms).toBe('number');
    expect(typeof body.players).toBe('number');
    expect(typeof body.uptime).toBe('number');
  });

  it('serves static files with MIME types and caching', async () => {
    const idx = await httpGet(server.port, '/');
    expect(idx.status).toBe(200);
    expect(idx.headers['content-type']).toMatch(/text\/html/);
    const js = await httpGet(server.port, '/assets/app-abc123.js');
    expect(js.headers['content-type']).toMatch(/text\/javascript/);
    expect(js.headers['cache-control']).toContain('immutable');
    const vrm = await httpGet(server.port, '/avatars/mei.vrm');
    expect(vrm.status).toBe(200);
    expect(vrm.headers['content-type']).toBe('model/gltf-binary');
  });

  it('falls back to index.html for SPA routes but 404s missing files', async () => {
    const spa = await httpGet(server.port, '/lobby/room');
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('Open Rummy');
    expect((await httpGet(server.port, '/missing.png')).status).toBe(404);
    expect((await httpGet(server.port, '/assets/missing.js')).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%00index.html', '/%E0%A4%A']) {
      const r = await httpGet(server.port, p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain(OUTSIDE_MARKER);
    }
    expect(resolveSafePath('/root', '/a/../../b')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

describe('websocket', () => {
  it('rejects disallowed origins and unknown paths', async () => {
    const bad = new WebSocket(wsUrl, { origin: 'http://evil.example' });
    await expect(new Promise((res, rej) => (bad.once('open', res), bad.once('error', rej)))).rejects.toThrow(/403/);
    const wrong = new WebSocket(`ws://127.0.0.1:${server.port}/nope`);
    await expect(new Promise((res, rej) => (wrong.once('open', res), wrong.once('error', rej)))).rejects.toThrow(/404/);
    const ok = await connect('http://allowed.example');
    expect((await ok.hello('Origin')).t).toBe('welcome');
  });

  it('validates messages and requires hello', async () => {
    const c = await connect();
    let p = c.next(isError('BAD_MESSAGE'));
    c.send({ t: 'add_bot' });
    await p;
    p = c.next(isError('BAD_MESSAGE'));
    c.ws.send('{not json');
    await p;
    await c.hello('Val');
    p = c.next(isError('BAD_MESSAGE'));
    c.send({ t: 'join_room', code: 'O0I1L!', name: 'x', avatar: 'mei' });
    await p;
    p = c.next(isError('NO_ROOM'));
    c.send({ t: 'join_room', code: 'abcdef', name: 'x', avatar: 'mei' });
    await p;
    p = c.next(isError('NOT_IN_ROOM'));
    c.send({ t: 'action', action: { type: 'END_TURN' } });
    await p;
  });

  it('rate limits floods', async () => {
    const c = await connect();
    await c.hello('Flood');
    const p = c.next(isError('RATE_LIMIT'));
    for (let i = 0; i < 60; i++) c.send({ t: 'ping' });
    await p;
  });

  it('plays a room: create, join, bots, start, private views, illegal action, resume', async () => {
    const a = await connect();
    const b = await connect();
    const welcomeA = await a.hello('Alice');
    await b.hello('Bob');
    expect(welcomeA.resumed).toBe(false);
    expect(welcomeA.token.length).toBeGreaterThanOrEqual(16);

    // create
    const roomA = a.next((m) => m.t === 'room');
    a.send({ t: 'create_room', name: 'Alice', avatar: 'mei', cfg: { players: 4, turnTimerMs: 1, foo: 'bar' }, botLevel: 'easy' });
    const created = (await roomA) as Extract<ServerMessage, { t: 'room' }>;
    const code = created.room.code;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(created.room.you).toBe(0);
    expect(created.room.seats[0]?.host).toBe(true);
    expect(created.room.cfg.turnTimerMs).toBe(5000); // clamped
    expect((created.room.cfg as unknown as Record<string, unknown>).foo).toBeUndefined();

    // join (lowercase code is accepted)
    const joinedB = b.next(isRoom((r) => r.you === 1));
    b.send({ t: 'join_room', code: code.toLowerCase(), name: 'Bob', avatar: 'kaya' });
    await joinedB;

    // only the host can add bots / start
    let p = b.next(isError('NOT_HOST'));
    b.send({ t: 'add_bot' });
    await p;
    const withBot = a.next(isRoom((r) => r.seats.filter((s) => s?.isBot).length === 1));
    a.send({ t: 'add_bot' });
    await withBot;

    // start: the remaining seat is filled with a bot; both humans get their own view
    const roomStartedB = b.next(isRoom((r) => r.started));
    const gameA = a.next(isGame);
    const gameB = b.next(isGame);
    a.send({ t: 'start_game' });
    const started = (await roomStartedB) as Extract<ServerMessage, { t: 'room' }>;
    expect(started.room.seats.every((s) => s !== null)).toBe(true);
    expect(started.room.seats.filter((s) => s?.isBot).length).toBe(2);
    const firstGameA = (await gameA) as Extract<ServerMessage, { t: 'game' }>;
    // serverNow lets clients correct deadline countdowns for clock skew
    expect(typeof firstGameA.serverNow).toBe('number');
    expect(Math.abs(firstGameA.serverNow - Date.now())).toBeLessThan(5000);
    const va = firstGameA.view;
    const vb = ((await gameB) as Extract<ServerMessage, { t: 'game' }>).view;
    expect(va.you).toBe(0);
    expect(vb.you).toBe(1);
    expect(va.hand.length).toBeGreaterThan(0);
    expect(vb.hand.length).toBeGreaterThan(0);
    // hands are private: disjoint, and nobody else's hand is revealed
    expect(va.hand.filter((t) => vb.hand.includes(t))).toEqual([]);
    for (const v of [va, vb]) for (const pl of v.players) if (pl.seat !== v.you) expect(pl.revealed).toBeNull();
    // DEAL events only carry tiles for the receiving seat
    for (const msg of a.inbox.filter(isGame)) {
      for (const ev of msg.events) if (ev.type === 'DEAL' && ev.seat !== 0) expect(ev.tiles).toBeUndefined();
    }
    expect(JSON.stringify(a.inbox)).not.toContain(JSON.stringify(vb.hand));

    // no more lobby actions
    p = a.next(isError('ALREADY_STARTED'));
    a.send({ t: 'add_bot' });
    await p;

    // illegal action -> ILLEGAL
    p = a.next(isError('ILLEGAL'));
    a.send({ t: 'action', action: { type: 'SWAP_JOKER', meldId: 'm999', jokerTileId: 'JK1', withTileId: 'B5a' } });
    await p;
    // malformed action -> BAD_MESSAGE
    p = a.next(isError('BAD_MESSAGE'));
    a.send({ t: 'action', action: { type: 'CUT', tiles: 'B5a' } });
    await p;

    // emote broadcast
    const emoteB = b.next((m) => m.t === 'emote' && m.seat === 0 && m.id === 'wave');
    a.send({ t: 'emote', id: 'wave' });
    await emoteB;

    // disconnect A: B sees seat 0 disconnected
    const seesDrop = b.next(isRoom((r) => r.seats[0]?.connected === false));
    await a.close();
    await seesDrop;

    // resume with the token: same seat, room then game view
    const a2 = await connect();
    const roomAgain = a2.next((m) => m.t === 'room');
    const gameAgain = a2.next(isGame);
    const w2 = await a2.hello('Alice', welcomeA.token);
    expect(w2.resumed).toBe(true);
    expect(w2.token).toBe(welcomeA.token);
    const r2 = (await roomAgain) as Extract<ServerMessage, { t: 'room' }>;
    expect(r2.room.you).toBe(0);
    expect(r2.room.started).toBe(true);
    expect(r2.room.seats[0]?.connected).toBe(true);
    const g2 = ((await gameAgain) as Extract<ServerMessage, { t: 'game' }>).view as PlayerView;
    expect(g2.you).toBe(0);
    expect(g2.hand.length).toBeGreaterThan(0);
    expect(g2.players[0].connected).toBe(true);

    // healthz counts the room
    const h = JSON.parse((await httpGet(server.port, '/healthz')).body) as { rooms: number; players: number };
    expect(h.rooms).toBeGreaterThanOrEqual(1);
    expect(h.players).toBeGreaterThanOrEqual(2);

    // leaving after start converts the seat to a bot
    const left = b.next((m) => m.t === 'left');
    const aSeesBot = a2.next(isRoom((r) => r.seats[1]?.isBot === true));
    b.send({ t: 'leave_room' });
    await left;
    await aSeesBot;
  });

  it('frees a lobby seat after the grace period when a player drops', async () => {
    const host = await connect();
    await host.hello('Host');
    const created = host.next((m) => m.t === 'room');
    host.send({ t: 'create_room', name: 'Host', avatar: 'mei' });
    const code = ((await created) as Extract<ServerMessage, { t: 'room' }>).room.code;
    const guest = await connect();
    await guest.hello('Guest');
    const joined = host.next(isRoom((r) => r.seats[1] !== null));
    guest.send({ t: 'join_room', code, name: 'Guest', avatar: 'kaya' });
    await joined;
    const freed = host.next(isRoom((r) => r.seats[1] === null));
    await guest.close();
    await freed;
  });

  it('routes restart_room: refused in the lobby and for non-hosts (full flow in restart.test.ts)', async () => {
    const host = await connect();
    await host.hello('Host');
    const created = host.next((m) => m.t === 'room');
    host.send({ t: 'create_room', name: 'Host', avatar: 'mei' });
    const code = ((await created) as Extract<ServerMessage, { t: 'room' }>).room.code;
    const guest = await connect();
    await guest.hello('Guest');
    const joined = guest.next(isRoom((r) => r.you === 1));
    guest.send({ t: 'join_room', code, name: 'Guest', avatar: 'kaya' });
    await joined;
    let p = guest.next(isError('NOT_HOST'));
    guest.send({ t: 'restart_room' });
    await p;
    p = host.next(isError('ILLEGAL'));
    host.send({ t: 'restart_room' });
    await p;
    await guest.close();
    await host.close();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('validation helpers', () => {
  it('sanitizes names and room codes', () => {
    expect(sanitizeName(`  Ah${String.fromCharCode(0)}  Beng${String.fromCharCode(0x202e)} `)).toBe('Ah Beng');
    expect(sanitizeName('x'.repeat(100)).length).toBe(16);
    expect(sanitizeName(42)).toBe('Player');
    expect(normaliseRoomCode('abc234')).toBe('ABC234');
    expect(normaliseRoomCode('ABCDE0')).toBeNull();
    expect(normaliseRoomCode('ABCDEFG')).toBeNull();
  });

  it('bounds rule config', () => {
    const cfg = sanitizeRules({ players: 99, jokers: -5, handSize: 'x', portTiming: 'weird', payoutLadder: [1, 2], aceHigh: false });
    expect(cfg.players).toBe(5);
    expect(cfg.jokers).toBe(0);
    expect(cfg.handSize).toBe(20);
    expect(cfg.portTiming).toBe('simultaneous');
    expect(cfg.payoutLadder).toEqual([3, 6, 9, 12]);
    expect(cfg.aceHigh).toBe(false);
  });

  it('rejects oversized and malformed messages', () => {
    expect(parseClientMessage('x'.repeat(20000))).toBeNull();
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, name: 'a', token: 'short' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'action', action: { type: 'PORT', melds: [Array(50).fill('B1a')] } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'emote', id: 'nope' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'action', action: { type: 'END_TURN', extra: 1 } }))).toEqual({
      t: 'action',
      action: { type: 'END_TURN' },
    });
  });
});
