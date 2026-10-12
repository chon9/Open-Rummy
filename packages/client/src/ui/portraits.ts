/**
 * Avatar portraits for DOM (seat badges, lobby grid, results). Rendering a VRM
 * portrait is expensive, so results are cached per (avatar, size). The avatar module
 * (three.js + three-vrm) is loaded lazily so the title screen stays light.
 */
import { AVATARS, avatarById } from '../avatars/catalog';
import type { AvatarDef } from '../scene/api';
import { h } from './dom';
import { pick } from '../i18n';

type PortraitModule = typeof import('../avatars/portrait');

let modPromise: Promise<PortraitModule> | null = null;
const cache = new Map<string, Promise<string>>();

export function loadAvatarModule(): Promise<PortraitModule> {
  if (!modPromise) modPromise = import('../avatars/portrait');
  return modPromise;
}

export function avatarDef(id: string): AvatarDef | undefined {
  try {
    return avatarById(id) ?? undefined;
  } catch {
    return undefined;
  }
}

export function avatarName(id: string): string {
  const def = avatarDef(id);
  return def ? pick(def.nameZh, def.nameEn) : id;
}

export function defaultAvatarId(): string {
  return AVATARS[0]?.id ?? 'default';
}

/** Resolves to an image URL for the avatar portrait (cached). Rejects if rendering fails. */
export function portraitUrl(avatarId: string, size = 160): Promise<string> {
  const key = `${avatarId}@${size}`;
  let p = cache.get(key);
  if (!p) {
    p = loadAvatarModule().then((m) => m.renderAvatarPortrait(avatarId, size));
    // do not cache failures forever: allow a retry later
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/**
 * Portrait element: shows a coloured monogram immediately and swaps in the
 * rendered portrait when ready.
 */
export function portraitEl(avatarId: string, label: string, size = 160, cls = ''): HTMLElement {
  const def = avatarDef(avatarId);
  const colour = def?.color ?? '#3dd6c6';
  const initial = (label || (def ? pick(def.nameZh, def.nameEn) : '?')).trim().charAt(0).toUpperCase() || '?';
  const el = h('div', { class: `portrait ${cls}`, style: `--accent:${colour}` },
    h('span', { class: 'portrait-initial', 'aria-hidden': 'true' }, initial),
  );
  portraitUrl(avatarId, size)
    .then((url) => {
      const img = h('img', { src: url, alt: '', draggable: 'false' });
      img.addEventListener('load', () => el.classList.add('loaded'));
      el.appendChild(img);
    })
    .catch(() => {
      // keep the monogram fallback
    });
  return el;
}
