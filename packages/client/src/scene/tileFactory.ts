/**
 * 3D tiles: a two-layer rounded body (ivory face layer + jade back layer, like real
 * mahjong tiles) and an optional textured face plane. Geometry and materials are shared;
 * face materials are cached per distinct face image. Tiles are pooled.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { faceKey, paintFace, IVORY, JADE } from '../art/tileArt';
import { TILE_D, TILE_H, TILE_RADIUS, TILE_W } from './constants';

const IVORY_FRACTION = 0.6;
const FACE_TEX_W = 176;
const FACE_TEX_H = 248;

export class Tile3D {
  readonly obj = new THREE.Group();
  readonly body: THREE.Mesh;
  face: THREE.Mesh | null = null;
  id: string | null = null;
  dead = false;

  constructor(body: THREE.Mesh) {
    this.body = body;
    this.obj.add(body);
  }
}

function colouredBox(w: number, h: number, d: number, z: number, colour: THREE.Color): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 3, TILE_RADIUS);
  g.translate(0, 0, z);
  const count = g.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}

export class TileFactory {
  private bodyGeo: THREE.BufferGeometry;
  private faceGeo: THREE.PlaneGeometry;
  private bodyMat: THREE.MeshStandardMaterial;
  private deadMat: THREE.MeshStandardMaterial;
  private faceMats = new Map<string, THREE.MeshStandardMaterial>();
  private pool: Tile3D[] = [];
  private anisotropy: number;
  shadows = true;

  constructor(anisotropy: number) {
    this.anisotropy = anisotropy;
    const ivoryD = TILE_D * IVORY_FRACTION;
    const jadeD = TILE_D - ivoryD + 0.0006; // slight overlap hides the seam's inner faces
    const ivory = colouredBox(TILE_W, TILE_H, ivoryD, TILE_D / 2 - ivoryD / 2, new THREE.Color(IVORY));
    const jade = colouredBox(TILE_W, TILE_H, jadeD, -TILE_D / 2 + jadeD / 2, new THREE.Color(JADE));
    const merged = mergeGeometries([ivory, jade], false);
    ivory.dispose();
    jade.dispose();
    if (!merged) throw new Error('tile geometry merge failed');
    this.bodyGeo = merged;
    this.bodyGeo.computeBoundingSphere();
    const flat = TILE_RADIUS * 2;
    this.faceGeo = new THREE.PlaneGeometry(TILE_W - flat, TILE_H - flat);
    this.faceGeo.translate(0, 0, TILE_D / 2 + 0.00015);
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.0, envMapIntensity: 0.9 });
    this.deadMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.0,
      color: 0x6c6f73,
      envMapIntensity: 0.3,
    });
  }

  private faceMaterial(id: string): THREE.MeshStandardMaterial {
    const key = faceKey(id);
    let mat = this.faceMats.get(key);
    if (!mat) {
      const canvas = document.createElement('canvas');
      canvas.width = FACE_TEX_W;
      canvas.height = FACE_TEX_H;
      const ctx = canvas.getContext('2d');
      if (ctx) paintFace(ctx, id, FACE_TEX_W, FACE_TEX_H, false);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.32, metalness: 0, envMapIntensity: 0.9 });
      this.faceMats.set(key, mat);
    }
    return mat;
  }

  /** A tile showing `id` on its face, or a blank back-only tile when id is null. */
  create(id: string | null): Tile3D {
    let t = this.pool.pop();
    if (!t) {
      const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
      t = new Tile3D(body);
    }
    t.obj.visible = true;
    t.obj.scale.setScalar(1);
    t.obj.position.set(0, 0, 0);
    t.obj.quaternion.identity();
    t.body.castShadow = this.shadows;
    t.body.receiveShadow = this.shadows;
    this.setDead(t, false);
    this.setFace(t, id);
    return t;
  }

  setFace(t: Tile3D, id: string | null): void {
    t.id = id;
    if (id === null) {
      if (t.face) t.face.visible = false;
      return;
    }
    const mat = this.faceMaterial(id);
    if (!t.face) {
      t.face = new THREE.Mesh(this.faceGeo, mat);
      t.obj.add(t.face);
    }
    t.face.material = mat;
    t.face.visible = true;
    t.face.receiveShadow = this.shadows;
  }

  setDead(t: Tile3D, dead: boolean): void {
    t.dead = dead;
    t.body.material = dead ? this.deadMat : this.bodyMat;
  }

  /** Return a tile to the pool (removes it from the scene). */
  release(t: Tile3D): void {
    t.obj.removeFromParent();
    t.obj.visible = false;
    t.id = null;
    if (this.pool.length < 300) this.pool.push(t);
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const t of this.pool) {
      t.body.castShadow = on;
      t.body.receiveShadow = on;
    }
  }

  dispose(): void {
    this.bodyGeo.dispose();
    this.faceGeo.dispose();
    this.bodyMat.dispose();
    this.deadMat.dispose();
    for (const m of this.faceMats.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.faceMats.clear();
    this.pool = [];
  }
}
