/**
 * Debug-only geometry probe: where do the seated avatars' hands actually sit relative to
 * the opponents' tile racks? Uses the skinned hand/finger vertices (exact surface, incl.
 * sleeves skinned to the hand) and tests them against oriented tile boxes.
 * Only reachable through the `?debug` hook in table.ts; not used by gameplay.
 */
import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { HAND_REST_MIN, RIM_HEIGHT, RIM_WIDTH, TABLE_HALF, TILE_D, TILE_H, TILE_W } from './constants';
import { MAX_RACK_COUNT, rackXform, seatDir, type RackState } from './layout';
import { handVertices } from '../avatars/handMesh';

export { handVertices };

const _v = new THREE.Vector3();

export interface TileBox {
  /** world -> tile-local (unscaled tile body is TILE_W x TILE_H x TILE_D, centred) */
  inv: THREE.Matrix4;
  /** world scale of the tile (to express local distances in metres) */
  scale: number;
  label: string;
}

export function tileBoxFromObject(obj: THREE.Object3D, label: string): TileBox {
  obj.updateWorldMatrix(true, false);
  const s = new THREE.Vector3();
  obj.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  return { inv: obj.matrixWorld.clone().invert(), scale: s.x, label };
}

/** Nominal rack tiles of a seat (all states, longest rack and a 14-tile rack), world space. */
export function nominalRackBoxes(angle: number, tableY: number): TileBox[] {
  const out: TileBox[] = [];
  const states: RackState[] = ['stand', 'dead', 'revealed'];
  for (const count of [14, MAX_RACK_COUNT]) {
    for (const state of states) {
      for (let i = 0; i < count; i++) {
        const xf = rackXform(angle, i, count, state);
        const m = new THREE.Matrix4().compose(xf.pos.clone().setY(xf.pos.y + tableY), xf.quat, new THREE.Vector3().setScalar(xf.scale));
        out.push({ inv: m.invert(), scale: xf.scale, label: `${state}${count}#${i}` });
      }
    }
  }
  return out;
}

/** Euclidean distance (metres) from a world point to a tile box; 0 when inside. */
export function boxDistance(p: THREE.Vector3, box: TileBox): number {
  const l = _v.copy(p).applyMatrix4(box.inv);
  const dx = Math.max(Math.abs(l.x) - TILE_W / 2, 0);
  const dy = Math.max(Math.abs(l.y) - TILE_H / 2, 0);
  const dz = Math.max(Math.abs(l.z) - TILE_D / 2, 0);
  return Math.hypot(dx, dy, dz) * box.scale;
}

export interface HandStats {
  side: 'left' | 'right';
  verts: number;
  /** closest approach toward the table centre along the seat direction (m from centre) */
  minRadial: number;
  /** wrist (hand bone) radial distance and height above the felt */
  wristRadial: number;
  wristY: number;
  /** lowest hand vertex above the felt (m) */
  minY: number;
  /** smallest gap to any rack tile box (m, 0 = touching/inside) */
  minGap: number;
  /** max (support height - vertex height) over the felt and rim: >0 sinks in, <0 = lowest point hovers that high */
  sink: number;
  /** same as sink for the forearm (lowerArm-skinned vertices) */
  forearmSink: number;
  /** vertices inside a rack tile box */
  inside: number;
  closest: string;
}

export function handStats(vrm: VRM, side: 'left' | 'right', angle: number, tableY: number, boxes: TileBox[]): HandStats {
  const verts = handVertices(vrm, side);
  const d = seatDir(angle);
  let minRadial = Infinity;
  let minY = Infinity;
  let minGap = Infinity;
  let inside = 0;
  let closest = '';
  const sink = sinkOf(verts, tableY);
  const forearmSink = sinkOf(handVertices(vrm, side, [`${side}LowerArm` as VRMHumanBoneName]), tableY);
  for (const p of verts) {
    const r = p.x * d.x + p.z * d.z;
    if (r < minRadial) minRadial = r;
    if (p.y - tableY < minY) minY = p.y - tableY;
    let pg = Infinity;
    for (const b of boxes) {
      // cheap reject: boxes are small, skip far ones
      const g = boxDistance(p, b);
      if (g < pg) {
        pg = g;
        if (g < minGap) {
          minGap = g;
          closest = b.label;
        }
      }
    }
    if (pg <= 0) inside++;
  }
  const wrist = vrm.humanoid.getRawBoneNode(`${side}Hand` as VRMHumanBoneName);
  const w = wrist ? wrist.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  return {
    side,
    verts: verts.length,
    minRadial: round(minRadial),
    wristRadial: round(w.x * d.x + w.z * d.z),
    wristY: round(w.y - tableY),
    minY: round(minY),
    minGap: round(minGap),
    sink: round(sink),
    forearmSink: round(forearmSink),
    inside,
    closest,
  };
}

/** max (support height - vertex height) over the square felt + rim; -Infinity if nothing is over the table */
function sinkOf(verts: THREE.Vector3[], tableY: number): number {
  let sink = -Infinity;
  for (const p of verts) {
    // the table is square in world x/z: felt inside TABLE_HALF, wooden rim around it
    const edge = Math.max(Math.abs(p.x), Math.abs(p.z));
    if (edge < TABLE_HALF + RIM_WIDTH) sink = Math.max(sink, (edge > TABLE_HALF ? RIM_HEIGHT : 0) - (p.y - tableY));
  }
  return sink;
}

const round = (v: number): number => Math.round(v * 10000) / 10000;

/** True when a hand is clear of the racks and resting behind the hand-rest line. */
export function handOk(h: HandStats): boolean {
  return h.inside === 0 && h.minGap > 0.003 && h.minRadial >= HAND_REST_MIN - 1e-4;
}
