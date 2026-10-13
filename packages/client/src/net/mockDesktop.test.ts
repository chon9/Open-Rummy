import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@open-rummy/shared';
import { LOBBY_KEYS, type LobbyEvent } from './desktopBridge';
import { createMockSteamNetwork } from './mockDesktop';

describe('createMockSteamNetwork', () => {
  it('creates, lists, joins a lobby and relays P2P only between members', async () => {
    const net = createMockSteamNetwork(3, { manualDelivery: true });
    const [host, guest, outsider] = net.bridges;
    const [hu, gu] = net.users;
    const hostEvents: LobbyEvent[] = [];
    host.steam.onLobbyEvent((e) => hostEvents.push(e));
    const got: Array<[string, string]> = [];
    host.steam.onMessage((from, data) => got.push([from, data]));

    const created = await host.steam.createLobby({ maxMembers: 2, data: { [LOBBY_KEYS.hostName]: 'Host' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const lobbyId = created.value.lobbyId;
    expect(created.value.data[LOBBY_KEYS.game]).toBe('open-rummy');
    expect(created.value.data[LOBBY_KEYS.version]).toBe(String(PROTOCOL_VERSION));

    const list = await guest.steam.listLobbies();
    expect(list.ok && list.value.map((l) => l.lobbyId)).toEqual([lobbyId]);

    const joined = await guest.steam.joinLobby(lobbyId);
    expect(joined.ok && joined.value.members.map((m) => m.steamId)).toEqual([hu.steamId, gu.steamId]);
    // full lobby
    expect(await outsider.steam.joinLobby(lobbyId)).toMatchObject({ ok: false, reason: 'join-failed' });

    expect(await guest.steam.sendTo(hu.steamId, '{"t":"ping"}')).toEqual({ ok: true });
    expect(await outsider.steam.sendTo(hu.steamId, 'x')).toMatchObject({ ok: false, reason: 'not-in-lobby' });
    expect(await guest.steam.setLobbyData('x', 'y')).toMatchObject({ ok: false, reason: 'not-owner' });
    expect(got).toEqual([]);
    await net.flush();
    expect(got).toEqual([[gu.steamId, '{"t":"ping"}']]);
    expect(hostEvents.map((e) => e.type)).toEqual(['lobby-entered', 'member-joined']);
  });

  it('moves ownership and reports disconnects', async () => {
    const net = createMockSteamNetwork(2);
    const [host, guest] = net.bridges;
    const [hu, gu] = net.users;
    const events: LobbyEvent[] = [];
    guest.steam.onLobbyEvent((e) => events.push(e));
    const created = await host.steam.createLobby();
    if (!created.ok) throw new Error('create failed');
    await guest.steam.joinLobby(created.value.lobbyId);
    net.disconnect(hu.steamId);
    await net.flush();
    expect(events.map((e) => e.type)).toEqual(['lobby-entered', 'member-left', 'owner-changed']);
    expect(events[1]).toMatchObject({ reason: 'disconnected', steamId: hu.steamId });
    expect(events[2]).toMatchObject({ ownerId: gu.steamId, previousOwnerId: hu.steamId });
  });

  it('keeps join requests for consumePendingJoin', async () => {
    const net = createMockSteamNetwork(1);
    net.requestJoin(net.users[0].steamId, '109775240917000001', '76561197960265729');
    expect(await net.bridges[0].steam.consumePendingJoin()).toEqual({ lobbyId: '109775240917000001', friendId: '76561197960265729' });
    expect(await net.bridges[0].steam.consumePendingJoin()).toBeNull();
  });
});
