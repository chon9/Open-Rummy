/**
 * Screen contract used by the router in main.ts, plus shared screen chrome.
 */
import { h, icon, ICONS } from './dom';
import { sound } from './sound';
import { t } from '../i18n';

export interface Screen {
  el: HTMLElement;
  /** called when the screen is removed */
  dispose?(): void;
  /** called after a language switch; return false to have the router rebuild the screen */
  relabel?(): boolean;
}

export function screenHeader(title: string, onBack: () => void, extra?: HTMLElement | null): HTMLElement {
  return h('header', { class: 'screen-header' },
    h('button', {
      class: 'icon-btn back-btn',
      'aria-label': t('common.back'),
      onclick: () => {
        sound.click();
        onBack();
      },
    }, icon(ICONS.back)),
    h('h1', { class: 'screen-title' }, title),
    h('div', { class: 'screen-header-extra' }, extra ?? null),
  );
}

/** Segmented control: a row of toggle buttons, one active. */
export function segmented<T>(
  options: { value: T; label: string }[],
  current: T,
  onPick: (v: T) => void,
  ariaLabel: string,
): HTMLElement {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': ariaLabel });
  const render = (cur: T): void => {
    group.replaceChildren(
      ...options.map((o) =>
        h('button', {
          class: `seg ${Object.is(o.value, cur) ? 'on' : ''}`,
          role: 'radio',
          'aria-checked': String(Object.is(o.value, cur)),
          onclick: () => {
            sound.click();
            render(o.value);
            onPick(o.value);
          },
        }, o.label),
      ),
    );
  };
  render(current);
  return group;
}

/** Labelled switch built on a real checkbox (keyboard + screen reader friendly). */
export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    class: 'switch-input',
    checked,
    onchange: () => {
      sound.click();
      onChange(input.checked);
    },
  });
  return h('label', { class: 'switch-row' },
    h('span', { class: 'switch-text' }, label, hint ? h('small', { class: 'muted' }, hint) : null),
    input,
    h('span', { class: 'switch', 'aria-hidden': 'true' }),
  );
}

/** Online connection status dot + label. */
export class ConnIndicator {
  readonly el: HTMLElement;
  private label: HTMLElement;
  constructor() {
    this.label = h('span', { class: 'conn-label' });
    this.el = h('div', { class: 'conn conn-connecting', role: 'status' }, h('i', { class: 'conn-dot', 'aria-hidden': 'true' }), this.label);
    this.set('connecting');
  }
  set(state: 'connecting' | 'open' | 'closed'): void {
    this.el.className = `conn conn-${state}`;
    this.label.textContent = t(`conn.${state}`);
  }
}
