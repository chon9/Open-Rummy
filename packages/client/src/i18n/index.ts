/**
 * Minimal i18n: Simplified Chinese (default) and English.
 * `zh.ts` is the source of truth for keys; `en.ts` is type-checked to cover every key.
 */
import { zh } from './zh';
import { en } from './en';

export type Lang = 'zh' | 'en';
export type I18nKey = keyof typeof zh;
export type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Record<I18nKey, string>> = { zh, en };

let current: Lang = 'zh';
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang !== 'zh' && lang !== 'en') return;
  const changed = lang !== current;
  current = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
  if (changed) for (const fn of listeners) fn(lang);
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translate `key`, replacing `{name}` placeholders with `vars`. */
export function t(key: I18nKey, vars?: Vars): string {
  const raw = DICTS[current][key] ?? zh[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Translate a dynamically built key; falls back to `fallback` (or the key) when missing. */
export function tDyn(key: string, vars?: Vars, fallback?: string): string {
  if (key in zh) return t(key as I18nKey, vars);
  return fallback ?? key;
}

/** Pick the localized variant of a bilingual pair (e.g. avatar names). */
export function pick(zhText: string, enText: string): string {
  return current === 'zh' ? zhText : enText;
}
