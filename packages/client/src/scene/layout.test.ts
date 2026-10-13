import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Meld } from '@open-rummy/shared';
import { MELD_AREA, MELD_MIN_SCALE, TABLE_Y, TILE_D, TILE_H, TILE_W } from './constants';
import {
  cameraRig,
  convexHull,
  deadWallXform,
  diceRestPos,
  layoutMelds,
  meldTileXform,
  polysIntersect,
  rackXform,
  seatAngle,
  type MeldLayoutOptions,
  type MeldSlot,
  type P2,
  type RackState,
  type Xform,
} from './layout';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const COLS = ['B', 'R', 'Y', 'G'] as const;
const CODE: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function run(id: string, colour: (typeof COLS)[number], lo: number, len: number): Meld {
  return {
    id,
    type: 'RUN',
    ownerSeat: 0,
    colour,
    tiles: Array.from({ length: len }, (_, k) => ({ tileId: `${colour}${CODE[lo + k] ?? lo + k}_1`, rep: { colour, rank: lo + k } })),
  };
}

function set(id: string, rank: number, len: number): Meld {
  return {
    id,
    type: 'SET',
    ownerSeat: 0,
    rank: rank as 9,
    tiles: Array.from({ length: len }, (_, k) => ({ tileId: `${COLS[k % 4]}${rank}_${(k >> 2) + 1}`, rep: { colour: null, rank } })),
  };
}

/** 4 x 14-tile runs + 6 runs of 8 + 6 sets of 6 (140 tiles). */
function worstCase(): Meld[] {
  const out: Meld[] = [];
  COLS.forEach((c, i) => out.push(run(`m${i + 1}`, c, 1, 14)));
  for (let i = 0; i < 6; i++) out.push(run(`m${5 + i}`, COLS[i % 4], 2 + (i % 3), 8));
  for (let i = 0; i < 6; i++) out.push(set(`m${11 + i}`, 2 + i, 6));
  return out;
}

// ---------------------------------------------------------------------------
// screen-space projection (independent of the layout's own felt-plane maths)
// ---------------------------------------------------------------------------

const VIEWPORTS: [number, number][] = [
  [1280, 760],
  [1920, 1080],
  [844, 390],
  [390, 844],
  [1024, 1024],
  [1280, 1024],
  [768, 1024],
  [2560, 1080],
];

function cameraFor(w: number, h: number): THREE.PerspectiveCamera {
  const rig = cameraRig(w / h);
  const cam = new THREE.PerspectiveCamera(rig.fov, w / h, 0.05, 40);
  cam.position.copy(rig.pos);
  cam.lookAt(rig.look);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Screen-space (NDC) convex outline of a box with half extents (hx, hy, hz) at a table-space transform. */
function screenHull(xf: Xform, hx: number, hy: number, hz: number, cam: THREE.Camera): P2[] {
  const pts: P2[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const v = new THREE.Vector3(sx * hx, sy * hy, sz * hz)
          .multiplyScalar(xf.scale)
          .applyQuaternion(xf.quat)
          .add(xf.pos)
          .add(new THREE.Vector3(0, TABLE_Y, 0))
          .project(cam);
        pts.push({ x: v.x, z: v.y });
      }
  return convexHull(pts);
}

const tileHull = (xf: Xform, cam: THREE.Camera): P2[] => screenHull(xf, TILE_W / 2, TILE_H / 2, TILE_D / 2, cam);

interface Obstacle {
  what: string;
  xf: Xform;
  half: [number, number, number];
}

function obstacles(n: number, rackCount: number, deadWall: number): Obstacle[] {
  const out: Obstacle[] = [];
  const states: RackState[] = ['stand', 'dead', 'revealed'];
  for (let rel = 1; rel < n; rel++) {
    for (const state of states)
      for (let i = 0; i < rackCount; i++)
        out.push({ what: `rack rel${rel} ${state} #${i}`, xf: rackXform(seatAngle(rel, n), i, rackCount, state), half: [TILE_W / 2, TILE_H / 2, TILE_D / 2] });
  }
  for (let i = 0; i < deadWall; i++) out.push({ what: `dead wall #${i}`, xf: deadWallXform(i, deadWall, n), half: [TILE_W / 2, TILE_H / 2, TILE_D / 2] });
  for (let i = 0; i < 2; i++)
    out.push({ what: `die ${i}`, xf: { pos: diceRestPos(i, n), quat: new THREE.Quaternion(), scale: 1 }, half: [0.01, 0.01, 0.01] });
  return out;
}

function meldTiles(slots: Map<string, MeldSlot>): { what: string; xf: Xform }[] {
  const out: { what: string; xf: Xform }[] = [];
  for (const s of slots.values()) s.tiles.forEach((_, i) => out.push({ what: `${s.meldId}[${i}]`, xf: meldTileXform(s, i) }));
  return out;
}

/** Every screen overlap between a meld tile and a rack / dead wall / die, for all viewports. */
function screenOverlaps(slots: Map<string, MeldSlot>, obs: Obstacle[]): string[] {
  const hits: string[] = [];
  const tiles = meldTiles(slots);
  for (const [w, h] of VIEWPORTS) {
    const cam = cameraFor(w, h);
    const obsHulls = obs.map((o) => ({ what: o.what, hull: screenHull(o.xf, ...o.half, cam) }));
    for (const t of tiles) {
      const th = tileHull(t.xf, cam);
      for (const o of obsHulls) if (polysIntersect(th, o.hull)) hits.push(`${w}x${h}: ${t.what} over ${o.what}`);
    }
  }
  return hits;
}

const deadWallFor = (n: number): number => 112 - 20 * n;

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('geometry helpers', () => {
  it('detects convex polygon overlap', () => {
    const sq = (x: number, z: number, s: number): P2[] =>
      convexHull([
        { x, z },
        { x: x + s, z },
        { x, z: z + s },
        { x: x + s, z: z + s },
      ]);
    expect(polysIntersect(sq(0, 0, 1), sq(0.5, 0.5, 1))).toBe(true);
    expect(polysIntersect(sq(0, 0, 1), sq(1.01, 0, 1))).toBe(false);
    expect(polysIntersect(sq(0, 0, 1), sq(0.2, 0.2, 0.1))).toBe(true);
  });
});

describe('layoutMelds keeps melds clear of racks, dead wall and dice', () => {
  for (const n of [3, 4, 5]) {
    for (const [label, opts, rackCount] of [
      ['default zones, 25-tile racks', {}, 25],
      ['live counts, 9-tile racks', { rackCounts: [0, ...new Array(n - 1).fill(9 + 2)], deadWall: deadWallFor(n) }, 9],
    ] as [string, MeldLayoutOptions, number][]) {
      it(`${n} players, worst-case melds, ${label}`, () => {
        const melds = worstCase();
        const t0 = performance.now();
        const slots = layoutMelds(melds, n, opts);
        const ms = performance.now() - t0;
        expect(slots.size).toBe(melds.length);
        const scale = [...slots.values()][0].scale;
        expect(scale).toBeGreaterThanOrEqual(MELD_MIN_SCALE - 1e-9);
        for (const s of slots.values()) {
          expect(s.scale).toBe(scale);
          expect(s.tiles.length).toBe(melds.find((m) => m.id === s.meldId)?.tiles.length);
          expect(s.cx - s.width / 2).toBeGreaterThanOrEqual(MELD_AREA.minX - 1e-9);
          expect(s.cx + s.width / 2).toBeLessThanOrEqual(MELD_AREA.maxX + 1e-9);
          expect(s.cz + s.depth / 2).toBeLessThanOrEqual(MELD_AREA.maxZ + 1e-9);
        }
        // melds never overlap each other on the felt
        const all = [...slots.values()];
        for (let a = 0; a < all.length; a++)
          for (let b = a + 1; b < all.length; b++) {
            const A = all[a];
            const B = all[b];
            const apart = Math.abs(A.cx - B.cx) >= (A.width + B.width) / 2 || Math.abs(A.cz - B.cz) >= (A.depth + B.depth) / 2;
            expect(apart, `${A.meldId} vs ${B.meldId}`).toBe(true);
          }
        expect(screenOverlaps(slots, obstacles(n, rackCount, deadWallFor(n)))).toEqual([]);
        expect(ms).toBeLessThan(1500);
      });
    }

    it(`${n} players, a few melds are drawn large and clear of every rack`, () => {
      const melds = [run('a1', 'R', 3, 3), run('a2', 'B', 9, 3), run('a3', 'Y', 5, 4)];
      const slots = layoutMelds(melds, n);
      expect(slots.size).toBe(3);
      expect([...slots.values()][0].scale).toBeGreaterThan(1.8);
      expect(screenOverlaps(slots, obstacles(n, 25, deadWallFor(n)))).toEqual([]);
    });

    it(`${n} players, every prefix of the worst case stays clear`, () => {
      const all = worstCase();
      const obs = obstacles(n, 20, deadWallFor(n));
      for (let k = 1; k <= all.length; k += 3) {
        const slots = layoutMelds(all.slice(0, k), n, { deadWall: deadWallFor(n) });
        expect(slots.size).toBe(k);
        expect(screenOverlaps(slots, obs)).toEqual([]);
      }
    });
  }
});
