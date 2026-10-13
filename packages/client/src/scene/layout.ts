/**
 * Pure layout math for the table (all in table space, see constants.ts).
 */
import * as THREE from 'three';
import type { Meld } from '@open-rummy/shared';
import {
  MELD_AREA,
  MELD_MAX_SCALE,
  MELD_TILT,
  OWN_ORIGIN,
  RACK_DIST,
  RACK_MAX_LEN,
  TABLE_HALF,
  TABLE_Y,
  TILE_D,
  TILE_GAP,
  TILE_H,
  TILE_W,
} from './constants';

export interface Xform {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function quatY(a: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, a);
}
export function quatX(a: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(X_AXIS, a);
}

/** Lying face up, readable from the camera (top of the face points away from it). */
export const FACE_UP = quatX(-Math.PI / 2);

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/** Seat position relative to the camera seat: 0 = camera, 1 = right (下家), ... */
export function relSeat(seat: number, camSeat: number, n: number): number {
  return (((seat - camSeat) % n) + n) % n;
}

/** Angle of a relative seat around the table (0 = toward +Z / camera, increasing toward +X). */
export function seatAngle(rel: number, n: number): number {
  return (rel * Math.PI * 2) / n;
}

/** Unit vector from the table centre toward the seat. */
export function seatDir(angle: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
}

/** Unit vector along the seat's edge (left to right as seen from the centre facing the seat... i.e. the seat's local +X). */
export function seatTangent(angle: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
}

/** Angles (between seats) used for the dead wall and dice. */
export function cornerAngles(n: number): { deadWall: number; dice: number; radius: number } {
  const gaps: number[] = [];
  for (let k = 0; k < n; k++) gaps.push(((k + 0.5) * Math.PI * 2) / n);
  const closest = (deg: number, exclude?: number): number => {
    const target = THREE.MathUtils.degToRad(deg);
    let best = gaps[0];
    let bestD = Infinity;
    for (const g of gaps) {
      if (exclude !== undefined && Math.abs(g - exclude) < 1e-6) continue;
      const d = Math.abs(Math.atan2(Math.sin(g - target), Math.cos(g - target)));
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  };
  const deadWall = closest(205);
  const dice = closest(130, deadWall);
  return { deadWall, dice, radius: n === 4 ? TABLE_HALF * 1.04 : TABLE_HALF * 0.8 };
}

// ---------------------------------------------------------------------------
// Racks (opponents' hands)
// ---------------------------------------------------------------------------

export type RackState = 'stand' | 'dead' | 'revealed';

export function rackSpacing(count: number): { pitch: number; scale: number } {
  const pitch = TILE_W + TILE_GAP * 0.6;
  const len = count * pitch;
  const scale = len > RACK_MAX_LEN ? RACK_MAX_LEN / len : 1;
  return { pitch: pitch * scale, scale };
}

/** Transform of tile `i` of `count` in a seat's rack. */
export function rackXform(angle: number, i: number, count: number, state: RackState): Xform {
  const d = seatDir(angle);
  const tg = seatTangent(angle);
  const { pitch, scale } = rackSpacing(count);
  const u = (i - (count - 1) / 2) * pitch;
  const facing = quatY(angle);
  if (state === 'stand') {
    const pos = d.clone().multiplyScalar(RACK_DIST).addScaledVector(tg, u);
    pos.y = (TILE_H / 2) * scale;
    return { pos, quat: facing, scale };
  }
  if (state === 'dead') {
    // tipped toward the owner, face down
    const pos = d.clone().multiplyScalar(RACK_DIST + ((TILE_H - TILE_D) / 2) * scale).addScaledVector(tg, u);
    pos.y = (TILE_D / 2) * scale;
    return { pos, quat: facing.multiply(quatX(Math.PI / 2)), scale };
  }
  // revealed: face up, top of the face toward the owner; order reversed so it reads left to right
  const pos = d.clone().multiplyScalar(RACK_DIST - 0.01).addScaledVector(tg, -u);
  pos.y = (TILE_D / 2) * scale;
  return { pos, quat: facing.multiply(quatY(Math.PI)).multiply(quatX(-Math.PI / 2)), scale };
}

/** Where the local player's tiles come from (they live in the DOM hand). */
export function ownOriginXform(i: number, count: number, backToCamera = false): Xform {
  const pos = new THREE.Vector3(OWN_ORIGIN.x + (i - (count - 1) / 2) * (TILE_W + 0.004), OWN_ORIGIN.y, OWN_ORIGIN.z);
  // face tilted toward the camera (a tile you play), or turned away (a tile dealt to you)
  const quat = backToCamera ? quatY(Math.PI).multiply(quatX(-1.0)) : quatX(-1.0);
  return { pos, quat, scale: 1 };
}

// ---------------------------------------------------------------------------
// Wall (temporary, during the deal) and dead wall
// ---------------------------------------------------------------------------

/** Stack slots of the N walls in deal order. Each slot holds 2 tiles (level 0 bottom, 1 top). */
export function wallSlots(n: number, camSeat: number, totalTiles: number): { seat: number; xf: Xform[] }[] {
  const stacksTotal = Math.ceil(totalTiles / 2);
  const perWall = Math.ceil(stacksTotal / n);
  const side = perWall * TILE_W;
  const apothem = side / (2 * Math.tan(Math.PI / n)) + TILE_H / 2 + 0.005;
  const out: { seat: number; xf: Xform[] }[] = [];
  for (let s = 0; s < n; s++) {
    const angle = seatAngle(relSeat(s, camSeat, n), n);
    const d = seatDir(angle);
    const tg = seatTangent(angle);
    const xf: Xform[] = [];
    // count from the wall's right end (as seen by its owner) toward its left
    for (let j = 0; j < perWall; j++) {
      const u = ((perWall - 1) / 2 - j) * TILE_W;
      for (let level = 0; level < 2; level++) {
        const pos = d.clone().multiplyScalar(apothem).addScaledVector(tg, -u);
        pos.y = TILE_D / 2 + level * TILE_D;
        xf.push({ pos, quat: quatY(angle).multiply(quatX(Math.PI / 2)), scale: 1 });
      }
    }
    out.push({ seat: s, xf });
  }
  return out;
}

/** Dead wall: a compact block of face-down stacks in a table corner. */
export function deadWallXform(i: number, count: number, n: number): Xform {
  const { deadWall, radius } = cornerAngles(n);
  const perRow = 4;
  const stacks = Math.ceil(count / 2);
  const rows = Math.ceil(stacks / perRow);
  const stack = Math.floor(i / 2);
  const level = i % 2;
  const col = stack % perRow;
  const row = Math.floor(stack / perRow);
  // block centre sits a little inside the corner
  const centre = seatDir(deadWall).multiplyScalar(radius * 0.74);
  const rot = deadWall + Math.PI / 4 * (n === 4 ? 1 : 0);
  const local = new THREE.Vector3((col - (perRow - 1) / 2) * (TILE_W + 0.001), 0, (row - (rows - 1) / 2) * (TILE_H + 0.001));
  local.applyAxisAngle(Y_AXIS, rot);
  const pos = centre.add(local);
  pos.y = TILE_D / 2 + level * TILE_D;
  return { pos, quat: quatY(rot).multiply(quatX(Math.PI / 2)), scale: 1 };
}

// ---------------------------------------------------------------------------
// Keep-out zones (racks, dead wall, dice) and screen-space separation
// ---------------------------------------------------------------------------
//
// Two objects overlap on screen exactly when their silhouettes, projected along the
// camera's view rays onto the felt plane, intersect. A box of footprint F and height h
// projects to hull(F, F raised to h and pushed down the view rays). Melds are laid out so
// that the projected silhouette of every meld tile stays clear of the projected
// silhouette of every rack, the dead wall and the dice, for a few representative
// camera framings (landscape, square, portrait).

export interface P2 {
  x: number;
  z: number;
}

/** Convex hull (counter-clockwise, monotone chain). */
export function convexHull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length <= 2) return p;
  const cross = (o: P2, a: P2, b: P2): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function separated(a: P2[], b: P2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    const nx = q.z - p.z;
    const nz = p.x - q.x;
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const v of a) {
      const d = v.x * nx + v.z * nz;
      if (d < aMin) aMin = d;
      if (d > aMax) aMax = d;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const v of b) {
      const d = v.x * nx + v.z * nz;
      if (d < bMin) bMin = d;
      if (d > bMax) bMax = d;
    }
    if (aMax <= bMin || bMax <= aMin) return true;
  }
  return false;
}

/** Do two convex polygons overlap (touching does not count)? */
export function polysIntersect(a: P2[], b: P2[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  return !separated(a, b) && !separated(b, a);
}

/** Camera framing for a viewport aspect (world space; the felt is at y = TABLE_Y). */
export function cameraRig(aspect: number): { fov: number; pos: THREE.Vector3; look: THREE.Vector3 } {
  // Landscape: ~66 degrees of horizontal view from a low, Mahjong-Soul-like angle.
  // Portrait / narrow: widen the fov a little, then go steeper and back far enough that
  // the whole table still fits across the screen (side avatars may be cropped).
  const deg = THREE.MathUtils.degToRad;
  const vfov = THREE.MathUtils.clamp(2 * Math.atan(Math.tan(deg(33)) / aspect), deg(38), deg(62));
  const narrow = THREE.MathUtils.clamp((1.3 - aspect) / 0.8, 0, 1);
  const halfHoriz = Math.atan(Math.tan(vfov / 2) * aspect);
  const elev = THREE.MathUtils.lerp(Math.atan2(0.82, 1.84), deg(52), narrow);
  const dist = Math.max(2.0, (TABLE_HALF + 0.14) / Math.tan(halfHoriz));
  const look = new THREE.Vector3(0, TABLE_Y + THREE.MathUtils.lerp(0.1, 0.0, narrow), THREE.MathUtils.lerp(-0.22, 0.02, narrow));
  const pos = new THREE.Vector3(0, Math.sin(elev) * dist, Math.cos(elev) * dist).add(look);
  return { fov: THREE.MathUtils.radToDeg(vfov), pos, look };
}

/** Eye points (table space) the meld layout keeps clear for: landscape and portrait (framings in between interpolate). */
const LAYOUT_EYES: THREE.Vector3[] = [16 / 9, 9 / 19.5].map((a) => cameraRig(a).pos.sub(new THREE.Vector3(0, TABLE_Y, 0)));

/** Extra air kept around every zone (camera sway, rounding, tile bevels). */
const ZONE_PAD = 0.012;

/** Something on the felt melds must stay clear of: a convex footprint and its height. */
export interface Zone {
  kind: 'rack' | 'deadWall' | 'dice';
  pts: P2[];
  h: number;
}

/** Silhouette of a footprint of height h as seen from `eye`, projected onto the felt. */
export function groundSilhouette(pts: P2[], h: number, eye: THREE.Vector3): P2[] {
  const t = eye.y / Math.max(1e-3, eye.y - h);
  const all = [...pts];
  for (const p of pts) all.push({ x: eye.x + (p.x - eye.x) * t, z: eye.z + (p.z - eye.z) * t });
  return convexHull(all);
}

/** Footprint covering a seat's rack in every state (standing, tipped over, revealed). */
export function rackZone(angle: number, count: number): Zone {
  const { pitch, scale } = rackSpacing(Math.max(1, count));
  const half = (count * pitch) / 2 + ZONE_PAD;
  const inner = RACK_DIST - 0.01 - (TILE_H / 2) * scale - ZONE_PAD;
  const outer = RACK_DIST + ((TILE_H - TILE_D) / 2) * scale + (TILE_H / 2) * scale + ZONE_PAD;
  const d = seatDir(angle);
  const tg = seatTangent(angle);
  const pts: P2[] = [];
  for (const r of [inner, outer]) for (const u of [-half, half]) pts.push({ x: d.x * r + tg.x * u, z: d.z * r + tg.z * u });
  return { kind: 'rack', pts: convexHull(pts), h: TILE_H * scale };
}

/** Footprint of the dead wall block with `count` tiles. */
export function deadWallZone(count: number, n: number): Zone | null {
  if (count <= 0) return null;
  const pts: P2[] = [];
  const hw = TILE_W / 2 + ZONE_PAD;
  const hd = TILE_H / 2 + ZONE_PAD;
  for (let i = 0; i < count; i += 2) {
    const xf = deadWallXform(i, count, n);
    // lying tiles: local x = width, local y (face height) lies along the felt
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(xf.quat);
    const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(xf.quat);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) pts.push({ x: xf.pos.x + ax.x * hw * sx + ay.x * hd * sy, z: xf.pos.z + ax.z * hw * sx + ay.z * hd * sy });
  }
  return { kind: 'deadWall', pts: convexHull(pts), h: TILE_D * 2 };
}

/** Resting place of die `i` (0 or 1). */
export function diceRestPos(i: number, n: number): THREE.Vector3 {
  const { dice, radius } = cornerAngles(n);
  const c = seatDir(dice).multiplyScalar(radius * 0.74);
  return c.addScaledVector(seatTangent(dice), (i - 0.5) * 0.035).setY(0.01);
}

export function diceZone(n: number): Zone {
  const pts: P2[] = [];
  const r = 0.02 + ZONE_PAD;
  for (let i = 0; i < 2; i++) {
    const c = diceRestPos(i, n);
    for (let k = 0; k < 8; k++) pts.push({ x: c.x + Math.cos((k * Math.PI) / 4) * r, z: c.z + Math.sin((k * Math.PI) / 4) * r });
  }
  return { kind: 'dice', pts: convexHull(pts), h: 0.024 };
}

export interface MeldLayoutOptions {
  /**
   * Tiles in each seat's rack, indexed by RELATIVE seat (0 = camera seat). Missing or
   * null seats get the longest possible rack; 0 means no rack. The camera seat has no
   * rack unless a count is given (its hand lives in the DOM).
   */
  rackCounts?: (number | null | undefined)[];
  /** dead wall tile count (default: a generous block) */
  deadWall?: number;
}

/** Longest rack any hand can make (racks are scaled down beyond RACK_MAX_LEN). */
export const MAX_RACK_COUNT = Math.ceil(RACK_MAX_LEN / (TILE_W + TILE_GAP * 0.6)) + 1;

/** Every keep-out zone on the felt for an n-player table. */
export function tableZones(n: number, opts: MeldLayoutOptions = {}): Zone[] {
  const zones: Zone[] = [];
  for (let rel = 0; rel < n; rel++) {
    const given = opts.rackCounts?.[rel];
    const count = given ?? (rel === 0 ? 0 : MAX_RACK_COUNT);
    if (count > 0) zones.push(rackZone(seatAngle(rel, n), count));
  }
  const dw = deadWallZone(opts.deadWall ?? 48, n);
  if (dw) zones.push(dw);
  zones.push(diceZone(n));
  return zones;
}

// ---------------------------------------------------------------------------
// Table melds
// ---------------------------------------------------------------------------

export interface MeldSlot {
  meldId: string;
  /** centre of the meld's footprint on the felt (table space) */
  cx: number;
  cz: number;
  /** footprint on the felt (x extent, z extent) */
  width: number;
  depth: number;
  scale: number;
  /** height of the tile centres above the felt */
  y: number;
  /** backward tilt of the faces toward the camera (radians from lying flat) */
  tilt: number;
  /** per tile centre (x, z) in meld.tiles order */
  tiles: { x: number; z: number }[];
}

const COLOUR_ORDER: Record<string, number> = { B: 0, R: 1, Y: 2, G: 3 };

function meldSerial(id: string, fallback: number): number {
  const m = /(\d+)\s*$/.exec(id);
  return m ? Number(m[1]) : fallback;
}

/** Display order: runs grouped by colour (creation order within), then sets. */
export function orderMelds(melds: Meld[]): Meld[] {
  return melds
    .map((m, i) => ({ m, i, serial: meldSerial(m.id, i) }))
    .sort((a, b) => {
      const ta = a.m.type === 'RUN' ? 0 : 1;
      const tb = b.m.type === 'RUN' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      if (ta === 0) {
        const ca = COLOUR_ORDER[a.m.colour ?? 'B'] ?? 0;
        const cb = COLOUR_ORDER[b.m.colour ?? 'B'] ?? 0;
        if (ca !== cb) return ca - cb;
      }
      return a.serial - b.serial || a.i - b.i;
    })
    .map((x) => x.m);
}

/** Felt footprint (z extent) of a tile tilted back by MELD_TILT, at scale 1. */
const TILT_SIN = Math.sin(MELD_TILT);
const TILT_COS = Math.cos(MELD_TILT);
const FOOT_D = TILE_H * TILT_COS + TILE_D * TILT_SIN;
/** height of a tilted tile's centre above the felt, at scale 1 */
const TILT_Y = (TILE_H / 2) * TILT_SIN + (TILE_D / 2) * TILT_COS;
/** height of a tilted tile's raised top edge, at scale 1 */
const TILT_TOP = TILE_H * TILT_SIN + TILE_D * TILT_COS;

/** Silhouette (projected on the felt) of meld tiles covering [x0,x1] x [z0,z1] with top height h. */
export function meldSilhouette(x0: number, x1: number, z0: number, z1: number, h: number, eye: THREE.Vector3): P2[] {
  return groundSilhouette(
    [
      { x: x0, z: z0 },
      { x: x1, z: z0 },
      { x: x1, z: z1 },
      { x: x0, z: z1 },
    ],
    h,
    eye,
  );
}

interface Sil {
  pts: P2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function sil(pts: P2[]): Sil {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { pts, minX, maxX, minZ, maxZ };
}

function silsHit(a: Sil, b: Sil): boolean {
  if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ) return false;
  return polysIntersect(a.pts, b.pts);
}

/** emergency floor below MELD_MIN_SCALE for absurdly full tables */
const MELD_FLOOR_SCALE = 0.6;
/** x resolution of the free-space scan */
const CELL = 0.01;
/** z steps (coarse, then fine) when a row band is blocked */
const Z_STEP = 0.01;
const Z_COARSE = 0.04;

/**
 * Shelf-pack melds into rows on the felt. Tiles lean back toward the camera for
 * readability. Rows are only placed where neither their footprint nor their raised top
 * edges cover (on screen) a rack, the dead wall or the dice; rows narrow or split
 * around those zones. The largest scale (up to MELD_MAX_SCALE) at which everything fits
 * wins, so a few melds are big and the layout shrinks smoothly as the table fills up.
 * Rows are centred in their free span; sets start on their own row.
 */
export function layoutMelds(melds: Meld[], n = 4, opts: MeldLayoutOptions = {}): Map<string, MeldSlot> {
  const ordered = orderMelds(melds);
  if (!ordered.length) return new Map();
  const pitch = TILE_W + TILE_GAP;
  const meldGap = TILE_W * 0.75;
  // tilted rows need extra air so the row in front does not hide the next row's ranks
  const rowGap = 0.017;
  const zones = tableZones(n, opts);
  const zoneSils = LAYOUT_EYES.map((eye) => zones.map((z) => sil(groundSilhouette(z.pts, z.h, eye))));
  const minX = MELD_AREA.minX;
  const maxX = MELD_AREA.maxX;
  const cells = Math.floor((maxX - minX) / CELL + 1e-6);

  /** Free x spans of a row band [z0, z1] whose tiles rise to h. */
  const freeSpans = (z0: number, z1: number, h: number): { x0: number; x1: number }[] => {
    const free = new Array<boolean>(cells).fill(true);
    LAYOUT_EYES.forEach((eye, e) => {
      const band = sil(meldSilhouette(minX, maxX, z0, z1, h, eye));
      const near = zoneSils[e].filter((zs) => silsHit(band, zs));
      if (!near.length) return;
      const t = eye.y / Math.max(1e-3, eye.y - h);
      // projected z range is the same for every cell of the band
      const pz0 = eye.z + (z0 - eye.z) * t;
      const pz1 = eye.z + (z1 - eye.z) * t;
      const cMinZ = Math.min(z0, pz0);
      const cMaxZ = Math.max(z1, pz1);
      for (let c = 0; c < cells; c++) {
        if (!free[c]) continue;
        const x0 = minX + c * CELL;
        const x1 = x0 + CELL;
        const px0 = eye.x + (x0 - eye.x) * t;
        const px1 = eye.x + (x1 - eye.x) * t;
        const cMinX = Math.min(x0, px0);
        const cMaxX = Math.max(x1, px1);
        // cheap bounding-box reject before building the silhouette
        const cand = near.filter((zs) => !(cMaxX <= zs.minX || zs.maxX <= cMinX || cMaxZ <= zs.minZ || zs.maxZ <= cMinZ));
        if (!cand.length) continue;
        const cs = sil(meldSilhouette(x0, x1, z0, z1, h, eye));
        if (cand.some((zs) => silsHit(cs, zs))) free[c] = false;
      }
    });
    const spans: { x0: number; x1: number }[] = [];
    let start = -1;
    for (let c = 0; c <= cells; c++) {
      if (c < cells && free[c]) {
        if (start < 0) start = c;
      } else if (start >= 0) {
        spans.push({ x0: minX + start * CELL, x1: minX + c * CELL });
        start = -1;
      }
    }
    return spans;
  };

  type Item = { m: Meld; x: number; w: number };
  const attempt = (scale: number, zStart: number): { slots: Map<string, MeldSlot>; first: number; bottom: number } | null => {
    const foot = FOOT_D * scale;
    const h = TILT_TOP * scale;
    const gap = meldGap * scale;
    const widthOf = (m: Meld): number => (m.tiles.length * pitch - TILE_GAP) * scale;
    const out = new Map<string, MeldSlot>();
    let z = zStart;
    let first = NaN;
    let bottom = zStart;
    type Row = { span: { x0: number; x1: number }; items: Item[] }[];
    /** Fill the row band at z starting with meld i; null if nothing fits there. */
    const rowAt = (z: number, i: number): { row: Row; next: number } | null => {
      const spans = freeSpans(z, z + foot, h);
      const row: Row = [];
      let j = i;
      let stop = false;
      let lastType: string | null = null;
      for (const span of spans) {
        if (stop || j >= ordered.length) break;
        const items: Item[] = [];
        let x = span.x0;
        while (j < ordered.length) {
          const m = ordered[j];
          // sets start on their own row
          if (lastType === 'RUN' && m.type === 'SET') {
            stop = true;
            break;
          }
          const w = widthOf(m);
          const start = items.length ? x + gap : x;
          if (start + w > span.x1 + 1e-9) break;
          items.push({ m, x: start, w });
          x = start + w;
          lastType = m.type;
          j++;
        }
        if (items.length) row.push({ span, items });
      }
      return row.length ? { row, next: j } : null;
    };
    const fits = (z: number): boolean => z + foot <= MELD_AREA.maxZ + 1e-9;
    let i = 0;
    while (i < ordered.length) {
      if (!fits(z)) return null;
      let found = rowAt(z, i);
      if (!found) {
        // blocked: walk down in coarse steps, then back up in fine steps to the first fit
        let zz = z;
        while (!found) {
          const prev = zz;
          zz += Z_COARSE;
          const coarse = fits(zz) ? rowAt(zz, i) : null;
          if (!coarse && fits(zz)) continue;
          // look for an earlier fit between the two coarse steps (also catches a fit
          // near the bottom edge that the coarse step jumped past)
          for (let f = prev + Z_STEP; f < zz - 1e-9 && fits(f); f += Z_STEP) {
            const fine = rowAt(f, i);
            if (fine) {
              found = fine;
              zz = f;
              break;
            }
          }
          if (!found && coarse) found = coarse;
          if (!found && !fits(zz)) return null;
        }
        z = zz;
      }
      const { row, next: j } = found;
      if (Number.isNaN(first)) first = z;
      const cz = z + foot / 2;
      for (const { span, items } of row) {
        const last = items[items.length - 1];
        const used = last.x + last.w - items[0].x;
        const shift = (span.x1 - span.x0 - used) / 2;
        for (const it of items) {
          const x0 = it.x + shift;
          out.set(it.m.id, {
            meldId: it.m.id,
            cx: x0 + it.w / 2,
            cz,
            width: it.w,
            depth: foot,
            scale,
            y: TILT_Y * scale,
            tilt: MELD_TILT,
            tiles: it.m.tiles.map((_, k) => ({ x: x0 + (k * pitch + TILE_W / 2) * scale, z: cz })),
          });
        }
      }
      bottom = z + foot;
      i = j;
      z += (FOOT_D + rowGap) * scale;
    }
    return { slots: out, first, bottom };
  };

  // largest scale that fits: try full size, then bisect (in log space) down to the floor
  const finish = (scale: number, res: { slots: Map<string, MeldSlot>; first: number; bottom: number }): Map<string, MeldSlot> => {
    // centre the block vertically in what is left, if it still fits further down
    const slack = MELD_AREA.maxZ - res.bottom;
    for (const k of [0.5, 0.25]) {
      if (slack * k < Z_STEP) break;
      const moved = attempt(scale, res.first + slack * k);
      if (moved) return moved.slots;
    }
    return res.slots;
  };
  const top = attempt(MELD_MAX_SCALE, MELD_AREA.minZ);
  if (top) return finish(MELD_MAX_SCALE, top);
  let lo = MELD_FLOOR_SCALE;
  let best = attempt(lo, MELD_AREA.minZ);
  if (best) {
    let hi = MELD_MAX_SCALE;
    for (let k = 0; k < 7; k++) {
      const mid = Math.sqrt(lo * hi);
      const res = attempt(mid, MELD_AREA.minZ);
      if (res) {
        lo = mid;
        best = res;
      } else hi = mid;
    }
    return finish(lo, best);
  }
  // nothing fits even at the floor scale: pack plainly (overlap beats losing melds)
  const scale = MELD_FLOOR_SCALE;
  const out = new Map<string, MeldSlot>();
  let x = MELD_AREA.minX;
  let z = MELD_AREA.minZ + (FOOT_D * scale) / 2;
  for (const m of ordered) {
    const w = (m.tiles.length * pitch - TILE_GAP) * scale;
    if (x + w > MELD_AREA.maxX && x > MELD_AREA.minX) {
      x = MELD_AREA.minX;
      z += (FOOT_D + rowGap) * scale;
    }
    const x0 = x;
    out.set(m.id, {
      meldId: m.id,
      cx: x0 + w / 2,
      cz: z,
      width: w,
      depth: FOOT_D * scale,
      scale,
      y: TILT_Y * scale,
      tilt: MELD_TILT,
      tiles: m.tiles.map((_, k) => ({ x: x0 + (k * pitch + TILE_W / 2) * scale, z })),
    });
    x += w + meldGap * scale;
  }
  return out;
}

export function meldTileXform(slot: MeldSlot, i: number): Xform {
  const t = slot.tiles[i];
  return { pos: new THREE.Vector3(t.x, slot.y, t.z), quat: quatX(-Math.PI / 2 + slot.tilt), scale: slot.scale };
}
