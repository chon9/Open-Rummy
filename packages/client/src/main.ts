/**
 * Open Rummy client entry: boots the app, routes between screens, and wires
 * Transport <-> GameController (UI) <-> TableSceneApi (3D).
 */
import './styles/base.css';
import './styles/screens.css';
import './styles/table.css';

import type { RoomInfo } from '@open-rummy/shared';
import type { TableSceneApi } from './scene/api';
import type { Transport, TransportHandlers } from './net/transport';
import { LocalTransport } from './net/local';
import { OnlineTransport, loadToken } from './net/online';
import { h } from './ui/dom';
import { ConnIndicator, type Screen } from './ui/screen';
import { titleScreen } from './ui/title';
import { lobbyScreen, currentName, type OfflineStart } from './ui/lobby';
import { roomScreen, type RoomScreen } from './ui/room';
import { rulesScreen, openRulesModal } from './ui/rulesScreen';
import { creditsScreen } from './ui/credits';
import { openSettings } from './ui/settings';
import { GameController } from './ui/table/controller';
import { FlatScene } from './ui/flatScene';
import { closeAllModals } from './ui/modal';
import { toast } from './ui/toast';
import { getPrefs } from './ui/prefs';
import { onLangChange, setLang, t } from './i18n';
import type { SteamFlow } from './ui/steamFlow';
import { setServerUrl } from './net/serverUrl';

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

setLang(getPrefs().lang);
document.title = t('app.title');

const app = document.getElementById('app') ?? document.body.appendChild(h('div', { id: 'app' }));
const sceneLayer = h('div', { class: 'scene-layer' });
const uiLayer = h('div', { class: 'ui-layer' });
app.replaceChildren(sceneLayer, uiLayer);

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

let screen: Screen | null = null;
let rebuild: (() => Screen) | null = null;

function show(factory: () => Screen): void {
  closeAllModals();
  screen?.dispose?.();
  screen = factory();
  rebuild = factory;
  uiLayer.replaceChildren(screen.el);
  screen.el.classList.add('screen-enter');
}

onLangChange(() => {
  document.title = t('app.title');
  conn.set(online?.connection ?? 'closed');
  if (screen?.relabel?.()) return;
  if (rebuild) show(rebuild);
});

// ---------------------------------------------------------------------------
// game session (table)
// ---------------------------------------------------------------------------

interface GameSession {
  transport: Transport;
  controller: GameController;
  scene: TableSceneApi | null;
}

let game: GameSession | null = null;

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Loading veil with a progress bar while the 3D table and avatars load. */
function loadingVeil(): { set(p: number): void; done(): void } {
  const bar = h('i', { class: 'loading-bar-fill' });
  const veil = h('div', { class: 'loading-veil', role: 'progressbar', 'aria-label': t('table.loading') },
    h('div', { class: 'loading-logo' }, '拉米麻将'),
    h('div', { class: 'loading-text' }, t('table.loading')),
    h('div', { class: 'loading-bar' }, bar),
  );
  document.body.appendChild(veil);
  return {
    set(p) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    },
    done() {
      veil.classList.add('out');
      setTimeout(() => veil.remove(), 500);
    },
  };
}

async function createScene(): Promise<TableSceneApi> {
  const veil = loadingVeil();
  const quality = getPrefs().quality;
  try {
    if (!webglAvailable()) throw new Error('WebGL unavailable');
    const mod = await import('./scene/table');
    const scene = mod.createTableScene();
    await scene.mount(sceneLayer, { quality, onProgress: (p: number) => veil.set(p) });
    return scene;
  } catch (err) {
    console.error('[main] 3D table unavailable, using flat table', err);
    toast(t('toast.no3d'), 'info', 4500);
    sceneLayer.replaceChildren();
    const flat = new FlatScene();
    await flat.mount(sceneLayer, { quality });
    return flat;
  } finally {
    veil.set(1);
    veil.done();
  }
}

function endGame(): void {
  if (!game) return;
  const g = game;
  game = null;
  g.controller.dispose();
  if (g.transport.kind === 'local') g.transport.dispose();
  try {
    g.scene?.dispose();
  } catch (err) {
    console.warn('[main] scene dispose failed', err);
  }
  sceneLayer.replaceChildren();
}

interface TableOptions {
  onExit(): void;
  onAgain(): void;
  againLabel: string;
  hudExtra?: HTMLElement;
  canAgain?: () => boolean;
  againPending?: boolean;
  leaveNote?: string;
}

function openTable(transport: Transport, opts: TableOptions): GameController {
  endGame();
  const tableEl = h('div', { class: 'screen table-screen', 'data-rotate': t('table.rotate') });
  const scenePromise = createScene();
  const controller = new GameController({
    root: tableEl,
    transport,
    scene: scenePromise,
    onExit: opts.onExit,
    onAgain: opts.onAgain,
    againLabel: opts.againLabel,
    hudExtra: opts.hudExtra,
    canAgain: opts.canAgain,
    againPending: opts.againPending,
    leaveNote: opts.leaveNote,
    onOpenSettings: () => openSettings({ onQuality: (q) => game?.scene?.setQuality(q) }),
    onOpenRules: () => openRulesModal(),
  });
  const session: GameSession = { transport, controller, scene: null };
  game = session;
  scenePromise.then((s) => {
    if (game === session) session.scene = s;
    else s.dispose();
  }).catch(() => undefined);
  show(() => ({
    el: tableEl,
    relabel: () => {
      controller.relabel();
      return true;
    },
    dispose: () => {
      if (game === session) endGame();
    },
  }));
  return controller;
}

// ---------------------------------------------------------------------------
// offline
// ---------------------------------------------------------------------------

function startOffline(o: OfflineStart): void {
  const transport = new LocalTransport({
    name: o.name,
    avatar: o.avatar,
    cfg: o.cfg,
    botLevel: o.botLevel,
    noTimers: o.relaxed,
    autoNextHand: getPrefs().autoNext,
  });
  const controller = openTable(transport, {
    onExit: () => goTitle(),
    onAgain: () => startOffline(o),
    againLabel: t('match.again'),
  });
  transport.setHandlers({
    onGame: (view, events) => controller.push(view, events),
    onEmote: (seat, id) => controller.showEmote(seat, id),
    onError: (msg) => controller.error(msg),
  });
  try {
    transport.start();
  } catch (err) {
    console.error('[main] could not start offline match', err);
    toast(t('err.startFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error', 6000);
    showOfflineLobby();
  }
}

function showOfflineLobby(): void {
  abandonProbe('user chose offline play');
  show(() => lobbyScreen({ mode: 'offline', onBack: goTitle, onStartOffline: startOffline }));
}

// ---------------------------------------------------------------------------
// online
// ---------------------------------------------------------------------------

const conn = new ConnIndicator();
let online: OnlineTransport | null = null;
let lastRoom: RoomInfo | null = null;
let roomView: RoomScreen | null = null;
/** true while silently probing for a resumable session at boot */
let probing = false;
/** a resumed welcome must be followed by room/game state within this window */
const RESUME_STATE_TIMEOUT_MS = 1500;
/** upper bound for the whole silent probe (connect + welcome) */
const RESUME_PROBE_MAX_MS = 8000;
let probeTimer: ReturnType<typeof setTimeout> | null = null;

/** End the boot probe (state arrived, user navigated, or it failed). */
function stopProbing(): void {
  probing = false;
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
}

/** The probe found nothing usable: drop the connection and stay on the title screen. */
function abandonProbe(reason: string): void {
  if (!probing) return;
  console.info(`[main] session resume abandoned: ${reason}`);
  stopProbing();
  online?.forgetSession();
  disposeOnline();
}

const onlineHandlers: TransportHandlers = {
  onGame(view, events) {
    if (!online) return;
    stopProbing();
    if (!game || game.transport !== online) enterOnlineTable();
    game?.controller.push(view, events);
  },
  onRoom(room) {
    stopProbing();
    lastRoom = room;
    if (game && game.transport === online) {
      if (room.started === false) {
        // the host restarted the finished match: everyone returns to the room lobby
        endGame();
        showRoom();
        return;
      }
      game.controller.updateAgain(); // in a match the table owns the screen
      return;
    }
    if (!roomView) showRoom();
    roomView?.update(room);
  },
  onEmote(seat, id) {
    game?.controller.showEmote(seat, id);
  },
  onError(message) {
    if (probing) {
      // a failed silent resume is not the user's concern, but keep it diagnosable
      console.warn('[main] error while resuming session:', message);
      abandonProbe('server rejected the resume');
      return;
    }
    if (game) game.controller.error(message);
    else toast(message, 'error', 4000);
  },
  onConnection(state) {
    conn.set(state);
    if (state === 'closed' && probing) {
      // no server reachable: stop probing quietly
      abandonProbe('connection closed');
    }
    if (state === 'closed' && game?.transport === online) toast(t('net.reconnecting'), 'info', 2500);
  },
};

function ensureOnline(): OnlineTransport {
  if (!online) {
    online = new OnlineTransport(currentName());
    online.setEvents({
      onWelcome(resumed) {
        if (!probing) return;
        if (!resumed) {
          abandonProbe('no session on the server');
          return;
        }
        // resumed, but the seat is only usable once room/game state arrives
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(() => {
          probeTimer = null;
          abandonProbe('no room/game state after resume');
        }, RESUME_STATE_TIMEOUT_MS);
      },
      onLeft() {
        lastRoom = null;
        if (roomView) showOnlineLobby();
      },
    });
  }
  online.setHandlers(onlineHandlers);
  return online;
}

function disposeOnline(): void {
  online?.dispose();
  online = null;
  lastRoom = null;
  roomView = null;
  conn.set('closed');
}

function showOnlineLobby(): void {
  // the user took over: a pending boot probe must neither swallow errors nor dispose this transport
  stopProbing();
  ensureOnline();
  roomView = null;
  show(() =>
    lobbyScreen({
      mode: 'online',
      onBack: () => {
        disposeOnline();
        goTitle();
      },
      online: {
        conn,
        onCreate(name, avatar, cfg, botLevel) {
          const o = ensureOnline();
          o.setName(name);
          o.createRoom(avatar, cfg, botLevel);
        },
        onJoin(code, name, avatar) {
          const o = ensureOnline();
          o.setName(name);
          o.joinRoom(code, avatar);
        },
      },
    }),
  );
}

function showRoom(): void {
  const o = ensureOnline();
  show(() => {
    const r = roomScreen(o, conn, () => showOnlineLobby());
    roomView = r;
    if (lastRoom) r.update(lastRoom);
    return {
      ...r,
      dispose: () => {
        if (roomView === r) roomView = null;
      },
    };
  });
}

function enterOnlineTable(): void {
  const o = online;
  if (!o) return;
  roomView = null;
  const hud = h('div', { class: 'hud-conn' }, conn.el);
  openTable(o, {
    onExit: () => {
      o.leave();
      endGame();
      disposeOnline();
      goTitle();
    },
    // Rematch: the host asks the server to reset the room to its lobby; the resulting
    // room info (started=false) brings every player back to the room screen (onRoom).
    onAgain: () => o.restartRoom(),
    againLabel: t('match.again'),
    canAgain: () => isRoomHost(lastRoom),
    againPending: true,
    hudExtra: hud,
  });
}

function isRoomHost(room: RoomInfo | null): boolean {
  return !!room && room.you >= 0 && !!room.seats[room.you]?.host;
}

/** After a refresh, silently try to resume an online session (token in sessionStorage). */
function tryResume(): void {
  if (!loadToken()) return;
  stopProbing();
  probing = true;
  // never probe (and mute errors) indefinitely, e.g. a server that never says welcome
  probeTimer = setTimeout(() => {
    probeTimer = null;
    abandonProbe('no welcome from the server');
  }, RESUME_PROBE_MAX_MS);
  ensureOnline();
}

// ---------------------------------------------------------------------------
// Steam (desktop build only)
// ---------------------------------------------------------------------------

/**
 * The Electron preload exposes `window.openRummyDesktop`; the browser never has it. On
 * desktop the page origin is `app://open-rummy`, so the WebSocket online mode connects to
 * the server URL main supplies (`app.info().onlineServerUrl`, default wss://www.chon9.com/ws)
 * and is hidden when main supplies none. Steam lobbies are offered next to it.
 */
const desktop = typeof window !== 'undefined' && window.openRummyDesktop !== undefined;
let steamFlow: Promise<SteamFlow> | null = null;
/** desktop only: whether a valid online server URL was configured (web: always same-origin) */
let desktopOnline = false;

/** Ask main for the online server URL (never rejects; gives up after 3 s and keeps online hidden). */
async function configureDesktopOnline(): Promise<void> {
  const bridge = window.openRummyDesktop;
  if (!bridge) return;
  try {
    const info = await Promise.race([
      bridge.app.info(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    desktopOnline = !!info && setServerUrl(info.onlineServerUrl);
  } catch (err) {
    console.error('[main] desktop app info failed', err);
  }
}

function loadSteam(): Promise<SteamFlow> {
  const bridge = window.openRummyDesktop;
  if (!bridge) return Promise.reject(new Error('desktop bridge unavailable'));
  if (!steamFlow) {
    steamFlow = import('./ui/steamFlow').then((m) =>
      m.createSteamFlow({
        bridge,
        show,
        openTable,
        endGame,
        tableTransport: () => game?.transport ?? null,
        goTitle,
      }),
    );
    steamFlow.catch(() => {
      steamFlow = null;
    });
  }
  return steamFlow;
}

function openSteam(): void {
  loadSteam()
    .then((f) => f.open())
    .catch((err) => {
      console.error('[main] Steam module failed to load', err);
      toast(t('steam.unavailable'), 'error');
    });
}

// ---------------------------------------------------------------------------
// title & static screens
// ---------------------------------------------------------------------------

function goTitle(): void {
  endGame();
  show(() =>
    titleScreen({
      offline: showOfflineLobby,
      online: !desktop || desktopOnline ? showOnlineLobby : undefined,
      steam: desktop ? openSteam : undefined,
      rules: () => show(() => rulesScreen(goTitle)),
      settings: () => openSettings({ onQuality: (q) => game?.scene?.setQuality(q) }),
      credits: () => show(() => creditsScreen(goTitle)),
    }),
  );
}

window.addEventListener('unhandledrejection', (e) => {
  console.error('[main] unhandled rejection', e.reason);
});

if (desktop) {
  void configureDesktopOnline().then(() => {
    goTitle();
    // invites accepted in the Steam overlay (or a `+connect_lobby` launch) join right away
    loadSteam()
      .then((f) => f.init())
      .catch((err) => console.error('[main] Steam module failed to load', err));
  });
} else {
  goTitle();
  tryResume();
}
