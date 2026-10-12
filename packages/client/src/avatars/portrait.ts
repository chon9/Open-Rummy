/**
 * Standalone avatar views for the DOM UI:
 *  - renderAvatarPortrait(): one-off head-and-shoulders render to a PNG data URL (cached)
 *  - AvatarStage: a small live three.js canvas with one avatar full-body (lobby select, win cut-in)
 */
import * as THREE from 'three';
import type { Quality, Reaction } from '../scene/api';
import { avatarById } from './catalog';
import { disposeVrm, loadVrm } from './loader';
import { AvatarRig } from './rig';

function addStudioLights(scene: THREE.Scene, accent: THREE.ColorRepresentation): void {
  scene.add(new THREE.HemisphereLight(0xfff3e6, 0x5a4a52, 1.4));
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(-1.2, 2.4, 2.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(accent, 1.6);
  rim.position.set(1.5, 2.0, -2.0);
  scene.add(rim);
}

// ---------------------------------------------------------------------------
// Portraits
// ---------------------------------------------------------------------------

const portraitCache = new Map<string, Promise<string>>();
let portraitQueue: Promise<unknown> = Promise.resolve();
let portraitRenderer: THREE.WebGLRenderer | null = null;
let portraitIdleTimer: ReturnType<typeof setTimeout> | null = null;

function getPortraitRenderer(): THREE.WebGLRenderer {
  if (portraitIdleTimer) {
    clearTimeout(portraitIdleTimer);
    portraitIdleTimer = null;
  }
  if (!portraitRenderer) {
    portraitRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    portraitRenderer.setPixelRatio(1);
    portraitRenderer.setClearColor(0x000000, 0);
  }
  return portraitRenderer;
}

/** Release the offscreen WebGL context when portraits have not been needed for a while. */
function schedulePortraitRendererRelease(): void {
  if (portraitIdleTimer) clearTimeout(portraitIdleTimer);
  portraitIdleTimer = setTimeout(() => {
    portraitRenderer?.dispose();
    portraitRenderer?.forceContextLoss();
    portraitRenderer = null;
    portraitIdleTimer = null;
  }, 15000);
}

async function renderPortraitNow(avatarId: string, size: number): Promise<string> {
  const def = avatarById(avatarId);
  const vrm = await loadVrm(def.url);
  const scene = new THREE.Scene();
  addStudioLights(scene, def.color);
  const rig = new AvatarRig(vrm, 'standing');
  rig.springBones = false;
  rig.setBlinking(false);
  rig.setMood('winner');
  scene.add(rig.root);

  const camera = new THREE.PerspectiveCamera(22, 1, 0.05, 20);
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  const headPos = new THREE.Vector3(0, rig.headHeight, 0);
  if (head) {
    rig.root.updateMatrixWorld(true);
    head.getWorldPosition(headPos);
  }
  const target = headPos.clone().add(new THREE.Vector3(0, -0.07, 0));
  const dist = 0.95;
  const yaw = 0.28;
  camera.position.set(target.x + Math.sin(yaw) * dist, target.y + 0.05, target.z + Math.cos(yaw) * dist);
  camera.lookAt(target);
  rig.lookAtWorld(camera.position);
  // settle the damped pose / expression
  for (let i = 0; i < 45; i++) rig.update(1 / 30);

  const renderer = getPortraitRenderer();
  renderer.setSize(size, size, false);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  disposeVrm(vrm);
  schedulePortraitRendererRelease();
  return url;
}

/** Data URL of a head-and-shoulders render (transparent background). Cached per (avatar, size). */
export function renderAvatarPortrait(avatarId: string, size: number): Promise<string> {
  const px = Math.max(16, Math.min(1024, Math.round(size)));
  const key = `${avatarById(avatarId).id}@${px}`;
  const hit = portraitCache.get(key);
  if (hit) return hit;
  // renders are serialized: they share one offscreen renderer
  const p = portraitQueue.then(() => renderPortraitNow(avatarId, px));
  portraitQueue = p.catch(() => undefined);
  portraitCache.set(key, p);
  p.catch(() => portraitCache.delete(key));
  return p;
}

// ---------------------------------------------------------------------------
// AvatarStage
// ---------------------------------------------------------------------------

export interface AvatarStageOptions {
  quality?: Quality;
  /** 'full' = whole body (lobby), 'upper' = waist up (cut-ins) */
  framing?: 'full' | 'upper';
}

/** A small live canvas with one standing avatar, idle animation and reactions. */
export class AvatarStage {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 1, 0.05, 30);
  private rig: AvatarRig | null = null;
  private avatarId: string | null = null;
  private loadToken = 0;
  private container: HTMLElement;
  private resizeObs: ResizeObserver;
  private visObs: IntersectionObserver | null = null;
  private visible = true;
  private lastT = performance.now();
  private framing: 'full' | 'upper';
  private floor: THREE.Mesh;
  private rimLight = new THREE.DirectionalLight(0xffffff, 1.4);
  private pendingReaction: Reaction | null = null;
  private disposed = false;

  constructor(container: HTMLElement, opts: AvatarStageOptions = {}) {
    this.container = container;
    this.framing = opts.framing ?? 'full';
    const q = opts.quality ?? 'medium';
    this.renderer = new THREE.WebGLRenderer({ antialias: q !== 'low', alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : 1.5));
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.appendChild(this.canvas);

    this.scene.add(new THREE.HemisphereLight(0xfff3e6, 0x4a3a40, 1.3));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.0);
    key.position.set(-1.2, 2.6, 2.4);
    this.scene.add(key);
    this.rimLight.position.set(1.4, 2.2, -2.2);
    this.scene.add(this.rimLight);

    // soft contact shadow under the feet
    const shadowTex = radialTexture('rgba(0,0,0,0.45)', 'rgba(0,0,0,0)');
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 0.002;
    this.scene.add(this.floor);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    if ('IntersectionObserver' in window) {
      this.visObs = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
      });
      this.visObs.observe(container);
    }
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Swap to another avatar. Resolves once it is visible. */
  async setAvatar(avatarId: string, onProgress?: (p: number) => void): Promise<void> {
    const def = avatarById(avatarId);
    if (this.avatarId === def.id && this.rig) return;
    this.avatarId = def.id;
    const token = ++this.loadToken;
    const vrm = await loadVrm(def.url, onProgress);
    if (this.disposed || token !== this.loadToken) {
      disposeVrm(vrm);
      return;
    }
    if (this.rig) {
      this.scene.remove(this.rig.root);
      disposeVrm(this.rig.vrm);
    }
    const rig = new AvatarRig(vrm, 'standing');
    this.rig = rig;
    this.scene.add(rig.root);
    this.rimLight.color.set(def.color);
    this.frame();
    rig.resetSprings();
    rig.react(this.pendingReaction ?? 'wave');
    this.pendingReaction = null;
  }

  react(reaction: Reaction): void {
    if (this.rig) this.rig.react(reaction);
    else this.pendingReaction = reaction;
  }

  setQuality(q: Quality): void {
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : 1.5));
    if (this.rig) this.rig.springBones = q !== 'low';
    this.resize();
  }

  private frame(): void {
    const rig = this.rig;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    const top = rig ? rig.headHeight + 0.24 : 1.6;
    const bottom = this.framing === 'full' ? -0.02 : (rig ? rig.hipsHeight : 0.9) - 0.05;
    const height = top - bottom;
    const width = this.framing === 'full' ? 0.85 : 0.75;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distV = height / 2 / Math.tan(fov / 2);
    const distH = width / 2 / (Math.tan(fov / 2) * aspect);
    const dist = Math.max(distV, distH) * 1.05;
    const cy = (top + bottom) / 2;
    this.camera.position.set(0.18 * dist * 0.3, cy + 0.05, dist);
    this.camera.lookAt(0, cy, 0);
    if (rig) {
      rig.lookAtWorld(this.camera.position);
      rig.setLookAnchors(new THREE.Vector3(0, 0.3, 0.8), this.camera.position);
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frame();
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.visible) return;
    this.rig?.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    this.visObs?.disconnect();
    if (this.rig) disposeVrm(this.rig.vrm);
    this.rig = null;
    this.floor.geometry.dispose();
    const mat = this.floor.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
