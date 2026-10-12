/**
 * Persisted player preferences (localStorage). Every storage access is wrapped in
 * try/catch: private mode or blocked storage must never break the game.
 */
import type { BotLevel, RulesConfig } from '@open-rummy/shared';
import type { Lang } from '../i18n';
import type { Quality } from '../scene/api';

export interface Prefs {
  lang: Lang;
  quality: Quality;
  sound: boolean;
  /** 0..1 */
  volume: number;
  /** offline: no turn timers */
  relaxed: boolean;
  /** offline: start the next hand automatically after a countdown */
  autoNext: boolean;
  name: string;
  avatar: string;
  botLevel: BotLevel;
  /** rule overrides relative to DEFAULT_RULES */
  rules: Partial<RulesConfig>;
}

const KEY = 'openrummy.prefs.v1';

function defaults(): Prefs {
  // Simplified Chinese is the default for everyone (Malaysian Chinese players); English is a toggle.
  const lang: Lang = 'zh';
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  return {
    lang,
    quality: coarse ? 'low' : 'medium',
    sound: true,
    volume: 0.7,
    relaxed: true,
    autoNext: false,
    name: '',
    avatar: '',
    botLevel: 'normal',
    rules: {},
  };
}

let prefs: Prefs = load();

function load(): Prefs {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const data = JSON.parse(raw) as Partial<Prefs>;
    if (data.lang === 'zh' || data.lang === 'en') base.lang = data.lang;
    if (data.quality === 'low' || data.quality === 'medium' || data.quality === 'high') base.quality = data.quality;
    if (typeof data.sound === 'boolean') base.sound = data.sound;
    if (typeof data.volume === 'number' && data.volume >= 0 && data.volume <= 1) base.volume = data.volume;
    if (typeof data.relaxed === 'boolean') base.relaxed = data.relaxed;
    if (typeof data.autoNext === 'boolean') base.autoNext = data.autoNext;
    if (typeof data.name === 'string') base.name = data.name.slice(0, 16);
    if (typeof data.avatar === 'string') base.avatar = data.avatar.slice(0, 64);
    if (data.botLevel === 'easy' || data.botLevel === 'normal' || data.botLevel === 'hard') base.botLevel = data.botLevel;
    if (data.rules && typeof data.rules === 'object') base.rules = data.rules;
  } catch {
    // unreadable storage: keep defaults
  }
  return base;
}

export function getPrefs(): Readonly<Prefs> {
  return prefs;
}

export function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage full or blocked: preferences just won't persist
  }
}
