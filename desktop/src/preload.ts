/**
 * Preload (sandboxed, contextIsolation on). Exposes `window.openRummyDesktop`, the
 * contract in packages/client/src/net/desktopBridge.ts, and nothing else. Every
 * argument is checked here before it crosses IPC; main checks again (channels.ts guards).
 * Event payloads from main are re-checked before they reach renderer callbacks.
 * Bundled by build.mjs into dist/preload.js (only `electron` stays external).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LobbyEvent, OpenRummyDesktopBridge, SteamResult } from '../../packages/client/src/net/desktopBridge';
import { IPC, isLobbyKey, isLobbyValue, isPayload, isSteamIdString, sanitizeCreateOpts, sanitizeLobbyData } from './channels';

const invalid = (message: string): SteamResult<never> => ({ ok: false, reason: 'invalid', message });

function subscribe(channel: string, accept: (args: unknown[]) => boolean, deliver: (args: unknown[]) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => {
    if (!accept(args)) return;
    try {
      deliver(args);
    } catch (err) {
      // a throwing renderer callback must not break other listeners
      console.error('openRummyDesktop listener failed', err);
    }
  };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const isLobbyEvent = (v: unknown): v is LobbyEvent =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

const bridge: OpenRummyDesktopBridge = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    quit: () => ipcRenderer.invoke(IPC.appQuit),
    toggleFullscreen: () => ipcRenderer.invoke(IPC.appToggleFullscreen),
  },
  steam: {
    available: () => ipcRenderer.invoke(IPC.steamAvailable),
    me: () => ipcRenderer.invoke(IPC.steamMe),

    createLobby: async (opts) => {
      const clean = sanitizeCreateOpts(opts);
      return clean ? ipcRenderer.invoke(IPC.steamCreateLobby, clean) : invalid('bad lobby options');
    },
    joinLobby: async (lobbyId) =>
      isSteamIdString(lobbyId) ? ipcRenderer.invoke(IPC.steamJoinLobby, lobbyId) : invalid('bad lobby id'),
    leaveLobby: () => ipcRenderer.invoke(IPC.steamLeaveLobby),
    currentLobby: () => ipcRenderer.invoke(IPC.steamCurrentLobby),
    lobbyMembers: () => ipcRenderer.invoke(IPC.steamLobbyMembers),
    listLobbies: () => ipcRenderer.invoke(IPC.steamListLobbies),
    setLobbyData: async (key, value) =>
      isLobbyKey(key) && isLobbyValue(value) ? ipcRenderer.invoke(IPC.steamSetLobbyData, key, value) : invalid('bad lobby data'),
    setLobbyDataMany: async (data) => {
      const clean = sanitizeLobbyData(data);
      return clean ? ipcRenderer.invoke(IPC.steamSetLobbyDataMany, clean) : invalid('bad lobby data');
    },
    getLobbyData: async (key) => (isLobbyKey(key) ? ipcRenderer.invoke(IPC.steamGetLobbyData, key) : null),
    setLobbyJoinable: async (joinable) =>
      typeof joinable === 'boolean' ? ipcRenderer.invoke(IPC.steamSetLobbyJoinable, joinable) : invalid('bad flag'),
    openInviteDialog: () => ipcRenderer.invoke(IPC.steamOpenInviteDialog),
    avatarDataUrl: async (steamId) => (isSteamIdString(steamId) ? ipcRenderer.invoke(IPC.steamAvatar, steamId) : null),
    consumePendingJoin: () => ipcRenderer.invoke(IPC.steamConsumePendingJoin),

    sendTo: async (steamId, data) =>
      isSteamIdString(steamId) && isPayload(data) ? ipcRenderer.invoke(IPC.steamSendTo, steamId, data) : invalid('bad peer or payload'),
    broadcast: async (data) => (isPayload(data) ? ipcRenderer.invoke(IPC.steamBroadcast, data) : invalid('bad payload')),

    onMessage: (cb) => {
      if (typeof cb !== 'function') throw new TypeError('callback required');
      return subscribe(
        IPC.evtMessage,
        ([from, data]) => isSteamIdString(from) && typeof data === 'string',
        ([from, data]) => cb(from as string, data as string),
      );
    },
    onLobbyEvent: (cb) => {
      if (typeof cb !== 'function') throw new TypeError('callback required');
      return subscribe(
        IPC.evtLobby,
        ([evt]) => isLobbyEvent(evt),
        ([evt]) => cb(evt as LobbyEvent),
      );
    },
  },
};

contextBridge.exposeInMainWorld('openRummyDesktop', bridge);
