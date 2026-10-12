/**
 * HTTP + WebSocket server assembly. `startServer` is used by main.ts and by the
 * tests (which start it in-process on an ephemeral port).
 *
 * Abuse limits (all in memory, keyed by client address, see limits.ts):
 *  - total and per-IP concurrent WebSocket connections, per-IP connection rate;
 *  - `hello` must arrive within a few seconds of connecting (idle sockets are closed);
 *  - per-socket message rate (token bucket) and inbound frame size (ws maxPayload);
 *  - join attempts per socket and per IP (room code guessing);
 *  - live rooms per creating IP (in RoomManager);
 *  - a socket that stops reading (send buffer keeps growing) is dropped.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { HEARTBEAT_MS, PROTOCOL_VERSION, WS_PATH, type ClientMessage, type ServerMessage } from '@open-rummy/shared';
import type { ServerConfig } from './config';
import { KeyedCounter, KeyedLimiter, clientIp, limitKey } from './limits';
import { RoomManager, type Result, type RoomManagerOptions } from './rooms';
import { MAX_MESSAGE_BYTES, Session, SessionStore, TokenBucket, parseClientMessage, sanitizeBotLevel, sanitizeRules } from './session';
import { createStaticHandler, securityHeaders } from './static';

/** Tunable abuse limits (defaults below); tests override some of them. */
export interface LimitOptions {
  /** close sockets that have not sent `hello` within this time */
  helloTimeoutMs: number;
  /** new WebSocket connections per IP: refill rate per second and burst */
  connRate: number;
  connBurst: number;
  /** join_room attempts per socket: refill rate per second and burst */
  joinRatePerSocket: number;
  joinBurstPerSocket: number;
  /** join_room attempts per IP: refill rate per second and burst */
  joinRatePerIp: number;
  joinBurstPerIp: number;
  /** drop a socket whose unsent data exceeds this many bytes (slow or non-reading client) */
  maxBufferedBytes: number;
}

export const DEFAULT_LIMITS: LimitOptions = {
  helloTimeoutMs: 10_000,
  connRate: 1,
  connBurst: 30,
  joinRatePerSocket: 0.2,
  joinBurstPerSocket: 5,
  joinRatePerIp: 0.5,
  joinBurstPerIp: 20,
  maxBufferedBytes: 1024 * 1024,
};

type LimitConfigKeys = 'trustProxy' | 'maxConnections' | 'maxConnsPerIp' | 'maxRoomsPerIp';

export interface StartOptions extends Omit<ServerConfig, LimitConfigKeys>, Partial<Pick<ServerConfig, LimitConfigKeys>> {
  heartbeatMs?: number;
  /** interval of the room/session garbage collector */
  sweepMs?: number;
  rooms?: Omit<RoomManagerOptions, 'maxRooms' | 'maxRoomsPerIp'>;
  limits?: Partial<LimitOptions>;
  /** disable request/connection logging (tests) */
  quiet?: boolean;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Rate-limit violations tolerated (per socket) before the socket is closed. */
const MAX_VIOLATIONS = 20;

/** Per-socket state. */
interface Conn {
  ws: WebSocket;
  /** limit key of the client address */
  ip: string;
  session: Session | null;
  bucket: TokenBucket;
  joinBucket: TokenBucket;
  violations: number;
  alive: boolean;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

export async function startServer(cfg: StartOptions): Promise<RunningServer> {
  const started = Date.now();
  const log = (...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    if (!cfg.quiet) console.log(new Date().toISOString(), ...args);
  };
  const limits: LimitOptions = { ...DEFAULT_LIMITS, ...cfg.limits };
  const trustProxy = cfg.trustProxy ?? 0;
  const maxConnections = cfg.maxConnections ?? 4000;
  const maxConnsPerIp = cfg.maxConnsPerIp ?? 20;
  const allowedOrigins = cfg.allowedOrigins.map((o) => o.toLowerCase());

  const sessions = new SessionStore();
  const conns = new Set<Conn>();
  const connsPerIp = new KeyedCounter();
  const connLimiter = new KeyedLimiter(limits.connRate, limits.connBurst);
  const joinLimiter = new KeyedLimiter(limits.joinRatePerIp, limits.joinBurstPerIp);

  const sendTo = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    // A client that stops reading makes our send buffer grow without bound; cut it off.
    if (ws.bufferedAmount > limits.maxBufferedBytes) {
      ws.terminate();
      return;
    }
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket is closing; the close handler cleans up
    }
  };
  const rooms = new RoomManager(
    sessions,
    (s, msg) => {
      if (s.ws) sendTo(s.ws, msg);
    },
    { maxRooms: cfg.maxRooms, maxRoomsPerIp: cfg.maxRoomsPerIp, ...cfg.rooms },
  );

  // ---------------------------------------------------------------- HTTP ----
  const serveStatic = createStaticHandler(cfg.webRoot);
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...securityHeaders(req), Allow: 'GET, HEAD', 'Content-Length': 0 });
        res.end();
        return;
      }
      const players = [...sessions.values()].filter((s) => s.connected).length;
      const body = JSON.stringify({ ok: true, rooms: rooms.roomCount, players, uptime: Math.round((Date.now() - started) / 1000) });
      res.writeHead(200, {
        ...securityHeaders(req),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    serveStatic(req, res).catch((e: unknown) => {
      log('static error', e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  // ----------------------------------------------------------- WebSocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    // Node removes its own error handler from upgraded sockets; without one, a reset
    // during the handshake would be an uncaught 'error' event.
    socket.on('error', () => socket.destroy());
    const pathname = (req.url ?? '').split('?')[0];
    const reject = (status: number, text: string): void => {
      if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (pathname !== WS_PATH) return reject(404, 'Not Found');
    const origin = req.headers.origin;
    // Browsers always send Origin; non-browser clients may omit it (and could forge it anyway).
    if (allowedOrigins.length > 0 && origin !== undefined && !allowedOrigins.includes(origin.replace(/\/+$/, '').toLowerCase())) {
      return reject(403, 'Forbidden');
    }
    const ip = limitKey(clientIp(req, trustProxy));
    if (conns.size >= maxConnections) return reject(503, 'Service Unavailable');
    if (connsPerIp.get(ip) >= maxConnsPerIp || !connLimiter.take(ip)) return reject(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  function onConnection(ws: WebSocket, ip: string): void {
    const conn: Conn = {
      ws,
      ip,
      session: null,
      bucket: new TokenBucket(20, 40),
      joinBucket: new TokenBucket(limits.joinRatePerSocket, limits.joinBurstPerSocket),
      violations: 0,
      alive: true,
      helloTimer: null,
    };
    conns.add(conn);
    connsPerIp.inc(ip);
    // A socket that never says hello only costs us memory; close it.
    conn.helloTimer = setTimeout(() => {
      conn.helloTimer = null;
      if (!conn.session) ws.close(1008, 'hello timeout');
    }, limits.helloTimeoutMs);
    conn.helloTimer.unref?.();

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      conn.alive = true;
      if (!conn.bucket.take()) {
        conn.violations++;
        if (conn.violations > MAX_VIOLATIONS) {
          ws.close(1008, 'rate limit');
          return;
        }
        sendTo(ws, { t: 'error', code: 'RATE_LIMIT', message: 'Too many messages' });
        return;
      }
      const text = isBinary ? null : rawToString(data);
      const msg = text === null ? null : parseClientMessage(text);
      if (!msg) {
        sendTo(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Malformed message' });
        return;
      }
      try {
        handle(conn, msg);
      } catch (e) {
        log('handler error', e instanceof Error ? (e.stack ?? e.message) : e);
        sendTo(ws, { t: 'error', code: 'SERVER', message: 'Internal error' });
      }
    });
    ws.on('close', () => {
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
      if (conns.delete(conn)) connsPerIp.dec(ip);
      const s = conn.session;
      // Only detach if this socket is still the session's current one (not replaced).
      if (s && s.ws === ws) {
        s.ws = null;
        s.lastSeen = Date.now();
        try {
          rooms.disconnected(s);
        } catch (e) {
          log('disconnect error', e instanceof Error ? (e.stack ?? e.message) : e);
        }
      }
    });
    ws.on('error', () => {
      // 'close' follows
    });
  }

  function handle(conn: Conn, msg: ClientMessage): void {
    const ws = conn.ws;
    const error = (r: Result): void => {
      if (!r.ok) sendTo(ws, { t: 'error', code: r.code, message: r.message });
    };

    if (msg.t === 'ping') {
      sendTo(ws, { t: 'pong' });
      return;
    }
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) {
        sendTo(ws, { t: 'error', code: 'VERSION', message: `Server speaks protocol ${PROTOCOL_VERSION}` });
        ws.close(1002, 'version');
        return;
      }
      if (conn.session) {
        sendTo(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Already greeted' });
        return;
      }
      let session = msg.token ? sessions.get(msg.token) : undefined;
      const resumed = session !== undefined;
      if (!session) session = sessions.create(msg.name) ?? undefined;
      if (!session) {
        sendTo(ws, { t: 'error', code: 'SERVER', message: 'Server is full' });
        ws.close(1013, 'full');
        return;
      }
      // A newer socket takes over the session; the old one is closed.
      const old = session.ws;
      if (old && old !== ws) {
        session.ws = null;
        old.close(4001, 'replaced');
      }
      session.ws = ws;
      session.ip = conn.ip;
      session.lastSeen = Date.now();
      conn.session = session;
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
      sendTo(ws, { t: 'welcome', v: PROTOCOL_VERSION, token: session.token, resumed });
      if (resumed) rooms.resume(session);
      return;
    }

    const s = conn.session;
    if (!s) {
      sendTo(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Send hello first' });
      return;
    }
    switch (msg.t) {
      case 'create_room':
        error(rooms.create(s, msg.name, msg.avatar, sanitizeRules(msg.cfg), sanitizeBotLevel(msg.botLevel)));
        break;
      case 'join_room':
        // Room codes are the only secret protecting a lobby: throttle guessing per socket and per IP.
        if (!conn.joinBucket.take() || !joinLimiter.take(conn.ip)) {
          sendTo(ws, { t: 'error', code: 'RATE_LIMIT', message: 'Too many join attempts, wait a moment' });
          break;
        }
        error(rooms.join(s, msg.code, msg.name, msg.avatar));
        break;
      case 'set_avatar':
        error(rooms.setAvatar(s, msg.avatar));
        break;
      case 'add_bot':
        error(rooms.addBot(s));
        break;
      case 'remove_seat':
        error(rooms.removeSeat(s, msg.seat));
        break;
      case 'start_game':
        error(rooms.start(s));
        break;
      case 'restart_room':
        error(rooms.restart(s));
        break;
      case 'action':
        error(rooms.action(s, msg.action));
        break;
      case 'emote':
        error(rooms.emote(s, msg.id));
        break;
      case 'leave_room':
        error(rooms.leave(s, true));
        break;
    }
  }

  // ---------------------------------------------------- Timers & shutdown ----
  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // closing
      }
    }
  }, cfg.heartbeatMs ?? HEARTBEAT_MS);
  const sweeper = setInterval(() => {
    const now = Date.now();
    try {
      rooms.sweep(now);
      sessions.gc(now);
      connLimiter.gc(now);
      joinLimiter.gc(now);
    } catch (e) {
      log('sweep error', e instanceof Error ? (e.stack ?? e.message) : e);
    }
  }, cfg.sweepMs ?? 60_000);
  heartbeat.unref();
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (e) => log('http server error', e instanceof Error ? e.message : e));
  const port = (server.address() as AddressInfo).port;
  log(`Open Rummy server listening on http://${cfg.host}:${port} (web root ${cfg.webRoot})`);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      rooms.disposeAll();
      for (const c of conns) c.ws.close(1001, 'server shutting down');
      // Give close frames a moment, then force anything left.
      const force = setTimeout(() => {
        for (const c of conns) c.ws.terminate();
        server.closeAllConnections();
      }, 1000);
      force.unref();
      wss.close();
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });
    return closing;
  };

  return { port, close };
}

function rawToString(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.length > MAX_MESSAGE_BYTES ? null : data.toString('utf8');
  if (Array.isArray(data)) {
    const buf = Buffer.concat(data);
    return buf.length > MAX_MESSAGE_BYTES ? null : buf.toString('utf8');
  }
  const buf = Buffer.from(data);
  return buf.length > MAX_MESSAGE_BYTES ? null : buf.toString('utf8');
}
