/**
 * In-memory test double of the desktop bridge (`window.openRummyDesktop`): one simulated
 * Steam with lobbies and P2P, and one bridge per simulated user. Pure TypeScript, no DOM,
 * no Electron: used by the vitest suites (node) to drive SteamHostTransport and
 * SteamGuestTransport end to end.
 *
 * Behaviour mirrors what docs/DESKTOP.md promises for the real main process:
 * - Steam ids are decimal strings; results never throw for expected failures ({ok:false}).
 * - P2P is reliable and ordered per sender; payloads over DESKTOP_LIMITS.maxP2PMessageBytes and
 *   sends to non-members are refused; packets reach a user only while it is still connected.
 * - Lobby membership changes emit lobby-entered / member-joined / member-left / owner-changed
 *   (Steam moves ownership to the next member when the owner leaves).
 * - Lobbies are listed only when public, joinable, not full and tagged with the game + version.
 * - Delivery is asynchronous (microtask) by default, or queued until flush() with manualDelivery.
 */
import { PROTOCOL_VERSION } from '@open-rummy/shared';
import {
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_LIMITS,
  LOBBY_GAME_TAG,
  LOBBY_KEYS,
  type CreateLobbyOptions,
  type CreateMockSteamNetwork,
  type DesktopSteamApi,
  type LobbyEvent,
  type LobbyMember,
  type LobbyState,
  type LobbySummary,
  type LobbyVisibility,
  type MemberLeaveReason,
  type MockSteamNetwork,
  type MockSteamNetworkOptions,
  type MockSteamUser,
  type OpenRummyDesktopBridge,
  type SteamIdString,
  type SteamResult,
} from './desktopBridge';
import { utf8Length } from './steam/validate';

interface MockLobby {
  id: SteamIdString;
  owner: SteamIdString;
  members: SteamIdString[];
  maxMembers: number;
  visibility: LobbyVisibility;
  joinable: boolean;
  data: Record<string, string>;
}

const ID_BASE = 76561197960265728n;

const fail = (reason: Extract<SteamResult, { ok: false }>['reason'], message?: string): { ok: false; reason: typeof reason; message?: string } =>
  message ? { ok: false, reason, message } : { ok: false, reason };

export const createMockSteamNetwork: CreateMockSteamNetwork = (userCount: number, opts: MockSteamNetworkOptions = {}): MockSteamNetwork => {
  const users: MockSteamUser[] =
    opts.users?.map((u) => ({ ...u })) ??
    Array.from({ length: userCount }, (_, i) => ({ steamId: String(ID_BASE + 1000n + BigInt(i)), name: `Player ${i + 1}` }));
  const unavailable = opts.unavailable === true;
  const manual = opts.manualDelivery === true;

  const lobbies = new Map<SteamIdString, MockLobby>();
  const userLobby = new Map<SteamIdString, SteamIdString>();
  const msgListeners = new Map<SteamIdString, Set<(from: SteamIdString, data: string) => void>>();
  const evtListeners = new Map<SteamIdString, Set<(evt: LobbyEvent) => void>>();
  const pendingJoin = new Map<SteamIdString, { lobbyId: SteamIdString; friendId?: SteamIdString }>();
  const disconnected = new Set<SteamIdString>();
  let nextLobby = 1n;

  // ----- delivery queue ---------------------------------------------------------
  const queue: (() => void)[] = [];
  let scheduled = false;
  const drain = (): void => {
    scheduled = false;
    let guard = 0;
    while (queue.length) {
      const job = queue.shift() as () => void;
      try {
        job();
      } catch (err) {
        console.error('[mockSteam] listener threw', err);
      }
      if (++guard > 1_000_000) throw new Error('mockSteam: delivery loop');
    }
  };
  const deliver = (job: () => void): void => {
    queue.push(job);
    if (manual || scheduled) return;
    scheduled = true;
    queueMicrotask(drain);
  };

  const emit = (to: SteamIdString, evt: LobbyEvent): void => {
    deliver(() => {
      if (disconnected.has(to)) return;
      const ls = evtListeners.get(to);
      if (!ls || ls.size === 0) return;
      if (evt.type === 'join-requested') pendingJoin.delete(to);
      for (const cb of [...ls]) cb(structuredClone(evt));
    });
  };

  // ----- lobby helpers ------------------------------------------------------------
  const snapshot = (lobby: MockLobby, me: SteamIdString): LobbyState => ({
    lobbyId: lobby.id,
    ownerId: lobby.owner,
    members: lobby.members.map((id): LobbyMember => ({ steamId: id, isOwner: id === lobby.owner, isMe: id === me })),
    maxMembers: lobby.maxMembers,
    data: { ...lobby.data },
  });

  const removeMember = (user: SteamIdString, reason: 'self' | MemberLeaveReason): void => {
    const lobbyId = userLobby.get(user);
    if (!lobbyId) return;
    userLobby.delete(user);
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    lobby.members = lobby.members.filter((m) => m !== user);
    emit(user, { type: 'lobby-left', lobbyId, reason });
    const memberReason: MemberLeaveReason = reason === 'self' ? 'left' : reason;
    for (const m of lobby.members) emit(m, { type: 'member-left', lobbyId, steamId: user, reason: memberReason });
    if (lobby.members.length === 0) {
      lobbies.delete(lobbyId);
      return;
    }
    if (lobby.owner === user) {
      const previousOwnerId = lobby.owner;
      lobby.owner = lobby.members[0];
      for (const m of lobby.members) emit(m, { type: 'owner-changed', lobbyId, ownerId: lobby.owner, previousOwnerId });
    }
  };

  const tagged = (lobby: MockLobby): boolean =>
    lobby.data[LOBBY_KEYS.game] === LOBBY_GAME_TAG && lobby.data[LOBBY_KEYS.version] === String(PROTOCOL_VERSION);

  const isKey = (k: unknown): k is string =>
    typeof k === 'string' && k.length > 0 && k.length <= DESKTOP_LIMITS.maxLobbyKeyLength && /^[A-Za-z0-9_.:-]+$/.test(k);
  const isValue = (v: unknown): v is string => typeof v === 'string' && v.length <= DESKTOP_LIMITS.maxLobbyValueLength;

  const parseSeats = (v: string | undefined): [number | null, number | null] => {
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(v ?? '');
    return m ? [Number(m[1]), Number(m[2])] : [null, null];
  };

  // ----- one bridge per user ----------------------------------------------------------
  const makeBridge = (user: MockSteamUser): OpenRummyDesktopBridge => {
    const me = user.steamId;
    const up = (): boolean => !unavailable && !disconnected.has(me);
    const myLobby = (): MockLobby | null => {
      const id = userLobby.get(me);
      return id ? lobbies.get(id) ?? null : null;
    };

    const send = (to: SteamIdString, data: string): SteamResult => {
      if (!up()) return fail('unavailable');
      const lobby = myLobby();
      if (!lobby) return fail('not-in-lobby');
      if (typeof to !== 'string' || !/^\d{1,20}$/.test(to) || to === me) return fail('invalid', 'bad peer');
      if (!lobby.members.includes(to)) return fail('invalid', 'peer is not a lobby member');
      if (typeof data !== 'string' || utf8Length(data) > DESKTOP_LIMITS.maxP2PMessageBytes) return fail('invalid', 'payload too large');
      deliver(() => {
        if (disconnected.has(to)) return;
        const ls = msgListeners.get(to);
        if (!ls) return;
        for (const cb of [...ls]) cb(me, data);
      });
      return { ok: true };
    };

    const setData = (data: Record<string, string>): SteamResult => {
      if (!up()) return fail('unavailable');
      const lobby = myLobby();
      if (!lobby) return fail('not-in-lobby');
      if (lobby.owner !== me) return fail('not-owner');
      for (const [k, v] of Object.entries(data)) if (!isKey(k) || !isValue(v)) return fail('invalid', 'bad lobby data');
      for (const [k, v] of Object.entries(data)) {
        if (v === '') delete lobby.data[k];
        else lobby.data[k] = v;
      }
      for (const m of lobby.members) emit(m, { type: 'data-updated', lobbyId: lobby.id, data: { ...lobby.data } });
      return { ok: true };
    };

    const steam: DesktopSteamApi = {
      available: async () => (up() ? { ok: true, appId: 480 } : { ok: false, reason: 'Steam is not running' }),
      me: async () => (up() ? { steamId: me, name: user.name } : null),

      createLobby: async (o: CreateLobbyOptions = {}) => {
        if (!up()) return fail('unavailable');
        const max = o.maxMembers ?? DESKTOP_LIMITS.maxLobbyMembers;
        if (!Number.isInteger(max) || max < 2 || max > DESKTOP_LIMITS.maxLobbyMembers) return fail('invalid', 'bad maxMembers');
        if (userLobby.has(me)) removeMember(me, 'self');
        const id = String(ID_BASE + (1n << 52n) + nextLobby++);
        const data: Record<string, string> = {};
        for (const [k, v] of Object.entries(o.data ?? {})) {
          if (!isKey(k) || !isValue(v)) return fail('invalid', 'bad lobby data');
          if (v !== '') data[k] = v;
        }
        data[LOBBY_KEYS.game] = LOBBY_GAME_TAG;
        data[LOBBY_KEYS.version] = String(PROTOCOL_VERSION);
        const lobby: MockLobby = { id, owner: me, members: [me], maxMembers: max, visibility: o.visibility ?? 'public', joinable: true, data };
        lobbies.set(id, lobby);
        userLobby.set(me, id);
        const state = snapshot(lobby, me);
        emit(me, { type: 'lobby-entered', lobby: state });
        return { ok: true, value: state };
      },

      joinLobby: async (lobbyId: SteamIdString) => {
        if (!up()) return fail('unavailable');
        if (typeof lobbyId !== 'string' || !/^\d{1,20}$/.test(lobbyId)) return fail('invalid', 'bad lobby id');
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return fail('join-failed', 'lobby not found');
        if (!tagged(lobby)) return fail('join-failed', 'not an Open Rummy lobby of this version');
        if (lobby.members.includes(me)) return { ok: true, value: snapshot(lobby, me) };
        if (!lobby.joinable || lobby.members.length >= lobby.maxMembers) return fail('join-failed', 'lobby full or closed');
        if (userLobby.has(me)) removeMember(me, 'self');
        lobby.members.push(me);
        userLobby.set(me, lobby.id);
        const state = snapshot(lobby, me);
        emit(me, { type: 'lobby-entered', lobby: state });
        for (const m of lobby.members) if (m !== me) emit(m, { type: 'member-joined', lobbyId: lobby.id, steamId: me });
        return { ok: true, value: state };
      },

      leaveLobby: async () => {
        removeMember(me, 'self');
      },
      currentLobby: async () => {
        const lobby = up() ? myLobby() : null;
        return lobby ? snapshot(lobby, me) : null;
      },
      lobbyMembers: async () => {
        const lobby = up() ? myLobby() : null;
        return lobby ? snapshot(lobby, me).members : [];
      },
      listLobbies: async () => {
        if (!up()) return fail('unavailable');
        const rows: LobbySummary[] = [];
        for (const l of lobbies.values()) {
          if (l.visibility !== 'public' || !l.joinable || l.members.length >= l.maxMembers || !tagged(l)) continue;
          const [taken, total] = parseSeats(l.data[LOBBY_KEYS.seats]);
          rows.push({
            lobbyId: l.id,
            hostName: l.data[LOBBY_KEYS.hostName] ?? '',
            seatsTaken: taken,
            seatsTotal: total,
            started: l.data[LOBBY_KEYS.started] === '1',
            data: { ...l.data },
          });
        }
        return { ok: true, value: rows };
      },
      setLobbyData: async (key: string, value: string) => setData({ [key]: value }),
      setLobbyDataMany: async (data: Record<string, string>) => setData({ ...data }),
      getLobbyData: async (key: string) => {
        const lobby = up() ? myLobby() : null;
        return lobby && key in lobby.data ? lobby.data[key] : null;
      },
      setLobbyJoinable: async (joinable: boolean) => {
        if (!up()) return fail('unavailable');
        const lobby = myLobby();
        if (!lobby) return fail('not-in-lobby');
        if (lobby.owner !== me) return fail('not-owner');
        lobby.joinable = joinable === true;
        return { ok: true };
      },
      openInviteDialog: async () => {
        if (!up()) return fail('unavailable');
        return myLobby() ? { ok: true } : fail('not-in-lobby');
      },
      avatarDataUrl: async () => null,

      sendTo: async (steamId: SteamIdString, data: string) => send(steamId, data),
      broadcast: async (data: string) => {
        if (!up()) return fail('unavailable');
        const lobby = myLobby();
        if (!lobby) return fail('not-in-lobby');
        let ok = true;
        for (const m of lobby.members) if (m !== me && !send(m, data).ok) ok = false;
        return ok ? { ok: true } : fail('send-failed');
      },

      consumePendingJoin: async () => {
        const p = pendingJoin.get(me) ?? null;
        pendingJoin.delete(me);
        return p;
      },
      onMessage: (cb) => {
        let set = msgListeners.get(me);
        if (!set) msgListeners.set(me, (set = new Set()));
        set.add(cb);
        return () => {
          set?.delete(cb);
        };
      },
      onLobbyEvent: (cb) => {
        let set = evtListeners.get(me);
        if (!set) evtListeners.set(me, (set = new Set()));
        set.add(cb);
        return () => {
          set?.delete(cb);
        };
      },
    };

    return {
      app: {
        info: async () => ({ appVersion: '0.0.0-mock', bridgeVersion: DESKTOP_BRIDGE_VERSION, electronVersion: 'mock', platform: 'mock', packaged: false, onlineServerUrl: null }),
        quit: async () => undefined,
        toggleFullscreen: async () => false,
      },
      steam,
    };
  };

  const bridges = users.map(makeBridge);

  return {
    bridges,
    users,
    async flush() {
      // keep delivering until the network is quiet (handlers may answer with new packets,
      // and transports defer some work to microtasks / zero-delay timers)
      for (let round = 0; round < 10_000; round++) {
        drain();
        await new Promise<void>((r) => setTimeout(r, 0));
        if (queue.length === 0) return;
      }
      throw new Error('mockSteam: flush did not settle');
    },
    disconnect(steamId: SteamIdString) {
      if (disconnected.has(steamId)) return;
      removeMember(steamId, 'disconnected');
      disconnected.add(steamId);
    },
    requestJoin(steamId: SteamIdString, lobbyId: SteamIdString, friendId?: SteamIdString) {
      const req = friendId ? { lobbyId, friendId } : { lobbyId };
      pendingJoin.set(steamId, req);
      emit(steamId, { type: 'join-requested', ...req });
    },
  };
};
