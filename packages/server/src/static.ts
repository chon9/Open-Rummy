/**
 * Static file serving for the built client: safe path resolution (no traversal),
 * MIME types (VRM/GLB included), long-lived caching for hashed /assets/*, and a
 * SPA fallback to index.html for extension-less routes.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  // VRM avatars are glTF binaries.
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

export function mimeType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Host header values that are safe to echo into the CSP (host, host:port, [v6]:port). */
const SAFE_HOST_RE = /^(?:[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

/**
 * Content-Security-Policy for the built client (kept in line with deploy/nginx/open-rummy.conf):
 *  - scripts only from our origin (Vite emits external module scripts, no inline ones);
 *  - 'unsafe-inline' styles: index.html has a small pre-boot <style> and the UI sets inline styles;
 *  - three.js / GLTFLoader decode textures through blob: URLs, small assets may be data: URLs;
 *  - connect-src names ws(s)://host explicitly for browsers without CSP3 'self' websocket matching.
 */
export function contentSecurityPolicy(host: string | undefined): string {
  const wsHosts = host && SAFE_HOST_RE.test(host) ? ` ws://${host} wss://${host}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${wsHosts} blob: data:`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Security headers sent with every HTTP response (static files, errors, health check). */
export function securityHeaders(req: IncomingMessage): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': contentSecurityPolicy(req.headers.host),
  };
}

/**
 * Map a URL pathname to a file inside `root`. Returns null for anything that is
 * malformed or would escape the root (encoded `..`, backslashes, NUL bytes, drive
 * letters / NTFS streams via `:`), and for dot-files and dot-directories
 * (`.env`, `.git/...`), which are never part of the client build.
 */
export function resolveSafePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) return null;
  // Reject `..` (and any other dot-leading) segment outright instead of relying on normalisation.
  if (decoded.split('/').some((seg) => seg.startsWith('.') && seg !== '.well-known')) return null;
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
  return full;
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...securityHeaders(req),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Stat a regular file that really lives inside `realRoot` (symlinks are resolved,
 * so a link inside the web root cannot expose files outside it). Returns the
 * resolved path to read from.
 */
async function statFile(file: string, realRoot: string): Promise<{ st: fs.Stats; real: string } | null> {
  try {
    const real = await fs.promises.realpath(file);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    const st = await fs.promises.stat(real);
    return st.isFile() ? { st, real } : null;
  } catch {
    return null;
  }
}

function cacheControl(pathname: string, file: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (path.extname(file) === '.html') return 'no-cache';
  return 'public, max-age=3600';
}

/** Create a request handler serving files from `root`. */
export function createStaticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const rootAbs = path.resolve(root);
  const indexFile = path.join(rootAbs, 'index.html');
  // The root itself may be a symlink (e.g. a release directory); compare against its real path.
  let realRootP: Promise<string> | null = null;
  const realRoot = (): Promise<string> =>
    (realRootP ??= fs.promises.realpath(rootAbs).catch(() => {
      realRootP = null;
      return rootAbs;
    }));

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      send(req, res, 405, 'Method Not Allowed');
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0].split('#')[0];
    // Only origin-form targets ("/path"); absolute-form and "*" are not ours to serve.
    const resolved = rawPath.startsWith('/') ? resolveSafePath(rootAbs, rawPath) : null;
    if (resolved === null) {
      send(req, res, 400, 'Bad Request');
      return;
    }
    const realRootDir = await realRoot();

    let file = resolved;
    let found = await statFile(file, realRootDir);
    if (!found && (rawPath.endsWith('/') || resolved === rootAbs)) {
      file = path.join(resolved, 'index.html');
      found = await statFile(file, realRootDir);
    }
    // SPA fallback: routes without a file extension get the app shell.
    if (!found && path.extname(resolved) === '' && !rawPath.startsWith('/assets/')) {
      file = indexFile;
      found = await statFile(file, realRootDir);
    }
    if (!found) {
      send(req, res, 404, 'Not Found');
      return;
    }
    const { st, real } = found;

    res.writeHead(200, {
      ...securityHeaders(req),
      'Content-Type': mimeType(file),
      'Content-Length': st.size,
      'Cache-Control': cacheControl(rawPath, file),
      'Last-Modified': st.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}
