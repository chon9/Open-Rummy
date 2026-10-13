/**
 * AvatarRig: drives one VRM procedurally.
 *
 * Layers, evaluated every frame:
 *   base pose (seated / standing) + mood offsets
 *   + idle life (breathing, sway, micro head motion)
 *   + look-at (eyes via vrm.lookAt.target, head/neck/chest share of the turn)
 *   + gesture clip (blended in/out by an envelope)
 * The resulting Euler targets are critically damped toward, so switching reactions
 * mid-gesture never pops. Expressions are damped the same way; blinking is layered on top.
 */
import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Reaction } from '../scene/api';
import {
  BONE_KEYS,
  CLIPS,
  EXPR_KEYS,
  SEATED_POSE,
  STANDING_POSE,
  clipWeight,
  type BoneKey,
  type ClipFrame,
  type ExprKey,
  type ExprWeights,
  type GestureClip,
  type Pose,
  type Vec3,
} from './gestures';

export type RigMode = 'seated' | 'standing';
export type Mood = 'normal' | 'dead' | 'winner';

const damp = (current: number, target: number, k: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-k * dt));

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

function eulerQuat(x: number, y: number, z: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(_e.set(x, y, z, 'XYZ'));
}

/** Stable string identifying a model (VRM 1 meta.name / VRM 0 meta.title). */
function modelKey(vrm: VRM): string {
  const meta = vrm.meta as { name?: string; title?: string } | undefined;
  return meta?.name ?? meta?.title ?? '';
}

/**
 * Deterministic per-model arm variation for the seated pose: one forearm a little further
 * forward than the other, slightly different elbow bends and wrist angles.
 */
function seatedArmVariant(key: string): Pose {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  const r = (): number => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return (h / 4294967296) * 2 - 1; // -1..1
  };
  const lead = r() * 0.08; // + = left arm reaches a bit further onto the table
  return {
    leftUpperArm: [-lead * 0.6, r() * 0.05, 0],
    rightUpperArm: [lead * 0.6, -r() * 0.05, 0],
    leftLowerArm: [0, r() * 0.08, 0],
    rightLowerArm: [0, -r() * 0.08, 0],
    leftHand: [0, r() * 0.1, r() * 0.06],
    rightHand: [0, -r() * 0.1, -r() * 0.06],
  };
}

export class AvatarRig {
  readonly vrm: VRM;
  readonly root = new THREE.Group();
  readonly mode: RigMode;
  /** height of the head bone above the root (metres), measured in rest pose */
  readonly headHeight: number;
  /** height of the hips above the root in rest pose */
  readonly hipsHeight: number;
  springBones = true;

  private bones = new Map<BoneKey, THREE.Object3D>();
  /**
   * VRM 0.x normalized bones live in the model's original -Z-facing frame (rotateVRM0 only
   * turns the scene), so rotations about X and Z must be mirrored to mean the same motion.
   */
  private flipXZ = false;
  /**
   * Smoothed bone rotations. Damping and gesture blending happen on quaternions so a
   * change between very different poses (e.g. forearm on the table -> hands over the eyes)
   * takes the shortest path instead of spinning through odd Euler intermediates.
   */
  private current = new Map<BoneKey, THREE.Quaternion>();
  /** per-frame scratch targets (reused to avoid garbage): Euler, then the blended quaternion */
  private target = new Map<BoneKey, Vec3>();
  private targetQ = new Map<BoneKey, THREE.Quaternion>();
  private hipsRestY = 0;
  private bounce = 0;
  private clip: { c: GestureClip; t: number } | null = null;
  private exprCurrent: Record<ExprKey, number> = { happy: 0, sad: 0, angry: 0, surprised: 0, relaxed: 0, aa: 0, oh: 0 };
  private exprAvailable = new Set<string>();
  private mood: Mood = 'normal';
  private time = Math.random() * 100;
  private phase = Math.random() * Math.PI * 2;
  private blinkTimer = 1 + Math.random() * 3;
  private blinkT = -1;
  private doubleBlink = false;
  private blinking = true;
  /** look target in root-local space: desired and smoothed */
  private lookDesired = new THREE.Vector3(0, 1, 2);
  private lookSmoothed = new THREE.Vector3(0, 1, 2);
  /** optional named targets, root-local */
  private tableTarget = new THREE.Vector3(0, 0.5, 1);
  private viewerTarget = new THREE.Vector3(0, 1.2, 2);
  private lookObj = new THREE.Object3D();
  private frame: ClipFrame = { pose: {}, expr: {}, bounce: 0, look: null };
  /** small per-character offsets on the seated arms so the table does not look cloned */
  private armVariant: Pose = {};

  constructor(vrm: VRM, mode: RigMode) {
    this.vrm = vrm;
    this.mode = mode;
    this.root.add(vrm.scene);
    this.root.add(this.lookObj);
    this.flipXZ = vrm.meta?.metaVersion === '0';
    const humanoid = vrm.humanoid;
    for (const key of BONE_KEYS) {
      const node = humanoid.getNormalizedBoneNode(key as VRMHumanBoneName);
      if (node) this.bones.set(key, node);
    }
    const hips = this.bones.get('hips');
    this.hipsRestY = hips ? hips.position.y : 0;

    // measure rest heights in root space
    vrm.scene.updateMatrixWorld(true);
    this.root.updateMatrixWorld(true);
    const head = humanoid.getNormalizedBoneNode('head');
    this.headHeight = head ? this.root.worldToLocal(head.getWorldPosition(_v)).y : 1.4;
    this.hipsHeight = hips ? this.root.worldToLocal(hips.getWorldPosition(_v)).y : 0.9;
    this.lookDesired.set(0, this.headHeight, 2);
    this.lookSmoothed.copy(this.lookDesired);
    this.lookObj.position.copy(this.lookSmoothed);
    if (vrm.lookAt) vrm.lookAt.target = this.lookObj;

    const em = vrm.expressionManager;
    if (em) {
      for (const name of [...EXPR_KEYS, 'blink']) if (em.getExpression(name)) this.exprAvailable.add(name);
    }

    if (mode === 'seated') this.armVariant = seatedArmVariant(modelKey(vrm));

    // start in the base pose immediately (no damping from T-pose)
    const base = this.basePose();
    for (const key of BONE_KEYS) {
      const b = base[key] ?? [0, 0, 0];
      const d = this.armVariant[key] ?? [0, 0, 0];
      this.current.set(key, eulerQuat(b[0] + d[0], b[1] + d[1], b[2] + d[2], new THREE.Quaternion()));
      this.targetQ.set(key, new THREE.Quaternion());
    }
    this.applyPose();
    vrm.humanoid.update();
  }

  private basePose(): Pose {
    return this.mode === 'seated' ? SEATED_POSE : STANDING_POSE;
  }

  /** Set where the avatar looks when idle (world space). */
  lookAtWorld(world: THREE.Vector3): void {
    this.root.updateWorldMatrix(true, false); // root only: the bone tree is updated by the renderer
    this.lookDesired.copy(this.root.worldToLocal(_w.copy(world)));
  }

  /** Configure world positions used by clip look hints. */
  setLookAnchors(tableWorld: THREE.Vector3, viewerWorld: THREE.Vector3): void {
    this.root.updateWorldMatrix(true, false); // root only: the bone tree is updated by the renderer
    this.tableTarget.copy(this.root.worldToLocal(_w.copy(tableWorld)));
    this.viewerTarget.copy(this.root.worldToLocal(_w.copy(viewerWorld)));
  }

  setBlinking(on: boolean): void {
    this.blinking = on;
  }

  setMood(m: Mood): void {
    this.mood = m;
  }

  react(reaction: Reaction): void {
    if (reaction === 'idle') {
      this.clip = null;
      return;
    }
    const c = CLIPS[reaction];
    if (c) this.clip = { c, t: 0 };
  }

  /** Call after teleporting the root so hair/skirts do not whip around. */
  resetSprings(): void {
    this.root.updateMatrixWorld(true);
    this.vrm.springBoneManager?.reset();
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    const base = this.basePose();
    const target = this.target;
    for (const key of BONE_KEYS) {
      const b = base[key];
      const v = target.get(key);
      if (v) {
        v[0] = b ? b[0] : 0;
        v[1] = b ? b[1] : 0;
        v[2] = b ? b[2] : 0;
      } else {
        target.set(key, b ? [b[0], b[1], b[2]] : [0, 0, 0]);
      }
    }
    const addTo = (key: BoneKey, x: number, y: number, z: number): void => {
      const v = target.get(key);
      if (!v) return;
      v[0] += x;
      v[1] += y;
      v[2] += z;
    };

    for (const key of Object.keys(this.armVariant) as BoneKey[]) {
      const d = this.armVariant[key];
      if (d) addTo(key, d[0], d[1], d[2]);
    }

    // mood
    if (this.mood === 'dead') {
      addTo('spine', 0.12, 0, 0);
      addTo('head', 0.25, 0, 0.05);
    }

    // idle life: breathing (~3.6 s), slow sway, tiny head drift
    const breath = Math.sin((t / 3.6) * Math.PI * 2 + this.phase);
    addTo('chest', breath * 0.018, 0, 0);
    addTo('spine', breath * 0.008, Math.sin(t * 0.37 + this.phase) * 0.025, Math.sin(t * 0.53 + this.phase) * 0.02);
    addTo('leftShoulder', 0, 0, breath * 0.012);
    addTo('rightShoulder', 0, 0, -breath * 0.012);
    addTo('head', Math.sin(t * 0.71 + this.phase) * 0.025, Math.sin(t * 0.43) * 0.03, Math.sin(t * 0.29 + this.phase) * 0.03);
    if (this.mode === 'seated') {
      // fidgety fingers / forearms on the table
      addTo('leftLowerArm', 0, Math.sin(t * 0.9 + this.phase) * 0.04, 0);
      addTo('rightLowerArm', 0, Math.sin(t * 0.8 + this.phase * 1.3) * 0.04, 0);
    } else {
      addTo('leftUpperArm', 0, 0, Math.sin(t * 0.6 + this.phase) * 0.03);
      addTo('rightUpperArm', 0, 0, -Math.sin(t * 0.6 + this.phase) * 0.03);
    }

    // gesture clip
    const frame = this.frame;
    frame.pose = {};
    frame.expr = {};
    frame.bounce = 0;
    frame.look = null;
    let w = 0;
    if (this.clip) {
      this.clip.t += dt;
      const { c } = this.clip;
      if (this.clip.t >= c.duration) {
        this.clip = null;
      } else {
        w = clipWeight(c, this.clip.t);
        c.sample(this.clip.t, this.mode === 'seated', frame);
      }
    }
    for (const key of BONE_KEYS) {
      const tv = target.get(key);
      const tq = this.targetQ.get(key);
      if (!tv || !tq) continue;
      eulerQuat(tv[0], tv[1], tv[2], tq);
      const cv = w > 0 ? frame.pose[key] : undefined;
      if (cv) tq.slerp(eulerQuat(cv[0], cv[1], cv[2], _q), w);
    }

    // look target: clip hint overrides the idle target while the clip is strong
    let desired = this.lookDesired;
    if (frame.look && w > 0.3) {
      if (frame.look === 'table') desired = this.tableTarget;
      else if (frame.look === 'viewer') desired = this.viewerTarget;
      else desired = _w.set(this.lookDesired.x * 0.3, this.headHeight + 0.9, this.lookDesired.z * 0.3 + 1.2);
    }
    const lk = 1 - Math.exp(-5 * dt);
    this.lookSmoothed.lerp(desired, lk);
    this.lookObj.position.copy(this.lookSmoothed);

    // head / neck / chest share of the gaze
    _v.copy(this.lookSmoothed).sub(_w.set(0, this.headHeight, 0.05));
    const yaw = THREE.MathUtils.clamp(Math.atan2(_v.x, _v.z), -0.9, 0.9);
    const pitchDown = THREE.MathUtils.clamp(Math.atan2(-_v.y, Math.hypot(_v.x, _v.z)), -0.5, 0.6);
    const gazeShare = 1 - w * 0.6; // gestures with their own head motion keep most of it
    this.gaze('head', pitchDown * 0.45 * gazeShare, yaw * 0.38 * gazeShare);
    this.gaze('neck', pitchDown * 0.2 * gazeShare, yaw * 0.3 * gazeShare);
    this.gaze('chest', 0, yaw * 0.12 * gazeShare);

    // damp toward target
    const a = 1 - Math.exp(-14 * dt);
    for (const key of BONE_KEYS) {
      const cur = this.current.get(key);
      const tq = this.targetQ.get(key);
      if (cur && tq) cur.slerp(tq, a);
    }
    this.bounce = damp(this.bounce, frame.bounce * w, 18, dt);
    this.applyPose();

    // expressions
    const moodExpr: ExprWeights =
      this.mood === 'dead' ? { sad: 0.35 } : this.mood === 'winner' ? { happy: 0.45 } : { relaxed: 0.12 };
    for (const key of EXPR_KEYS) {
      const tgt = Math.max((frame.expr[key] ?? 0) * w, moodExpr[key] ?? 0);
      this.exprCurrent[key] = damp(this.exprCurrent[key], tgt, 9, dt);
    }
    this.applyExpressions(dt);

    this.updateVrm(dt);
  }

  /** Apply a small gaze turn on top of a bone's blended target. */
  private gaze(key: BoneKey, pitch: number, yaw: number): void {
    const tq = this.targetQ.get(key);
    if (tq) tq.multiply(eulerQuat(pitch, yaw, 0, _q));
  }

  private applyPose(): void {
    for (const [key, node] of this.bones) {
      const c = this.current.get(key);
      if (!c) continue;
      // mirroring Euler x/z (see flipXZ) is conjugation by a half turn about Y
      if (this.flipXZ) node.quaternion.set(-c.x, c.y, -c.z, c.w);
      else node.quaternion.copy(c);
    }
    const hips = this.bones.get('hips');
    if (hips) hips.position.y = this.hipsRestY + this.bounce;
  }

  private setExpr(name: string, value: number): void {
    if (this.exprAvailable.has(name)) this.vrm.expressionManager?.setValue(name, value);
  }

  private applyExpressions(dt: number): void {
    const e = this.exprCurrent;
    this.setExpr('happy', e.happy);
    this.setExpr('sad', e.sad);
    this.setExpr('angry', e.angry);
    this.setExpr('relaxed', e.relaxed * (1 - e.happy));
    // VRM0 models have no 'surprised': fall back to an open "oh" mouth
    if (this.exprAvailable.has('surprised')) {
      this.setExpr('surprised', e.surprised);
      this.setExpr('oh', e.oh);
    } else {
      this.setExpr('oh', Math.min(1, e.oh + e.surprised * 0.8));
    }
    this.setExpr('aa', e.aa);

    // blinking (suppressed while smiling hard: happy eyes are already closed arcs)
    this.blinkTimer -= dt;
    if (this.blinking && this.blinkT < 0 && this.blinkTimer <= 0) {
      this.blinkT = 0;
      this.doubleBlink = Math.random() < 0.18;
      this.blinkTimer = 2 + Math.random() * 3.5;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const len = 0.16;
      const gap = 0.07;
      const total = this.doubleBlink ? len * 2 + gap : len;
      if (this.blinkT >= total) {
        this.blinkT = -1;
      } else {
        const u = this.blinkT < len ? this.blinkT : this.blinkT - len - gap;
        blink = u >= 0 && u < len ? Math.sin((u / len) * Math.PI) : 0;
      }
    }
    const suppress = Math.min(1, e.happy * 1.3 + e.surprised);
    this.setExpr('blink', Math.max(0, blink) * (1 - suppress));
  }

  /** Equivalent to vrm.update(dt), but spring bones can be switched off (low quality). */
  private updateVrm(dt: number): void {
    const vrm = this.vrm;
    vrm.humanoid.update();
    vrm.lookAt?.update(dt);
    vrm.expressionManager?.update();
    vrm.nodeConstraintManager?.update();
    if (this.springBones) vrm.springBoneManager?.update(dt);
    if (vrm.materials) {
      for (const m of vrm.materials) {
        const mm = m as THREE.Material & { update?: (d: number) => void };
        if (typeof mm.update === 'function') mm.update(dt);
      }
    }
  }
}
