/**
 * Open Rummy desktop - Electron main process.
 *
 * - Serves the Vite-built renderer (dist/renderer) through the privileged `app://open-rummy/`
 *   scheme (file:// breaks fetch() of the .vrm avatars and module scripts).
 * - Owns Steam through a SteamBackend: SteamService (steamworks.js) by default, or
 *   MockSteamService (loopback relay, no Steam) with OPEN_RUMMY_STEAM=mock. OPEN_RUMMY_STEAM=off
 *   disables Steam. Steam failure is non-fatal: `steam.available() -> {ok:false}`, offline play works.
 * - Exposes the contract in packages/client/src/net/desktopBridge.ts through preload.ts.
 *
 * Command line:
 *   --dev          DevTools (F12) and the menu bar; renderer console mirrored to stdout
 *   --profile=N    (1..999) separate userData dir and NO single-instance lock, so several
 *                  instances can run side by side (pair with OPEN_RUMMY_STEAM=mock)
 *   --server=<url> online (WebSocket) server; same as env OPEN_RUMMY_SERVER. Default
 *                  wss://www.chon9.com/ws; `off` hides the online mode. Must be wss:// (ws:// only
 *                  on loopback). The page CSP allows exactly that origin.
 *   +connect_lobby <id>  Steam invite launch (handled by the backend)
 *
 * Smoke mode (verification): OPEN_RUMMY_SMOKE=1 quits ~OPEN_RUMMY_SMOKE_MS (default 8000)
 * after did-finish-load; OPEN_RUMMY_SMOKE_SHOT=<png path> also captures the window;
 * OPEN_RUMMY_SMOKE_STEAM=lobby|host|guest runs a lobby / P2P scenario through the real
 * preload bridge first (see smokeSteam below).
 */
import { app, BrowserWindow, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DESKTOP_BRIDGE_VERSION, type DesktopAppInfo, type SteamResult } from '../../packages/client/src/net/desktopBridge';
import { IPC, isLobbyKey, isLobbyValue, isPayload, isSteamIdString, sanitizeCreateOpts, sanitizeLobbyData } from './channels';
import { errMessage, resolveAppId, type SteamBackend } from './steam/backend';
import { MockSteamService } from './steam/mock';
import { SteamService } from './steam/service';
import { SMOKE_SCENARIOS, runSmokeUi, type SmokeScenario } from './smokeUi';
import { DEFAULT_DESKTOP_SERVER_URL, normaliseServerUrl, serverOrigin } from '../../packages/client/src/net/serverUrl';

const SCHEME = 'app';
const HOST = 'open-rummy';
const ORIGIN = `${SCHEME}://${HOST}/`;
const START_URL = `${ORIGIN}index.html`;
const WINDOW_TITLE = 'Open Rummy 拉米麻将';
const DEV = process.argv.includes('--dev');
const PROFILE = parseProfile(process.argv);
/** --smoke-test=<scenario> (or OPEN_RUMMY_SMOKE_UI): drive the UI, screenshot, quit (smokeUi.ts) */
const SMOKE_UI = parseSmokeUi(argValue('--smoke-test') ?? process.env.OPEN_RUMMY_SMOKE_UI);
const SMOKE = process.env.OPEN_RUMMY_SMOKE === '1' || SMOKE_UI !== null;

/** dist/ holds main.js, preload.js and renderer/ (see build.mjs and vite.config.ts) */
const distDir = __dirname;
const rendererDir = path.join(distDir, 'renderer');

const log = (...args: unknown[]): void => console.log(`[open-rummy${PROFILE === null ? '' : ` p${PROFILE}`}]`, ...args);

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/**
 * The online (WebSocket) server: `--server=` beats OPEN_RUMMY_SERVER beats the default. `off` /
 * `none` disables the online mode; an invalid value disables it too (logged), never falls back
 * to a different server silently.
 */
function resolveOnlineServer(): { url: string | null; source: string } {
  const arg = argValue('--server');
  const env = process.env.OPEN_RUMMY_SERVER;
  const [raw, source] =
    arg !== undefined ? [arg, '--server'] : env !== undefined && env.trim() !== '' ? [env, 'OPEN_RUMMY_SERVER'] : [DEFAULT_DESKTOP_SERVER_URL, 'default'];
  if (/^(off|none)$/i.test(raw.trim())) return { url: null, source };
  return { url: normaliseServerUrl(raw), source };
}

function parseSmokeUi(v: string | undefined): SmokeScenario | null {
  return v && (SMOKE_SCENARIOS as readonly string[]).includes(v) ? (v as SmokeScenario) : null;
}

function parseProfile(argv: readonly string[]): number | null {
  for (const a of argv) {
    const m = /^--profile=(\d{1,3})$/.exec(a);
    if (m && Number(m[1]) >= 1) return Number(m[1]);
  }
  return null;
}

// --- instances: one per user normally; --profile=N runs isolated side-by-side copies -------
if (PROFILE !== null) {
  app.setPath('userData', `${app.getPath('userData')}-profile-${PROFILE}`);
} else if (!app.requestSingleInstanceLock()) {
  // a second launch (e.g. Steam "+connect_lobby") is forwarded to the first via 'second-instance'
  app.quit();
  process.exit(0);
}

// --- Steam: the real init must run before 'ready' so the overlay switches still apply ------
const steamMode = (process.env.OPEN_RUMMY_STEAM ?? '').trim().toLowerCase();
let steam: SteamBackend;
if (steamMode === 'mock') {
  steam = new MockSteamService(PROFILE, log);
  log('steam backend: mock loopback relay');
} else {
  const { appId, source } = resolveAppId(app.getAppPath(), path.dirname(process.execPath));
  const real = new SteamService(appId, log);
  steam = real;
  if (steamMode === 'off') {
    log('steam disabled by OPEN_RUMMY_STEAM=off');
  } else {
    const status = real.initSync();
    if (status.ok) {
      real.enableOverlay();
      log(`steam init ok appId=${status.appId} (from ${source})`);
      if (SMOKE && process.env.OPEN_RUMMY_SMOKE_PRINT_PERSONA === '1') log(`steam persona: ${real.me()?.name ?? '(none)'}`);
    } else {
      log(`steam unavailable (appId=${appId} from ${source}): ${status.reason}`);
    }
  }
}
const steamReady: Promise<unknown> = steam.kind === 'mock' ? steam.init() : Promise.resolve();

const ONLINE = resolveOnlineServer();
log(ONLINE.url ? `online server ${ONLINE.url} (${ONLINE.source})` : `online mode off (${ONLINE.source}${ONLINE.source === 'default' ? '' : ': off or invalid URL'})`);

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** The built renderer uses only same-origin module scripts/assets; inline styles come from three/gsap/ui code. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  // only the configured online (WebSocket) server; Steam P2P goes through IPC, assets are app://
  `connect-src 'self' data: blob:${ONLINE.url ? ` ${serverOrigin(ONLINE.url)}` : ''}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (req) => {
    try {
      const url = new URL(req.url);
      if (url.host !== HOST) return new Response('not found', { status: 404 });
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(rendererDir, rel));
      if (!file.startsWith(rendererDir + path.sep)) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
      if (file.endsWith('.vrm')) headers.set('Content-Type', 'model/gltf-binary');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      log(`app:// handler failed: ${errMessage(err)}`);
      return new Response('error', { status: 500 });
    }
  });
}

function hardenSession(): void {
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(allowed.has(permission) && wc.getURL().startsWith(ORIGIN));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && origin.startsWith(`${SCHEME}://${HOST}`));
}

function findIcon(): string | undefined {
  for (const name of ['icon.ico', 'icon.png']) {
    const p = path.join(distDir, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    backgroundColor: '#070b18',
    title: WINDOW_TITLE,
    icon: findIcon(),
    autoHideMenuBar: !DEV,
    webPreferences: {
      preload: path.join(distDir, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: DEV,
      // a networked game must keep running when minimised / covered: the guest's keepalive and
      // the host's GameHost timers (turn deadlines, bots) would otherwise be throttled (verified:
      // a minimised guest was dropped as silent and its table stopped animating)
      backgroundThrottling: false,
    },
  });
  if (!DEV) w.removeMenu();
  w.once('ready-to-show', () => w.show());
  // keep the bilingual window title instead of the page's <title>
  w.on('page-title-updated', (e) => e.preventDefault());

  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      e.preventDefault();
      w.setFullScreen(!w.isFullScreen());
    } else if (input.key === 'F12' && DEV) {
      e.preventDefault();
      w.webContents.toggleDevTools();
    }
  });

  // never navigate away from the app; https links open in the default browser
  w.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  w.webContents.on('will-redirect', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  w.webContents.on('did-finish-load', () => {
    log(`did-finish-load ${w.webContents.getURL()}`);
    if (SMOKE) void smokeFinish(w);
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url) => log(`did-fail-load ${code} ${desc} ${url}`));
  w.webContents.on('console-message', (details) => {
    if (SMOKE || DEV) log(`renderer ${details.level}: ${details.message}`);
  });
  w.webContents.on('render-process-gone', (_e, details) => log(`render-process-gone ${details.reason}`));

  void w.loadURL(START_URL);
  return w;
}

function openExternalSafe(url: string): void {
  try {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url);
  } catch {
    // malformed URL: ignore
  }
}

// --- smoke mode ------------------------------------------------------------------

async function smokeFinish(w: BrowserWindow): Promise<void> {
  if (SMOKE_UI) {
    const dir = argValue('--smoke-dir') ?? process.env.OPEN_RUMMY_SMOKE_DIR ?? null;
    const num = (v: string | undefined, d: number): number => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
    const ok = await runSmokeUi(w, {
      scenario: SMOKE_UI,
      dir: dir ? path.resolve(dir) : null,
      turns: num(process.env.OPEN_RUMMY_SMOKE_TURNS, 4),
      holdMs: num(process.env.OPEN_RUMMY_SMOKE_HOLD_MS, 0),
      log,
    });
    log(`smoke-ui result=${ok ? 'PASS' : 'FAIL'}, quitting`);
    setTimeout(() => app.quit(), 1500);
    return;
  }
  try {
    const scenario = process.env.OPEN_RUMMY_SMOKE_STEAM;
    if (scenario === 'lobby' || scenario === 'host' || scenario === 'guest') await smokeSteam(w, scenario);
    const delay = Number(process.env.OPEN_RUMMY_SMOKE_MS ?? 8000);
    await new Promise((r) => setTimeout(r, Number.isFinite(delay) ? delay : 8000));
    const shot = process.env.OPEN_RUMMY_SMOKE_SHOT;
    if (shot && !w.isDestroyed()) {
      const img = await w.webContents.capturePage();
      fs.writeFileSync(shot, img.toPNG());
      log(`smoke screenshot ${img.getSize().width}x${img.getSize().height} -> ${shot}`);
    }
    if (!w.isDestroyed()) {
      const title = await w.webContents.executeJavaScript('document.title');
      const bridge = await w.webContents.executeJavaScript('typeof window.openRummyDesktop');
      log(`smoke document.title=${JSON.stringify(title)} window.title=${JSON.stringify(w.getTitle())} bridge=${bridge}`);
      const webgl2 = await w.webContents.executeJavaScript("!!document.createElement('canvas').getContext('webgl2')");
      const vrm = fs.readdirSync(path.join(rendererDir, 'avatars')).find((f) => f.endsWith('.vrm'));
      const fetched = vrm
        ? await w.webContents.executeJavaScript(
            `fetch('./avatars/${vrm}').then(async (r) => r.status + ' ' + (await r.arrayBuffer()).byteLength + 'B ' + r.headers.get('content-type')).catch((e) => 'ERR ' + e)`,
          )
        : 'no .vrm found';
      log(`smoke webgl2=${webgl2} fetch avatars/${vrm}: ${fetched}`);
      const steamAvail = await w.webContents.executeJavaScript('window.openRummyDesktop.steam.available().then(JSON.stringify)');
      log(`smoke bridge steam.available()=${steamAvail}`);
    }
  } catch (err) {
    log(`smoke failed: ${errMessage(err)}`);
  }
  log('smoke done, quitting');
  app.quit();
}

/**
 * Runs inside the renderer through window.openRummyDesktop (preload -> IPC -> backend), so
 * it exercises the whole bridge. Logs lengths/counts only (no ids or names).
 * - lobby: create a private lobby, read it back, set data, leave.
 * - host:  create a public lobby, wait for a guest's {"t":"ping"}, answer {"t":"pong"}, leave.
 * - guest: find the lobby via listLobbies, join, ping the owner, wait for the pong, leave.
 */
async function smokeSteam(w: BrowserWindow, scenario: 'lobby' | 'host' | 'guest'): Promise<void> {
  const script = `(async () => {
    const s = window.openRummyDesktop.steam;
    const out = [];
    const events = [];
    const offEvt = s.onLobbyEvent((e) => events.push(e.type));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitMsg = (want, ms) => new Promise((res) => {
      const t = setTimeout(() => { off(); res(null); }, ms);
      const off = s.onMessage((from, data) => { if (data === want) { clearTimeout(t); off(); res(from); } });
    });
    const avail = await s.available();
    out.push('available=' + avail.ok);
    if (!avail.ok) return out.join(' | ');
    const scenario = ${JSON.stringify(scenario)};
    if (scenario === 'lobby') {
      const r = await s.createLobby({ visibility: 'private', maxMembers: 4, data: { host: 'smoke' } });
      out.push('create ok=' + r.ok + (r.ok ? ' idLen=' + r.value.lobbyId.length + ' members=' + r.value.members.length + ' isOwner=' + r.value.members[0].isOwner + ' game=' + r.value.data.game + ' version=' + r.value.data.version : ' reason=' + r.reason + ' ' + (r.message || '')));
      if (r.ok) {
        const set = await s.setLobbyDataMany({ seats: '1/4', started: '0' });
        await sleep(500);
        out.push('setData ok=' + set.ok + ' read seats=' + (await s.getLobbyData('seats')));
        const cur = await s.currentLobby();
        out.push('current matches=' + (!!cur && cur.lobbyId === r.value.lobbyId));
        out.push('sendTo self -> ' + JSON.stringify(await s.sendTo((await s.me()).steamId, 'x')));
        await s.leaveLobby();
        out.push('after leave current=' + JSON.stringify(await s.currentLobby()));
      }
    } else if (scenario === 'host') {
      const r = await s.createLobby({ visibility: 'public', maxMembers: 2, data: { host: 'smoke-host', seats: '1/2' } });
      out.push('create ok=' + r.ok + (r.ok ? ' idLen=' + r.value.lobbyId.length : ''));
      if (r.ok) {
        const from = await waitMsg('{"t":"ping"}', 45000);
        out.push('ping received=' + !!from);
        if (from) out.push('pong sent=' + JSON.stringify(await s.sendTo(from, '{"t":"pong"}')));
        const members = await s.lobbyMembers();
        out.push('members=' + members.length);
        await sleep(3000);
        await s.leaveLobby();
      }
    } else {
      let lobbyId = null;
      for (let i = 0; i < 40 && !lobbyId; i++) {
        const list = await s.listLobbies();
        if (list.ok && list.value.length) lobbyId = list.value[0].lobbyId;
        else await sleep(500);
      }
      out.push('listed=' + !!lobbyId);
      if (lobbyId) {
        const j = await s.joinLobby(lobbyId);
        out.push('join ok=' + j.ok + (j.ok ? ' members=' + j.value.members.length : ' reason=' + j.reason));
        if (j.ok) {
          const pong = waitMsg('{"t":"pong"}', 15000);
          out.push('ping sent=' + JSON.stringify(await s.sendTo(j.value.ownerId, '{"t":"ping"}')));
          out.push('pong received=' + !!(await pong));
          await sleep(1500);
          await s.leaveLobby();
        }
      }
    }
    await sleep(300);
    offEvt();
    out.push('events=' + events.join(','));
    return out.join(' | ');
  })()`;
  const result = await w.webContents.executeJavaScript(script);
  log(`smoke steam ${scenario}: ${String(result)}`);
}

// --- IPC -------------------------------------------------------------------------

/** only our own window/page may call the bridge */
function trusted(e: IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && e.sender === win.webContents && (e.senderFrame?.url ?? '').startsWith(ORIGIN);
}

const INVALID = { ok: false, reason: 'invalid' } as const satisfies SteamResult;

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    try {
      return await fn(...args);
    } catch (err) {
      log(`ipc ${channel} failed: ${errMessage(err)}`);
      throw new Error(`${channel} failed`);
    }
  });
}

function registerIpc(): void {
  handle(IPC.appInfo, (): DesktopAppInfo => ({
    appVersion: app.getVersion(),
    bridgeVersion: DESKTOP_BRIDGE_VERSION,
    electronVersion: process.versions.electron,
    platform: process.platform,
    packaged: app.isPackaged,
    onlineServerUrl: ONLINE.url,
  }));
  handle(IPC.appQuit, () => {
    app.quit();
  });
  handle(IPC.appToggleFullscreen, () => {
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });

  handle(IPC.steamAvailable, async () => {
    await steamReady;
    return steam.available();
  });
  handle(IPC.steamMe, async () => {
    await steamReady;
    return steam.me();
  });

  handle(IPC.steamCreateLobby, (opts) => {
    const clean = sanitizeCreateOpts(opts);
    return clean ? steam.createLobby(clean) : INVALID;
  });
  handle(IPC.steamJoinLobby, (id) => (isSteamIdString(id) ? steam.joinLobby(id) : INVALID));
  handle(IPC.steamLeaveLobby, () => steam.leaveLobby());
  handle(IPC.steamCurrentLobby, () => steam.currentLobby());
  handle(IPC.steamLobbyMembers, () => steam.lobbyMembers());
  handle(IPC.steamListLobbies, () => steam.listLobbies());
  handle(IPC.steamSetLobbyData, (key, value) => (isLobbyKey(key) && isLobbyValue(value) ? steam.setLobbyData(key, value) : INVALID));
  handle(IPC.steamSetLobbyDataMany, (data) => {
    const clean = sanitizeLobbyData(data);
    return clean ? steam.setLobbyDataMany(clean) : INVALID;
  });
  handle(IPC.steamGetLobbyData, (key) => (isLobbyKey(key) ? steam.getLobbyData(key) : null));
  handle(IPC.steamSetLobbyJoinable, (joinable) => (typeof joinable === 'boolean' ? steam.setLobbyJoinable(joinable) : INVALID));
  handle(IPC.steamOpenInviteDialog, () => steam.openInviteDialog());
  handle(IPC.steamAvatar, (id) => (isSteamIdString(id) ? steam.avatarDataUrl(id) : null));
  handle(IPC.steamConsumePendingJoin, () => steam.consumePendingJoin());
  handle(IPC.steamSendTo, (id, data) => (isSteamIdString(id) && isPayload(data) ? steam.sendTo(id, data) : INVALID));
  handle(IPC.steamBroadcast, (data) => (isPayload(data) ? steam.broadcast(data) : INVALID));

  // main -> renderer pushes (one channel each)
  steam.onLobbyEvent((evt) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.evtLobby, evt);
  });
  steam.onMessage((from, data) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.evtMessage, from, data);
  });
}

// --- lifecycle -------------------------------------------------------------------

app.on('second-instance', (_e, argv) => {
  steam.handleArgv(argv);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(ORIGIN)) ev.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => app.quit());

let shuttingDown = false;
app.on('will-quit', (e) => {
  if (shuttingDown) return;
  // leave the Steam lobby before exiting (members get a clean 'left' instead of a timeout)
  shuttingDown = true;
  e.preventDefault();
  const done = (): void => app.exit(0);
  const timer = setTimeout(done, 1500);
  steam.dispose().then(
    () => {
      clearTimeout(timer);
      done();
    },
    () => {
      clearTimeout(timer);
      done();
    },
  );
});

process.on('uncaughtException', (err) => log(`uncaught exception: ${errMessage(err)}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${errMessage(err)}`));

void app.whenReady().then(() => {
  hardenSession();
  registerAppProtocol();
  registerIpc();
  win = createWindow();
  win.on('closed', () => {
    win = null;
  });
  steam.handleArgv(process.argv);
});
