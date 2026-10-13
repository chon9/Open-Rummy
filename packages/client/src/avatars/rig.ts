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
  SEATED_FOREARM,
  SEATED_HAND,
  SEATED_POSE,
  STANDING_POSE,
  forearmEuler,
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

/** Solve the square system A x = b (Gaussian elimination, partial pivoting); null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

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
  /** per-model arm and hand correction from calibrateSeatedHands (added to the rest pose) */
  private armFit: Pose = {};

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
    for (const key of BONE_KEYS) {
      this.current.set(key, new THREE.Quaternion());
      this.targetQ.set(key, new THREE.Quaternion());
    }
    this.snapToRest();
  }

  /** Rest rotation of a bone: base pose + per-character variation + calibration. */
  private restEuler(key: BoneKey): Vec3 {
    const b = this.basePose()[key] ?? [0, 0, 0];
    const d = this.armVariant[key] ?? [0, 0, 0];
    const f = this.armFit[key] ?? [0, 0, 0];
    return [b[0] + d[0] + f[0], b[1] + d[1] + f[1], b[2] + d[2] + f[2]];
  }

  /** Jump (no damping) to the rest pose and update the skeleton. */
  private snapToRest(): void {
    for (const key of BONE_KEYS) {
      const e = this.restEuler(key);
      eulerQuat(e[0], e[1], e[2], this.current.get(key) ?? new THREE.Quaternion());
    }
    this.applyPose();
    this.vrm.humanoid.update();
  }

  /** Raw bone position in root space for the current pose. */
  private boneLocal(name: VRMHumanBoneName, out: THREE.Vector3): THREE.Vector3 {
    const node = this.vrm.humanoid.getRawBoneNode(name);
    if (!node) return out.set(0, 0, 0);
    return this.root.worldToLocal(node.getWorldPosition(out));
  }

  /**
   * Seated only: fit each arm so that, at rest, the wrist sits `wristSide` to its side of the
   * midline, `wristForward` in front of the root and `wristHeight[side]` above it, with the elbow at `elbowHeight[side]` (root space,
   * i.e. before the root's scale) - forearm lying on the table edge, hands just behind the
   * rack. Models differ a lot in arm length and shoulder width, so one fixed pose put some
   * hands on the tiles and others in the air; this fits every model to the same resting
   * place. Then each hand is turned so the palm lies flat with the fingers pointing in
   * toward the other hand (SEATED_HAND). Newton steps with numeric Jacobians; solutions are
   * clamped to stay near the authored pose.
   */
  calibrateSeatedHands(
    wristSide: number,
    wristForward: number,
    wristHeight: { left: number; right: number },
    elbowHeight: { left: number; right: number },
  ): void {
    if (this.mode !== 'seated') return;
    this.armFit = {};
    for (const side of ['left', 'right'] as const) {
      const L = side === 'left';
      const upper: BoneKey = L ? 'leftUpperArm' : 'rightUpperArm';
      const lower: BoneKey = L ? 'leftLowerArm' : 'rightLowerArm';
      const baseLower = forearmEuler(side, SEATED_FOREARM.bend, SEATED_FOREARM.pronation);

      // 1) joints: upper arm swing, lift and sweep, elbow bend -> wrist sideways/forward/height,
      // elbow height
      this.newton(
        (q) => {
          this.armFit[upper] = [q[0], q[3], q[1]];
          const l = forearmEuler(side, SEATED_FOREARM.bend + q[2], SEATED_FOREARM.pronation);
          this.armFit[lower] = [l[0] - baseLower[0], l[1] - baseLower[1], l[2] - baseLower[2]];
        },
        () => {
          const w = this.boneLocal(L ? 'leftHand' : 'rightHand', _v);
          const wx = w.x - (L ? wristSide : -wristSide);
          const wz = w.z - wristForward;
          const wy = w.y - wristHeight[side];
          const e = this.boneLocal(L ? 'leftLowerArm' : 'rightLowerArm', _v);
          return [wz, wy, e.y - elbowHeight[side], wx];
        },
        [0.8, 0.8, 0.6, 0.8],
        this.vrm.humanoid.getRawBoneNode(L ? 'leftUpperArm' : 'rightUpperArm'),
      );
    }
    // 2) hands: palms flat, fingers turned in
    this.fitHand('left', SEATED_HAND.inward);
    this.fitHand('right', SEATED_HAND.inward);
    this.snapToRest();
  }

  /** Turn one hand so the fingers point forward and `inward`, down by SEATED_HAND.droop, palm level. */
  private fitHand(side: 'left' | 'right', inward: number): void {
    const L = side === 'left';
    const hand: BoneKey = L ? 'leftHand' : 'rightHand';
    const h = this.vrm.humanoid;
    const wrist = h.getRawBoneNode(L ? 'leftHand' : 'rightHand');
    const middle = h.getRawBoneNode(L ? 'leftMiddleProximal' : 'rightMiddleProximal');
    const index = h.getRawBoneNode(L ? 'leftIndexProximal' : 'rightIndexProximal');
    const little = h.getRawBoneNode(L ? 'leftLittleProximal' : 'rightLittleProximal');
    if (!wrist || !middle || !index || !little) return;
    const { droop } = SEATED_HAND;
    // the model's left hand is on its +X side, so "in" is -X for it
    const fx = (L ? -1 : 1) * Math.sin(inward) * Math.cos(droop);
    const fy = -Math.sin(droop);
    const pW = new THREE.Vector3();
    const pM = new THREE.Vector3();
    const pI = new THREE.Vector3();
    const pL = new THREE.Vector3();
    this.newton(
      (q) => {
        this.armFit[hand] = [q[0], q[1], q[2]];
      },
      () => {
        this.root.worldToLocal(wrist.getWorldPosition(pW));
        const f = this.root.worldToLocal(middle.getWorldPosition(pM)).sub(pW).normalize();
        this.root.worldToLocal(index.getWorldPosition(pI));
        const across = this.root.worldToLocal(little.getWorldPosition(pL)).sub(pI).normalize();
        return [f.x - fx, f.y - fy, across.y];
      },
      [1.2, 1.2, 1.2],
      wrist,
    );
  }

  /**
   * Damped Newton solve of N residuals in N unknowns (numeric Jacobian, N = limit.length).
   * `set` applies the unknowns to the pose; `residual` is evaluated after the skeleton is
   * updated (only `chain` and its parents/children when given).
   */
  private newton(set: (q: number[]) => void, residual: () => number[], limit: number[], chain: THREE.Object3D | null): void {
    const evalAt = (q: number[]): number[] => {
      set(q);
      this.snapToRest();
      // only the arm's matrices are read: update that chain (and its parents), not the model
      if (chain) chain.updateWorldMatrix(true, true);
      else this.root.updateMatrixWorld(true);
      return residual();
    };
    const n = limit.length;
    const p = new Array<number>(n).fill(0);
    const eps = 0.01;
    for (let it = 0; it < 12; it++) {
      const r = evalAt(p);
      if (Math.hypot(...r) < 0.002) break;
      const J: number[][] = r.map(() => []);
      for (let j = 0; j < n; j++) {
        const q = p.slice();
        q[j] += eps;
        const rj = evalAt(q);
        for (let i = 0; i < n; i++) J[i][j] = (rj[i] - r[i]) / eps;
      }
      const step = solveLinear(J, r.map((v) => -v));
      if (!step) break;
      const len = Math.hypot(...step);
      const k = len > 0.25 ? 0.25 / len : 1;
      for (let j = 0; j < n; j++) p[j] = THREE.MathUtils.clamp(p[j] + step[j] * k, -limit[j], limit[j]);
    }
    set(p);
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
    for (const key of Object.keys(this.armFit) as BoneKey[]) {
      const d = this.armFit[key];
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
