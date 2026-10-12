/**
 * VRM loading. Downloads are cached per URL (as ArrayBuffers) so the table, lobby
 * stage and portrait renderer share one network fetch; each call to `loadVrm` parses
 * a fresh instance because a skinned model can only live in one scene/renderer.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

type ProgressFn = (fraction: number) => void;

interface Download {
  promise: Promise<ArrayBuffer>;
  /** progress listeners while the download is in flight */
  listeners: Set<ProgressFn>;
  fraction: number;
}

const downloads = new Map<string, Download>();
let sharedLoader: GLTFLoader | null = null;

function loader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedLoader.register((parser) => new VRMLoaderPlugin(parser));
  }
  return sharedLoader;
}

async function fetchWithProgress(url: string, dl: Download): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    dl.fraction = 1;
    dl.listeners.forEach((l) => l(1));
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      dl.fraction = Math.min(0.99, received / total);
      dl.listeners.forEach((l) => l(dl.fraction));
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  dl.fraction = 1;
  dl.listeners.forEach((l) => l(1));
  return out.buffer;
}

/** Download (or reuse) the raw VRM bytes. */
export function fetchVrmBytes(url: string, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  let dl = downloads.get(url);
  if (!dl) {
    const created: Download = { promise: Promise.resolve(new ArrayBuffer(0)), listeners: new Set(), fraction: 0 };
    created.promise = fetchWithProgress(url, created).catch((err: unknown) => {
      downloads.delete(url); // allow a retry later
      throw err;
    });
    downloads.set(url, created);
    dl = created;
  }
  if (onProgress) {
    onProgress(dl.fraction);
    if (dl.fraction < 1) {
      const d = dl;
      d.listeners.add(onProgress);
      d.promise.finally(() => d.listeners.delete(onProgress)).catch(() => undefined);
    }
  }
  return dl.promise;
}

/** Start downloading without parsing (warms the cache for the lobby). */
export function prefetchVrm(url: string): void {
  fetchVrmBytes(url).catch(() => undefined);
}

/** Load and prepare a new VRM instance. */
export async function loadVrm(url: string, onProgress?: ProgressFn): Promise<VRM> {
  const bytes = await fetchVrmBytes(url, onProgress);
  const basePath = url.slice(0, url.lastIndexOf('/') + 1);
  const gltf = await loader().parseAsync(bytes, basePath);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`${url} is not a VRM model`);
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((obj) => {
    // skinned meshes have stale bounds once posed; avoid popping out of view
    obj.frustumCulled = false;
    if ((obj as THREE.Mesh).isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = false;
    }
  });
  // we drive look-at ourselves through `target`
  if (vrm.lookAt) vrm.lookAt.autoUpdate = true;
  return vrm;
}

/** Free GPU resources of a VRM instance. */
export function disposeVrm(vrm: VRM): void {
  vrm.scene.removeFromParent();
  VRMUtils.deepDispose(vrm.scene);
}
