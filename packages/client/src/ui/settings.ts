/**
 * Settings modal: language, graphics quality, sound, offline timers.
 */
import type { Quality } from '../scene/api';
import { h } from './dom';
import { openModal, type ModalHandle } from './modal';
import { getPrefs, setPrefs } from './prefs';
import { segmented, toggle } from './screen';
import { sound } from './sound';
import { getLang, setLang, t, type Lang } from '../i18n';

export interface SettingsHooks {
  onQuality?(q: Quality): void;
}

export function openSettings(hooks: SettingsHooks = {}): ModalHandle {
  const p = getPrefs();
  const volume = h('input', {
    type: 'range',
    class: 'range',
    min: '0',
    max: '100',
    value: String(Math.round(p.volume * 100)),
    'aria-label': t('settings.volume'),
    onchange: () => {
      setPrefs({ volume: Number(volume.value) / 100 });
      sound.chime();
    },
  });
  const body = h('div', { class: 'settings' },
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, t('settings.language')),
      segmented<Lang>(
        [
          { value: 'zh', label: '简体中文' },
          { value: 'en', label: 'English' },
        ],
        getLang(),
        (lang) => {
          setPrefs({ lang });
          modal.close();
          setLang(lang);
          // reopen in the new language
          openSettings(hooks);
        },
        t('settings.language'),
      ),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, t('settings.quality')),
      segmented<Quality>(
        [
          { value: 'low', label: t('settings.qLow') },
          { value: 'medium', label: t('settings.qMedium') },
          { value: 'high', label: t('settings.qHigh') },
        ],
        p.quality,
        (q) => {
          setPrefs({ quality: q });
          hooks.onQuality?.(q);
        },
        t('settings.quality'),
      ),
    ),
    toggle(t('settings.sound'), p.sound, (v) => {
      setPrefs({ sound: v });
      if (v) sound.chime();
    }),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('settings.volume')), volume),
    toggle(t('lobby.relaxed'), p.relaxed, (v) => setPrefs({ relaxed: v }), t('settings.relaxedHint')),
    toggle(t('settings.autoNext'), p.autoNext, (v) => setPrefs({ autoNext: v }), t('settings.autoNextHint')),
  );
  const modal = openModal({ title: t('menu.settings'), body, className: 'modal-settings' });
  return modal;
}
