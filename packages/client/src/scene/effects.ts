/**
 * Celebration and feedback effects: confetti, glow bursts, landing ripples, dice.
 * All effects are updated from the scene's render loop via update(dt).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TABLE_Y } from './constants';
import { glowTexture } from './environment';

// ---------------------------------------------------------------------------
// Confetti (instanced quads with simple physics)
// ---------------------------------------------------------------------------

const CONFETTI_COLOURS = [0xffd36b, 0xffc23a, 0xfff1c4, 0xe8423f, 0xff8a5c, 0xf7e08a];

export class Confetti {
  readonly mesh: THREE.InstancedMesh;
  private count: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private rot: Float32Array;
  private spin: Float32Array;
  private life: Float32Array;
  private active = 0;
  private dummy = new THREE.Object3D();

  constructor(parent: THREE.Object3D, count = 260) {
    this.count = count;
    const geo = new THREE.PlaneGeometry(0.014, 0.022);
    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      metalness: 0.6,
      roughness: 0.35,
      emissive: 0x6a4a10,
      emissiveIntensity: 0.6,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.rot = new Float32Array(count * 3);
    this.spin = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      c.setHex(CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]);
      this.mesh.setColorAt(i, c);
    }
    parent.add(this.mesh);
  }

  /** Burst from `origin` (world/parent space) spraying upward and outward. */
  burst(origin: THREE.Vector3, power = 1): void {
    for (let i = 0; i < this.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.4 + Math.random() * 1.1) * power;
      this.pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.1;
      this.pos[i * 3 + 1] = origin.y + Math.random() * 0.05;
      this.pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.1;
      this.vel[i * 3] = Math.cos(a) * sp * 0.8;
      this.vel[i * 3 + 1] = (1.4 + Math.random() * 1.6) * power;
      this.vel[i * 3 + 2] = Math.sin(a) * sp * 0.8;
      for (let k = 0; k < 3; k++) {
        this.rot[i * 3 + k] = Math.random() * Math.PI * 2;
        this.spin[i * 3 + k] = (Math.random() - 0.5) * 18;
      }
      this.life[i] = 2.6 + Math.random() * 1.2;
    }
    this.active = this.count;
    this.mesh.count = this.count;
  }

  update(dt: number): void {
    if (!this.active) return;
    let alive = 0;
    const d = this.dummy;
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      const l = this.life[i];
      if (l <= 0) {
        d.scale.setScalar(0);
        d.updateMatrix();
        this.mesh.setMatrixAt(i, d.matrix);
        continue;
      }
      alive++;
      const vi = i * 3;
      // gravity with strong air drag: confetti flutters down
      this.vel[vi + 1] -= 3.2 * dt;
      const drag = Math.exp(-2.2 * dt);
      this.vel[vi] *= drag;
      this.vel[vi + 1] *= this.vel[vi + 1] < 0 ? Math.exp(-4 * dt) : drag;
      this.vel[vi + 2] *= drag;
      this.pos[vi] += this.vel[vi] * dt + Math.sin(l * 6 + i) * 0.002;
      this.pos[vi + 1] += this.vel[vi + 1] * dt;
      this.pos[vi + 2] += this.vel[vi + 2] * dt;
      // rest on the table top, or on the floor outside it
      const onTable = Math.abs(this.pos[vi]) < 0.62 && Math.abs(this.pos[vi + 2]) < 0.62;
      const ground = onTable ? TABLE_Y + 0.005 : 0.01;
      if (this.pos[vi + 1] < ground) {
        this.pos[vi + 1] = ground;
        this.vel[vi] = this.vel[vi + 1] = this.vel[vi + 2] = 0;
        this.spin[vi] = this.spin[vi + 1] = this.spin[vi + 2] = 0;
      }
      for (let k = 0; k < 3; k++) this.rot[vi + k] += this.spin[vi + k] * dt;
      d.position.set(this.pos[vi], this.pos[vi + 1], this.pos[vi + 2]);
      d.rotation.set(this.rot[vi], this.rot[vi + 1], this.rot[vi + 2]);
      d.scale.setScalar(Math.min(1, l * 2));
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.active = alive;
    if (!alive) this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// One-shot sprites: glow bursts and landing ripples
// ---------------------------------------------------------------------------

interface Flash {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  t: number;
  dur: number;
  from: number;
  to: number;
  peak: number;
}

export class Flashes {
  private parent: THREE.Object3D;
  private glowTex = glowTexture('rgba(255,236,170,1)', 'rgba(255,170,60,0)');
  private ringTex: THREE.CanvasTexture;
  private ringGeo = new THREE.PlaneGeometry(1, 1);
  private items: Flash[] = [];

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(64, 64, 30, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,230,160,0)');
      g.addColorStop(0.75, 'rgba(255,230,160,0.9)');
      g.addColorStop(1, 'rgba(255,230,160,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }
    this.ringTex = new THREE.CanvasTexture(c);
    this.ringTex.colorSpace = THREE.SRGBColorSpace;
  }

  /** Big soft glow (billboard) that swells and fades. */
  glow(at: THREE.Vector3, size = 1.2, dur = 1.4, colour: THREE.ColorRepresentation = 0xffe0a0): void {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color: colour,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(at);
    this.parent.add(s);
    this.items.push({ obj: s, mat, t: 0, dur, from: size * 0.3, to: size, peak: 0.9 });
  }

  /** Flat ring on the felt expanding from a landing point. */
  ripple(at: THREE.Vector3, size = 0.12, dur = 0.45, peak = 0.7): void {
    const mat = new THREE.MeshBasicMaterial({
      map: this.ringTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.copy(at);
    this.parent.add(m);
    this.items.push({ obj: m, mat, t: 0, dur, from: size * 0.2, to: size, peak });
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const f = this.items[i];
      f.t += dt;
      const u = Math.min(1, f.t / f.dur);
      const s = f.from + (f.to - f.from) * (1 - Math.pow(1 - u, 3));
      f.obj.scale.set(s, s, s);
      f.mat.opacity = f.peak * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - u * 0.3);
      if (u >= 1) {
        f.obj.removeFromParent();
        f.mat.dispose();
        this.items.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const f of this.items) {
      f.obj.removeFromParent();
      f.mat.dispose();
    }
    this.items = [];
    this.glowTex.dispose();
    this.ringTex.dispose();
    this.ringGeo.dispose();
  }
}

// ---------------------------------------------------------------------------
// Dice (2d6, flavour). Red 1 and 4 pips like Chinese dice.
// ---------------------------------------------------------------------------

const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [
    [0.28, 0.28],
    [0.72, 0.72],
  ],
  3: [
    [0.25, 0.25],
    [0.5, 0.5],
    [0.75, 0.75],
  ],
  4: [
    [0.28, 0.28],
    [0.72, 0.28],
    [0.28, 0.72],
    [0.72, 0.72],
  ],
  5: [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.5, 0.5],
    [0.25, 0.75],
    [0.75, 0.75],
  ],
  6: [
    [0.28, 0.22],
    [0.72, 0.22],
    [0.28, 0.5],
    [0.72, 0.5],
    [0.28, 0.78],
    [0.72, 0.78],
  ],
};

/** BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z */
const FACE_VALUES = [2, 5, 1, 6, 3, 4];

export function diceFaceQuat(value: number, yaw: number): THREE.Quaternion {
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  switch (value) {
    case 6:
      e.set(Math.PI, 0, 0);
      break;
    case 2:
      e.set(0, 0, Math.PI / 2);
      break;
    case 5:
      e.set(0, 0, -Math.PI / 2);
      break;
    case 3:
      e.set(-Math.PI / 2, 0, 0);
      break;
    case 4:
      e.set(Math.PI / 2, 0, 0);
      break;
    default:
      e.set(0, 0, 0);
  }
  q.setFromEuler(e);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(q);
}

export function createDice(size: number): { meshes: THREE.Mesh[]; dispose(): void } {
  const mats = FACE_VALUES.map((v) => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#fbf6ea';
      ctx.fillRect(0, 0, 128, 128);
      for (const [x, y] of PIPS[v]) {
        ctx.beginPath();
        const r = v === 1 ? 20 : 11;
        ctx.arc(x * 128, y * 128, r, 0, Math.PI * 2);
        ctx.fillStyle = v === 1 || v === 4 ? '#c8182c' : '#1a1a22';
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3, metalness: 0 });
  });
  const geo = new RoundedBoxGeometry(size, size, size, 3, size * 0.16);
  const meshes = [new THREE.Mesh(geo, mats), new THREE.Mesh(geo, mats)];
  for (const m of meshes) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  return {
    meshes,
    dispose() {
      geo.dispose();
      for (const m of mats) {
        m.map?.dispose();
        m.dispose();
      }
    },
  };
}
