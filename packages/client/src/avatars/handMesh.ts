/**
 * Skinned hand geometry of a VRM: the actual surface of the hands (and anything skinned
 * to them, e.g. cuffs) in the current pose. Used to fit the seated hands onto the table
 * and by the ?debug hands-vs-racks probe (scene/handCheck.ts).
 */
import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const SEGMENTS = ['Metacarpal', 'Proximal', 'Intermediate', 'Distal'];

export function handBoneNames(side: 'left' | 'right'): VRMHumanBoneName[] {
  const out: string[] = [`${side}Hand`];
  for (const f of FINGERS) for (const s of SEGMENTS) out.push(`${side}${f}${s}`);
  return out as VRMHumanBoneName[];
}

const _v = new THREE.Vector3();

interface VertexSet {
  mesh: THREE.SkinnedMesh;
  indices: number[];
}

/** per model: bone-name key -> vertices dominated by those bones (skin weights never change) */
const cache = new WeakMap<VRM, Map<string, VertexSet[]>>();

function vertexSets(vrm: VRM, names: VRMHumanBoneName[]): VertexSet[] {
  let byKey = cache.get(vrm);
  if (!byKey) {
    byKey = new Map();
    cache.set(vrm, byKey);
  }
  const key = names.join(',');
  const hit = byKey.get(key);
  if (hit) return hit;
  const bones = new Set<THREE.Object3D>();
  for (const name of names) {
    const b = vrm.humanoid.getRawBoneNode(name);
    if (b) bones.add(b);
  }
  const sets: VertexSet[] = [];
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.every((m) => (m as { isOutline?: boolean }).isOutline)) return;
    const geo = mesh.geometry;
    const si = geo.getAttribute('skinIndex');
    const sw = geo.getAttribute('skinWeight');
    const pos = geo.getAttribute('position');
    if (!si || !sw || !pos) return;
    const mask = mesh.skeleton.bones.map((b) => bones.has(b));
    if (!mask.some(Boolean)) return;
    const indices: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      let best = -1;
      let bw = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      if (best >= 0 && mask[best]) indices.push(i);
    }
    if (indices.length) sets.push({ mesh, indices });
  });
  byKey.set(key, sets);
  return sets;
}

/** World positions of every skinned vertex dominated by a hand or finger bone of `side`. */
export function handVertices(vrm: VRM, side: 'left' | 'right', names = handBoneNames(side)): THREE.Vector3[] {
  // only the listed bones (with their parents/children) and the meshes need fresh matrices
  for (const name of names) vrm.humanoid.getRawBoneNode(name)?.updateWorldMatrix(true, true);
  const out: THREE.Vector3[] = [];
  for (const { mesh, indices } of vertexSets(vrm, names)) {
    if (!mesh.visible) continue;
    mesh.updateWorldMatrix(true, false);
    for (const i of indices) {
      mesh.getVertexPosition(i, _v); // SkinnedMesh: morphs + bone transform, mesh space
      out.push(_v.clone().applyMatrix4(mesh.matrixWorld));
    }
  }
  return out;
}
