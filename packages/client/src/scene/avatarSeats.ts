/**
 * Seated VRM opponents around the table: lazy loading, chairs, placement, gaze
 * direction (active seat / table / camera, plus random glances) and reactions.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Reaction, SeatAvatar } from './api';
import { avatarById } from '../avatars/catalog';
import { disposeVrm, loadVrm } from '../avatars/loader';
import { AvatarRig, type Mood } from '../avatars/rig';
import { AVATAR_DIST, SEAT_HIP_Y, TABLE_Y } from './constants';
import { relSeat, seatAngle, seatDir } from './layout';

interface Entry {
  seat: number;
  avatarId: string;
  anchor: THREE.Group;
  rig: AvatarRig | null;
  token: number;
  pendingReaction: Reaction | null;
  mood: Mood;
  glanceTimer: number;
  glanceLeft: number;
  glance: THREE.Vector3;
}

const _v = new THREE.Vector3();

/** Rest hip height (m) the seated pose and the chair are tuned for. */
const SEATED_HIPS_REF = 0.86;

/** Uniform scale for a seated model: 1 for adult-sized models, up to 1.1 for petite ones. */
export function seatedScale(hipsHeight: number): number {
  if (!(hipsHeight > 0)) return 1;
  return THREE.MathUtils.clamp(SEATED_HIPS_REF / hipsHeight, 1, 1.1);
}

export class SeatedAvatars {
  private parent: THREE.Object3D;
  private entries = new Map<number, Entry>();
  private camSeat = 0;
  private n = 4;
  private active: number | null = null;
  private springBones = true;
  private tokenSeq = 0;
  private chairGeo: { seat: THREE.BufferGeometry; back: THREE.BufferGeometry; cushion: THREE.BufferGeometry; leg: THREE.BufferGeometry };
  private chairMat: THREE.MeshStandardMaterial;
  private cushionMat: THREE.MeshStandardMaterial;
  private cameraPos = new THREE.Vector3(0, 1.4, 1.1);
  private disposed = false;

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    this.chairGeo = {
      seat: new RoundedBoxGeometry(0.46, 0.04, 0.42, 2, 0.01),
      back: new RoundedBoxGeometry(0.44, 0.5, 0.04, 2, 0.012),
      cushion: new RoundedBoxGeometry(0.4, 0.035, 0.36, 3, 0.015),
      leg: new THREE.CylinderGeometry(0.018, 0.015, 0.48, 8),
    };
    this.chairMat = new THREE.MeshStandardMaterial({ color: 0x4a2414, roughness: 0.45, metalness: 0.05 });
    this.cushionMat = new THREE.MeshStandardMaterial({ color: 0xa3242a, roughness: 0.85, metalness: 0 });
  }

  private makeChair(): THREE.Group {
    const g = new THREE.Group();
    const seat = new THREE.Mesh(this.chairGeo.seat, this.chairMat);
    seat.position.set(0, 0.48, 0);
    const cushion = new THREE.Mesh(this.chairGeo.cushion, this.cushionMat);
    cushion.position.set(0, 0.515, 0.0);
    const back = new THREE.Mesh(this.chairGeo.back, this.chairMat);
    back.position.set(0, 0.76, -0.2);
    back.rotation.x = -0.08;
    g.add(seat, cushion, back);
    for (const [x, z] of [
      [0.19, 0.17],
      [-0.19, 0.17],
      [0.19, -0.17],
      [-0.19, -0.17],
    ]) {
      const leg = new THREE.Mesh(this.chairGeo.leg, this.chairMat);
      leg.position.set(x, 0.24, z);
      g.add(leg);
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return g;
  }

  /** Place/replace avatars. Resolves when every requested avatar has loaded (or failed). */
  async setSeats(seats: SeatAvatar[], camSeat: number, n: number, onProgress?: (p: number) => void): Promise<void> {
    this.camSeat = camSeat;
    this.n = Math.max(n, 1);
    const wanted = new Map<number, SeatAvatar>();
    for (const s of seats) if (s.seat !== camSeat) wanted.set(s.seat, s);

    // remove seats no longer present / changed avatar
    for (const [seat, e] of this.entries) {
      const w = wanted.get(seat);
      if (!w || avatarById(w.avatarId).id !== e.avatarId) this.removeEntry(seat);
    }

    const loads: Promise<void>[] = [];
    const progress = new Map<number, number>();
    const report = (): void => {
      if (!onProgress || !progress.size) return;
      let sum = 0;
      for (const v of progress.values()) sum += v;
      onProgress(sum / progress.size);
    };
    for (const [seat, s] of wanted) {
      const def = avatarById(s.avatarId);
      let e = this.entries.get(seat);
      if (!e) {
        const anchor = new THREE.Group();
        anchor.add(this.makeChair());
        this.parent.add(anchor);
        e = {
          seat,
          avatarId: def.id,
          anchor,
          rig: null,
          token: 0,
          pendingReaction: null,
          mood: 'normal',
          glanceTimer: 2 + Math.random() * 4,
          glanceLeft: 0,
          glance: new THREE.Vector3(),
        };
        this.entries.set(seat, e);
      }
      this.place(e);
      if (!e.rig) {
        const entry = e;
        const token = ++this.tokenSeq;
        entry.token = token;
        progress.set(seat, 0);
        loads.push(
          loadVrm(def.url, (p) => {
            progress.set(seat, p * 0.9);
            report();
          })
            .then((vrm) => {
              if (this.disposed || entry.token !== token || this.entries.get(seat) !== entry) {
                disposeVrm(vrm);
                return;
              }
              const rig = new AvatarRig(vrm, 'seated');
              rig.springBones = this.springBones;
              entry.rig = rig;
              entry.anchor.add(rig.root);
              this.place(entry);
              rig.setMood(entry.mood);
              rig.react(entry.pendingReaction ?? 'wave');
              entry.pendingReaction = null;
            })
            .catch((err: unknown) => {
              console.warn(`[scene] avatar ${def.id} failed to load`, err);
            })
            .finally(() => {
              progress.set(seat, 1);
              report();
            }),
        );
      }
    }
    if (!loads.length) onProgress?.(1);
    await Promise.all(loads);
  }

  /** Re-place everyone after the seat count or camera seat changed. */
  relayout(camSeat: number, n: number): void {
    if (camSeat === this.camSeat && n === this.n) return;
    this.camSeat = camSeat;
    this.n = Math.max(1, n);
    for (const [seat, e] of this.entries) {
      if (seat === camSeat) this.removeEntry(seat);
      else this.place(e);
    }
  }

  private place(e: Entry): void {
    const angle = seatAngle(relSeat(e.seat, this.camSeat, this.n), this.n);
    const d = seatDir(angle);
    e.anchor.position.copy(d.multiplyScalar(AVATAR_DIST));
    e.anchor.rotation.y = angle + Math.PI; // face the table centre
    e.anchor.updateMatrixWorld(true);
    if (e.rig) {
      const rig = e.rig;
      // petite models (short legs/torso) are scaled up a little so they sit at the table
      // like everyone else instead of peering over it with dangling feet
      const s = seatedScale(rig.hipsHeight);
      rig.root.scale.setScalar(s);
      rig.root.position.set(0, SEAT_HIP_Y - rig.hipsHeight * s, 0.02);
      rig.root.updateMatrixWorld(true);
      rig.setLookAnchors(new THREE.Vector3(0, TABLE_Y, 0).addScaledVector(seatDir(angle), 0.25), this.cameraPos);
      rig.resetSprings();
    }
  }

  private removeEntry(seat: number): void {
    const e = this.entries.get(seat);
    if (!e) return;
    e.token = -1;
    if (e.rig) disposeVrm(e.rig.vrm);
    e.anchor.removeFromParent();
    this.entries.delete(seat);
  }

  has(seat: number): boolean {
    return this.entries.has(seat);
  }

  react(seat: number, reaction: Reaction): void {
    const e = this.entries.get(seat);
    if (!e) return;
    if (e.rig) e.rig.react(reaction);
    else e.pendingReaction = reaction;
  }

  setMood(seat: number, mood: Mood): void {
    const e = this.entries.get(seat);
    if (!e || e.mood === mood) return;
    e.mood = mood;
    e.rig?.setMood(mood);
  }

  setActive(seat: number | null): void {
    this.active = seat;
  }

  /** World position of an avatar's head (falls back to an estimate while loading). */
  headWorld(seat: number, out: THREE.Vector3): THREE.Vector3 | null {
    const e = this.entries.get(seat);
    if (!e) return null;
    if (e.rig) {
      const head = e.rig.vrm.humanoid.getNormalizedBoneNode('head');
      if (head) return head.getWorldPosition(out);
    }
    return out.copy(e.anchor.position).setY(1.15);
  }

  seats(): number[] {
    return [...this.entries.keys()];
  }

  setSpringBones(on: boolean): void {
    this.springBones = on;
    for (const e of this.entries.values()) {
      if (!e.rig) continue;
      e.rig.springBones = on;
      if (on) e.rig.resetSprings();
    }
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    this.cameraPos.copy(cameraPos);
    const others = [...this.entries.values()];
    for (const e of others) {
      const rig = e.rig;
      if (!rig) continue;
      // idle glances keep the table feeling alive
      e.glanceTimer -= dt;
      if (e.glanceLeft > 0) e.glanceLeft -= dt;
      if (e.glanceTimer <= 0) {
        e.glanceTimer = 3 + Math.random() * 5;
        e.glanceLeft = 1.1 + Math.random() * 1.2;
        const r = Math.random();
        const candidates = others.filter((o) => o !== e);
        if (r < 0.35) e.glance.set(cameraPos.x, cameraPos.y - 0.15, cameraPos.z);
        else if (r < 0.7 && candidates.length) {
          const o = candidates[Math.floor(Math.random() * candidates.length)];
          this.headWorld(o.seat, e.glance);
        } else e.glance.set((Math.random() - 0.5) * 0.5, TABLE_Y, (Math.random() - 0.5) * 0.5);
      }

      let target: THREE.Vector3;
      if (e.glanceLeft > 0) {
        target = e.glance;
      } else if (this.active === null) {
        target = _v.set(0, TABLE_Y + 0.02, 0);
      } else if (this.active === e.seat) {
        // own turn: study the table
        target = _v.copy(e.anchor.position).multiplyScalar(0.2).setY(TABLE_Y);
      } else if (this.active === this.camSeat || !this.entries.has(this.active)) {
        // the local player is thinking: look at them (just below the camera)
        target = _v.set(cameraPos.x * 0.6, TABLE_Y + 0.28, cameraPos.z * 0.75);
      } else {
        target = this.headWorld(this.active, _v) ?? _v.set(0, TABLE_Y, 0);
      }
      rig.lookAtWorld(target);
      rig.update(dt);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const seat of [...this.entries.keys()]) this.removeEntry(seat);
    for (const g of Object.values(this.chairGeo)) g.dispose();
    this.chairMat.dispose();
    this.cushionMat.dispose();
  }
}
