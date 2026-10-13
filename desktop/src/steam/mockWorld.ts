/**
 * Simulated Steam backend for OPEN_RUMMY_STEAM=mock (users, lobbies, lobby data, P2P relay).
 * Synchronous and I/O free; events go to a per-user sink. mock.ts serves one world over a
 * 127.0.0.1 TCP relay so several Electron instances on one machine share it.
 *
 * Semantics follow docs/DESKTOP.md and the renderer test double
 * (packages/client/src/net/mockDesktop.ts): decimal-string ids, `{ok:false, reason}` results,
 * lobby tag/version filtering, owner-only lobby data, P2P only between members of the same
 * lobby, ownership moves to the oldest remaining member when the owner leaves.
 */
import { PROTOCOL_VERSION } from '@open-rummy/shared';
import {
  DESKTOP_LIMITS,
  LOBBY_GAME_TAG,
  LOBBY_KEYS,
  type CreateLobbyOptions,
  type LobbyEvent,
  type LobbyMember,
  type LobbyState,
  type LobbySummary,
  type LobbyVisibility,
  type MemberLeaveReason,
  type SteamIdString,
  type SteamResult,
} from '../../../packages/client/src/net/desktopBridge';
import { isPayload, isSteamIdString, sanitizeCreateOpts, sanitizeLobbyData } from '../channels';
import { fail, lobbySummaryFromData } from './backend';

export interface MockUser {
  steamId: SteamIdString;
  name: string;
}

export interface MockSink {
  lobbyEvent(evt: LobbyEvent): void;
  message(fromSteamId: SteamIdString, data: string): void;
}

export interface MockWorldOptions {
  /** openInviteDialog() sends 'join-requested' to every connected user outside the lobby */
  autoInvite?: boolean;
}

interface MockLobby {
  id: SteamIdString;
  owner: SteamIdString;
  /** join order; ownership falls to members[0] when the owner leaves */
  members: SteamIdString[];
  maxMembers: number;
  visibility: LobbyVisibility;
  joinable: boolean;
  data: Record<string, string>;
}

interface UserEntry {
  user: MockUser;
  sink: MockSink;
  lobbyId: SteamIdString | null;
}

export class MockSteamWorld {
  private readonly users = new Map<SteamIdString, UserEntry>();
  private readonly lobbies = new Map<SteamIdString, MockLobby>();
  private nextLobby = 109775240917000000n;
  private readonly version = String(PROTOCOL_VERSION);

  constructor(private readonly opts: MockWorldOptions = {}) {}

  /** registers a user (a previous registration of the same id is disconnected first) */
  addUser(user: MockUser, sink: MockSink): boolean {
    if (!isSteamIdString(user.steamId)) return false;
    if (this.users.has(user.steamId)) this.disconnect(user.steamId);
    this.users.set(user.steamId, { user: { ...user }, sink, lobbyId: null });
    return true;
  }

  isOnline(steamId: SteamIdString): boolean {
    return this.users.has(steamId);
  }

  /** crash / network loss: members see 'member-left' reason 'disconnected'; the user is removed */
  disconnect(steamId: SteamIdString): void {
    const u = this.users.get(steamId);
    if (!u) return;
    if (u.lobbyId) this.removeFromLobby(u, 'disconnected', false);
    this.users.delete(steamId);
  }

  createLobby(steamId: SteamIdString, rawOpts: unknown): SteamResult<LobbyState> {
    const u = this.users.get(steamId);
    if (!u) return fail('unavailable');
    const opts: CreateLobbyOptions | null = sanitizeCreateOpts(rawOpts);
    if (!opts) return fail('invalid', 'lobby options');
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.data ?? {})) if (v !== '') data[k] = v;
    data[LOBBY_KEYS.game] = LOBBY_GAME_TAG;
    data[LOBBY_KEYS.version] = this.version;
    if (u.lobbyId) this.removeFromLobby(u, 'left', true);
    const id = (this.nextLobby++).toString();
    const lobby: MockLobby = {
      id,
      owner: steamId,
      members: [steamId],
      maxMembers: opts.maxMembers ?? DESKTOP_LIMITS.maxLobbyMembers,
      visibility: opts.visibility ?? 'public',
      joinable: true,
      data,
    };
    this.lobbies.set(id, lobby);
    u.lobbyId = id;
    const state = this.state(lobby, steamId);
    u.sink.lobbyEvent({ type: 'lobby-entered', lobby: state });
    return { ok: true, value: state };
  }

  joinLobby(steamId: SteamIdString, lobbyId: unknown): SteamResult<LobbyState> {
    const u = this.users.get(steamId);
    if (!u) return fail('unavailable');
    if (!isSteamIdString(lobbyId)) return fail('invalid', 'lobby id');
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return fail('join-failed', 'lobby not found');
    if (u.lobbyId === lobbyId) return { ok: true, value: this.state(lobby, steamId) };
    if (lobby.data[LOBBY_KEYS.game] !== LOBBY_GAME_TAG) return fail('join-failed', 'not an Open Rummy lobby');
    if (lobby.data[LOBBY_KEYS.version] !== this.version) return fail('join-failed', 'protocol version mismatch');
    if (!lobby.joinable) return fail('join-failed', 'lobby not joinable');
    if (lobby.members.length >= lobby.maxMembers) return fail('join-failed', 'lobby full');
    if (u.lobbyId) this.removeFromLobby(u, 'left', true);
    const others = [...lobby.members];
    lobby.members.push(steamId);
    u.lobbyId = lobbyId;
    for (const m of others) this.emit(m, { type: 'member-joined', lobbyId, steamId });
    const state = this.state(lobby, steamId);
    u.sink.lobbyEvent({ type: 'lobby-entered', lobby: state });
    return { ok: true, value: state };
  }

  leaveLobby(steamId: SteamIdString): void {
    const u = this.users.get(steamId);
    if (u?.lobbyId) this.removeFromLobby(u, 'left', true);
  }

  currentLobby(steamId: SteamIdString): LobbyState | null {
    const lobby = this.lobbyOf(steamId);
    return lobby ? this.state(lobby, steamId) : null;
  }

  lobbyMembers(steamId: SteamIdString): LobbyMember[] {
    return this.currentLobby(steamId)?.members ?? [];
  }

  listLobbies(steamId: SteamIdString): SteamResult<LobbySummary[]> {
    if (!this.users.has(steamId)) return fail('unavailable');
    const rows: LobbySummary[] = [];
    for (const l of this.lobbies.values()) {
      if (l.visibility !== 'public' || !l.joinable || l.members.length >= l.maxMembers) continue;
      if (l.data[LOBBY_KEYS.game] !== LOBBY_GAME_TAG || l.data[LOBBY_KEYS.version] !== this.version) continue;
      rows.push(lobbySummaryFromData(l.id, l.data));
    }
    return { ok: true, value: rows };
  }

  setLobbyDataMany(steamId: SteamIdString, rawData: unknown): SteamResult {
    const owned = this.ownerLobby(steamId);
    if (!owned.ok) return owned;
    const data = sanitizeLobbyData(rawData);
    if (!data) return fail('invalid', 'lobby data');
    const lobby = owned.lobby;
    let changed = false;
    for (const [k, v] of Object.entries(data)) {
      if (v === '') {
        if (k in lobby.data) {
          delete lobby.data[k];
          changed = true;
        }
      } else if (lobby.data[k] !== v) {
        lobby.data[k] = v;
        changed = true;
      }
    }
    if (changed) for (const m of lobby.members) this.emit(m, { type: 'data-updated', lobbyId: lobby.id, data: { ...lobby.data } });
    return { ok: true };
  }

  getLobbyData(steamId: SteamIdString, key: unknown): string | null {
    if (typeof key !== 'string') return null;
    return this.lobbyOf(steamId)?.data[key] ?? null;
  }

  setLobbyJoinable(steamId: SteamIdString, joinable: unknown): SteamResult {
    const owned = this.ownerLobby(steamId);
    if (!owned.ok) return owned;
    if (typeof joinable !== 'boolean') return fail('invalid', 'joinable');
    owned.lobby.joinable = joinable;
    return { ok: true };
  }

  openInviteDialog(steamId: SteamIdString): SteamResult {
    if (!this.users.has(steamId)) return fail('unavailable');
    const lobby = this.lobbyOf(steamId);
    if (!lobby) return fail('not-in-lobby');
    if (this.opts.autoInvite) {
      for (const u of this.users.values()) {
        if (u.lobbyId !== lobby.id) u.sink.lobbyEvent({ type: 'join-requested', lobbyId: lobby.id, friendId: steamId });
      }
    }
    return { ok: true };
  }

  sendTo(steamId: SteamIdString, to: unknown, data: unknown): SteamResult {
    if (!this.users.has(steamId)) return fail('unavailable');
    const lobby = this.lobbyOf(steamId);
    if (!lobby) return fail('not-in-lobby');
    if (!isSteamIdString(to) || !isPayload(data)) return fail('invalid', 'bad peer or payload');
    if (to === steamId || !lobby.members.includes(to)) return fail('invalid', 'peer is not a lobby member');
    const peer = this.users.get(to);
    if (!peer) return fail('send-failed');
    peer.sink.message(steamId, data);
    return { ok: true };
  }

  broadcast(steamId: SteamIdString, data: unknown): SteamResult {
    if (!this.users.has(steamId)) return fail('unavailable');
    const lobby = this.lobbyOf(steamId);
    if (!lobby) return fail('not-in-lobby');
    let all: SteamResult = { ok: true };
    for (const m of lobby.members) {
      if (m === steamId) continue;
      const r = this.sendTo(steamId, m, data);
      if (!r.ok) all = r;
    }
    return all;
  }

  // --- internals -------------------------------------------------------------

  private lobbyOf(steamId: SteamIdString): MockLobby | null {
    const id = this.users.get(steamId)?.lobbyId;
    return id ? (this.lobbies.get(id) ?? null) : null;
  }

  private ownerLobby(steamId: SteamIdString): { ok: true; lobby: MockLobby } | { ok: false; reason: 'unavailable' | 'not-in-lobby' | 'not-owner' } {
    if (!this.users.has(steamId)) return { ok: false, reason: 'unavailable' };
    const lobby = this.lobbyOf(steamId);
    if (!lobby) return { ok: false, reason: 'not-in-lobby' };
    if (lobby.owner !== steamId) return { ok: false, reason: 'not-owner' };
    return { ok: true, lobby };
  }

  private state(lobby: MockLobby, me: SteamIdString): LobbyState {
    return {
      lobbyId: lobby.id,
      ownerId: lobby.owner,
      members: lobby.members.map((m) => ({ steamId: m, isOwner: m === lobby.owner, isMe: m === me })),
      maxMembers: lobby.maxMembers,
      data: { ...lobby.data },
    };
  }

  private emit(steamId: SteamIdString, evt: LobbyEvent): void {
    this.users.get(steamId)?.sink.lobbyEvent(evt);
  }

  private removeFromLobby(u: UserEntry, reason: MemberLeaveReason, notifySelf: boolean): void {
    const lobby = u.lobbyId ? this.lobbies.get(u.lobbyId) : undefined;
    u.lobbyId = null;
    if (!lobby) return;
    const me = u.user.steamId;
    lobby.members = lobby.members.filter((m) => m !== me);
    if (notifySelf) u.sink.lobbyEvent({ type: 'lobby-left', lobbyId: lobby.id, reason: 'self' });
    if (lobby.members.length === 0) {
      this.lobbies.delete(lobby.id);
      return;
    }
    for (const m of lobby.members) this.emit(m, { type: 'member-left', lobbyId: lobby.id, steamId: me, reason });
    if (lobby.owner === me) {
      lobby.owner = lobby.members[0];
      for (const m of lobby.members) this.emit(m, { type: 'owner-changed', lobbyId: lobby.id, ownerId: lobby.owner, previousOwnerId: me });
    }
  }
}
