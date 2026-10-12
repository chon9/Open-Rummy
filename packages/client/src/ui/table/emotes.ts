/**
 * Emote wheel: a radial menu of the protocol EMOTES. Also maps emotes to avatar
 * reactions for the 3D scene.
 */
import { EMOTES, type EmoteId } from '@open-rummy/shared';
import type { Reaction } from '../../scene/api';
import { h, icon, ICONS } from '../dom';
import { sound } from '../sound';
import { t } from '../../i18n';

export const EMOTE_REACTION: Record<EmoteId, Reaction> = {
  wave: 'wave',
  laugh: 'laugh',
  cheer: 'cheer',
  cry: 'cry',
  angry: 'angry',
  think: 'think',
  gg: 'happy',
  huat: 'win',
};

/** Short glyph shown on the wheel button (text, not emoji). */
const EMOTE_GLYPH: Record<EmoteId, string> = {
  wave: 'Hi',
  laugh: '哈',
  cheer: '加',
  cry: '呜',
  angry: '怒',
  think: '嗯',
  gg: 'GG',
  huat: '發',
};

export function emoteText(id: string): string {
  return (EMOTES as readonly string[]).includes(id) ? t(`emote.${id as EmoteId}`) : id;
}

export class EmoteWheel {
  readonly el: HTMLElement;
  private wheel: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private openState = false;
  private cooldownUntil = 0;

  constructor(private readonly onEmote: (id: EmoteId) => void) {
    const n = EMOTES.length;
    this.wheel = h('div', { class: 'emote-wheel', role: 'menu', 'aria-label': t('emote.title') },
      EMOTES.map((id, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        return h('button', {
          class: 'emote-item',
          role: 'menuitem',
          style: `--x:${Math.cos(angle).toFixed(3)};--y:${Math.sin(angle).toFixed(3)};--i:${i}`,
          'aria-label': t(`emote.${id}`),
          title: t(`emote.${id}`),
          onclick: () => this.fire(id),
        }, h('b', null, EMOTE_GLYPH[id]), h('small', null, t(`emote.${id}`)));
      }),
    );
    this.toggleBtn = h('button', {
      class: 'icon-btn emote-toggle',
      'aria-label': t('emote.title'),
      'aria-expanded': 'false',
      onclick: () => this.toggle(),
    }, icon(ICONS.emote));
    this.el = h('div', { class: 'emote-dock' }, this.wheel, this.toggleBtn);
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('pointerdown', this.onOutside);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.openState) this.toggle(false);
  };

  private onOutside = (e: PointerEvent): void => {
    if (this.openState && !this.el.contains(e.target as Node)) this.toggle(false);
  };

  /** Re-apply translated labels after a language switch. */
  relabel(): void {
    this.wheel.setAttribute('aria-label', t('emote.title'));
    this.toggleBtn.setAttribute('aria-label', t('emote.title'));
    this.wheel.querySelectorAll<HTMLButtonElement>('.emote-item').forEach((btn, i) => {
      const id = EMOTES[i];
      btn.setAttribute('aria-label', t(`emote.${id}`));
      btn.title = t(`emote.${id}`);
      const small = btn.querySelector('small');
      if (small) small.textContent = t(`emote.${id}`);
    });
  }

  toggle(force?: boolean): void {
    this.openState = force ?? !this.openState;
    this.el.classList.toggle('open', this.openState);
    this.toggleBtn.setAttribute('aria-expanded', String(this.openState));
    sound.pop();
  }

  private fire(id: EmoteId): void {
    const now = Date.now();
    this.toggle(false);
    // light client-side rate limit; the server enforces its own
    if (now < this.cooldownUntil) return;
    this.cooldownUntil = now + 1500;
    this.onEmote(id);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerdown', this.onOutside);
    this.el.remove();
  }
}
