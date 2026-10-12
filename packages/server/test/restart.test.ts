/**
 * restart_room: after MATCH_END the host can return the same room to its lobby.
 * Driven directly through RoomManager with fake sockets so a full one-hand match
 * can be played out by bots (disconnected humans are autoplayed) in a few seconds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { resolveRules, type RoomInfo, type ServerMessage } from '@open-rummy/shared';
import { RoomManager } from '../src/rooms';
import { SessionStore, parseClientMessage, type Session } from '../src/session';

const FAKE_WS = {} as WebSocket;

interface Sent {
  token: string;
  msg: ServerMessage;
}

function setup() {
  const sessions = new SessionStore();
  const sent: Sent[] = [];
  const waiters: { pred: (x: Sent) => boolean; resolve: () => void }[] = [];
  const rooms = new RoomManager(
    sessions,
    (s, msg) => {
      const item = { token: s.token, msg };
      sent.push(item);
      for (const w of [...waiters]) {
        if (w.pred(item)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    },
    { maxRooms: 10, lobbyGraceMs: 60_000, hostOptions: { botDelayMs: [0, 5] } },
  );
  const until = (pred: (x: Sent) => boolean, ms = 20_000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (sent.some(pred)) return resolve();
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      waiters.push({
        pred,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  const lastRoom = (s: Session): RoomInfo | undefined => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const x = sent[i];
      if (x.token === s.token && x.msg.t === 'room') return x.msg.room;
    }
    return undefined;
  };
  const human = (name: string, connected: boolean): Session => {
    const s = sessions.create(name)!;
    s.ws = connected ? FAKE_WS : null;
    return s;
  };
  return { sessions, rooms, sent, until, lastRoom, human };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('restart_room', () => {
  it('parses restart_room', () => {
    expect(parseClientMessage('{"t":"restart_room"}')).toEqual({ t: 'restart_room' });
    expect(parseClientMessage('{"t":"restart_room","extra":1}')).toEqual({ t: 'restart_room' });
  });

  it('is host-only, refused before MATCH_END, then resets the room to its lobby', async () => {
    const { rooms, until, lastRoom, human } = setup();
    cleanup = () => rooms.disposeAll();
    const host = human('Host', true);
    const guest = human('Guest', true);
    const quitter = human('Quitter', true);
    const cfg = resolveRules({ players: 5, handsPerMatch: 1, handEndDelayMs: 10 });

    // not in a room / lobby
    expect(rooms.restart(host)).toMatchObject({ ok: false, code: 'NOT_IN_ROOM' });
    expect(rooms.create(host, 'Host', 'mei', cfg, 'easy')).toEqual({ ok: true });
    const code = lastRoom(host)!.code;
    expect(rooms.join(guest, code, 'Guest', 'kaya')).toEqual({ ok: true });
    expect(rooms.join(quitter, code, 'Quitter', 'pandan')).toEqual({ ok: true });
    expect(rooms.addBot(host)).toEqual({ ok: true });
    expect(rooms.restart(host)).toMatchObject({ ok: false, code: 'ILLEGAL' });

    expect(rooms.start(host)).toEqual({ ok: true });
    expect(lastRoom(host)!.started).toBe(true);
    // mid-match: refused, and only the host may ask
    expect(rooms.restart(guest)).toMatchObject({ ok: false, code: 'NOT_HOST' });
    expect(rooms.restart(host)).toMatchObject({ ok: false, code: 'ALREADY_STARTED' });

    // Everyone hands over to autoplay: the quitter leaves for good, the others drop.
    rooms.leave(quitter, true);
    host.ws = null;
    rooms.disconnected(host);
    guest.ws = null;
    rooms.disconnected(guest);

    await until((x) => x.token === host.token && x.msg.t === 'game' && x.msg.view.phase === 'MATCH_END');

    // Only the host comes back.
    host.ws = FAKE_WS;
    rooms.resume(host);
    expect(rooms.restart(guest)).toMatchObject({ ok: false, code: 'NOT_HOST' });
    expect(rooms.restart(host)).toEqual({ ok: true });

    const info = lastRoom(host)!;
    expect(info.code).toBe(code);
    expect(info.started).toBe(false);
    expect(info.you).toBe(0);
    expect(info.cfg.handsPerMatch).toBe(1);
    // host kept, disconnected guest freed, quitter (replaced by a bot) freed, the added bot and the start-filled bot kept
    expect(info.seats[0]).toMatchObject({ name: 'Host', host: true, isBot: false, connected: true });
    expect(info.seats[1]).toBeNull();
    expect(info.seats[2]).toBeNull();
    expect(info.seats[3]?.isBot).toBe(true);
    expect(info.seats[4]?.isBot).toBe(true);
    expect(guest.room).toBeNull();
    expect(guest.seat).toBe(-1);

    // the lobby works again: refill, restart a second match
    const late = human('Late', true);
    expect(rooms.join(late, code, 'Late', 'lingling')).toEqual({ ok: true });
    expect(lastRoom(late)!.you).toBe(1);
    expect(rooms.start(host)).toEqual({ ok: true });
    expect(lastRoom(late)!.started).toBe(true);
  }, 30_000);
});
