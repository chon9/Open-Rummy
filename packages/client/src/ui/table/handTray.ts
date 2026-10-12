/**
 * The local player's hand: big DOM tiles at the bottom of the screen.
 * Click to (multi-)select, sort by colour or rank, drag to reorder (desktop).
 * Tile elements are kept and re-ordered (not rebuilt) so selection lifts animate.
 */
import { sortTiles } from '@open-rummy/shared';
import { h, icon, ICONS } from '../dom';
import { tileAria, tileFace } from '../tileView';
import { sortByRank } from '../moves';
import { t } from '../../i18n';

export type SortMode = 'colour' | 'rank' | 'custom';

export interface TrayState {
  hand: string[];
  selected: Set<string>;
  /** tiles that can take part in a legal move now (glow) */
  playable: Set<string>;
  /** tiles staged into port runs (hidden from selection) */
  staged: Set<string>;
  /** hint highlight */
  hinted: Set<string>;
  /** hand points shown in the header */
  points: number;
  disabled: boolean;
}

export class HandTray {
  readonly el: HTMLElement;
  private row: HTMLElement;
  private pointsEl: HTMLElement;
  private sortBtns: Record<'colour' | 'rank', HTMLButtonElement>;
  private tiles = new Map<string, HTMLButtonElement>();
  private order: string[] = [];
  private mode: SortMode = 'colour';
  private dragId: string | null = null;

  constructor(private readonly onToggle: (id: string) => void) {
    this.row = h('div', { class: 'tray-row', role: 'group', 'aria-label': t('tray.hand') });
    this.pointsEl = h('span', { class: 'tray-points' });
    this.sortBtns = {
      colour: h('button', { class: 'chip-btn', onclick: () => this.setMode('colour') }, icon(ICONS.sort), t('tray.sortColour')),
      rank: h('button', { class: 'chip-btn', onclick: () => this.setMode('rank') }, icon(ICONS.sort), t('tray.sortRank')),
    };
    this.el = h('div', { class: 'hand-tray' },
      h('div', { class: 'tray-head' }, this.pointsEl, h('span', { class: 'tray-sorts' }, this.sortBtns.colour, this.sortBtns.rank)),
      this.row,
    );
    this.syncSortButtons();
  }

  /** Re-apply translated labels after a language switch. */
  relabel(): void {
    this.row.setAttribute('aria-label', t('tray.hand'));
    this.sortBtns.colour.replaceChildren(icon(ICONS.sort), t('tray.sortColour'));
    this.sortBtns.rank.replaceChildren(icon(ICONS.sort), t('tray.sortRank'));
  }

  setMode(mode: SortMode): void {
    this.mode = mode;
    if (mode === 'colour') this.order = sortTiles(this.order);
    else if (mode === 'rank') this.order = sortByRank(this.order);
    this.syncSortButtons();
    this.layout();
  }

  private syncSortButtons(): void {
    this.sortBtns.colour.setAttribute('aria-pressed', String(this.mode === 'colour'));
    this.sortBtns.rank.setAttribute('aria-pressed', String(this.mode === 'rank'));
  }

  /** Current display order (left to right). */
  get displayOrder(): string[] {
    return [...this.order];
  }

  render(s: TrayState): void {
    // reconcile order: keep the player's arrangement, append new tiles sorted
    const inHand = new Set(s.hand);
    const kept = this.order.filter((id) => inHand.has(id));
    const added = s.hand.filter((id) => !kept.includes(id));
    if (this.mode === 'colour') this.order = sortTiles([...kept, ...added]);
    else if (this.mode === 'rank') this.order = sortByRank([...kept, ...added]);
    else this.order = [...kept, ...sortTiles(added)];

    for (const [id, el] of this.tiles) {
      if (!inHand.has(id)) {
        el.remove();
        this.tiles.delete(id);
      }
    }
    for (const id of this.order) {
      let el = this.tiles.get(id);
      if (!el) {
        el = this.createTile(id);
        this.tiles.set(id, el);
      }
      const staged = s.staged.has(id);
      el.classList.toggle('selected', s.selected.has(id));
      el.classList.toggle('playable', s.playable.has(id) && !staged);
      el.classList.toggle('hinted', s.hinted.has(id));
      el.classList.toggle('staged', staged);
      el.setAttribute('aria-pressed', String(s.selected.has(id)));
      el.disabled = s.disabled || staged;
    }
    this.row.classList.toggle('has-playable', s.playable.size > 0);
    this.pointsEl.textContent = t('tray.points', { n: s.points, count: s.hand.length });
    this.layout();
  }

  private layout(): void {
    // appendChild moves existing nodes, so this re-orders without rebuilding
    this.order.forEach((id, i) => {
      const el = this.tiles.get(id);
      if (el && this.row.children[i] !== el) this.row.insertBefore(el, this.row.children[i] ?? null);
    });
    this.row.style.setProperty('--n', String(this.order.length));
  }

  private createTile(id: string): HTMLButtonElement {
    const el = h('button', {
      class: 'tile hand-tile',
      'aria-label': tileAria(id),
      draggable: 'true',
      dataset: { id },
      onclick: () => this.onToggle(id),
    }, tileFace(id), h('span', { class: 'tile-glow', 'aria-hidden': 'true' }));
    el.addEventListener('dragstart', (e) => {
      this.dragId = id;
      el.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      this.dragId = null;
      el.classList.remove('dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (this.dragId && this.dragId !== id) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragId;
      if (!from || from === id) return;
      const order = this.order.filter((x) => x !== from);
      const rect = el.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      order.splice(order.indexOf(id) + (after ? 1 : 0), 0, from);
      this.order = order;
      this.mode = 'custom';
      this.syncSortButtons();
      this.layout();
    });
    return el;
  }
}
