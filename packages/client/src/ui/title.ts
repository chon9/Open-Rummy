/**
 * Title screen: animated background with drifting tiles, the logo and the main menu.
 */
import { h } from './dom';
import type { Screen } from './screen';
import { sound } from './sound';
import { tileFace } from './tileView';
import { getLang, setLang, t } from '../i18n';
import { setPrefs } from './prefs';

export interface TitleNav {
  offline(): void;
  /** WebSocket online rooms (hidden when absent, e.g. in the desktop build) */
  online?(): void;
  /** Steam lobby (desktop build only; hidden when absent) */
  steam?(): void;
  rules(): void;
  settings(): void;
  credits(): void;
}

const FLOAT_TILES = ['RA_1', 'B10_1', 'Y7_1', 'GK_1', 'JK_1', 'R5_2', 'BQ_1', 'G3_1', 'Y9_2', 'RJ_1', 'JK_2', 'B2_1', 'GA_2', 'Y4_1'];

export function titleScreen(nav: TitleNav): Screen {
  // deterministic pseudo-random layout so the background looks the same each visit
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const floating = FLOAT_TILES.map((id, i) =>
    h('div', {
      class: 'float-tile',
      'aria-hidden': 'true',
      style: [
        `--x:${(rnd() * 100).toFixed(1)}%`,
        `--top:${(rnd() * 90).toFixed(1)}%`,
        `--delay:${(-rnd() * 24).toFixed(1)}s`,
        `--dur:${(18 + rnd() * 14).toFixed(1)}s`,
        `--rot:${(rnd() * 60 - 30).toFixed(0)}deg`,
        `--scale:${(0.6 + rnd() * 0.7).toFixed(2)}`,
        `--blur:${i % 3 === 0 ? 2 : 0}px`,
      ].join(';'),
    }, tileFace(id)),
  );

  const item = (label: string, sub: string, onClick: () => void, primary = false): HTMLElement =>
    h('button', {
      class: `menu-item ${primary ? 'primary' : ''}`,
      onclick: () => {
        sound.click();
        onClick();
      },
    }, h('span', { class: 'menu-label' }, label), h('span', { class: 'menu-sub' }, sub));

  const langBtn = h('button', {
    class: 'chip-btn lang-toggle',
    'aria-label': t('settings.language'),
    onclick: () => {
      const next = getLang() === 'zh' ? 'en' : 'zh';
      setPrefs({ lang: next });
      setLang(next);
    },
  }, getLang() === 'zh' ? 'English' : '中文');

  const el = h('div', { class: 'screen title-screen' },
    h('div', { class: 'title-bg', 'aria-hidden': 'true' },
      h('div', { class: 'bg-glow g1' }),
      h('div', { class: 'bg-glow g2' }),
      h('div', { class: 'bg-rays' }),
      h('div', { class: 'bg-pattern' }),
      floating,
    ),
    h('div', { class: 'title-content' },
      h('div', { class: 'logo' },
        h('div', { class: 'logo-zh', 'data-text': '拉米麻将' }, '拉米麻将'),
        h('div', { class: 'logo-en' }, h('span', { class: 'logo-line' }), 'Open Rummy', h('span', { class: 'logo-line' })),
        h('div', { class: 'logo-tag' }, t('title.tagline')),
      ),
      h('nav', { class: 'menu', 'aria-label': t('title.menu') },
        item(t('menu.offline'), t('menu.offlineSub'), nav.offline, true),
        nav.steam ? item(t('menu.steam'), t('menu.steamSub'), nav.steam, true) : null,
        nav.online ? item(t('menu.online'), t('menu.onlineSub'), nav.online, true) : null,
        item(t('menu.rules'), t('menu.rulesSub'), nav.rules),
        item(t('menu.settings'), t('menu.settingsSub'), nav.settings),
        item(t('menu.credits'), t('menu.creditsSub'), nav.credits),
      ),
    ),
    h('footer', { class: 'title-footer' },
      h('span', { class: 'muted' }, t('title.footer')),
      langBtn,
    ),
  );
  return { el };
}
