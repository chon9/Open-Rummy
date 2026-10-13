/**
 * Steam P2P transports end to end over the in-memory mock Steam (node, no DOM):
 * a host + 2 guests (+ 1 bot) play complete matches, every human seat driven by the
 * shared bot brain acting on the view it RECEIVED (guests send their actions over P2P).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameHost,
  PROTOCOL_VERSION,
  chooseBotAction,
  type Action,
  type PlayerView,
  type RoomInfo,
  type RulesConfig,
} from '@open-rummy/shared';
import { createMockSteamNetwork } from '../mockDesktop';
import { DESKTOP_LIMITS, LOBBY_GAME_TAG, LOBBY_KEYS, type LobbyEvent, type MockSteamNetwork, type OpenRummyDesktopBridge } from '../desktopBridge';
import { SteamHostTransport } from './hostTransport';
import { SteamGuestTransport, type HostLeftReason } from './guestTransport';
import { parseGuestMessage, parseHostMessage } from './validate';
import type { Transport } from '../transport';

// Fast, short matches: 2 hands, no pause between hands, generous decision timers as a safety net.
const FAST_RULES: Partial<RulesConfig> = { players: 4, handsPerMatch: 2, handEndDelayMs: 0, portTimerMs: 4000, turnTimerMs: 4000, instantTimerMs: 3000 };

/** The same fallbacks GameHost uses when a bot's first choice is rejected. */
function fallbackActions(view: PlayerView): Action[] {
  const legal = view.legal;
  if (!legal) return [];
  if (view.phase === 'INSTANT') return [{ type: 'DECLARE_INSTANT', declare: true }];
  const me = view.players[view.you];
  if (me && !me.ported) return legal.portCandidates.slice(0, 3).map((m) => ({ type: 'PORT', melds: [m] }));
  const out: Action[] = [];
  for (const e of legal.extends.slice(0, 3)) out.push({ type: 'EXTEND', ...e });
  for (const c of legal.cuts.slice(0, 3)) out.push({ type: 'CUT', tiles: c });
  for (const f of legal.follows.slice(0, 3)) out.push({ type: 'FOLLOW_CUT', ...f });
  for (const r of legal.newRuns.slice(0, 3)) out.push({ type: 'NEW_RUN', tiles: r });
  if (legal.canEndTurn) out.push({ type: 'END_TURN' });
  return out;
}

/** Simultaneous decisions keep one key while others answer (as GameHost.decisionKey). */
function decisionKey(v: PlayerView): string {
  if (v.phase === 'INSTANT' || (v.phase === 'PORT' && v.turn === null)) return `${v.handNo}:${v.phase}`;
  return `v${v.version}`;
}

interface Driver {
  views: PlayerView[];
  rooms: RoomInfo[];
  errors: string[];
  notices: string[];
  emotes: [number, string][];
  /** stop acting (e.g. after leaving) */
  stopped: boolean;
  last(): PlayerView | undefined;
}

/** Wire a transport to a "player" that plays its received views with the bot brain. */
function drive(transport: Transport, opts: { act?: boolean; seed?: number } = {}): Driver {
  let seed = opts.seed ?? 1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const d: Driver = {
    views: [],
    rooms: [],
    errors: [],
    notices: [],
    emotes: [],
    stopped: false,
    last: () => d.views[d.views.length - 1],
  };
  let actedKey = '';
  let candidates: Action[] = [];
  const next = (): void => {
    const a = candidates.shift();
    if (a && !d.stopped) transport.send(a);
  };
  transport.setHandlers({
    onGame(view) {
      d.views.push(view);
      if (opts.act === false || d.stopped || !view.legal) return;
      const key = decisionKey(view);
      if (key === actedKey) return;
      actedKey = key;
      const chosen = chooseBotAction(view, 'normal', rand);
      candidates = [...(chosen ? [chosen] : []), ...fallbackActions(view)];
      next();
    },
    onRoom: (room) => d.rooms.push(room),
    onEmote: (seat, id) => d.emotes.push([seat, id]),
    onError(msg) {
      d.errors.push(msg);
      // our pick was refused: try the next candidate while the decision is still ours
      const v = d.last();
      if (v?.legal && decisionKey(v) === actedKey) next();
    },
    onNotice: (text) => d.notices.push(text),
  });
  return d;
}

/** Record every raw payload a bridge receives (what actually crossed the wire). */
function tap(bridge: OpenRummyDesktopBridge): { from: string; data: string }[] {
  const log: { from: string; data: string }[] = [];
  bridge.steam.onMessage((from, data) => log.push({ from, data }));
  return log;
}

async function waitFor(cond: () => boolean, ms = 60_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Public part of a view: identical for every seat at the same version. */
function publicState(v: PlayerView): string {
  return JSON.stringify({
    phase: v.phase,
    handNo: v.handNo,
    dealer: v.dealer,
    firstSeat: v.firstSeat,
    wallBreak: v.wallBreak,
    turn: v.turn,
    players: v.players,
    melds: v.melds,
    deadWallCount: v.deadWallCount,
    lastResult: v.lastResult,
    standings: v.standings,
    version: v.version,
  });
}

interface Table {
  net: MockSteamNetwork;
  host: SteamHostTransport;
  guests: SteamGuestTransport[];
  hostDriver: Driver;
  guestDrivers: Driver[];
  hostLeft: (HostLeftReason | null)[];
  rejected: (string | null)[];
  wires: { from: string; data: string }[][];
  /** deliver a lobby event to the HOST transport only (e.g. a P2P failure Steam reports) */
  hostEvent(evt: LobbyEvent): void;
}

const open: Transport[] = [];

async function setupTable(opts: { guests?: number; cfg?: Partial<RulesConfig>; relaxed?: boolean; act?: boolean; users?: number } = {}): Promise<Table> {
  const guestCount = opts.guests ?? 2;
  const net = createMockSteamNetwork(opts.users ?? guestCount + 1);
  const [rawHb, ...gbs] = net.bridges;
  // the host's bridge, with a hook to inject lobby events only the host sees
  const hostListeners: ((evt: LobbyEvent) => void)[] = [];
  const hb: OpenRummyDesktopBridge = {
    ...rawHb,
    steam: {
      ...rawHb.steam,
      onLobbyEvent(cb) {
        hostListeners.push(cb);
        return rawHb.steam.onLobbyEvent(cb);
      },
    },
  };
  const self = await hb.steam.me();
  const created = await hb.steam.createLobby({ visibility: 'public', maxMembers: DESKTOP_LIMITS.maxLobbyMembers });
  if (!self || !created.ok) throw new Error('mock lobby create failed');
  const host = new SteamHostTransport({
    bridge: hb,
    self,
    lobby: created.value,
    name: 'Host',
    avatar: 'mei',
    cfg: opts.cfg ?? FAST_RULES,
    botLevel: 'normal',
    relaxed: opts.relaxed ?? false,
    hostOptions: { botDelayMs: [0, 0] },
    seed: 12345,
    keepalive: false,
  });
  open.push(host);
  const hostDriver = drive(host, { act: opts.act, seed: 7 });
  const guests: SteamGuestTransport[] = [];
  const guestDrivers: Driver[] = [];
  const hostLeft: (HostLeftReason | null)[] = [];
  const rejected: (string | null)[] = [];
  const wires: { from: string; data: string }[][] = [];
  for (let i = 0; i < guestCount; i++) {
    const b = gbs[i];
    wires.push(tap(b));
    const me = await b.steam.me();
    const joined = await b.steam.joinLobby(created.value.lobbyId);
    if (!me || !joined.ok) throw new Error('mock lobby join failed');
    const g = new SteamGuestTransport({ bridge: b, self: me, lobby: joined.value, name: `Guest ${i + 1}`, avatar: i === 0 ? 'shino' : 'twist', keepalive: false });
    open.push(g);
    hostLeft.push(null);
    rejected.push(null);
    g.setEvents({ onHostLeft: (r) => (hostLeft[i] = r), onRejected: (code) => (rejected[i] = code) });
    guests.push(g);
    guestDrivers.push(drive(g, { act: opts.act, seed: 100 + i }));
  }
  await waitFor(() => host.room().seats.filter((s) => s && !s.isBot).length === guestCount + 1, 5000, 'guests seated');
  await net.flush();
  return { net, host, guests, hostDriver, guestDrivers, hostLeft, rejected, wires, hostEvent: (evt) => hostListeners.forEach((cb) => cb(evt)) };
}

afterEach(() => {
  for (const t of open.splice(0)) t.dispose();
  vi.restoreAllMocks();
});

describe('mock Steam network', () => {
  it('lists only public, tagged, joinable lobbies and wires lobby events', async () => {
    const net = createMockSteamNetwork(3);
    const [a, b, c] = net.bridges;
    const pub = await a.steam.createLobby({ visibility: 'public', data: { [LOBBY_KEYS.hostName]: 'A', [LOBBY_KEYS.seats]: '1/4' } });
    await b.steam.createLobby({ visibility: 'friends' });
    expect(pub.ok).toBe(true);
    const list = await c.steam.listLobbies();
    expect(list.ok && list.value.map((l) => [l.hostName, l.seatsTaken, l.seatsTotal, l.data[LOBBY_KEYS.game]])).toEqual([['A', 1, 4, LOBBY_GAME_TAG]]);

    const events: string[] = [];
    a.steam.onLobbyEvent((e) => events.push(e.type));
    const id = pub.ok ? pub.value.lobbyId : '';
    expect((await c.steam.joinLobby(id)).ok).toBe(true);
    await net.flush();
    expect(events).toContain('member-joined');
    // P2P only between members, payload cap enforced
    expect((await c.steam.sendTo(a.steam ? (await a.steam.me())!.steamId : '', 'x'.repeat(70_000))).ok).toBe(false);
    expect((await b.steam.sendTo((await a.steam.me())!.steamId, 'hi')).ok).toBe(false);
    net.requestJoin((await b.steam.me())!.steamId, id);
    expect(await b.steam.consumePendingJoin()).toEqual({ lobbyId: id });
    expect(await b.steam.consumePendingJoin()).toBeNull();
  });

  it('reports Steam unavailable without throwing', async () => {
    const net = createMockSteamNetwork(1, { unavailable: true });
    const s = net.bridges[0].steam;
    expect((await s.available()).ok).toBe(false);
    expect(await s.me()).toBeNull();
    expect(await s.createLobby()).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('Steam P2P validation', () => {
  it('accepts only the guest envelopes and sanitises them', () => {
    expect(parseGuestMessage(JSON.stringify({ t: 'hello', v: 1, name: '  A​B  ', token: 'abcdefghijklmnop0123' }))).toEqual({ t: 'hello', v: 1, name: 'AB' }); // check-secrets: allow (fake test token)
    // same rules as the WebSocket server (shared parseClientMessage): a malformed token refuses the hello
    expect(parseGuestMessage(JSON.stringify({ t: 'hello', v: 1, name: 'A', token: 'x' }))).toBeNull();
    expect(parseGuestMessage(JSON.stringify({ t: 'action', action: { type: 'END_TURN', extra: 1 }, seat: 0 }))).toEqual({ t: 'action', action: { type: 'END_TURN' } });
    for (const bad of [
      'not json',
      JSON.stringify({ t: 'start_game' }),
      JSON.stringify({ t: 'add_bot' }),
      JSON.stringify({ t: 'restart_room' }),
      JSON.stringify({ t: 'action', action: { type: 'PORT', melds: [] } }),
      JSON.stringify({ t: 'emote', id: 'rickroll' }),
      JSON.stringify({ t: 'set_avatar', avatar: '../../etc' }),
      JSON.stringify({ t: 'ping', pad: 'x'.repeat(17_000) }),
      JSON.stringify([1, 2]),
    ]) {
      expect(parseGuestMessage(bad)).toBeNull();
    }
  });

  it('rejects malformed host messages', () => {
    expect(parseHostMessage(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' });
    expect(parseHostMessage(JSON.stringify({ t: 'game', view: { you: 'x' }, events: [] }))).toBeNull();
    expect(parseHostMessage(JSON.stringify({ t: 'emote', seat: 1, id: 'nope' }))).toBeNull();
    expect(parseHostMessage('{"t":"pong"' + ' '.repeat(70_000) + '}')).toBeNull();
  });
});

describe('Steam P2P match (host + 2 guests + 1 bot)', () => {
  it('plays a complete match: private hands, converging public state, MATCH_END everywhere', async () => {
    const tbl = await setupTable();
    const { host, guests, hostDriver, guestDrivers, wires } = tbl;
    const room = host.room();
    expect(room.seats.map((s) => (s ? (s.host ? 'host' : s.isBot ? 'bot' : 'guest') : null))).toEqual(['host', 'guest', 'guest', null]);
    expect(host.timersEnabled).toBe(true);
    expect(guests.every((g) => g.timersEnabled)).toBe(true);

    host.start();
    await waitFor(
      () => [hostDriver, ...guestDrivers].every((d) => d.last()?.phase === 'MATCH_END'),
      90_000,
      'MATCH_END on every client',
    );

    // seats: host 0, joiners 1..2, bot 3
    const final = hostDriver.last()!;
    expect(final.players.map((p) => p.isBot)).toEqual([false, false, false, true]);
    expect(final.handNo).toBe(2);
    expect(final.standings?.length).toBe(4);
    expect(guests.map((g) => g.seat)).toEqual([1, 2]);
    // guests really played: some of their actions were accepted by the host
    expect(host.stats.accepted).toBeGreaterThan(4);

    // each guest only ever received ITS OWN view, from the owner, never another hand
    const owner = (await tbl.net.bridges[0].steam.me())!.steamId;
    const handsByVersion = new Map<number, string[][]>();
    for (const v of hostDriver.views) handsByVersion.set(v.version, [v.hand]);
    wires.forEach((log, i) => {
      const games = log.map((m) => ({ from: m.from, msg: JSON.parse(m.data) })).filter((m) => m.msg.t === 'game');
      expect(games.length).toBeGreaterThan(10);
      for (const { from, msg } of games) {
        expect(from).toBe(owner);
        expect(msg.view.you).toBe(i + 1);
        expect(typeof msg.serverNow).toBe('number');
        for (const p of msg.view.players) expect(p).not.toHaveProperty('hand');
        const list = handsByVersion.get(msg.view.version) ?? [];
        list.push(msg.view.hand);
        handsByVersion.set(msg.view.version, list);
      }
    });
    // hands seen at the same version never share a tile
    let compared = 0;
    for (const hands of handsByVersion.values()) {
      const all = hands.flat();
      expect(new Set(all).size).toBe(all.length);
      if (hands.length > 1) compared++;
    }
    expect(compared).toBeGreaterThan(10);

    // every client converges to the same public state at every version
    const byVersion = new Map<number, string>();
    let checked = 0;
    for (const d of [hostDriver, ...guestDrivers]) {
      for (const v of d.views) {
        const pub = publicState(v);
        const seen = byVersion.get(v.version);
        if (seen === undefined) byVersion.set(v.version, pub);
        else {
          expect(pub).toBe(seen);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(publicState(guestDrivers[0].last()!)).toBe(publicState(final));
    expect(publicState(guestDrivers[1].last()!)).toBe(publicState(final));
  }, 120_000);

  it('rejects malformed, oversized, spoofed and wrong-seat messages', async () => {
    // 3 seats so a 4th Steam member cannot get one; relaxed + passive players so nothing moves on its own
    const tbl = await setupTable({ cfg: { ...FAST_RULES, players: 3 }, relaxed: true, act: false, users: 4 });
    const { net, host, guests, guestDrivers } = tbl;
    const [hb, g1b, g2b, outsider] = net.bridges;
    const hostId = (await hb.steam.me())!.steamId;
    const g1Id = (await g1b.steam.me())!.steamId;
    expect(guests[0].timersEnabled).toBe(false); // relaxed mode reaches the guests

    // a lobby member without a seat: hello refused (table full), later actions refused too
    const outsiderId = (await outsider.steam.me())!.steamId;
    const outLog = tap(outsider);
    expect((await outsider.steam.joinLobby(host.lobby)).ok).toBe(true);
    await net.flush();
    await outsider.steam.sendTo(hostId, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Late' }));
    await net.flush();

    const submit = vi.spyOn(GameHost.prototype, 'submit');
    host.start();
    await waitFor(() => guestDrivers.every((d) => d.views.length > 0), 5000, 'first views');
    const before = host.stats.rejected;

    // malformed / oversized / not allowed from a guest
    await g1b.steam.sendTo(hostId, 'not json');
    await g1b.steam.sendTo(hostId, JSON.stringify({ t: 'ping', pad: 'x'.repeat(20_000) }));
    await g1b.steam.sendTo(hostId, JSON.stringify({ t: 'start_game' }));
    await g1b.steam.sendTo(hostId, JSON.stringify({ t: 'restart_room' }));
    await g1b.steam.sendTo(hostId, JSON.stringify({ t: 'action', action: { type: 'PORT', melds: 'all' } }));
    await net.flush();
    expect(host.stats.rejected - before).toBe(5);

    // a guest claiming another seat: the action is applied to ITS OWN seat (1) and refused there
    const errorsBefore = guestDrivers[0].errors.length;
    await g1b.steam.sendTo(hostId, JSON.stringify({ t: 'action', seat: 0, action: { type: 'END_TURN' } }));
    await net.flush();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toBe(1);
    expect(guestDrivers[0].errors.length).toBe(errorsBefore + 1);
    expect(host.stats.rejected - before).toBe(6);

    await outsider.steam.sendTo(hostId, JSON.stringify({ t: 'action', action: { type: 'END_TURN' } }));
    await net.flush();
    const outMsgs = outLog.map((m) => JSON.parse(m.data));
    expect(outMsgs.map((m) => m.code)).toEqual(['ROOM_FULL', 'NOT_IN_ROOM']);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(host.room().seats.some((s) => s?.name === 'Late')).toBe(false);

    // spoofed host traffic: a non-owner member sends a fake view to a guest -> dropped
    const g1Views = guestDrivers[0].views.length;
    const fakeView = { ...guestDrivers[1].last()!, you: 1, hand: ['RA_1'] };
    await g2b.steam.sendTo(g1Id, JSON.stringify({ t: 'game', view: fakeView, events: [], serverNow: Date.now() }));
    await outsider.steam.sendTo(g1Id, JSON.stringify({ t: 'left' }));
    await net.flush();
    expect(guests[0].stats.rejected).toBe(2);
    expect(guestDrivers[0].views.length).toBe(g1Views);
    expect(tbl.hostLeft[0]).toBeNull();
    expect(guests[0].active).toBe(true);
    expect(outsiderId).not.toBe(hostId);
  }, 30_000);

  it('a guest leaving mid-game becomes a bot and the match still completes', async () => {
    const tbl = await setupTable();
    const { host, guests, hostDriver, guestDrivers } = tbl;
    host.start();
    await waitFor(() => (guestDrivers[1].last()?.version ?? 0) > 8, 20_000, 'game under way');
    guestDrivers[1].stopped = true;
    guests[1].leave();
    await waitFor(() => host.room().seats[2]?.isBot === true, 5000, 'seat 2 taken over by a bot');
    expect(hostDriver.notices.join(' ')).toMatch(/Guest 2/);
    await waitFor(() => hostDriver.last()?.phase === 'MATCH_END' && guestDrivers[0].last()?.phase === 'MATCH_END', 90_000, 'MATCH_END');
    const final = hostDriver.last()!;
    expect(final.players[2].isBot).toBe(true);
    expect(final.players[2].name).toContain('Guest 2');
    // the remaining guest heard about it too
    expect(guestDrivers[0].notices.join(' ')).toMatch(/Guest 2/);
    expect(tbl.hostLeft).toEqual([null, null]);
  }, 120_000);

  it('host leaving surfaces "host left" to every guest', async () => {
    const tbl = await setupTable({ relaxed: true, act: false });
    tbl.host.start();
    await waitFor(() => tbl.guestDrivers.every((d) => d.views.length > 0), 5000, 'first views');
    tbl.host.leave();
    await tbl.net.flush();
    expect(tbl.hostLeft).toEqual(['left', 'left']);
    expect(tbl.guests.every((g) => !g.active)).toBe(true);
  });

  it('host crash (owner changes / leaves Steam) surfaces "host left" once', async () => {
    const tbl = await setupTable({ act: false });
    const hostId = (await tbl.net.bridges[0].steam.me())!.steamId;
    tbl.net.disconnect(hostId);
    await tbl.net.flush();
    expect(tbl.hostLeft.every((r) => r === 'left' || r === 'owner-changed')).toBe(true);
    expect(tbl.guests.every((g) => !g.active)).toBe(true);
  });

  it('restart after MATCH_END returns everyone to the lobby with the same members', async () => {
    const tbl = await setupTable({ cfg: { ...FAST_RULES, handsPerMatch: 1 } });
    const { host, hostDriver, guestDrivers } = tbl;
    expect(host.restart()).toBe(false);
    host.start();
    await waitFor(() => [hostDriver, ...guestDrivers].every((d) => d.last()?.phase === 'MATCH_END'), 90_000, 'MATCH_END');
    expect(host.restart()).toBe(true);
    await tbl.net.flush();
    for (const d of [hostDriver, ...guestDrivers]) {
      const r = d.rooms[d.rooms.length - 1];
      expect(r.started).toBe(false);
      expect(r.seats.filter((s) => s && !s.isBot).length).toBe(3);
    }
    // and a second match starts on the same lobby
    host.start();
    await waitFor(() => guestDrivers.every((d) => d.last()?.handNo === 1 && d.last()?.phase !== 'MATCH_END'), 10_000, 'second match');
  }, 120_000);
});

describe('Steam P2P adversarial cases', () => {
  const msgs = (log: { from: string; data: string }[], from = 0): { t: string; code?: string; view?: PlayerView }[] =>
    log.slice(from).map((m) => JSON.parse(m.data));

  it('a guest the host lost contact with is told its seat is gone (no zombie pongs), others play on', async () => {
    const tbl = await setupTable({ relaxed: true, act: false });
    const { net, host, guests, wires } = tbl;
    const [hb, g1b, g2b] = net.bridges;
    const hostId = (await hb.steam.me())!.steamId;
    const g1Id = (await g1b.steam.me())!.steamId;
    const g2Id = (await g2b.steam.me())!.steamId;
    host.start();
    await waitFor(() => tbl.guestDrivers.every((d) => d.views.length > 0), 5000, 'first views');

    // guest 2's client is alive: Steam reports a P2P failure to the host only
    tbl.hostEvent({ type: 'p2p-failed', steamId: g2Id, error: 1 });
    await net.flush();
    expect(host.room().seats[2]?.isBot).toBe(true);
    expect(tbl.rejected[1]).toBe('NOT_IN_ROOM');
    expect(guests[1].active).toBe(false);
    expect(await g2b.steam.currentLobby()).toBeNull(); // it left the lobby on its own

    // guest 1's client is stuck (transport gone, still a lobby member): every later message
    // gets NOT_IN_ROOM instead of a pong / a seat, and nothing reaches the GameHost
    guests[0].dispose();
    tbl.hostEvent({ type: 'p2p-failed', steamId: g1Id, error: 1 });
    await net.flush();
    expect(host.room().seats[1]?.isBot).toBe(true);
    const mark = wires[0].length;
    const submit = vi.spyOn(GameHost.prototype, 'submit');
    for (const m of [{ t: 'ping' }, { t: 'hello', v: PROTOCOL_VERSION, name: 'Again' }, { t: 'action', action: { type: 'END_TURN' } }]) {
      await g1b.steam.sendTo(hostId, JSON.stringify(m));
    }
    await net.flush();
    expect(msgs(wires[0], mark).map((m) => m.code ?? m.t)).toEqual(['NOT_IN_ROOM', 'NOT_IN_ROOM', 'NOT_IN_ROOM']);
    expect(submit).not.toHaveBeenCalled();
    expect(host.room().seats.filter((s) => s && !s.isBot).length).toBe(1);
  });

  it('a seated guest repeating hello mid-game is resynced with its current view', async () => {
    const tbl = await setupTable({ relaxed: true, act: false });
    const { net, host, wires, hostDriver } = tbl;
    const [hb, g1b] = net.bridges;
    const hostId = (await hb.steam.me())!.steamId;
    host.start();
    await waitFor(() => tbl.guestDrivers.every((d) => d.views.length > 0), 5000, 'first views');
    const mark = wires[0].length;
    await g1b.steam.sendTo(hostId, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Guest 1' }));
    await net.flush();
    const got = msgs(wires[0], mark);
    expect(got.map((m) => m.t)).toEqual(['welcome', 'room', 'game']);
    const view = got[2].view!;
    expect(view.you).toBe(1);
    expect(view.version).toBe(hostDriver.last()!.version);
    expect(view.hand).toEqual(tbl.guestDrivers[0].last()!.hand);
    expect(host.room().seats[1]?.isBot).toBe(false);
  });

  it('flooding guests are throttled: bounded replies, bounded engine calls', async () => {
    const tbl = await setupTable({ relaxed: true, act: false });
    const { net, host, wires } = tbl;
    const [hb, g1b] = net.bridges;
    const hostId = (await hb.steam.me())!.steamId;
    host.start();
    await waitFor(() => tbl.guestDrivers.every((d) => d.views.length > 0), 5000, 'first views');
    const submit = vi.spyOn(GameHost.prototype, 'submit');
    const mark = wires[0].length;
    const rejectedBefore = host.stats.rejected;
    const ping = JSON.stringify({ t: 'ping' });
    const act = JSON.stringify({ t: 'action', action: { type: 'END_TURN' } });
    await Promise.all(Array.from({ length: 300 }, (_, i) => g1b.steam.sendTo(hostId, i % 2 ? act : ping)));
    await net.flush();
    const replies = wires[0].length - mark;
    // burst of 40 (+ a token or two of refill); everything else is dropped unanswered
    expect(replies).toBeLessThanOrEqual(45);
    expect(submit.mock.calls.length).toBeLessThanOrEqual(25);
    expect(host.stats.rejected - rejectedBefore).toBeGreaterThanOrEqual(255);
    // the guest is still seated and the table still works
    expect(host.room().seats[1]?.isBot).toBe(false);
  });

  it('a member whose hello arrives after the start is refused and leaves the lobby', async () => {
    const tbl = await setupTable({ relaxed: true, act: false, users: 4 });
    const { net, host } = tbl;
    const late = net.bridges[3];
    const me = (await late.steam.me())!;
    const joined = await late.steam.joinLobby(host.lobby);
    expect(joined.ok).toBe(true);
    host.start(); // before the late member said hello
    await net.flush();
    if (!joined.ok) return;
    let rejectedWith: string | null = null;
    const g = new SteamGuestTransport({ bridge: late, self: me, lobby: joined.value, name: 'Late', avatar: 'mei', keepalive: false });
    open.push(g);
    g.setEvents({ onRejected: (code) => (rejectedWith = code) });
    await waitFor(() => rejectedWith !== null, 5000, 'late hello refused');
    await net.flush();
    expect(rejectedWith).toBe('ALREADY_STARTED');
    expect(await late.steam.currentLobby()).toBeNull();
    expect(host.room().seats.some((s) => s?.name === 'Late')).toBe(false);
    expect(host.room().seats.length).toBe(4);
  });

  it('a 5-seat table seats 4 guests; Steam refuses a 6th member', async () => {
    const tbl = await setupTable({ guests: 4, users: 6, cfg: { ...FAST_RULES, players: 5 }, relaxed: true, act: false });
    expect(tbl.host.room().seats.map((s) => (s ? (s.host ? 'host' : 'guest') : null))).toEqual(['host', 'guest', 'guest', 'guest', 'guest']);
    const extra = await tbl.net.bridges[5].steam.joinLobby(tbl.host.lobby);
    expect(extra.ok).toBe(false);
    // and the full lobby no longer shows up in the browser
    const list = await tbl.net.bridges[5].steam.listLobbies();
    expect(list.ok && list.value.some((l) => l.lobbyId === tbl.host.lobby)).toBe(false);
  });

  it('protocol version mismatch: wrong hello version refused; a lobby of another version is neither listed nor joinable', async () => {
    const tbl = await setupTable({ guests: 1, users: 3, relaxed: true, act: false });
    const { net, host } = tbl;
    const [hb, , other] = net.bridges;
    const hostId = (await hb.steam.me())!.steamId;
    // a member speaking another protocol version
    expect((await other.steam.joinLobby(host.lobby)).ok).toBe(true);
    const log = tap(other);
    await other.steam.sendTo(hostId, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Future' }));
    await net.flush();
    expect(msgs(log).map((m) => m.code)).toEqual(['VERSION']);
    expect(host.room().seats.some((s) => s?.name === 'Future')).toBe(false);
    await other.steam.leaveLobby();
    // the lobby advertises another version: hidden from the browser, join refused
    expect((await hb.steam.setLobbyData(LOBBY_KEYS.version, String(PROTOCOL_VERSION + 1))).ok).toBe(true);
    await net.flush();
    const list = await other.steam.listLobbies();
    expect(list.ok && list.value.some((l) => l.lobbyId === host.lobby)).toBe(false);
    expect((await other.steam.joinLobby(host.lobby)).ok).toBe(false);
  });
});
