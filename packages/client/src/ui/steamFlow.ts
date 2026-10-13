/**
 * Steam multiplayer flow (desktop build only). Loaded lazily by main.ts when
 * `window.openRummyDesktop` exists, so the web build never runs it.
 *
 * home (availability, create, browse) -> lobby room (members, invite, settings, start)
 * -> table (shared GameController) -> rematch back to the room / leave back to home.
 * The lobby owner uses SteamHostTransport (authoritative GameHost); everyone else
 * SteamGuestTransport. Steam overlay invites ('join-requested' / `+connect_lobby`) join
 * the requested lobby, after a confirmation if a match is in progress.
 */
import type { ErrorCode, RoomInfo } from '@open-rummy/shared';
import { DESKTOP_LIMITS, type OpenRummyDesktopBridge, type SteamIdString, type SteamSelf } from '../net/desktopBridge';
import type { Transport } from '../net/transport';
import { SteamHostTransport } from '../net/steam/hostTransport';
import { SteamGuestTransport, type HostLeftReason } from '../net/steam/guestTransport';
import { errorText } from '../net/online';
import type { GameController } from './table/controller';
import type { Screen } from './screen';
import { cleanName, currentAvatar, currentName } from './lobby';
import { steamHomeScreen, steamRoomScreen, type SteamRoomScreen, type SteamTableSettings } from './steamLobby';
import { getPrefs, setPrefs } from './prefs';
import { openModal } from './modal';
import { toast } from './toast';
import { t } from '../i18n';

/** What the flow needs from the router in main.ts (structurally matches its openTable options). */
export interface SteamTableOptions {
  onExit(): void;
  onAgain(): void;
  againLabel: string;
  canAgain?: () => boolean;
  againPending?: boolean;
  leaveNote?: string;
}

export interface SteamFlowDeps {
  bridge: OpenRummyDesktopBridge;
  show(factory: () => Screen): void;
  openTable(transport: Transport, opts: SteamTableOptions): GameController;
  /** tears down the current table (if any) */
  endGame(): void;
  /** transport of the open table, or null */
  tableTransport(): Transport | null;
  goTitle(): void;
}

export interface SteamFlow {
  /** subscribe to invites and consume a pending `+connect_lobby` (call once at boot) */
  init(): void;
  /** open the Steam screen (title menu) */
  open(): void;
}

type Session = SteamHostTransport | SteamGuestTransport;

/** Ignore a repeated join request for the same lobby within this window (event + pending copy). */
const JOIN_DEDUPE_MS = 4000;

export function createSteamFlow(deps: SteamFlowDeps): SteamFlow {
  const steam = deps.bridge.steam;
  let self: SteamSelf | null = null;
  let session: Session | null = null;
  let lastRoom: RoomInfo | null = null;
  let roomView: SteamRoomScreen | null = null;
  let controller: GameController | null = null;
  let lastJoin = { id: '', at: 0 };
  let initialized = false;

  const settings = (): SteamTableSettings => {
    const p = getPrefs();
    return { avatar: currentAvatar(), cfg: p.rules, botLevel: p.botLevel, relaxed: p.relaxed };
  };
  const saveSettings = (s: SteamTableSettings): void => {
    setPrefs({ avatar: s.avatar, rules: s.cfg, botLevel: s.botLevel, relaxed: s.relaxed });
  };

  const displayName = (me: SteamSelf): string => cleanName(me.name) || currentName();

  async function ensureSelf(): Promise<SteamSelf | null> {
    if (self) return self;
    try {
      self = await steam.me();
    } catch (err) {
      console.warn('[steam] me() failed', err);
      self = null;
    }
    return self;
  }

  const tableOpen = (): boolean => !!session && deps.tableTransport() === session;

  // ----- session lifecycle ----------------------------------------------------------

  /** Leave the current lobby (closing the table for everyone when we host). */
  function leaveSession(): void {
    const s = session;
    session = null;
    lastRoom = null;
    roomView = null;
    controller = null;
    if (s) s.leave();
  }

  /** The session ended from the other side: back to the Steam home with a message. */
  function sessionLost(message: string): void {
    const s = session;
    session = null;
    lastRoom = null;
    roomView = null;
    controller = null;
    s?.dispose();
    deps.endGame();
    open();
    openModal({ title: t('steam.title'), body: message, actions: [{ label: t('common.close'), kind: 'gold', onClick: () => undefined }] });
  }

  function attach(s: Session): void {
    session = s;
    lastRoom = null;
    s.setHandlers({
      onRoom(room) {
        if (session !== s) return;
        lastRoom = room;
        if (tableOpen()) {
          if (!room.started) {
            // rematch: every player returns to the lobby room
            deps.endGame();
            controller = null;
            showRoom();
            return;
          }
          controller?.updateAgain();
          return;
        }
        if (!roomView) showRoom();
        roomView?.update(room);
      },
      onGame(view, events) {
        if (session !== s) return;
        if (!tableOpen()) enterTable();
        controller?.push(view, events);
      },
      onEmote(seat, id) {
        if (session === s) controller?.showEmote(seat, id);
      },
      onError(message) {
        if (session !== s) return;
        if (tableOpen() && controller) controller.error(message);
        else toast(message, 'error', 4000);
      },
      onNotice(text) {
        if (session === s) toast(text, 'info', 3500);
      },
    });
    if (s instanceof SteamHostTransport) {
      s.setEvents({ onLobbyLost: () => session === s && sessionLost(t('steam.lobbyLost')) });
    } else {
      s.setEvents({
        onHostLeft: (reason: HostLeftReason) => {
          if (session !== s) return;
          sessionLost(reason === 'unreachable' || reason === 'timeout' ? t('steam.hostUnreachable') : reason === 'lobby-lost' ? t('steam.lobbyLost') : t('steam.hostLeft'));
        },
        onRejected: (code: ErrorCode, message: string) => {
          if (session !== s) return;
          sessionLost(code === 'NOT_IN_ROOM' ? t('steam.seatLost') : t('steam.rejected', { msg: errorText(code, message) }));
        },
      });
    }
  }

  /**
   * One lobby create/join at a time. Main queues lobby operations and each one leaves the
   * current lobby first, so a second join (an invite repeated after the dedupe window, a
   * double click) racing a pending one would leave the lobby the first join just entered and
   * tear its session down. Requests arriving while one is in flight are dropped.
   */
  let lobbyOpBusy = false;
  async function exclusive(op: () => Promise<void>): Promise<void> {
    if (lobbyOpBusy) return;
    lobbyOpBusy = true;
    try {
      await op();
    } finally {
      lobbyOpBusy = false;
    }
  }

  function create(visibility: 'friends' | 'public', s: SteamTableSettings): Promise<void> {
    return exclusive(() => createNow(visibility, s));
  }

  function join(lobbyId: SteamIdString): Promise<void> {
    return exclusive(() => joinNow(lobbyId));
  }

  async function createNow(visibility: 'friends' | 'public', s: SteamTableSettings): Promise<void> {
    saveSettings(s);
    const me = await ensureSelf();
    if (!me) {
      toast(t('steam.unavailable'), 'error');
      return;
    }
    leaveSession();
    toast(t('steam.creating'), 'info', 1500);
    // room for the largest table (5); the host seats at most cfg.players and refuses the rest
    const res = await steam.createLobby({ visibility, maxMembers: DESKTOP_LIMITS.maxLobbyMembers });
    if (!res.ok) {
      toast(t('steam.createFailed', { msg: res.message ?? res.reason }), 'error', 5000);
      return;
    }
    const host = new SteamHostTransport({
      bridge: deps.bridge,
      self: me,
      lobby: res.value,
      name: displayName(me),
      avatar: s.avatar,
      cfg: s.cfg,
      botLevel: s.botLevel,
      relaxed: s.relaxed,
    });
    attach(host);
    lastRoom = host.room();
    showRoom();
  }

  async function joinNow(lobbyId: SteamIdString): Promise<void> {
    const me = await ensureSelf();
    if (!me) {
      toast(t('steam.unavailable'), 'error');
      return;
    }
    if (session?.lobby === lobbyId) {
      if (!tableOpen()) showRoom();
      return;
    }
    leaveSession();
    deps.endGame();
    toast(t('steam.joining'), 'info', 1500);
    const res = await steam.joinLobby(lobbyId);
    if (!res.ok) {
      toast(t('steam.joinFailed', { msg: res.message ?? res.reason }), 'error', 5000);
      open();
      return;
    }
    if (res.value.ownerId === me.steamId) {
      // our own (stale) lobby: there is no host session for it any more
      void steam.leaveLobby();
      toast(t('steam.lobbyLost'), 'error');
      open();
      return;
    }
    const guest = new SteamGuestTransport({
      bridge: deps.bridge,
      self: me,
      lobby: res.value,
      name: displayName(me),
      avatar: currentAvatar(),
    });
    attach(guest);
    showRoom();
  }

  // ----- screens ------------------------------------------------------------------------

  function open(): void {
    roomView = null;
    deps.show(() =>
      steamHomeScreen({
        onBack: () => {
          leaveSession();
          deps.goTitle();
        },
        async status() {
          const avail = await steam.available();
          if (!avail.ok) return { ok: false, reason: avail.reason };
          self = null;
          const me = await ensureSelf();
          return me ? { ok: true, name: me.name, appId: avail.appId } : { ok: false, reason: avail.reason };
        },
        settings: settings(),
        onSettings: saveSettings,
        onCreate: create,
        onJoin: join,
        list: () => steam.listLobbies(),
      }),
    );
  }

  function showRoom(): void {
    const s = session;
    if (!s) {
      open();
      return;
    }
    const isHost = s instanceof SteamHostTransport;
    deps.show(() => {
      const view = steamRoomScreen({
        isHost,
        avatar: currentAvatar(),
        onLeave: () => {
          leaveSession();
          open();
        },
        async onInvite() {
          try {
            return (await steam.openInviteDialog()).ok;
          } catch {
            return false;
          }
        },
        onAvatar(avatar) {
          setPrefs({ avatar });
          s.setAvatar(avatar);
        },
        onStart: isHost ? () => (s as SteamHostTransport).start() : undefined,
        hostSettings: isHost ? { avatar: currentAvatar(), ...(s as SteamHostTransport).rules } : undefined,
        onConfigure: isHost
          ? (st) => {
              const ok = (s as SteamHostTransport).configure(st.cfg, st.botLevel, st.relaxed);
              if (ok) saveSettings({ ...st, avatar: currentAvatar() });
              return ok;
            }
          : undefined,
      });
      roomView = view;
      view.update(lastRoom);
      return {
        ...view,
        dispose: () => {
          if (roomView === view) roomView = null;
        },
      };
    });
  }

  function enterTable(): void {
    const s = session;
    if (!s) return;
    roomView = null;
    const isHost = s instanceof SteamHostTransport;
    controller = deps.openTable(s, {
      onExit: () => {
        leaveSession();
        deps.endGame();
        open();
      },
      onAgain: () => {
        if (s instanceof SteamHostTransport && !s.restart()) toast(t('steam.restartFailed'), 'error');
      },
      againLabel: t('match.again'),
      canAgain: () => isHost,
      againPending: true,
      leaveNote: isHost ? t('steam.leaveHost') : undefined,
    });
  }

  // ----- invites ------------------------------------------------------------------------

  function onJoinRequest(lobbyId: SteamIdString): void {
    const now = Date.now();
    if (lastJoin.id === lobbyId && now - lastJoin.at < JOIN_DEDUPE_MS) return;
    lastJoin = { id: lobbyId, at: now };
    if (session?.lobby === lobbyId) {
      if (!tableOpen()) showRoom();
      return;
    }
    const proceed = (): void => {
      toast(t('steam.joinRequest'), 'info', 2500);
      void join(lobbyId);
    };
    if (deps.tableTransport()) {
      openModal({
        title: t('steam.joinRequestTitle'),
        body: t('steam.joinRequestBody'),
        actions: [
          { label: t('common.cancel'), kind: 'ghost', onClick: () => undefined },
          { label: t('steam.join'), kind: 'gold', onClick: proceed },
        ],
      });
      return;
    }
    proceed();
  }

  return {
    init() {
      if (initialized) return;
      initialized = true;
      steam.onLobbyEvent((evt) => {
        if (evt.type === 'join-requested') onJoinRequest(evt.lobbyId);
      });
      steam
        .consumePendingJoin()
        .then((p) => {
          if (p) onJoinRequest(p.lobbyId);
        })
        .catch((err) => console.warn('[steam] consumePendingJoin failed', err));
    },
    open,
  };
}
