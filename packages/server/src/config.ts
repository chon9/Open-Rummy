/**
 * Server configuration. Read from environment variables only; the server needs
 * no secrets. See `.env.example` at the repo root.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  host: string;
  /** directory with the built client (index.html + assets) */
  webRoot: string;
  maxRooms: number;
  /** allowed WebSocket Origin values; empty = allow all */
  allowedOrigins: string[];
  production: boolean;
  /**
   * Number of reverse-proxy hops whose X-Forwarded-For entries are trusted (TRUST_PROXY).
   * 0 (default) = ignore X-Forwarded-For and use the socket address. 1 = one proxy (nginx,
   * a load balancer) appends the real client address as the last entry.
   */
  trustProxy: number;
  /** total concurrent WebSocket connections (MAX_CONNECTIONS) */
  maxConnections: number;
  /** concurrent WebSocket connections per client IP (MAX_CONNS_PER_IP) */
  maxConnsPerIp: number;
  /** concurrent rooms created from one client IP (MAX_ROOMS_PER_IP) */
  maxRoomsPerIp: number;
}

/**
 * Default web root: the client build next to this package. Resolved relative to
 * the running file, which is `packages/server/dist/server.js` for the bundle and
 * `packages/server/src/config.ts` under tsx; both are two levels below `packages/`.
 */
export function defaultWebRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../client/dist');
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid integer env value "${value}" (expected ${min}..${max})`);
  }
  return n;
}

/** TRUST_PROXY: unset/0/false = off, 1/true = one hop, n = n hops (max 10). */
function trustProxyEnv(value: string | undefined): number {
  const v = value?.trim().toLowerCase();
  if (!v || v === 'false' || v === 'no' || v === 'off') return 0;
  if (v === 'true' || v === 'yes' || v === 'on') return 1;
  return intEnv(v, 0, 0, 10);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const webRoot = env.WEB_ROOT?.trim();
  return {
    port: intEnv(env.PORT, 3001, 0, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    webRoot: webRoot ? path.resolve(webRoot) : defaultWebRoot(),
    maxRooms: intEnv(env.MAX_ROOMS, 500, 1, 100000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter((s) => s.length > 0),
    production: env.NODE_ENV === 'production',
    trustProxy: trustProxyEnv(env.TRUST_PROXY),
    maxConnections: intEnv(env.MAX_CONNECTIONS, 4000, 1, 1_000_000),
    maxConnsPerIp: intEnv(env.MAX_CONNS_PER_IP, 20, 1, 100_000),
    maxRoomsPerIp: intEnv(env.MAX_ROOMS_PER_IP, 5, 1, 100_000),
  };
}
