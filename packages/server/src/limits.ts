/**
 * Abuse limits keyed by client address: client IP resolution (proxy aware),
 * per-IP token buckets (connections, join attempts) and per-IP counters
 * (open connections). Everything is in memory and garbage-collected so idle
 * keys do not accumulate.
 */
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import { TokenBucket } from './session';

/** Strip the IPv4-mapped IPv6 prefix and zone ids; return '' for anything that is not an IP. */
function normaliseIp(raw: string | undefined): string {
  if (!raw) return '';
  let ip = raw.trim();
  // "[::1]:1234" or "1.2.3.4:5678" as some proxies send them
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : '';
}

/**
 * Client address of a request. X-Forwarded-For is only consulted when
 * `trustProxy` > 0, and then only the entries appended by trusted proxies are
 * used: with one hop the last entry is the address nginx (or the load
 * balancer) saw; anything to its left is client-supplied and spoofable.
 */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  const socketIp = normaliseIp(req.socket.remoteAddress) || 'unknown';
  if (trustProxy <= 0) return socketIp;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return socketIp;
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return socketIp;
  // With n trusted hops the client is the n-th entry from the right (or the leftmost if fewer).
  const idx = Math.max(0, parts.length - trustProxy);
  return normaliseIp(parts[idx]) || socketIp;
}

/** Expand an IPv6 address into its 8 hextets (no validation beyond net.isIPv6). */
function hextets(ip: string): string[] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip;
  // embedded IPv4 tail (e.g. ::ffff:1.2.3.4 or 64:ff9b::1.2.3.4)
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  if (tail === null) return h.length === 8 ? h : null;
  const t = tail ? tail.split(':') : [];
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  return [...h, ...new Array<string>(fill).fill('0'), ...t];
}

/**
 * Key used for per-client limits. IPv6 users usually get a whole /64, so
 * addresses are grouped by that prefix; IPv4 addresses are used as-is.
 */
export function limitKey(ip: string): string {
  const h = hextets(ip);
  if (!h) return ip;
  return h
    .slice(0, 4)
    .map((x) => parseInt(x, 16).toString(16))
    .join(':') + '::/64';
}

/** Token buckets per key, dropped once they have refilled (idle). */
export class KeyedLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.rate, this.burst, now);
      this.buckets.set(key, b);
    }
    return b.take(now);
  }

  /** Forget keys whose bucket is full again (nothing to remember). */
  gc(now = Date.now()): void {
    for (const [k, b] of this.buckets) if (b.isFull(now)) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Reference counts per key (e.g. open connections per IP); zero entries are removed. */
export class KeyedCounter {
  private readonly counts = new Map<string, number>();

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  inc(key: string): void {
    this.counts.set(key, this.get(key) + 1);
  }

  dec(key: string): void {
    const n = this.get(key) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
  }

  get size(): number {
    return this.counts.size;
  }
}
