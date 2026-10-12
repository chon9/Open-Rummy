/**
 * Toast notifications (small, top) and banners (big, centre, e.g. "Game牌!").
 * Both live in a fixed layer above every screen.
 */
import { h } from './dom';

export type ToastKind = 'info' | 'error' | 'success';

let layer: HTMLElement | null = null;

function getLayer(): HTMLElement {
  if (!layer) {
    layer = h('div', { class: 'fx-layer' },
      h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }),
      h('div', { class: 'banners', 'aria-live': 'assertive' }),
    );
    document.body.appendChild(layer);
  }
  return layer;
}

export function toast(message: string, kind: ToastKind = 'info', ms = 2800): void {
  const box = getLayer().querySelector('.toasts')!;
  // collapse duplicate messages that arrive in quick succession
  for (const el of Array.from(box.children)) {
    if (el.textContent === message) el.remove();
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

export type BannerKind = 'gold' | 'teal' | 'red' | 'plain';

const queue: { title: string; sub?: string; kind: BannerKind; ms: number }[] = [];
let showing = false;

/** Big centred banner. Banners queue so they never overlap. */
export function banner(title: string, sub?: string, kind: BannerKind = 'gold', ms = 1500): void {
  queue.push({ title, sub, kind, ms });
  if (queue.length > 3) queue.splice(0, queue.length - 3);
  if (!showing) void next();
}

async function next(): Promise<void> {
  const item = queue.shift();
  if (!item) {
    showing = false;
    return;
  }
  showing = true;
  const box = getLayer().querySelector('.banners')!;
  const el = h('div', { class: `banner banner-${item.kind}` },
    h('div', { class: 'banner-title' }, item.title),
    item.sub ? h('div', { class: 'banner-sub' }, item.sub) : null,
  );
  box.appendChild(el);
  await new Promise((r) => setTimeout(r, item.ms));
  el.classList.add('out');
  await new Promise((r) => setTimeout(r, 300));
  el.remove();
  void next();
}

export function clearBanners(): void {
  queue.length = 0;
  layer?.querySelector('.banners')?.replaceChildren();
}
