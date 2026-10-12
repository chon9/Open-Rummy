/**
 * DOM tiles using the shared procedural tile art (same look as the 3D table).
 * Falls back to a CSS-drawn label if the art module fails for any reason.
 */
import { tileArt } from '../art/tileArt';
import { tileFromId, tileLabel, COLOUR_SUIT, rankCode, type Rep } from '@open-rummy/shared';
import { h } from './dom';
import { t } from '../i18n';

const COLOUR_CLASS: Record<string, string> = { B: 'c-black', R: 'c-red', Y: 'c-yellow', G: 'c-teal' };

function faceUrl(id: string): string | null {
  try {
    return tileArt.faceUrl(id);
  } catch {
    return null;
  }
}

/** Screen-reader friendly name of a tile, e.g. "红 10" / "Red 10". */
export function tileAria(id: string): string {
  const tile = tileFromId(id);
  if (tile.joker) return 'Joker';
  return `${t(`colour.${tile.colour}` as 'colour.B')} ${rankCode(tile.rank as number)}`;
}

/** Inner face of a tile (image, or text fallback). */
export function tileFace(id: string): HTMLElement {
  const url = faceUrl(id);
  if (url) return h('img', { class: 'tile-img', src: url, alt: '', draggable: 'false' });
  const tile = tileFromId(id);
  if (tile.joker) return h('span', { class: 'tile-fallback c-joker' }, 'JOKER');
  return h('span', { class: `tile-fallback ${COLOUR_CLASS[tile.colour!]}` },
    h('b', null, rankCode(tile.rank as number)),
    h('i', null, COLOUR_SUIT[tile.colour!]),
  );
}

/** Small non-interactive tile, for strips (results, staged runs, swap lists). */
export function miniTile(id: string, rep?: Rep): HTMLElement {
  const el = h('span', { class: 'mini-tile', title: tileLabel(id), role: 'img', 'aria-label': tileAria(id) }, tileFace(id));
  if (rep && tileFromId(id).joker) {
    // show what a joker stands for
    el.appendChild(h('span', { class: 'mini-rep' }, rankCode(rep.rank)));
  }
  return el;
}

export function tileStrip(ids: string[], cls = ''): HTMLElement {
  return h('span', { class: `tile-strip ${cls}` }, ids.map((id) => miniTile(id)));
}
