/**
 * IPC channel names and argument guards shared by main.ts and preload.ts (both validate:
 * preload before sending, main again on receipt). Renderer code never sees these: it only
 * talks to window.openRummyDesktop. Must stay free of Node/Electron imports (sandboxed preload).
 */
import { DESKTOP_LIMITS, type CreateLobbyOptions, type LobbyVisibility } from '../../packages/client/src/net/desktopBridge';

export const IPC = {
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appToggleFullscreen: 'app:toggle-fullscreen',

  steamAvailable: 'steam:available',
  steamMe: 'steam:me',
  steamCreateLobby: 'steam:create-lobby',
  steamJoinLobby: 'steam:join-lobby',
  steamLeaveLobby: 'steam:leave-lobby',
  steamCurrentLobby: 'steam:current-lobby',
  steamLobbyMembers: 'steam:lobby-members',
  steamListLobbies: 'steam:list-lobbies',
  steamSetLobbyData: 'steam:set-lobby-data',
  steamSetLobbyDataMany: 'steam:set-lobby-data-many',
  steamGetLobbyData: 'steam:get-lobby-data',
  steamSetLobbyJoinable: 'steam:set-lobby-joinable',
  steamOpenInviteDialog: 'steam:open-invite-dialog',
  steamAvatar: 'steam:avatar',
  steamSendTo: 'steam:send-to',
  steamBroadcast: 'steam:broadcast',
  steamConsumePendingJoin: 'steam:consume-pending-join',

  /** main -> renderer push channels */
  evtMessage: 'steam:evt-message',
  evtLobby: 'steam:evt-lobby',
} as const;

/** 64-bit Steam id as a decimal string (no sign, no leading +, at most 20 digits). */
export function isSteamIdString(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) > 0n && BigInt(v) <= 0xffff_ffff_ffff_ffffn;
}

/** UTF-8 byte length without allocating a Buffer (works in sandboxed preload and main). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const LOBBY_KEY_RE = /^[A-Za-z0-9_.:-]+$/;
const VISIBILITIES: readonly LobbyVisibility[] = ['private', 'friends', 'public', 'invisible'];

export function isLobbyKey(k: unknown): k is string {
  return typeof k === 'string' && k.length > 0 && k.length <= DESKTOP_LIMITS.maxLobbyKeyLength && LOBBY_KEY_RE.test(k);
}

export function isLobbyValue(v: unknown): v is string {
  return typeof v === 'string' && v.length <= DESKTOP_LIMITS.maxLobbyValueLength;
}

/** P2P payload: a string of at most DESKTOP_LIMITS.maxP2PMessageBytes UTF-8 bytes */
export function isPayload(d: unknown): d is string {
  return typeof d === 'string' && d.length <= DESKTOP_LIMITS.maxP2PMessageBytes && utf8Length(d) <= DESKTOP_LIMITS.maxP2PMessageBytes;
}

const MAX_LOBBY_DATA_ENTRIES = 32;

/** plain record of valid lobby keys/values (at most 32 entries), or null */
export function sanitizeLobbyData(data: unknown): Record<string, string> | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length > MAX_LOBBY_DATA_ENTRIES) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!isLobbyKey(k) || !isLobbyValue(v)) return null;
    out[k] = v;
  }
  return out;
}

/** validated copy of CreateLobbyOptions (unknown fields dropped), or null when invalid */
export function sanitizeCreateOpts(opts: unknown): CreateLobbyOptions | null {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== 'object' || Array.isArray(opts)) return null;
  const o = opts as Record<string, unknown>;
  const out: CreateLobbyOptions = {};
  if (o.visibility !== undefined) {
    if (!VISIBILITIES.includes(o.visibility as LobbyVisibility)) return null;
    out.visibility = o.visibility as LobbyVisibility;
  }
  if (o.maxMembers !== undefined) {
    const n = o.maxMembers;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > DESKTOP_LIMITS.maxLobbyMembers) return null;
    out.maxMembers = n;
  }
  if (o.data !== undefined) {
    const data = sanitizeLobbyData(o.data);
    if (!data) return null;
    out.data = data;
  }
  return out;
}
