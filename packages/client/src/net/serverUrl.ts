/**
 * WebSocket server URL handling for the online (server) mode.
 *
 * - Browser build: same origin as the page (`/ws` on the host that served the client).
 * - Desktop build: the page origin is `app://open-rummy`, so the Electron main process
 *   supplies an explicit URL (`DesktopAppInfo.onlineServerUrl`, default
 *   `DEFAULT_DESKTOP_SERVER_URL`, overridable with OPEN_RUMMY_SERVER / `--server=`).
 *
 * Pure and import-free (no DOM, Node or workspace imports), so desktop/src/main.ts bundles
 * `normaliseServerUrl` / `serverOrigin` for its app info and CSP.
 */

/** Same as `WS_PATH` in @open-rummy/shared (asserted by serverUrl.test.ts; not imported, see above). */
export const WS_PATH = '/ws';

/** The project's deployed server; the desktop build's default online server. */
export const DEFAULT_DESKTOP_SERVER_URL = 'wss://www.chon9.com/ws';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate and normalise a configured server URL. Accepts `wss://host[:port][/path]`
 * (`https://` is mapped to `wss://`); plain `ws://` / `http://` only for loopback hosts
 * (local development). An empty path becomes `/ws`. Credentials, query strings and
 * fragments are refused. Returns null when the value is not acceptable.
 */
export function normaliseServerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  let proto = url.protocol;
  if (proto === 'https:') proto = 'wss:';
  else if (proto === 'http:') proto = 'ws:';
  if (proto !== 'wss:' && proto !== 'ws:') return null;
  if (proto === 'ws:' && !LOOPBACK.has(url.hostname)) return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname === '' || url.pathname === '/' ? WS_PATH : url.pathname;
  return `${proto}//${url.host}${path}`;
}

/** CSP source expression (`wss://host[:port]`) for a normalised server URL. */
export function serverOrigin(normalised: string): string {
  const url = new URL(normalised);
  return `${url.protocol}//${url.host}`;
}

let configured: string | null = null;

/**
 * Use an explicit server URL instead of the page origin (desktop build). Invalid values
 * are ignored and leave the current setting. Returns whether the URL was accepted.
 */
export function setServerUrl(raw: unknown): boolean {
  const url = normaliseServerUrl(raw);
  if (!url) return false;
  configured = url;
  return true;
}

/** The WebSocket URL to connect to: the configured one, else same-origin `/ws`. */
export function serverUrl(): string {
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${WS_PATH}`;
}
