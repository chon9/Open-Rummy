import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HAND_REST_MIN, HAND_WRIST, RIM_WIDTH, TABLE_HALF, TILE_D, TILE_H, TILE_W } from './constants';
import { MAX_RACK_COUNT, rackXform, seatAngle, seatDir, type RackState } from './layout';

/**
 * Seated avatars rest their hands behind HAND_REST_MIN (checked on the real skinned models
 * at runtime with ?debug, see handCheck.ts). Here: no rack tile, in any state, for any
 * player count, seat or hand size, reaches past that line toward its owner.
 */
describe('racks stay in front of the hand-rest line', () => {
  const states: RackState[] = ['stand', 'dead', 'revealed'];
  for (const n of [3, 4, 5]) {
    it(`${n} players: every rack tile corner is closer to the centre than HAND_REST_MIN`, () => {
      let farthest = 0;
      for (let rel = 1; rel < n; rel++) {
        const angle = seatAngle(rel, n);
        const d = seatDir(angle);
        for (let count = 1; count <= MAX_RACK_COUNT + 2; count++) {
          for (const state of states) {
            for (let i = 0; i < count; i++) {
              const xf = rackXform(angle, i, count, state);
              for (const sx of [-1, 1])
                for (const sy of [-1, 1])
                  for (const sz of [-1, 1]) {
                    const c = new THREE.Vector3((sx * TILE_W) / 2, (sy * TILE_H) / 2, (sz * TILE_D) / 2)
                      .multiplyScalar(xf.scale)
                      .applyQuaternion(xf.quat)
                      .add(xf.pos);
                    farthest = Math.max(farthest, c.x * d.x + c.z * d.z);
                  }
            }
          }
        }
      }
      // at least 5 mm of felt between the back of the rack and the fingertips
      expect(farthest).toBeLessThan(HAND_REST_MIN - 0.005);
    });
  }

  it('wrists rest on the rim, behind the hand-rest line', () => {
    expect(HAND_WRIST.radial).toBeGreaterThan(HAND_REST_MIN + 0.08); // room for the hand itself
    expect(HAND_WRIST.radial).toBeGreaterThan(TABLE_HALF);
    expect(HAND_WRIST.radial).toBeLessThan(TABLE_HALF + RIM_WIDTH);
    expect(HAND_WRIST.elbowHeight).toBeGreaterThan(0);
  });
});
