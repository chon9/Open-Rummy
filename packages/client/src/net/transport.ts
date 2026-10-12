/**
 * Transport abstraction: the UI and 3D scene only talk to a Transport, so offline
 * (local GameHost + bots) and online (WebSocket to the authoritative server) share
 * 100% of the presentation code.
 */
import type { Action, GameEvent, PlayerView, RoomInfo } from '@open-rummy/shared';

export interface TransportHandlers {
  /** new projected view + the events that led to it (play events before reconciling) */
  onGame(view: PlayerView, events: GameEvent[]): void;
  /** lobby/room info (online only) */
  onRoom?(room: RoomInfo): void;
  onEmote?(seat: number, id: string): void;
  onError?(message: string): void;
  /** connection state changes (online only) */
  onConnection?(state: 'connecting' | 'open' | 'closed'): void;
}

export interface Transport {
  readonly kind: 'local' | 'online';
  /**
   * false when decisions have no enforced deadline (offline relaxed mode): the UI
   * must then hide every countdown. Deadlines delivered in views are always in the
   * LOCAL clock (online transports correct them for server clock skew).
   */
  readonly timersEnabled: boolean;
  setHandlers(h: TransportHandlers): void;
  send(action: Action): void;
  emote(id: string): void;
  /** offline only: advance from HAND_END immediately */
  advance?(): void;
  dispose(): void;
}
