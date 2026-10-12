/**
 * Seat badges around the table: portrait, name, chips, tile count, status chip,
 * dealer mark, turn timer ring and speech bubbles (emotes / call-outs).
 */
import type { PlayerView, PublicPlayer } from '@open-rummy/shared';
import { h, icon, ICONS } from '../dom';
import { portraitEl } from '../portraits';
import { t } from '../../i18n';

export type SeatPos = 'bottom' | 'right' | 'top' | 'left' | 'top-right' | 'top-left';

/** Screen position of `seat` relative to the local player (you sit at the bottom). */
export function seatPos(seat: number, you: number, n: number): SeatPos {
  const rel = (seat - Math.max(0, you) + n) % n;
  if (rel === 0) return 'bottom';
  if (n === 3) return rel === 1 ? 'right' : 'left';
  if (n === 5) return (['bottom', 'right', 'top-right', 'top-left', 'left'] as SeatPos[])[rel];
  return (['bottom', 'right', 'top', 'left'] as SeatPos[])[rel];
}

/** Absolute local-clock countdown for a seat. */
export interface SeatTimer {
  end: number;
  total: number;
}

const RING_C = 2 * Math.PI * 46;

interface BadgeEls {
  root: HTMLElement;
  portraitSlot: HTMLElement;
  avatar: string;
  name: HTMLElement;
  chips: HTMLElement;
  count: HTMLElement;
  status: HTMLElement;
  dealer: HTMLElement;
  ring: SVGCircleElement;
  bubble: HTMLElement;
  bubbleTimer: ReturnType<typeof setTimeout> | null;
}

export class SeatBadges {
  private badges = new Map<number, BadgeEls>();

  /**
   * @param container layer for opponents' badges
   * @param youSlot   optional slot for the local player's badge (next to the action bar)
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly youSlot: HTMLElement | null = null,
  ) {}

  update(view: PlayerView, active: Set<number>): void {
    const n = view.players.length;
    for (const p of view.players) {
      let b = this.badges.get(p.seat);
      if (!b) {
        b = this.create(p);
        this.badges.set(p.seat, b);
      }
      // (re)parent: the local player's badge lives in the dock slot when provided
      const parent = p.seat === view.you && this.youSlot ? this.youSlot : this.container;
      if (b.root.parentElement !== parent) parent.appendChild(b.root);
      if (b.avatar !== p.avatar) {
        b.avatar = p.avatar;
        b.portraitSlot.replaceChildren(portraitEl(p.avatar, p.name, 160, 'seat-portrait'));
      }
      const pos = seatPos(p.seat, view.you, n);
      b.root.className = `seat-badge pos-${pos}`;
      b.root.classList.toggle('is-you', p.seat === view.you);
      b.root.classList.toggle('active', active.has(p.seat));
      b.root.classList.toggle('is-dead', p.status === 'DEAD' || p.status === 'QUANCAN');
      b.root.classList.toggle('is-out', p.status === 'OUT');
      b.root.classList.toggle('offline', !p.connected && !p.isBot);
      b.name.replaceChildren(
        h('span', { class: 'seat-name-text' }, p.name),
        p.isBot ? h('span', { class: 'tag tag-bot', title: t('common.bot') }, icon(ICONS.robot)) : '',
      );
      b.chips.textContent = String(p.chips);
      b.count.textContent = String(p.handCount);
      b.dealer.hidden = view.dealer !== p.seat || view.phase === 'LOBBY';
      const status = statusText(p, view);
      b.status.textContent = status.text;
      b.status.className = `seat-status ${status.cls}`;
      b.status.hidden = !status.text;
      b.root.setAttribute(
        'aria-label',
        `${p.name}, ${t('seat.chips')} ${p.chips}, ${t('seat.tiles')} ${p.handCount}${status.text ? ', ' + status.text : ''}`,
      );
    }
    // seats that disappeared (should not happen mid-match)
    for (const [seat, b] of this.badges) {
      if (!view.players.some((p) => p.seat === seat)) {
        b.root.remove();
        this.badges.delete(seat);
      }
    }
  }

  /** Update timer rings from local-clock deadlines. */
  tick(now: number, timers: Map<number, SeatTimer>): void {
    for (const [seat, b] of this.badges) {
      const tm = timers.get(seat);
      if (!tm) {
        b.ring.style.opacity = '0';
        continue;
      }
      const left = Math.max(0, tm.end - now);
      const frac = tm.total > 0 ? left / tm.total : 0;
      b.ring.style.opacity = '1';
      b.ring.style.strokeDashoffset = String(RING_C * (1 - frac));
      b.ring.classList.toggle('urgent', left < 5000);
    }
  }

  /** Show a speech bubble near the seat for a moment. */
  bubble(seat: number, text: string, kind: 'emote' | 'call' = 'call', ms = 2200): void {
    const b = this.badges.get(seat);
    if (!b) return;
    if (b.bubbleTimer) clearTimeout(b.bubbleTimer);
    b.bubble.textContent = text;
    b.bubble.className = `seat-bubble show bubble-${kind}`;
    b.bubbleTimer = setTimeout(() => {
      b.bubble.className = 'seat-bubble';
      b.bubbleTimer = null;
    }, ms);
  }

  dispose(): void {
    for (const b of this.badges.values()) {
      if (b.bubbleTimer) clearTimeout(b.bubbleTimer);
      b.root.remove();
    }
    this.badges.clear();
  }

  private create(p: PublicPlayer): BadgeEls {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'timer-ring');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', '50');
    ring.setAttribute('cy', '50');
    ring.setAttribute('r', '46');
    ring.style.strokeDasharray = String(RING_C);
    ring.style.opacity = '0';
    svg.appendChild(ring);

    const portraitSlot = h('div', { class: 'seat-portrait-slot' });
    const dealer = h('span', { class: 'dealer-mark', title: t('gloss.dealer') }, t('seat.dealerShort'));
    const name = h('div', { class: 'seat-name' });
    const chips = h('span', { class: 'stat-val' });
    const count = h('span', { class: 'stat-val' });
    const status = h('span', { class: 'seat-status' });
    const bubble = h('div', { class: 'seat-bubble', 'aria-live': 'polite' });
    const root = h('div', { class: 'seat-badge', role: 'group' },
      h('div', { class: 'seat-portrait-wrap' }, portraitSlot, svg, dealer),
      h('div', { class: 'seat-info' },
        name,
        h('div', { class: 'seat-stats' },
          h('span', { class: 'stat stat-chips', title: t('seat.chips') }, h('i', { class: 'coin', 'aria-hidden': 'true' }), chips),
          h('span', { class: 'stat stat-tiles', title: t('seat.tiles') }, icon(ICONS.tile), count),
        ),
        status,
      ),
      bubble,
    );
    return { root, portraitSlot, avatar: '', name, chips, count, status, dealer, ring, bubble, bubbleTimer: null };
  }
}

function statusText(p: PublicPlayer, view: PlayerView): { text: string; cls: string } {
  if (p.status === 'QUANCAN') return { text: t('status.QUANCAN'), cls: 'st-quancan' };
  if (p.status === 'DEAD') return { text: t('status.DEAD'), cls: 'st-dead' };
  if (p.status === 'OUT') return { text: t('status.OUT'), cls: 'st-out' };
  if (!p.connected && !p.isBot) return { text: t('status.offline'), cls: 'st-offline' };
  if (view.phase === 'PORT') {
    if (p.ported || p.portSubmitted) return { text: t('status.portReady'), cls: 'st-ready' };
    return { text: t('status.porting'), cls: 'st-wait' };
  }
  return { text: '', cls: '' };
}
