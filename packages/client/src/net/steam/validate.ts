/**
 * Validation of Steam P2P payloads. Nothing that arrives over P2P is trusted:
 * main already drops oversized packets and non-members, but the renderer checks
 * size, JSON, envelope type and every field again before use.
 *
 * Guest -> host parsing is the WebSocket server's own validator (`parseClientMessage`
 * in packages/shared/src/validate.ts) restricted to the envelopes a guest may send
 * (`SteamGuestMessage`). Host -> guest parsing reuses the WebSocket client's
 * `parseServerMessage` behind a byte cap.
 */
import { MAX_MESSAGE_BYTES, parseClientMessage, utf8Length, type ServerMessage } from '@open-rummy/shared';
import { DESKTOP_LIMITS, type SteamGuestMessage, type SteamRoomExtras } from '../desktopBridge';
import { parseServerMessage } from '../online';

export { TokenBucket, sanitizeAvatar, sanitizeName, utf8Length } from '@open-rummy/shared';

/** Max UTF-8 bytes of a guest message (the server's MAX_MESSAGE_BYTES). */
export const MAX_GUEST_MESSAGE_BYTES = MAX_MESSAGE_BYTES;
/** Max UTF-8 bytes of a host message (the bridge limit). */
export const MAX_HOST_MESSAGE_BYTES = DESKTOP_LIMITS.maxP2PMessageBytes;

const STEAM_ID_RE = /^\d{1,20}$/;

export function isSteamId(v: unknown): v is string {
  return typeof v === 'string' && STEAM_ID_RE.test(v);
}

/**
 * Parse one guest -> host payload. Returns null for anything malformed or not allowed
 * from a guest (room management such as start_game / add_bot stays local to the host).
 * Unknown extra fields (e.g. a claimed `seat`) are dropped: the host derives the seat
 * from the sender's Steam id only. Session tokens are meaningless over Steam (identity is
 * the Steam id), so a well-formed `hello.token` is dropped too.
 */
export function parseGuestMessage(data: unknown): SteamGuestMessage | null {
  const msg = parseClientMessage(data);
  if (!msg) return null;
  switch (msg.t) {
    case 'hello':
      return { t: 'hello', v: msg.v, name: msg.name };
    case 'set_avatar':
    case 'action':
    case 'emote':
    case 'leave_room':
    case 'ping':
      return msg;
    default:
      return null;
  }
}

/** A host -> guest `room` envelope may carry whether the host chose relaxed mode (contract: SteamRoomExtras). */
export type { SteamRoomExtras } from '../desktopBridge';

/** Parse one host -> guest payload (byte cap, then the WebSocket client's structural checks). */
export function parseHostMessage(data: unknown): (ServerMessage & SteamRoomExtras) | null {
  if (typeof data !== 'string' || data.length > MAX_HOST_MESSAGE_BYTES || utf8Length(data) > MAX_HOST_MESSAGE_BYTES) return null;
  const msg = parseServerMessage(data) as (ServerMessage & SteamRoomExtras) | null;
  if (!msg) return null;
  if (msg.t === 'room') {
    const room = msg.room;
    if (!Number.isInteger(room.you) || room.seats.length > 8 || typeof room.started !== 'boolean') return null;
    if (msg.relaxed !== undefined && typeof msg.relaxed !== 'boolean') delete msg.relaxed;
  }
  if (msg.t === 'game') {
    const v = msg.view as unknown as Record<string, unknown>;
    if (!Number.isInteger(v.you) || !Number.isInteger(v.version) || !Number.isInteger(v.handNo)) return null;
  }
  if (msg.t === 'emote' && !Number.isInteger(msg.seat)) return null;
  return msg;
}
