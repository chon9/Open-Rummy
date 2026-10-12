/**
 * WebSocket protocol between client and server. JSON envelopes `{ t, ...payload }`.
 * The server is authoritative: clients send intents, the server validates them
 * with the shared engine and broadcasts per-seat projected views.
 */
import type { RulesConfig } from './config';
import type { Action, GameEvent, PlayerView } from './types';
import type { BotLevel } from './bot';

export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';
export const HEARTBEAT_MS = 20000;
export const ROOM_CODE_LENGTH = 6;
export const MAX_NAME_LENGTH = 16;

export interface SeatInfo {
  seat: number;
  name: string;
  isBot: boolean;
  avatar: string;
  connected: boolean;
  /** this seat belongs to the room host */
  host: boolean;
}

export interface RoomInfo {
  code: string;
  seats: (SeatInfo | null)[];
  started: boolean;
  cfg: RulesConfig;
  botLevel: BotLevel;
  /** seat of the receiving client, -1 if spectating */
  you: number;
}

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; token?: string }
  | { t: 'create_room'; name: string; avatar: string; cfg?: Partial<RulesConfig>; botLevel?: BotLevel }
  | { t: 'join_room'; code: string; name: string; avatar: string }
  | { t: 'set_avatar'; avatar: string }
  | { t: 'add_bot' }
  | { t: 'remove_seat'; seat: number }
  | { t: 'start_game' }
  /** host only, after MATCH_END: reset the room to its lobby (same code, connected seats kept) */
  | { t: 'restart_room' }
  | { t: 'action'; action: Action }
  | { t: 'emote'; id: string }
  | { t: 'leave_room' }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; v: number; token: string; resumed: boolean }
  | { t: 'room'; room: RoomInfo }
  /** serverNow: server clock (ms) when sent, so clients can correct deadline countdowns for clock skew */
  | { t: 'game'; view: PlayerView; events: GameEvent[]; serverNow: number }
  | { t: 'emote'; seat: number; id: string }
  | { t: 'left' }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'VERSION'
  | 'NO_ROOM'
  | 'ROOM_FULL'
  | 'NOT_HOST'
  | 'NOT_IN_ROOM'
  | 'ALREADY_STARTED'
  | 'ILLEGAL'
  | 'RATE_LIMIT'
  | 'SERVER';

/** Emote ids understood by clients (rendered as avatar reactions + bubble). */
export const EMOTES = ['wave', 'laugh', 'cheer', 'cry', 'angry', 'think', 'gg', 'huat'] as const;
export type EmoteId = (typeof EMOTES)[number];
