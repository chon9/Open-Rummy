/**
 * UI smoke scenarios (verification only): drive the REAL renderer UI of this window through
 * DOM clicks (title -> Steam lobby -> table) and capture the window with capturePage.
 *
 *   --smoke-test=<scenario>   (or OPEN_RUMMY_SMOKE_UI=<scenario>)
 *   --smoke-dir=<dir>         (or OPEN_RUMMY_SMOKE_DIR) where desktop-<scenario>-<step>.png go
 *   OPEN_RUMMY_SMOKE_TURNS    own decisions to play before leaving (default 4)
 *   OPEN_RUMMY_SMOKE_HOLD_MS  pause at the table before leaving (e.g. to test the overlay by hand)
 *
 * Scenarios:
 *   steam-solo  create a friends-only lobby, check our seat, start vs 3 bots, play turns via the
 *               hint button, leave the lobby (works with real Steam or the mock)
 *   mock-host   create a public lobby, wait for one guest, start (2 bots fill), play, wait until
 *               the guest's seat is taken over by a bot, leave
 *   mock-guest  find the lobby in the browser, join, play some turns, leave mid-game
 *   mock-host-quit   like mock-host, but the host leaves mid-game while the guest is still seated
 *   mock-guest-stay  like mock-guest, but keeps playing until the host leaves; expects the
 *                    "host left" notice and the Steam home screen (lobby left)
 *   online-check     title shows the Online Room item (desktop server URL configured), opening it
 *                    completes the WebSocket handshake (hello -> welcome) with the configured
 *                    server through the page CSP; no room is created
 *
 * Logged lines carry counts / booleans only: no Steam ids, no persona names.
 */
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type SmokeScenario = 'steam-solo' | 'mock-host' | 'mock-guest' | 'mock-host-quit' | 'mock-guest-stay' | 'online-check';
export const SMOKE_SCENARIOS: readonly SmokeScenario[] = ['steam-solo', 'mock-host', 'mock-guest', 'mock-host-quit', 'mock-guest-stay', 'online-check'];

export interface SmokeUiOptions {
  scenario: SmokeScenario;
  dir: string | null;
  turns: number;
  holdMs: number;
  log(...args: unknown[]): void;
}

/** In-page helpers, installed once as window.__smoke (plain JS, no imports). */
const HELPERS = `(() => {
  if (window.__smoke) return true;
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const S = {
    acts: 0,
    hints: 0,
    turns: 0,
    toasts: [],
    q: (sel) => document.querySelector(sel),
    qa: (sel) => Array.from(document.querySelectorAll(sel)),
    click(sel, pred) {
      const el = S.qa(sel).find((e) => visible(e) && !e.disabled && (!pred || pred(e)));
      if (!el) return false;
      el.click();
      return true;
    },
    // --- auto player: hint first, then the move the hint prepared, END TURN as the fallback ---
    driving: false,
    phase: 'idle',
    wait: 0,
    tick() {
      if (!S.q('.table-ui .action-bar')) return;
      // a picker opened by our move (joker swap, run order, extend end): take the first option
      const choice = S.qa('.modal-choice .choice').find(visible);
      if (choice) { choice.click(); return; }
      const buttons = S.qa('.table-ui .action-bar .bar-buttons button').filter((b) => visible(b) && !b.disabled);
      if (!buttons.length) {
        // our decision is over once the bar no longer offers anything (busy or not our turn)
        if (S.phase !== 'idle') S.turns++;
        S.phase = 'idle'; S.wait = 0; return;
      }
      const act = () => {
        const chip = S.qa('.table-ui .target-chip').find(visible);
        const b = chip || buttons.find((x) => x.classList.contains('btn-teal')) || buttons.find((x) => x.classList.contains('btn-gold'));
        if (b) { b.click(); S.acts++; }
        S.phase = 'acted';
        S.wait = 0;
      };
      if (S.phase === 'idle') {
        const hint = buttons.find((b) => b.classList.contains('btn-hint'));
        if (hint) { hint.click(); S.hints++; S.phase = 'hinted'; return; }
        act();
        return;
      }
      if (S.phase === 'hinted') { act(); return; }
      // 'acted' and still our decision: the prepared move did not go through
      S.wait++;
      if (S.wait === 4) {
        const gold = buttons.find((b) => b.classList.contains('btn-gold'));
        if (gold) { gold.click(); S.acts++; }
      } else if (S.wait >= 8) {
        S.phase = 'idle';
        S.wait = 0;
      }
    },
    drive() {
      if (S.driving) return;
      S.driving = true;
      setInterval(() => { try { S.tick(); } catch (e) { console.warn('smoke tick', e); } }, 700);
      new MutationObserver((list) => {
        for (const m of list) for (const n of m.addedNodes) if (n.classList && n.classList.contains('toast')) S.toasts.push(n.textContent || '');
      }).observe(document.body, { childList: true, subtree: true });
    },
  };
  window.__smoke = S;
  return true;
})()`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSmokeUi(w: BrowserWindow, o: SmokeUiOptions): Promise<boolean> {
  const wc = w.webContents;
  const js = <T = unknown>(code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>;
  const tag = `smoke-ui ${o.scenario}`;
  const step = (msg: string): void => o.log(`${tag}: ${msg}`);
  let shotNo = 0;
  const shot = async (name: string): Promise<void> => {
    if (!o.dir || w.isDestroyed()) return;
    const img = await wc.capturePage();
    const file = path.join(o.dir, `desktop-${o.scenario}-${String(++shotNo).padStart(2, '0')}-${name}.png`);
    fs.mkdirSync(o.dir, { recursive: true });
    fs.writeFileSync(file, img.toPNG());
    step(`screenshot ${img.getSize().width}x${img.getSize().height} -> ${path.basename(file)}`);
  };
  const waitFor = async (what: string, cond: string, ms: number, every = 250): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (w.isDestroyed()) return false;
      if (await js<boolean>(`!!(${cond})`).catch(() => false)) {
        step(`ok ${what}`);
        return true;
      }
      await sleep(every);
    }
    step(`FAIL ${what} (timeout ${ms} ms)`);
    return false;
  };
  const must = async (what: string, cond: string, ms: number): Promise<void> => {
    if (!(await waitFor(what, cond, ms))) throw new Error(`step failed: ${what}`);
  };
  const tableUp = "document.querySelector('.table-ui') && document.querySelector('canvas')";
  const humansInRoom =
    "Array.from(document.querySelectorAll('.steam-room .room-seat')).filter((e) => !e.classList.contains('empty') && !e.querySelector('.tag-bot')).length";

  const isHost = o.scenario === 'steam-solo' || o.scenario === 'mock-host' || o.scenario === 'mock-host-quit';
  const isMockHost = o.scenario === 'mock-host' || o.scenario === 'mock-host-quit';
  const isGuest = o.scenario === 'mock-guest' || o.scenario === 'mock-guest-stay';
  const errorToasts = "__smoke.toasts.filter((t) => /error|failed|失败/i.test(t)).length";

  try {
    await js(HELPERS);
    if (o.scenario === 'online-check') {
      // the Online Room item is the menu entry that is neither Steam nor the first (vs bots) one
      const onlineItem = "__smoke.qa('.menu .menu-item').find((b) => /online|在线/i.test(b.textContent) && !/steam/i.test(b.textContent))";
      await must('title screen with the Online Room item', `${onlineItem}`, 15_000);
      await js(`${onlineItem}.click()`);
      await must('online lobby: WebSocket handshake done (connected)', "document.querySelector('.conn.conn-open')", 20_000);
      await shot('online-lobby');
      // the page CSP must allow only the configured server: a socket to any other host is refused
      const blocked = await js<boolean>(`new Promise((resolve) => {
        const onViolation = (e) => { if (e.violatedDirective.startsWith('connect-src')) { cleanup(); resolve(true); } };
        const cleanup = () => document.removeEventListener('securitypolicyviolation', onViolation);
        document.addEventListener('securitypolicyviolation', onViolation);
        try { const s = new WebSocket('wss://example.com/ws'); s.onopen = () => { s.close(); cleanup(); resolve(false); }; }
        catch { cleanup(); resolve(true); }
        setTimeout(() => { cleanup(); resolve(false); }, 5000);
      })`);
      step(`${blocked ? 'ok' : 'FAIL'} CSP refuses a WebSocket to another host`);
      if (!blocked) throw new Error('step failed: CSP connect-src');
      step(`error-looking toasts=${await js<number>(errorToasts)}`);
      step('PASS');
      return true;
    }
    await js('__smoke.drive()');
    await must('title screen with the Steam button', `__smoke.qa('.menu .menu-item').some((b) => /steam/i.test(b.textContent))`, 15_000);
    await sleep(2000); // the title fades in
    await shot('title');
    await js(`__smoke.click('.menu .menu-item', (b) => /steam/i.test(b.textContent))`);
    await must('Steam home: signed in', "document.querySelector('.steam-screen .steam-status.ok')", 20_000);
    await shot('steam-home');

    if (isHost) {
      const which = o.scenario === 'steam-solo' ? 'btn-gold' : 'btn-teal'; // friends-only / public
      await must('create button enabled', `document.querySelector('.steam-create-row .${which}:not([disabled])')`, 10_000);
      await js(`__smoke.click('.steam-create-row .${which}')`);
      await must('lobby room shows ourselves as host', "document.querySelector('.steam-room .room-seat.is-you .tag-host')", 30_000);
      const lobbyOk = await js<boolean>('window.openRummyDesktop.steam.currentLobby().then((l) => !!l && l.members.length >= 1 && l.members.some((m) => m.isOwner))');
      step(`currentLobby owned by us=${lobbyOk}`);
      if (isMockHost) {
        await must('a guest is seated', `${humansInRoom} >= 2`, 120_000);
      }
      await shot('lobby');
      await js(`__smoke.click('.steam-room .room-controls .btn-gold.btn-xl')`);
    } else {
      // mock-guest: browse until the host's lobby shows up, then join it
      const end = Date.now() + 120_000;
      let joined = false;
      while (!joined && Date.now() < end) {
        joined = await js<boolean>(`__smoke.click('.steam-lobby-row .btn-teal')`);
        if (!joined) {
          await sleep(1500);
          await js(`__smoke.click('.steam-browse-head .chip-btn')`);
          await sleep(800);
        }
      }
      if (!joined) throw new Error('step failed: lobby listed');
      step('ok lobby listed and join clicked');
      // the host may start the moment we are seated, so the table can replace the room quickly
      await must(
        'seated by the host (lobby room shows us, or the table is already up)',
        `(document.querySelector('.steam-room .room-seat.is-you') && !document.querySelector('.steam-room .room-seat.is-you .tag-host')) || (${tableUp})`,
        30_000,
      );
      step(`humans in room=${await js<number>(humansInRoom)}`);
      await shot('lobby');
    }

    await must('3D table up', tableUp, 60_000);
    const webgl = await js<boolean>("(() => { const c = document.querySelector('canvas'); return !!c && c.width > 0 && c.height > 0; })()");
    step(`table canvas sized=${webgl}`);
    await sleep(6000); // avatars stream in
    await shot('table');

    const turns = isGuest ? Math.min(o.turns, 3) : o.turns;
    await waitFor(`${turns} own decisions played via hint`, `__smoke.turns >= ${turns}`, 240_000, 1000);
    step(`decisions=${await js<number>('__smoke.turns')} clicks=${await js<number>('__smoke.acts')} hints=${await js<number>('__smoke.hints')}`);
    await shot('played');

    if (o.scenario === 'mock-host') {
      // the guest leaves mid-game: its seat must turn into a bot (host toast + seat name)
      const converted = await waitFor(
        'guest seat taken over by a bot',
        "__smoke.toasts.some((t) => /Mock Player 2/.test(t))",
        240_000,
        500,
      );
      step(`bot takeover notice=${converted}`);
      await sleep(4000);
      await shot('after-guest-left');
      const moreTurns = await js<number>('__smoke.turns');
      await waitFor('host keeps playing after the takeover', `__smoke.turns > ${moreTurns}`, 120_000, 1000);
    }

    if (o.scenario === 'mock-guest-stay') {
      // keep playing until the host closes the table: notice + back on the Steam home, lobby left
      const hostLeft = "Array.from(document.querySelectorAll('.modal')).some((m) => /房主已离开|host left/i.test(m.textContent || ''))";
      await must('"host left" notice', hostLeft, 300_000);
      await must('back on the Steam home screen', "document.querySelector('.steam-screen .steam-status')", 10_000);
      await sleep(1500);
      step(`left lobby (currentLobby null)=${await js<boolean>('window.openRummyDesktop.steam.currentLobby().then((l) => l === null)')}`);
      await shot('host-left');
      step(`error-looking toasts=${await js<number>(errorToasts)}`);
      step('PASS');
      return true;
    }

    if (o.holdMs > 0) {
      step(`holding ${o.holdMs} ms at the table`);
      await sleep(o.holdMs);
    }

    // leave through the table UI (confirm modal)
    await js(`__smoke.click('.table-ui .hud-buttons .icon-btn:last-child')`);
    await must('leave confirmation', "document.querySelector('.modal-actions .btn-danger')", 5000);
    await js(`__smoke.click('.modal-actions .btn-danger')`);
    await must('back on the Steam home screen', "document.querySelector('.steam-screen .steam-status')", 10_000);
    await sleep(1500);
    const lobbyAfter = await js<boolean>('window.openRummyDesktop.steam.currentLobby().then((l) => l === null)');
    step(`left lobby (currentLobby null)=${lobbyAfter}`);
    await shot('left');
    const errors = await js<number>(errorToasts);
    step(`error-looking toasts=${errors}`);
    step('PASS');
    return true;
  } catch (err) {
    step(`ABORT ${err instanceof Error ? err.message : String(err)}`);
    await shot('abort').catch(() => undefined);
    return false;
  }
}
