/**
 * Procedural tile art (no external assets). Shared by the DOM hand tray (image URLs)
 * and the 3D table (canvas textures), so tiles look identical everywhere.
 *
 * Face layout: ivory background, big rank code on top, big vector suit symbol below.
 * Suits are drawn as paths (not text glyphs) so no platform ever swaps in emoji glyphs.
 * Jokers: 8 jokers, two per colour styling (JK_1/2 black, JK_3/4 red, JK_5/6 yellow, JK_7/8 cyan).
 */
import { COLOURS, rankCode, tileFromId, type Colour } from '@open-rummy/shared';
import type { TileArt } from './api';

/** Ink colours per tile colour (RULES §1: black / red / yellow / cyan). */
export const TILE_INK: Record<Colour, { ink: string; deep: string; light: string }> = {
  B: { ink: '#1c1d24', deep: '#000000', light: '#5a5c6e' },
  R: { ink: '#d3203b', deep: '#7d0f1f', light: '#ff6f83' },
  Y: { ink: '#dc9500', deep: '#6e4300', light: '#ffc93c' },
  G: { ink: '#0b9ead', deep: '#05545d', light: '#5fe0ec' },
};

export const IVORY = '#f7f0dd';
export const IVORY_SHADE = '#e9dcbc';
export const JADE = '#0e8a74';
export const JADE_DEEP = '#06493d';

const FONT_STACK = '"Segoe UI", "Helvetica Neue", Arial, "Microsoft YaHei", "PingFang SC", sans-serif';

/** Colour styling used for a tile: natural colour, or the joker's art colour. */
export function tileStyleColour(id: string): Colour {
  const t = tileFromId(id);
  if (!t.joker) return t.colour as Colour;
  const n = Number(id.slice(3)) || 1;
  return COLOURS[Math.floor((n - 1) / 2) % COLOURS.length];
}

/** Key identifying a distinct face image (copies of the same tile share it). */
export function faceKey(id: string): string {
  const t = tileFromId(id);
  if (t.joker) return `JK${tileStyleColour(id)}`;
  return `${t.colour}${rankCode(t.rank as number)}`;
}

// ---------------------------------------------------------------------------
// Vector suit symbols, drawn in a unit box centred at (0,0), y down.
// ---------------------------------------------------------------------------

function heartPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, 0.46);
  ctx.bezierCurveTo(-0.16, 0.3, -0.5, 0.1, -0.5, -0.14);
  ctx.bezierCurveTo(-0.5, -0.37, -0.33, -0.48, -0.21, -0.48);
  ctx.bezierCurveTo(-0.09, -0.48, -0.01, -0.39, 0, -0.28);
  ctx.bezierCurveTo(0.01, -0.39, 0.09, -0.48, 0.21, -0.48);
  ctx.bezierCurveTo(0.33, -0.48, 0.5, -0.37, 0.5, -0.14);
  ctx.bezierCurveTo(0.5, 0.1, 0.16, 0.3, 0, 0.46);
  ctx.closePath();
}

function stemPath(ctx: CanvasRenderingContext2D): void {
  ctx.moveTo(0.03, 0.2);
  ctx.quadraticCurveTo(0.06, 0.42, 0.2, 0.5);
  ctx.lineTo(-0.2, 0.5);
  ctx.quadraticCurveTo(-0.06, 0.42, -0.03, 0.2);
  ctx.closePath();
}

function spadePath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, -0.5);
  ctx.bezierCurveTo(0.16, -0.31, 0.5, -0.14, 0.5, 0.1);
  ctx.bezierCurveTo(0.5, 0.29, 0.34, 0.37, 0.21, 0.37);
  ctx.bezierCurveTo(0.1, 0.37, 0.03, 0.3, 0.01, 0.24);
  ctx.lineTo(-0.01, 0.24);
  ctx.bezierCurveTo(-0.03, 0.3, -0.1, 0.37, -0.21, 0.37);
  ctx.bezierCurveTo(-0.34, 0.37, -0.5, 0.29, -0.5, 0.1);
  ctx.bezierCurveTo(-0.5, -0.14, -0.16, -0.31, 0, -0.5);
  ctx.closePath();
  stemPath(ctx);
}

function diamondPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, -0.5);
  ctx.quadraticCurveTo(0.17, -0.2, 0.38, 0);
  ctx.quadraticCurveTo(0.17, 0.2, 0, 0.5);
  ctx.quadraticCurveTo(-0.17, 0.2, -0.38, 0);
  ctx.quadraticCurveTo(-0.17, -0.2, 0, -0.5);
  ctx.closePath();
}

function clubPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  const r = 0.205;
  ctx.moveTo(0 + r, -0.25);
  ctx.arc(0, -0.25, r, 0, Math.PI * 2);
  ctx.moveTo(-0.235 + r, 0.08);
  ctx.arc(-0.235, 0.08, r, 0, Math.PI * 2);
  ctx.moveTo(0.235 + r, 0.08);
  ctx.arc(0.235, 0.08, r, 0, Math.PI * 2);
  ctx.moveTo(0.12, -0.05);
  ctx.lineTo(0.12, 0.12);
  ctx.lineTo(-0.12, 0.12);
  ctx.lineTo(-0.12, -0.05);
  ctx.closePath();
  stemPath(ctx);
}

const SUIT_PATH: Record<Colour, (ctx: CanvasRenderingContext2D) => void> = {
  B: spadePath,
  R: heartPath,
  Y: diamondPath,
  G: clubPath,
};

/** Draw a suit symbol of the given colour centred at (cx, cy) with size s. */
export function drawSuit(ctx: CanvasRenderingContext2D, colour: Colour, cx: number, cy: number, s: number): void {
  const ink = TILE_INK[colour];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  SUIT_PATH[colour](ctx);
  const g = ctx.createLinearGradient(0, -0.5, 0, 0.5);
  g.addColorStop(0, ink.light);
  g.addColorStop(0.45, ink.ink);
  g.addColorStop(1, ink.deep);
  ctx.fillStyle = g;
  ctx.fill('nonzero');
  ctx.lineWidth = 0.035;
  ctx.strokeStyle = ink.deep;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function fillIvory(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#fffaf0');
  g.addColorStop(0.55, IVORY);
  g.addColorStop(1, IVORY_SHADE);
  ctx.fillStyle = g;
  ctx.fill();
}

function drawRank(ctx: CanvasRenderingContext2D, colour: Colour, code: string, cx: number, cy: number, size: number, maxW: number): void {
  const ink = TILE_INK[colour];
  ctx.save();
  ctx.font = `900 ${Math.round(size)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const measured = ctx.measureText(code).width;
  const sx = measured > maxW ? maxW / measured : 1;
  ctx.translate(cx, cy);
  ctx.scale(sx, 1);
  // soft engraved look: light offset below, ink on top
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(code, 0, size * 0.035);
  // yellow ink needs a dark keyline to read on ivory
  if (colour === 'Y') {
    ctx.lineWidth = size * 0.09;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink.deep;
    ctx.strokeText(code, 0, 0);
  }
  ctx.fillStyle = ink.ink;
  ctx.fillText(code, 0, 0);
  ctx.restore();
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number, points = 5): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawJoker(ctx: CanvasRenderingContext2D, colour: Colour, x: number, y: number, w: number, h: number): void {
  const ink = TILE_INK[colour];
  const cx = x + w / 2;
  // "JOKER" banner at the top
  ctx.save();
  ctx.font = `900 ${Math.round(h * 0.13)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = 'JOKER';
  const mw = ctx.measureText(label).width;
  const sx = mw > w * 0.84 ? (w * 0.84) / mw : 1;
  ctx.translate(cx, y + h * 0.15);
  ctx.scale(sx, 1);
  if (colour === 'Y') {
    ctx.lineWidth = h * 0.012;
    ctx.strokeStyle = ink.deep;
    ctx.strokeText(label, 0, 0);
  }
  ctx.fillStyle = ink.ink;
  ctx.fillText(label, 0, 0);
  ctx.restore();

  // gold burst behind the star
  const sy = y + h * 0.56;
  const R = Math.min(w, h) * 0.4;
  ctx.save();
  const glow = ctx.createRadialGradient(cx, sy, R * 0.1, cx, sy, R * 1.15);
  glow.addColorStop(0, 'rgba(255,214,102,0.9)');
  glow.addColorStop(1, 'rgba(255,214,102,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x, sy - R * 1.2, w, R * 2.4);
  // rays
  ctx.strokeStyle = 'rgba(214,150,20,0.55)';
  ctx.lineWidth = Math.max(1, w * 0.018);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.75, sy + Math.sin(a) * R * 0.75);
    ctx.lineTo(cx + Math.cos(a) * R * 1.05, sy + Math.sin(a) * R * 1.05);
    ctx.stroke();
  }
  // star in the joker's colour with a gold rim
  starPath(ctx, cx, sy, R * 0.82, R * 0.38);
  const sg = ctx.createLinearGradient(cx, sy - R, cx, sy + R);
  sg.addColorStop(0, ink.light);
  sg.addColorStop(0.5, ink.ink);
  sg.addColorStop(1, ink.deep);
  ctx.fillStyle = sg;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, w * 0.035);
  ctx.strokeStyle = '#d9a21b';
  ctx.lineJoin = 'round';
  ctx.stroke();
  // cheeky face
  ctx.fillStyle = '#fffaf0';
  const er = R * 0.07;
  ctx.beginPath();
  ctx.arc(cx - R * 0.15, sy - R * 0.05, er, 0, Math.PI * 2);
  ctx.arc(cx + R * 0.15, sy - R * 0.05, er, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.lineWidth = Math.max(1, R * 0.06);
  ctx.strokeStyle = '#fffaf0';
  ctx.lineCap = 'round';
  ctx.arc(cx, sy + R * 0.04, R * 0.17, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  ctx.restore();

  // 鬼 seal at the bottom
  ctx.save();
  ctx.font = `700 ${Math.round(h * 0.1)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#b8860b';
  ctx.fillText('鬼', cx, y + h * 0.91);
  ctx.restore();
}

/**
 * Paint a tile face. `framed` draws a rounded tile with a jade edge for DOM use;
 * otherwise the face fills the whole canvas (used as a 3D texture on the tile's face).
 */
export function paintFace(ctx: CanvasRenderingContext2D, id: string, w: number, h: number, framed: boolean): void {
  const t = tileFromId(id);
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  let x = 0;
  let y = 0;
  let fw = w;
  let fh = h;
  if (framed) {
    // jade back peeking below the ivory gives a hint of thickness
    const r = w * 0.14;
    roundRectPath(ctx, 0, 0, w, h, r);
    const jg = ctx.createLinearGradient(0, 0, 0, h);
    jg.addColorStop(0, JADE);
    jg.addColorStop(1, JADE_DEEP);
    ctx.fillStyle = jg;
    ctx.fill();
    fw = w;
    fh = h * 0.93;
    roundRectPath(ctx, 0, 0, fw, fh, r);
    fillIvory(ctx, 0, 0, fh);
    ctx.lineWidth = Math.max(1, w * 0.012);
    ctx.strokeStyle = 'rgba(120,100,60,0.35)';
    ctx.stroke();
    x = w * 0.06;
    y = h * 0.05;
    fw = w * 0.88;
    fh = h * 0.83;
  } else {
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    fillIvory(ctx, 0, 0, h);
    x = w * 0.04;
    y = h * 0.03;
    fw = w * 0.92;
    fh = h * 0.94;
  }

  const colour = tileStyleColour(id);
  if (t.joker) {
    drawJoker(ctx, colour, x, y, fw, fh);
  } else {
    const code = rankCode(t.rank as number);
    // big glyphs: table melds are seen small and at an angle, so rank and suit fill the face
    drawRank(ctx, colour, code, x + fw / 2, y + fh * 0.29, fh * 0.54, fw * 0.98);
    drawSuit(ctx, colour, x + fw / 2, y + fh * 0.74, Math.min(fw * 0.7, fh * 0.44));
  }
  ctx.restore();
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Back of a tile: jade with a carved lozenge motif. */
export function paintBack(ctx: CanvasRenderingContext2D, w: number, h: number, framed: boolean): void {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const r = framed ? w * 0.14 : 0;
  roundRectPath(ctx, 0, 0, w, h, r);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#22b394');
  g.addColorStop(0.5, JADE);
  g.addColorStop(1, JADE_DEEP);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.clip();
  // carved inner border
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = Math.max(1, w * 0.025);
  roundRectPath(ctx, w * 0.12, h * 0.1, w * 0.76, h * 0.8, w * 0.1);
  ctx.stroke();
  // lozenge
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.28);
  ctx.lineTo(w * 0.72, h / 2);
  ctx.lineTo(w / 2, h * 0.72);
  ctx.lineTo(w * 0.28, h / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  ctx.stroke();
  // glossy highlight
  const hl = ctx.createLinearGradient(0, 0, 0, h * 0.5);
  hl.addColorStop(0, 'rgba(255,255,255,0.25)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(0, 0, w, h * 0.5);
  ctx.restore();
}

const URL_W = 120;
const URL_H = 160;
const faceUrlCache = new Map<string, string>();
let backUrlCache: string | null = null;

export const tileArt: TileArt = {
  drawFace(ctx, id, w, h) {
    paintFace(ctx, id, w, h, true);
  },
  faceUrl(id) {
    const key = faceKey(id);
    const hit = faceUrlCache.get(key);
    if (hit) return hit;
    const c = makeCanvas(URL_W, URL_H);
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    paintFace(ctx, id, URL_W, URL_H, true);
    const url = c.toDataURL('image/png');
    faceUrlCache.set(key, url);
    return url;
  },
  backUrl() {
    if (backUrlCache) return backUrlCache;
    const c = makeCanvas(URL_W, URL_H);
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    paintBack(ctx, URL_W, URL_H, true);
    backUrlCache = c.toDataURL('image/png');
    return backUrlCache;
  },
};
