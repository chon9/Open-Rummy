/**
 * Procedural pose + gesture library (no animation files).
 *
 * Poses are Euler XYZ rotations (radians) on VRM *normalized* humanoid bones, where
 * every bone's rest rotation is identity in a T-pose and the model faces +Z.
 * Handy conventions (derived from that rest frame):
 *   - spine/chest/neck/head  +x  = lean / nod forward,   +y = turn to the model's left
 *   - leftUpperArm           -z  = lower the arm,         +z = raise it, -x = swing forward
 *   - rightUpperArm          +z  = lower the arm,         -z = raise it, -x = swing forward
 *   - leftLowerArm           -y  = bend the elbow forward (right arm: +y)
 *   - upperLeg               -x  = lift the thigh forward (sitting)
 */
import * as THREE from 'three';
import type { Reaction } from '../scene/api';

export type BoneKey =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'rightUpperLeg'
  | 'leftLowerLeg'
  | 'rightLowerLeg';

export const BONE_KEYS: BoneKey[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
];

export type Vec3 = [number, number, number];
export type Pose = Partial<Record<BoneKey, Vec3>>;

export type ExprKey = 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed' | 'aa' | 'oh';
export const EXPR_KEYS: ExprKey[] = ['happy', 'sad', 'angry', 'surprised', 'relaxed', 'aa', 'oh'];
export type ExprWeights = Partial<Record<ExprKey, number>>;

/** Where the avatar's gaze should go while a clip plays (null = default target). */
export type LookHint = 'table' | 'up' | 'viewer' | null;

export interface ClipFrame {
  pose: Pose;
  expr: ExprWeights;
  /** vertical bounce of the hips (metres) */
  bounce: number;
  look: LookHint;
}

export interface GestureClip {
  duration: number;
  fadeIn: number;
  fadeOut: number;
  /** fill `out` for time t (seconds since start). `seated` selects table-friendly variants. */
  sample(t: number, seated: boolean, out: ClipFrame): void;
}

// ---------------------------------------------------------------------------
// Base poses
// ---------------------------------------------------------------------------

/** Seated forearm: elbow bend, then pronation about the forearm's own axis (palms down). */
export const SEATED_FOREARM = { bend: 1.14, pronation: 1.21 };

/**
 * Seated hands at rest (fitted per model, see AvatarRig.calibrateSeatedHands): palms flat,
 * fingers turned in toward the other hand by `inward` (radians from straight ahead) and
 * drooping `droop` below level, so the hands stay short of the rack in front of them.
 */
export const SEATED_HAND = { inward: 0.85, droop: 0.2 };

/** Euler XYZ of Ry(-bend) * Rx(pronation) for the left forearm (mirrored for the right). */
export function forearmEuler(side: 'left' | 'right', bend: number, pronation: number): Vec3 {
  const q = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), side === 'left' ? -bend : bend)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pronation));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z];
}

/** Sitting at the table: legs under the table, forearms resting near the edge. */
export const SEATED_POSE: Pose = {
  spine: [0.06, 0, 0],
  chest: [0.04, 0, 0],
  neck: [0, 0, 0],
  head: [0, 0, 0],
  // Authored arm pose; at the table each model's upper arms and elbow bend are then fitted
  // (AvatarRig.calibrateSeatedHands via scene/avatarSeats.ts fitSeatedHands) so the
  // forearms lie on the rim and the wrists rest on it at HAND_WRIST, behind the rack.
  leftUpperArm: [-0.32, -0.47, -1.27],
  rightUpperArm: [-0.32, 0.47, 1.27],
  // forearms: elbow bend 1.14 then a 1.21 rad pronation about the forearm's own axis so the
  // palms lie flat on the table (Euler XYZ of Ry(-1.14) * Rx(1.21), mirrored for the right)
  leftLowerArm: forearmEuler('left', SEATED_FOREARM.bend, SEATED_FOREARM.pronation),
  rightLowerArm: forearmEuler('right', SEATED_FOREARM.bend, SEATED_FOREARM.pronation),
  // starting point only: the hands are fitted to SEATED_HAND per model at the table
  leftHand: [0, -0.116, 0.164],
  rightHand: [0, 0.116, -0.164],
  leftUpperLeg: [-1.5, 0, 0.08],
  rightUpperLeg: [-1.5, 0, -0.08],
  leftLowerLeg: [1.45, 0, 0],
  rightLowerLeg: [1.45, 0, 0],
};

/** Relaxed standing pose for the lobby stage / portraits. */
export const STANDING_POSE: Pose = {
  spine: [0, 0, 0],
  chest: [0, 0, 0],
  neck: [0, 0, 0],
  head: [0, 0, 0],
  leftUpperArm: [0.05, 0, -1.22],
  rightUpperArm: [0.05, 0, 1.22],
  leftLowerArm: [0, -0.25, 0],
  rightLowerArm: [0, 0.25, 0],
  leftHand: [0, 0, 0.1],
  rightHand: [0, 0, -0.1],
  leftUpperLeg: [0, 0, 0.02],
  rightUpperLeg: [0, 0, -0.02],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const osc = (t: number, hz: number, amp: number, phase = 0): number => Math.sin(t * TAU * hz + phase) * amp;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number): number => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
/** 0 -> 1 -> 0 hump over [a, b] */
const hump = (a: number, b: number, t: number): number => Math.sin(Math.PI * clamp01((t - a) / (b - a)));

function add(base: Pose, bone: BoneKey, d: Vec3): Vec3 {
  const b = base[bone] ?? [0, 0, 0];
  return [b[0] + d[0], b[1] + d[1], b[2] + d[2]];
}

function clip(duration: number, fadeIn: number, fadeOut: number, sample: GestureClip['sample']): GestureClip {
  return { duration, fadeIn, fadeOut, sample };
}

/** Both fists up, pumping. Used by win / cheer. */
function armsUp(t: number, out: ClipFrame, pumpHz: number, alternate: boolean): void {
  const pl = osc(t, pumpHz, 0.18);
  const pr = alternate ? -pl : pl;
  out.pose.leftUpperArm = [-0.25, 0, 1.05 + pl];
  out.pose.rightUpperArm = [-0.25, 0, -1.05 - pr];
  out.pose.leftLowerArm = [0, -0.5, 0.55 + pl * 0.5];
  out.pose.rightLowerArm = [0, 0.5, -0.55 - pr * 0.5];
  out.pose.leftHand = [0, 0, 0];
  out.pose.rightHand = [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Clips per reaction
// ---------------------------------------------------------------------------

export const CLIPS: Partial<Record<Reaction, GestureClip>> = {
  play: clip(1.0, 0.22, 0.35, (t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    const reach = hump(0, 1.0, t);
    out.pose.spine = add(base, 'spine', [0.1 * reach, -0.06 * reach, 0]);
    out.pose.chest = add(base, 'chest', [0.06 * reach, -0.1 * reach, 0]);
    // right arm stretched forward and down onto the felt, palm down, close to the arm's full
    // reach: the fingers land ~25 cm from the table centre, in front of the rack.
    // On the way out and back the arm is lifted so the hand arcs over the standing rack
    // (resting hands sit behind it) instead of sweeping through it; at the peak it is down
    // on the felt in front of the rack
    const lift = 1 - smoothstep(0.2, 0.5, t) + smoothstep(0.6, 0.9, t);
    out.pose.rightUpperArm = [-1.37, 0.98, 1.73 - 0.3 * lift];
    out.pose.rightLowerArm = [0.6, 0.16, -0.11];
    out.pose.rightHand = [0, -0.05, -0.29];
    out.expr.relaxed = 0.3;
    out.look = 'table';
  }),

  think: clip(2.4, 0.35, 0.45, (t, _seated, out) => {
    // hand on chin, other arm folded under the elbow
    out.pose.rightUpperArm = [-0.95, 0.6, 1.25];
    out.pose.rightLowerArm = [0, 2.15, 0];
    out.pose.rightHand = [0, 0, -0.3];
    // supporting forearm lies across the body under the right elbow, palm up
    out.pose.leftUpperArm = [-0.78, -1.28, -1.67];
    out.pose.leftLowerArm = [-1.58, 0.73, -1.56];
    out.pose.leftHand = [0, 0.05, 0.13];
    out.pose.head = [0.06 + osc(t, 0.4, 0.03), 0.12, 0.16];
    out.pose.neck = [0, 0.05, 0.05];
    out.expr.relaxed = 0.2;
    out.expr.oh = 0.15;
    out.look = 'up';
  }),

  happy: clip(1.7, 0.2, 0.5, (t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    out.pose.chest = add(base, 'chest', [osc(t, 2.2, 0.04), 0, osc(t, 1.1, 0.05)]);
    out.pose.head = [-0.06, 0, 0.14 + osc(t, 1.1, 0.06)];
    out.pose.leftShoulder = [0, 0, 0.08 + osc(t, 2.2, 0.04)];
    out.pose.rightShoulder = [0, 0, -0.08 - osc(t, 2.2, 0.04)];
    out.expr.happy = 1;
    out.bounce = Math.max(0, osc(t, 2.2, 0.012));
    out.look = 'viewer';
  }),

  surprised: clip(1.4, 0.12, 0.5, (_t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    out.pose.spine = add(base, 'spine', [-0.12, 0, 0]);
    out.pose.head = [-0.14, 0, 0];
    out.pose.leftUpperArm = [-0.85, 0.2, -0.85];
    out.pose.rightUpperArm = [-0.85, -0.2, 0.85];
    out.pose.leftLowerArm = [0, -1.9, 0];
    out.pose.rightLowerArm = [0, 1.9, 0];
    out.pose.leftHand = [0, 0, 0.4];
    out.pose.rightHand = [0, 0, -0.4];
    out.expr.surprised = 1;
    out.bounce = 0.01;
    out.look = null;
  }),

  sad: clip(2.4, 0.4, 0.6, (t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    out.pose.spine = add(base, 'spine', [0.14, 0, 0]);
    out.pose.chest = add(base, 'chest', [0.08, 0, 0]);
    out.pose.head = [0.38 + osc(t, 0.5, 0.02), 0, 0.06];
    out.pose.leftShoulder = [0, 0, -0.1];
    out.pose.rightShoulder = [0, 0, 0.1];
    out.expr.sad = 1;
    out.look = 'table';
  }),

  angry: clip(1.6, 0.15, 0.45, (t, _seated, out) => {
    out.pose.head = [0.12, osc(t, 3, 0.05), 0];
    out.pose.rightUpperArm = [-0.85, -0.2, 0.95];
    out.pose.rightLowerArm = [0, 2.0 + osc(t, 4, 0.22), 0];
    out.pose.leftUpperArm = [-0.6, 0.3, -1.05];
    out.pose.leftLowerArm = [0, -1.6, 0];
    out.expr.angry = 1;
    out.look = 'viewer';
  }),

  win: clip(2.9, 0.2, 0.6, (t, _seated, out) => {
    armsUp(t, out, 2.4, false);
    out.pose.spine = [-0.08, 0, osc(t, 1.2, 0.05)];
    out.pose.chest = [-0.05, osc(t, 1.2, 0.08), 0];
    out.pose.head = [-0.18, 0, osc(t, 1.2, 0.1)];
    out.expr.happy = 1;
    out.expr.aa = 0.35 + osc(t, 2.4, 0.2);
    out.bounce = Math.abs(osc(t, 1.2, 0.03));
    out.look = 'up';
  }),

  cheer: clip(2.1, 0.2, 0.5, (t, _seated, out) => {
    armsUp(t, out, 3, true);
    out.pose.head = [-0.1, 0, osc(t, 1.5, 0.12)];
    out.expr.happy = 1;
    out.expr.aa = 0.3;
    out.bounce = Math.abs(osc(t, 1.5, 0.02));
    out.look = 'viewer';
  }),

  lose: clip(2.0, 0.2, 0.5, (t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    const decay = 1 - smoothstep(0.4, 1.6, t);
    out.pose.head = [0.2, osc(t, 2.3, 0.3) * decay, 0];
    out.pose.spine = add(base, 'spine', [0.1, 0, 0]);
    out.pose.leftShoulder = [0, 0, -0.08];
    out.pose.rightShoulder = [0, 0, 0.08];
    out.expr.sad = 0.85;
    out.look = 'table';
  }),

  wave: clip(2.1, 0.25, 0.45, (t, _seated, out) => {
    out.pose.rightUpperArm = [-0.25, 0, -0.35];
    out.pose.rightLowerArm = [0, 0.2, -1.45 + osc(t, 2.1, 0.38)];
    out.pose.rightHand = [0, 0, 0];
    out.pose.head = [0, 0, -0.12];
    out.pose.chest = [0, 0, -0.04];
    out.expr.happy = 0.8;
    out.look = 'viewer';
  }),

  laugh: clip(1.8, 0.15, 0.45, (t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    out.pose.spine = add(base, 'spine', [osc(t, 4, 0.05), 0, 0]);
    out.pose.head = [-0.16 + osc(t, 4, 0.05), 0, 0.08];
    // hand politely in front of the mouth, palm toward the face
    out.pose.leftUpperArm = [-0.67, -0.55, -1.4];
    out.pose.leftLowerArm = [-2.13, -0.41, -2.58];
    out.pose.leftHand = [0, 0.15, 0.03];
    out.expr.happy = 1;
    out.expr.aa = 0.4 + osc(t, 4, 0.3);
    out.bounce = Math.abs(osc(t, 4, 0.01));
    out.look = 'viewer';
  }),

  cry: clip(2.7, 0.35, 0.6, (t, seated, out) => {
    const base = seated ? SEATED_POSE : STANDING_POSE;
    out.pose.spine = add(base, 'spine', [0.16 + osc(t, 5, 0.015), 0, 0]);
    out.pose.head = [0.32, 0, osc(t, 0.8, 0.05)];
    // both hands over the eyes, palms to the face, fingers up
    out.pose.leftUpperArm = [-1.19, -0.39, -1.47];
    out.pose.rightUpperArm = [-1.19, 0.39, 1.47];
    out.pose.leftLowerArm = [-1.83, -0.29, -2.31];
    out.pose.rightLowerArm = [-1.83, 0.29, 2.31];
    out.pose.leftHand = [0, -0.08, 0.14];
    out.pose.rightHand = [0, 0.08, -0.14];
    out.expr.sad = 1;
    out.look = 'table';
  }),
};

/** Expression the face holds while a reaction plays (used by `react` without a clip too). */
export function clipWeight(c: GestureClip, t: number): number {
  return smoothstep(0, c.fadeIn, t) * (1 - smoothstep(c.duration - c.fadeOut, c.duration, t));
}
