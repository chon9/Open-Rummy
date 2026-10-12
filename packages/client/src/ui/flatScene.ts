/**
 * DOM fallback for the 3D table (TableSceneApi) used when WebGL or the 3D module is
 * unavailable. Keeps the game fully playable: melds are drawn as tile strips on a
 * felt background and can be clicked as targets.
 */
import type { GameEvent, Meld, PlayerView } from '@open-rummy/shared';
import type { MeldPick, Quality, Reaction, SeatAvatar, TableSceneApi } from '../scene/api';
import { h, sleep } from './dom';
import { miniTile } from './tileView';
import { meldLabel } from './moves';

export class FlatScene implements TableSceneApi {
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private pick: ((p: MeldPick) => void) | null = null;
  private highlighted = new Set<string>();
  private lastMelds = '';

  async mount(container: HTMLElement, opts: { quality: Quality; onProgress?: (p: number) => void }): Promise<void> {
    this.list = h('div', { class: 'flat-melds' });
    this.root = h('div', { class: 'flat-scene' }, h('div', { class: 'flat-felt' }, this.list));
    container.appendChild(this.root);
    opts.onProgress?.(1);
  }

  async setSeats(_seats: SeatAvatar[], _you: number): Promise<void> {
    // seats are shown by the DOM seat badges
  }

  async playEvents(events: GameEvent[], view: PlayerView): Promise<void> {
    this.sync(view);
    const meldEvents = events.filter((e) => e.type === 'MELD_CREATED' || e.type === 'MELD_EXTENDED' || e.type === 'SET_FOLLOWED');
    if (meldEvents.length) await sleep(220);
  }

  sync(view: PlayerView): void {
    if (!this.list) return;
    const sig = JSON.stringify(view.melds.map((m) => [m.id, m.tiles.map((x) => x.tileId)]));
    if (sig === this.lastMelds) return;
    this.lastMelds = sig;
    this.list.replaceChildren(...view.melds.map((m) => this.meldEl(m)));
    this.applyHighlight();
  }

  private meldEl(m: Meld): HTMLElement {
    const el = h('button', {
      class: `flat-meld meld-${m.type.toLowerCase()}`,
      dataset: { id: m.id },
      'aria-label': meldLabel(m),
      onclick: (e: MouseEvent) => {
        const rect = el.getBoundingClientRect();
        const end = m.type === 'RUN' ? (e.clientX < rect.left + rect.width / 2 ? 'low' : 'high') : null;
        this.pick?.({ meldId: m.id, end });
      },
    }, m.tiles.map((mt) => miniTile(mt.tileId, mt.rep)));
    return el;
  }

  private applyHighlight(): void {
    this.list?.querySelectorAll<HTMLElement>('.flat-meld').forEach((el) => {
      el.classList.toggle('target', this.highlighted.has(el.dataset.id ?? ''));
    });
  }

  highlightMelds(meldIds: string[]): void {
    this.highlighted = new Set(meldIds);
    this.applyHighlight();
  }

  onMeldPick(cb: (pick: MeldPick) => void): void {
    this.pick = cb;
  }

  react(_seat: number, _reaction: Reaction): void {
    // no avatars in the flat table
  }

  setActiveSeat(_seat: number | null): void {
    // the seat badges show the active turn
  }

  setQuality(_q: Quality): void {
    // nothing to tune
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
    this.list = null;
  }
}
