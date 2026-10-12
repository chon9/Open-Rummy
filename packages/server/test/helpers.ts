/** Shared test utilities: a promise-friendly WebSocket test client and raw HTTP helpers. */
import http from 'node:http';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type RoomInfo, type ServerMessage } from '@open-rummy/shared';

export class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  /** raw frames as received (for leak scans) */
  readonly raw: string[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closed = false;
  closeCode: number | null = null;

  constructor(url: string, opts?: { origin?: string; headers?: Record<string, string> }) {
    this.ws = new WebSocket(url, opts);
    this.ws.on('message', (data) => {
      const text = String(data);
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerMessage;
      this.inbox.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    // Rejected handshakes surface through open(); keep stray errors from failing the run.
    this.ws.on('error', () => undefined);
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  /** Accepts any object so tests can send deliberately malformed messages. */
  send(msg: ClientMessage | object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for a matching message that arrives after this call. */
  next<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, ms?: number): Promise<T>;
  next(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  next(pred: (m: ServerMessage) => boolean, ms = 5000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async hello(name: string, token?: string): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
    const p = this.next((m) => m.t === 'welcome');
    this.send(token ? { t: 'hello', v: PROTOCOL_VERSION, name, token } : { t: 'hello', v: PROTOCOL_VERSION, name });
    return (await p) as Extract<ServerMessage, { t: 'welcome' }>;
  }

  /** Resolves with the close code once the socket is closed. */
  waitClosed(ms = 5000): Promise<number> {
    if (this.closed) return Promise.resolve(this.closeCode ?? 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), ms);
      this.ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      if (this.ws.readyState === this.ws.CONNECTING) this.ws.terminate();
      else this.ws.close();
    });
  }
}

export const isRoom = (pred: (r: RoomInfo) => boolean) => (m: ServerMessage) => m.t === 'room' && pred(m.room);
export const isGame = (m: ServerMessage): m is Extract<ServerMessage, { t: 'game' }> => m.t === 'game';
export const isError = (code: string) => (m: ServerMessage) => m.t === 'error' && m.code === code;

export interface HttpResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** Raw HTTP request; http.request sends the path verbatim (no normalisation). */
export function httpRequest(port: number, rawPath: string, method = 'GET', headers?: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

export const httpGet = (port: number, rawPath: string): Promise<HttpResult> => httpRequest(port, rawPath, 'GET');

/** Expect a WebSocket handshake to be refused; resolves with the error message (contains the status). */
export function expectRejected(url: string, opts?: { origin?: string; headers?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('handshake unexpectedly succeeded'));
    });
    ws.once('error', (e) => resolve(e.message));
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
