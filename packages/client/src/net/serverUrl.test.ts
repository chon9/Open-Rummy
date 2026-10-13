import { describe, expect, it } from 'vitest';
import { WS_PATH as SHARED_WS_PATH } from '@open-rummy/shared';
import { DEFAULT_DESKTOP_SERVER_URL, WS_PATH, normaliseServerUrl, serverOrigin } from './serverUrl';

describe('online server URL', () => {
  it('matches the shared WebSocket path', () => {
    expect(WS_PATH).toBe(SHARED_WS_PATH);
  });

  it('accepts the desktop default and normalises https / bare hosts', () => {
    expect(normaliseServerUrl(DEFAULT_DESKTOP_SERVER_URL)).toBe('wss://www.chon9.com/ws');
    expect(normaliseServerUrl(' https://www.chon9.com ')).toBe('wss://www.chon9.com/ws');
    expect(normaliseServerUrl('wss://rummy.example.com:8443/game/ws')).toBe('wss://rummy.example.com:8443/game/ws');
    expect(normaliseServerUrl('ws://127.0.0.1:3001')).toBe('ws://127.0.0.1:3001/ws');
    expect(normaliseServerUrl('http://localhost:3001/ws')).toBe('ws://localhost:3001/ws');
  });

  it('refuses insecure remote, credentials, queries and junk', () => {
    for (const bad of [
      'ws://www.chon9.com/ws',
      'http://example.com',
      'wss://user:pw@example.com/ws',
      'wss://example.com/ws?x=1',
      'wss://example.com/ws#a',
      'ftp://example.com',
      'javascript:alert(1)',
      'app://open-rummy/ws',
      '',
      'off',
      42,
      null,
      `wss://${'a'.repeat(600)}.com`,
    ]) {
      expect(normaliseServerUrl(bad), String(bad)).toBeNull();
    }
  });

  it('derives the CSP origin', () => {
    expect(serverOrigin('wss://www.chon9.com/ws')).toBe('wss://www.chon9.com');
    expect(serverOrigin('ws://localhost:3001/ws')).toBe('ws://localhost:3001');
  });
});
