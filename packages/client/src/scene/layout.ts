/**
 * Pure layout math for the table (all in table space, see constants.ts).
 */
import * as THREE from 'three';
import type { Meld } from '@open-rummy/shared';
import {
  MELD_AREA,
  MELD_MAX_SCALE,
  MELD_MIN_SCALE,
  MELD_TILT,
  OWN_ORIGIN,
  RACK_DIST,
  RACK_MAX_LEN,
  TABLE_HALF,
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

/** Something already lying on the felt that melds must not cover (dead wall, dice). */
interface Obstacle {
  x: number;
  z: number;
  r: number;
}

function meldObstacles(n: number): Obstacle[] {
  const { deadWall, dice, radius } = cornerAngles(n);
  const dw = seatDir(deadWall).multiplyScalar(radius * 0.74);
  const dc = seatDir(dice).multiplyScalar(radius * 0.74);
  return [
    { x: dw.x, z: dw.z, r: 0.105 },
    { x: dc.x, z: dc.z, r: 0.06 },
  ];
}

/** Axis-aligned rect [x0, x1] x [z0, z1] against a circle. */
function rectHitsCircle(x0: number, x1: number, z0: number, z1: number, o: Obstacle): boolean {
  const dx = Math.max(x0 - o.x, 0, o.x - x1);
  const dz = Math.max(z0 - o.z, 0, o.z - z1);
  return dx * dx + dz * dz < o.r * o.r;
}

/** Felt footprint (z extent) of a tile tilted back by MELD_TILT, at scale 1. */
const TILT_SIN = Math.sin(MELD_TILT);
const TILT_COS = Math.cos(MELD_TILT);
const FOOT_D = TILE_H * TILT_COS + TILE_D * TILT_SIN;
/** height of a tilted tile's centre above the felt, at scale 1 */
const TILT_Y = (TILE_H / 2) * TILT_SIN + (TILE_D / 2) * TILT_COS;

/**
 * Shelf-pack melds into rows inside MELD_AREA. Tiles lean back toward the camera for
 * readability. The largest scale (up to MELD_MAX_SCALE) at which everything fits without
 * covering the dead wall or dice wins, so a few melds are big and the layout shrinks
 * smoothly as the table fills up. Rows are centred; sets start on their own row.
 */
export function layoutMelds(melds: Meld[], n = 4): Map<string, MeldSlot> {
  const ordered = orderMelds(melds);
  const areaW = MELD_AREA.maxX - MELD_AREA.minX;
  const areaD = MELD_AREA.maxZ - MELD_AREA.minZ;
  const pitch = TILE_W + TILE_GAP;
  const meldGap = TILE_W * 0.75;
  // tilted rows need extra air so the row in front does not hide the next row's ranks
  const rowGap = 0.017;
  const obstacles = meldObstacles(n);

  type Row = { melds: Meld[]; width: number };
  const pack = (scale: number): Row[] => {
    const maxW = areaW / scale;
    const rows: Row[] = [];
    let cur: Row = { melds: [], width: 0 };
    let lastType: string | null = null;
    for (const m of ordered) {
      const w = m.tiles.length * pitch - TILE_GAP;
      const needed = cur.melds.length ? cur.width + meldGap + w : w;
      const typeBreak = lastType === 'RUN' && m.type === 'SET' && cur.melds.length > 0;
      if (cur.melds.length && (needed > maxW || typeBreak)) {
        rows.push(cur);
        cur = { melds: [], width: 0 };
      }
      cur.width = cur.melds.length ? cur.width + meldGap + w : w;
      cur.melds.push(m);
      lastType = m.type;
    }
    if (cur.melds.length) rows.push(cur);
    return rows;
  };

  const place = (rows: Row[], scale: number, startZ: number): Map<string, MeldSlot> => {
    const out = new Map<string, MeldSlot>();
    const rowPitch = (FOOT_D + rowGap) * scale;
    let z = startZ + (FOOT_D * scale) / 2;
    for (const row of rows) {
      let x = -(row.width * scale) / 2;
      for (const m of row.melds) {
        const w = (m.tiles.length * pitch - TILE_GAP) * scale;
        const tiles = m.tiles.map((_, i) => ({ x: x + (i * pitch + TILE_W / 2) * scale, z }));
        out.set(m.id, {
          meldId: m.id,
          cx: x + w / 2,
          cz: z,
          width: w,
          depth: FOOT_D * scale,
          scale,
          y: TILT_Y * scale,
          tilt: MELD_TILT,
          tiles,
        });
        x += w + meldGap * scale;
      }
      z += rowPitch;
    }
    return out;
  };

  const blocked = (slots: Map<string, MeldSlot>): boolean => {
    for (const s of slots.values()) {
      // the raised top edges of tilted tiles also hide whatever lies just behind them
      const hidden = TILE_H * TILT_SIN * s.scale * 1.2;
      const x0 = s.cx - s.width / 2;
      const x1 = s.cx + s.width / 2;
      const z0 = s.cz - s.depth / 2 - hidden;
      const z1 = s.cz + s.depth / 2;
      for (const o of obstacles) if (rectHitsCircle(x0, x1, z0, z1, o)) return true;
    }
    return false;
  };

  const totalDepth = (rows: Row[], scale: number): number => (rows.length * (FOOT_D + rowGap) - rowGap) * scale;
  const centreZ = (MELD_AREA.minZ + MELD_AREA.maxZ) / 2;

  let fallback: Map<string, MeldSlot> | null = null;
  for (let scale = MELD_MAX_SCALE; scale >= MELD_MIN_SCALE - 1e-9; scale *= 0.96) {
    const rows = pack(scale);
    const depth = totalDepth(rows, scale);
    if (depth > areaD) continue;
    // centred first, then slide toward the camera side if the far corners (dead wall,
    // dice) are in the way
    const centred = centreZ - depth / 2;
    const lowest = MELD_AREA.maxZ - depth;
    for (let k = 0; k <= 4; k++) {
      const startZ = centred + ((lowest - centred) * k) / 4;
      const slots = place(rows, scale, startZ);
      if (!blocked(slots)) return slots;
      fallback ??= slots;
    }
  }
  if (fallback) return fallback;
  const rows = pack(MELD_MIN_SCALE);
  return place(rows, MELD_MIN_SCALE, centreZ - totalDepth(rows, MELD_MIN_SCALE) / 2);
}

export function meldTileXform(slot: MeldSlot, i: number): Xform {
  const t = slot.tiles[i];
  return { pos: new THREE.Vector3(t.x, slot.y, t.z), quat: quatX(-Math.PI / 2 + slot.tilt), scale: slot.scale };
}
