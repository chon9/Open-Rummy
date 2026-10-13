/**
 * The 3D table (implements TableSceneApi from ./api).
 *
 * Structure
 *   scene
 *    |- environment (room, lanterns, table furniture, lights)
 *    |- table group (origin = centre of the felt): tiles, turn strips, meld glows/hit boxes, dice
 *    |- seated avatars (chairs + VRMs)
 *    |- effects (confetti, glows)
 *
 * Animation model: playEvents() turns a batch of GameEvents into "steps" that start one
 * after another (with short gaps so they overlap), then reconciles with the authoritative
 * view so any visual drift is corrected. Batches are queued; when they pile up the
 * animations speed up, and a large backlog skips straight to the final state.
 */
import * as THREE from 'three';
import gsap from 'gsap';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  sortTiles,
  type GameEvent,
  type HandResult,
  type MatchStanding,
  type Meld,
  type MeldTile,
  type PlayerStatus,
  type PlayerView,
  type WallBreak,
} from '@open-rummy/shared';
import type { MeldPick, Quality, Reaction, SeatAvatar, TableSceneApi } from './api';
import { SeatedAvatars } from './avatarSeats';
import { COLOURS_3D, HAND_WRIST, TABLE_HALF, TABLE_Y, TILE_D, TILE_H, TILE_W } from './constants';
import { Confetti, Flashes, createDice, diceFaceQuat } from './effects';
import { buildEnvironment, type Environment } from './environment';
import {
  cameraRig,
  deadWallXform,
  diceRestPos,
  layoutMelds,
  meldTileXform,
  ownOriginXform,
  quatX,
  quatY,
  rackXform,
  relSeat,
  seatAngle,
  seatDir,
  wallSlots,
  type MeldLayoutOptions,
  type MeldSlot,
  type RackState,
  type Xform,
} from './layout';
import { Tile3D, TileFactory } from './tileFactory';
import { handOk, handStats, nominalRackBoxes, tileBoxFromObject, type HandStats, type TileBox } from './handCheck';
import { CLIPS, SEATED_HAND, SEATED_POSE } from '../avatars/gestures';

interface HandReport {
  seat: number;
  avatarId: string;
  rel: number;
  n: number;
  ok: boolean;
  hands: HandStats[];
}

interface MeldVis {
  meld: Meld;
  tiles: Tile3D[];
  slot: MeldSlot | null;
  hit: THREE.Mesh;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  glowLevel: number;
}

interface Rack {
  seat: number;
  tiles: Tile3D[];
  state: RackState;
}

interface StepResult {
  done: Promise<void>;
  /** seconds until the next step may start */
  gap: number;
}
type Step = () => StepResult;

interface MoveOpts {
  dur: number;
  delay?: number;
  arc?: number;
  ease?: string;
}

const MAX_BATCH_SECONDS = 7;
/** sustained frame rate below this triggers the automatic quality governor */
const FPS_FLOOR = 45;

function cloneMeld(m: Meld): Meld {
  return { ...m, tiles: m.tiles.map((t) => ({ tileId: t.tileId, rep: { ...t.rep } })) };
}

function meldGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.shadowColor = 'rgba(255,214,120,1)';
    ctx.shadowBlur = 26;
    ctx.strokeStyle = 'rgba(255,226,150,1)';
    ctx.lineWidth = 10;
    const x = 30;
    const y = 30;
    const w = 196;
    const h = 68;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,140,0.18)';
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class TableScene implements TableSceneApi {
  private container: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private overlay: HTMLDivElement | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 40);
  private table = new THREE.Group();
  private env: Environment | null = null;
  private tiles: TileFactory | null = null;
  private avatars: SeatedAvatars | null = null;
  private confetti: Confetti | null = null;
  private flashes: Flashes | null = null;
  private dice: { meshes: THREE.Mesh[]; dispose(): void } | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTex: THREE.Texture | null = null;
  private resizeObs: ResizeObserver | null = null;
  private quality: Quality = 'medium';
  private onProgress: ((p: number) => void) | undefined;
  private mounted = false;
  private disposed = false;

  // seats
  private n = 4;
  private you = 0;
  private seatList: SeatAvatar[] = [];
  private statuses = new Map<number, PlayerStatus>();

  // table contents
  private melds = new Map<string, MeldVis>();
  private racks = new Map<number, Rack>();
  private wall: Tile3D[] = [];
  private wallCursor = 0;
  private deadWall: Tile3D[] = [];
  private strips = new Map<number, THREE.Mesh>();
  private stripGeo = new THREE.PlaneGeometry(1, 1);
  private hitGeo = new THREE.PlaneGeometry(1, 1);
  private hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private meldGlowTex: THREE.CanvasTexture | null = null;

  // interaction
  private activeSeat: number | null = null;
  private highlighted = new Set<string>();
  private hovered: string | null = null;
  private pickCbs: ((p: MeldPick) => void)[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDirty = false;
  private pointerInside = false;
  private downAt: { x: number; y: number; t: number } | null = null;

  // camera
  private camBase = new THREE.Vector3(0, 1.4, 1.14);
  private camLook = new THREE.Vector3(0, 0.66, -0.12);
  private push = { v: 0 };
  private pushFocus = new THREE.Vector3(0, TABLE_Y, 0);
  private shakeAmp = 0;
  private elapsed = 0;
  private lastT = 0;

  // animation bookkeeping
  private tweens = new Map<gsap.core.Animation, () => void>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private speed = 1;
  /** bumped by sync() and each batch so an interrupted batch stops animating */
  private generation = 0;
  /** true while shader variants compile after a quality change (rendering pauses) */
  private compiling = false;
  /** governor resolution multiplier (1 = quality default) */
  private resScale = 1;
  private perf = {
    frames: 0,
    windowStart: 0,
    graceUntil: 0,
    slowSeconds: 0,
    shadowsOff: false,
    outlinesOff: false,
    springOff: false,
    reset(now: number) {
      this.frames = 0;
      this.windowStart = now;
      this.graceUntil = now + 5000;
      this.slowSeconds = 0;
      this.shadowsOff = false;
      this.outlinesOff = false;
      this.springOff = false;
    },
  };
  private fpsEl: HTMLDivElement | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async mount(container: HTMLElement, opts: { quality: Quality; onProgress?: (p: number) => void }): Promise<void> {
    if (this.mounted) return;
    this.container = container;
    this.quality = opts.quality;
    this.onProgress = opts.onProgress;
    this.onProgress?.(0.05);

    const renderer = new THREE.WebGLRenderer({ antialias: opts.quality !== 'low', powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(canvas);

    // cinematic vignette (DOM overlay, never intercepts input)
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 52%, rgba(18,6,2,0.55) 100%);';
    container.appendChild(overlay);
    this.overlay = overlay;

    if (/[?&]fps(=|&|$)/.test(location.search)) {
      const fpsEl = document.createElement('div');
      fpsEl.style.cssText =
        'position:absolute;left:8px;top:52px;z-index:5;pointer-events:none;font:12px/1.4 monospace;color:#9ff;background:rgba(0,0,0,0.55);padding:2px 6px;border-radius:4px;';
      container.appendChild(fpsEl);
      this.fpsEl = fpsEl;
      (window as unknown as { __rummyScene?: THREE.Scene }).__rummyScene = this.scene;
    }
    if (/[?&]debug(=|&|$)/.test(location.search)) {
      // geometry probes for development (hands vs racks); see handCheck.ts
      (window as unknown as { __rummyDebug?: unknown }).__rummyDebug = {
        table: this,
        pose: SEATED_POSE,
        clips: CLIPS,
        hand: SEATED_HAND,
        wrist: HAND_WRIST,
        refit: () => this.avatars?.debugRefit(),
        handReport: () => this.handReport(),
        trackHands: (ms: number) => this.trackHands(ms),
      };
    }

    // image-based lighting for glossy tiles and wood
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    this.envTex = this.pmrem.fromScene(roomEnv, 0.04).texture;
    roomEnv.dispose();
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.45;
    this.onProgress?.(0.3);

    this.env = buildEnvironment(this.scene);
    this.table.position.y = TABLE_Y;
    this.scene.add(this.table);
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.tiles = new TileFactory(aniso);
    this.avatars = new SeatedAvatars(this.scene);
    this.confetti = new Confetti(this.scene);
    this.flashes = new Flashes(this.scene);
    this.dice = createDice(0.02);
    for (const m of this.dice.meshes) {
      m.visible = false;
      this.table.add(m);
    }
    this.meldGlowTex = meldGlowTexture();
    this.rebuildSeatGeometry();
    this.onProgress?.(0.7);

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);

    this.applyQuality(this.quality);
    this.resize();
    // warm up shaders so the first animations do not hitch
    renderer.compile(this.scene, this.camera);
    this.lastT = performance.now();
    renderer.setAnimationLoop(() => this.tick());
    this.mounted = true;
    this.onProgress?.(1);
    // seats assigned before mount finished
    if (this.seatList.length) void this.setSeats(this.seatList, this.you);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killAll();
    gsap.killTweensOf(this.push);
    const r = this.renderer;
    if (r) {
      r.setAnimationLoop(null);
      const c = r.domElement;
      c.removeEventListener('pointermove', this.onPointerMove);
      c.removeEventListener('pointerdown', this.onPointerDown);
      c.removeEventListener('pointerup', this.onPointerUp);
      c.removeEventListener('pointerleave', this.onPointerLeave);
    }
    this.resizeObs?.disconnect();
    for (const vis of this.melds.values()) this.removeMeldVis(vis);
    this.avatars?.dispose();
    this.confetti?.dispose();
    this.flashes?.dispose();
    this.dice?.dispose();
    this.env?.dispose();
    this.tiles?.dispose();
    for (const s of this.strips.values()) (s.material as THREE.Material).dispose();
    this.stripGeo.dispose();
    this.hitGeo.dispose();
    this.hitMat.dispose();
    this.meldGlowTex?.dispose();
    this.envTex?.dispose();
    this.pmrem?.dispose();
    if (r) {
      r.dispose();
      r.domElement.remove();
    }
    this.overlay?.remove();
    this.fpsEl?.remove();
    this.renderer = null;
    this.container = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async setSeats(seats: SeatAvatar[], you: number): Promise<void> {
    this.seatList = seats;
    const maxSeat = seats.reduce((m, s) => Math.max(m, s.seat), -1);
    const n = Math.max(seats.length, maxSeat + 1, this.lastViewN ?? 0) || this.n;
    if (n !== this.n || you !== this.you) {
      this.n = n;
      this.you = you;
      this.rebuildSeatGeometry();
    }
    if (!this.avatars) return;
    await this.avatars.setSeats(seats, this.camSeat, this.n, this.onProgress);
  }

  playEvents(events: GameEvent[], view: PlayerView): Promise<void> {
    this.pending++;
    const run = this.queue
      .then(() => this.runBatch(events, view))
      .catch((err: unknown) => {
        console.error('[scene] playEvents failed', err);
        this.safeReconcile(view);
      })
      .finally(() => {
        this.pending--;
      });
    this.queue = run;
    return run;
  }

  sync(view: PlayerView): void {
    this.generation++;
    this.killAll();
    this.safeReconcile(view);
  }

  highlightMelds(meldIds: string[]): void {
    this.highlighted = new Set(meldIds);
  }

  onMeldPick(cb: (pick: MeldPick) => void): void {
    this.pickCbs.push(cb);
  }

  react(seat: number, reaction: Reaction): void {
    if (seat === this.camSeat && this.you >= 0) return; // shown by the UI's own portrait
    this.avatars?.react(seat, reaction);
  }

  setActiveSeat(seat: number | null): void {
    this.activeSeat = seat;
    this.avatars?.setActive(seat);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    if (this.mounted) this.applyQuality(q);
  }

  // -------------------------------------------------------------------------
  // Debug probes (?debug)
  // -------------------------------------------------------------------------

  private handReport(): HandReport[] {
    const rigs = this.avatars?.debugRigs() ?? [];
    const actual: TileBox[] = [];
    for (const [seat, rack] of this.racks) {
      rack.tiles.forEach((t, i) => {
        if (t.obj.visible && t.obj.parent) actual.push(tileBoxFromObject(t.obj, `seat${seat}#${i}`));
      });
    }
    return rigs.map((r) => {
      const boxes = [...actual, ...nominalRackBoxes(r.angle, TABLE_Y)];
      const hands = (['left', 'right'] as const).map((side) => handStats(r.rig.vrm, side, r.angle, TABLE_Y, boxes));
      return { seat: r.seat, avatarId: r.avatarId, rel: relSeat(r.seat, this.camSeat, this.n), n: this.n, ok: hands.every(handOk), hands };
    });
  }

  /** Sample handReport every frame for `ms`; keeps the worst value per seat and hand. */
  private trackHands(ms: number): Promise<HandReport[]> {
    const worst = new Map<string, HandReport>();
    const end = performance.now() + ms;
    return new Promise((resolve) => {
      const step = (): void => {
        for (const r of this.handReport()) {
          const prev = worst.get(String(r.seat));
          if (!prev) {
            worst.set(String(r.seat), r);
            continue;
          }
          prev.ok = prev.ok && r.ok;
          r.hands.forEach((h, k) => {
            const p = prev.hands[k];
            p.inside = Math.max(p.inside, h.inside);
            p.minGap = Math.min(p.minGap, h.minGap);
            p.minRadial = Math.min(p.minRadial, h.minRadial);
            p.minY = Math.min(p.minY, h.minY);
          });
        }
        if (performance.now() < end) requestAnimationFrame(step);
        else resolve([...worst.values()]);
      };
      step();
    });
  }

  // -------------------------------------------------------------------------
  // Seats / geometry helpers
  // -------------------------------------------------------------------------

  private lastViewN: number | null = null;

  private get camSeat(): number {
    return this.you >= 0 ? this.you : 0;
  }

  private angleOf(seat: number): number {
    return seatAngle(relSeat(seat, this.camSeat, this.n), this.n);
  }

  /** The camera seat's own hand lives in the DOM (unless spectating). */
  private isOwnSeat(seat: number): boolean {
    return this.you >= 0 && seat === this.you;
  }

  private rebuildSeatGeometry(): void {
    if (!this.tiles) return;
    for (const rack of this.racks.values()) for (const t of rack.tiles) this.tiles.release(t);
    this.racks.clear();
    for (const s of this.strips.values()) {
      s.removeFromParent();
      (s.material as THREE.Material).dispose();
    }
    this.strips.clear();
    for (let seat = 0; seat < this.n; seat++) {
      const angle = this.angleOf(seat);
      const mat = new THREE.MeshBasicMaterial({
        color: COLOURS_3D.turn,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const strip = new THREE.Mesh(this.stripGeo, mat);
      const d = seatDir(angle);
      const edge = this.n === 4 ? TABLE_HALF - 0.022 : TABLE_HALF * 0.86;
      strip.position.copy(d.multiplyScalar(edge)).setY(0.0012);
      strip.quaternion.copy(quatY(angle).multiply(quatX(-Math.PI / 2)));
      strip.scale.set(this.n === 4 ? 0.7 : 0.5, 0.012, 1);
      this.table.add(strip);
      this.strips.set(seat, strip);
    }
    this.avatars?.relayout(this.camSeat, this.n);
  }

  private rack(seat: number): Rack {
    let r = this.racks.get(seat);
    if (!r) {
      r = { seat, tiles: [], state: 'stand' };
      this.racks.set(seat, r);
    }
    return r;
  }

  private newTile(id: string | null): Tile3D {
    const t = (this.tiles as TileFactory).create(id);
    this.table.add(t.obj);
    return t;
  }

  private releaseTile(t: Tile3D): void {
    gsap.killTweensOf(t.obj.position);
    this.tiles?.release(t);
  }

  private setXform(obj: THREE.Object3D, xf: Xform): void {
    obj.position.copy(xf.pos);
    obj.quaternion.copy(xf.quat);
    obj.scale.setScalar(xf.scale);
  }

  // -------------------------------------------------------------------------
  // Tweens
  // -------------------------------------------------------------------------

  private sec(s: number): number {
    return s / this.speed;
  }

  private track(anim: gsap.core.Animation, resolve: () => void): void {
    this.tweens.set(anim, resolve);
  }

  private untrack(anim: gsap.core.Animation): void {
    this.tweens.delete(anim);
  }

  /** Kill every running scene tween; their promises resolve immediately. */
  private killAll(): void {
    const entries = [...this.tweens.entries()];
    this.tweens.clear();
    for (const [anim, resolve] of entries) {
      anim.kill();
      resolve();
    }
  }

  private wait(seconds: number): Promise<void> {
    if (seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const call = gsap.delayedCall(seconds, () => {
        this.untrack(call);
        resolve();
      });
      this.track(call, resolve);
    });
  }

  /** Run a callback later (cancelled by sync/dispose). */
  private later(seconds: number, fn: () => void): void {
    const call = gsap.delayedCall(seconds, () => {
      this.untrack(call);
      if (!this.disposed) fn();
    });
    this.track(call, () => undefined);
  }

  /** Move a tile to a transform along an arc, slerping its rotation. */
  private move(t: Tile3D, xf: Xform, o: MoveOpts): Promise<void> {
    const obj = t.obj;
    const p0 = obj.position.clone();
    const q0 = obj.quaternion.clone();
    const s0 = obj.scale.x;
    const p2 = xf.pos.clone();
    const q2 = xf.quat.clone();
    const s2 = xf.scale;
    const mid = p0.clone().lerp(p2, 0.5);
    mid.y = Math.max(p0.y, p2.y) + (o.arc ?? 0);
    const proxy = { u: 0 };
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    return new Promise((resolve) => {
      const tw = gsap.to(proxy, {
        u: 1,
        duration: this.sec(o.dur),
        delay: this.sec(o.delay ?? 0),
        ease: o.ease ?? 'power2.inOut',
        onUpdate: () => {
          const u = proxy.u;
          // quadratic bezier p0 -> mid -> p2
          a.copy(p0).lerp(mid, u);
          b.copy(mid).lerp(p2, u);
          obj.position.copy(a.lerp(b, u));
          obj.quaternion.slerpQuaternions(q0, q2, Math.min(1, u * 1.2));
          obj.scale.setScalar(s0 + (s2 - s0) * u);
        },
        onComplete: () => {
          this.untrack(tw);
          resolve();
        },
      });
      this.track(tw, resolve);
    });
  }

  private shake(amount: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  // -------------------------------------------------------------------------
  // Racks
  // -------------------------------------------------------------------------

  /** Snap a rack to a state and contents (ids null = backs). */
  private setRack(seat: number, state: RackState, ids: (string | null)[]): void {
    if (!this.tiles) return;
    const rack = this.rack(seat);
    while (rack.tiles.length > ids.length) {
      const t = rack.tiles.pop();
      if (t) this.releaseTile(t);
    }
    while (rack.tiles.length < ids.length) rack.tiles.push(this.newTile(null));
    const angle = this.angleOf(seat);
    rack.tiles.forEach((t, i) => {
      this.tiles?.setFace(t, state === 'revealed' ? ids[i] : null);
      this.tiles?.setDead(t, state === 'dead');
      this.setXform(t.obj, rackXform(angle, i, ids.length, state));
    });
    rack.state = state;
  }

  private clearRack(seat: number): void {
    const rack = this.racks.get(seat);
    if (!rack) return;
    for (const t of rack.tiles) this.releaseTile(t);
    rack.tiles = [];
  }

  /** Re-space a rack after tiles left or arrived. */
  private reflowRack(seat: number, dur = 0.3, delay = 0): Promise<void> {
    const rack = this.racks.get(seat);
    if (!rack) return Promise.resolve();
    const angle = this.angleOf(seat);
    const count = rack.tiles.length;
    return Promise.all(rack.tiles.map((t, i) => this.move(t, rackXform(angle, i, count, rack.state), { dur, delay }))).then(
      () => undefined,
    );
  }

  /**
   * Remove `k` tiles from a seat's hand for playing. Opponents give up rack tiles (spread
   * out, like picking from a real hand); the local player's tiles appear from the bottom edge.
   */
  private takeFromHand(seat: number, k: number): Tile3D[] {
    const out: Tile3D[] = [];
    if (this.isOwnSeat(seat)) {
      for (let i = 0; i < k; i++) {
        const t = this.newTile(null);
        this.setXform(t.obj, ownOriginXform(i, k));
        out.push(t);
      }
      return out;
    }
    const rack = this.rack(seat);
    for (let i = 0; i < k; i++) {
      if (rack.tiles.length) {
        const idx = Math.floor(((i + 0.5) / k) * rack.tiles.length) % rack.tiles.length;
        const [t] = rack.tiles.splice(idx, 1);
        this.tiles?.setDead(t, false);
        out.push(t);
      } else {
        const t = this.newTile(null);
        this.setXform(t.obj, rackXform(this.angleOf(seat), 0, 1, 'stand'));
        out.push(t);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Melds
  // -------------------------------------------------------------------------

  private createMeldVis(meld: Meld): MeldVis {
    const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
    hit.rotation.x = -Math.PI / 2;
    hit.userData.meldId = meld.id;
    const glowMat = new THREE.MeshBasicMaterial({
      map: this.meldGlowTex,
      color: COLOURS_3D.gold,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(this.hitGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.visible = false;
    glow.renderOrder = 2;
    this.table.add(hit, glow);
    const vis: MeldVis = { meld: cloneMeld(meld), tiles: [], slot: null, hit, glow, glowMat, glowLevel: 0 };
    this.melds.set(meld.id, vis);
    return vis;
  }

  private removeMeldVis(vis: MeldVis): void {
    for (const t of vis.tiles) this.releaseTile(t);
    vis.tiles = [];
    vis.hit.removeFromParent();
    vis.glow.removeFromParent();
    vis.glowMat.dispose();
    this.melds.delete(vis.meld.id);
  }

  /**
   * Recompute the meld layout. Existing tiles glide to their new spots (or snap when
   * `animate` is false); tiles in `skip` are left for the caller to fly in.
   */
  private relayoutMelds(animate: boolean, skip?: Set<Tile3D>): Map<string, MeldSlot> {
    const slots = layoutMelds(
      [...this.melds.values()].map((v) => v.meld),
      this.n,
      this.meldLayoutOptions(),
    );
    for (const vis of this.melds.values()) {
      const slot = slots.get(vis.meld.id) ?? null;
      vis.slot = slot;
      if (!slot) continue;
      // pick plane lies on the tilted faces, slightly proud of them and a little oversized
      const faceLift = (TILE_D / 2) * slot.scale + 0.001;
      vis.hit.rotation.x = -Math.PI / 2 + slot.tilt;
      vis.hit.position.set(slot.cx, slot.y + Math.cos(slot.tilt) * faceLift, slot.cz + Math.sin(slot.tilt) * faceLift);
      vis.hit.scale.set(slot.width + 0.016, TILE_H * slot.scale + 0.02, 1);
      vis.glow.position.set(slot.cx, 0.0015, slot.cz);
      vis.glow.scale.set(slot.width + TILE_W * 2.2, slot.depth + TILE_H * 1.1, 1);
      vis.tiles.forEach((t, i) => {
        if (skip?.has(t) || i >= slot.tiles.length) return;
        const xf = meldTileXform(slot, i);
        if (animate && t.obj.position.distanceToSquared(xf.pos) > 1e-8) void this.move(t, xf, { dur: 0.35 });
        else if (!animate) this.setXform(t.obj, xf);
      });
    }
    return slots;
  }

  /**
   * Keep-out zones for the meld layout: each rack at its current length (plus room for a
   * couple of returned jokers), unknown racks at full length, the camera seat's rack only
   * when one is shown, and the dead wall at its current size.
   */
  private meldLayoutOptions(): MeldLayoutOptions {
    const rackCounts: (number | null)[] = new Array<number | null>(this.n).fill(null);
    for (let seat = 0; seat < this.n; seat++) {
      const rel = relSeat(seat, this.camSeat, this.n);
      const rack = this.racks.get(seat);
      if (this.isOwnSeat(seat)) rackCounts[rel] = rack?.tiles.length ?? 0;
      else rackCounts[rel] = rack && rack.tiles.length ? rack.tiles.length + 2 : null;
    }
    return { rackCounts, deadWall: this.deadWall.length || undefined };
  }

  /** Fly freshly played tiles into their meld slots. */
  private flyIntoMeld(vis: MeldVis, tiles: Tile3D[], o: { delay: number; slam: boolean; stagger?: number }): Promise<void> {
    const slot = vis.slot;
    if (!slot) return Promise.resolve();
    const jobs = tiles.map((t, j) => {
      const i = vis.tiles.indexOf(t);
      if (i < 0) return Promise.resolve();
      const xf = meldTileXform(slot, i);
      return this.move(t, xf, {
        dur: o.slam ? 0.42 : 0.5,
        delay: o.delay + j * (o.stagger ?? 0.035),
        arc: o.slam ? 0.16 : 0.09,
        ease: o.slam ? 'power3.in' : 'power2.inOut',
      });
    });
    return Promise.all(jobs).then(() => undefined);
  }

  private meldWorldCentre(vis: MeldVis): THREE.Vector3 {
    const s = vis.slot;
    return new THREE.Vector3(s ? s.cx : 0, TABLE_Y + 0.002, s ? s.cz : 0);
  }

  // -------------------------------------------------------------------------
  // Wall, dead wall, dice
  // -------------------------------------------------------------------------

  private releaseWall(): void {
    for (const t of this.wall) this.releaseTile(t);
    this.wall = [];
    this.wallCursor = 0;
  }

  /** Build the square wall of face-down stacks, ordered so dealing starts at the break. */
  private buildWall(total: number, brk: WallBreak | null, animate: boolean, delay = 0): Promise<void> {
    this.releaseWall();
    const walls = wallSlots(this.n, this.camSeat, total);
    const startWall = brk ? ((brk.wallSeat % this.n) + this.n) % this.n : 0;
    const order: Xform[] = [];
    for (let w = 0; w < walls.length; w++) {
      const xfs = walls[(startWall + w) % walls.length].xf;
      const stacks = xfs.length / 2;
      const s0 = w === 0 && brk ? Math.min(stacks - 1, Math.max(0, brk.stack)) : 0;
      for (let j = 0; j < stacks; j++) {
        const s = (s0 + j) % stacks;
        // top tile of a stack is taken first
        order.push(xfs[s * 2 + 1], xfs[s * 2]);
      }
    }
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < Math.min(total, order.length); i++) {
      const t = this.newTile(null);
      const xf = order[i];
      if (animate) {
        this.setXform(t.obj, { pos: xf.pos.clone().setY(xf.pos.y - 0.05), quat: xf.quat, scale: 0.6 });
        jobs.push(this.move(t, xf, { dur: 0.26, delay: delay + (i % 28) * 0.004, ease: 'back.out(1.6)' }));
      } else {
        this.setXform(t.obj, xf);
      }
      this.wall.push(t);
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /** Snap the dead wall to `count` tiles. */
  private setDeadWall(count: number): void {
    while (this.deadWall.length > count) {
      const t = this.deadWall.pop();
      if (t) this.releaseTile(t);
    }
    while (this.deadWall.length < count) this.deadWall.push(this.newTile(null));
    this.deadWall.forEach((t, i) => this.setXform(t.obj, deadWallXform(i, count, this.n)));
  }

  private diceRest(i: number): THREE.Vector3 {
    return diceRestPos(i, this.n);
  }

  private placeDice(values: [number, number] | null): void {
    if (!this.dice) return;
    this.dice.meshes.forEach((m, i) => {
      if (!values) {
        m.visible = false;
        return;
      }
      m.visible = true;
      m.position.copy(this.diceRest(i));
      m.quaternion.copy(diceFaceQuat(values[i], 0.35 + i * 0.6));
    });
  }

  private rollDice(values: [number, number], fromSeat: number, delay: number): Promise<void> {
    if (!this.dice) return Promise.resolve();
    const start = seatDir(this.angleOf(fromSeat)).multiplyScalar(0.3).setY(0.12);
    const jobs = this.dice.meshes.map((m, i) => {
      m.visible = true;
      m.position.copy(start).add(new THREE.Vector3((i - 0.5) * 0.04, 0, 0));
      const end = this.diceRest(i);
      const qEnd = diceFaceQuat(values[i], 0.35 + i * 0.6);
      const eEnd = new THREE.Euler().setFromQuaternion(qEnd);
      const spins = 2 + i;
      m.rotation.set(eEnd.x - Math.PI * 2 * spins, eEnd.y + Math.PI, eEnd.z + Math.PI * 2 * (spins - 1));
      const proxy = { u: 0 };
      const p0 = m.position.clone();
      const r0 = m.rotation.clone();
      return new Promise<void>((resolve) => {
        const tw = gsap.to(proxy, {
          u: 1,
          duration: this.sec(0.75),
          delay: this.sec(delay + i * 0.05),
          ease: 'power2.out',
          onUpdate: () => {
            const u = proxy.u;
            m.position.lerpVectors(p0, end, u);
            // two decaying bounces
            m.position.y = end.y + Math.abs(Math.cos(u * Math.PI * 2.5)) * 0.08 * (1 - u) * (1 - u);
            m.rotation.set(r0.x + (eEnd.x - r0.x) * u, r0.y + (eEnd.y - r0.y) * u, r0.z + (eEnd.z - r0.z) * u);
          },
          onComplete: () => {
            this.untrack(tw);
            m.quaternion.copy(qEnd);
            resolve();
          },
        });
        this.track(tw, resolve);
      });
    });
    return Promise.all(jobs).then(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  private reactSeat(seat: number, r: Reaction, delay = 0): void {
    if (this.isOwnSeat(seat)) return;
    if (delay > 0) this.later(this.sec(delay), () => this.avatars?.react(seat, r));
    else this.avatars?.react(seat, r);
  }

  /** Some opponents (other than `except`) react; at most `max`, picked at random. */
  private othersReact(except: number[], r: Reaction, max = 3, delay = 0): void {
    const seats = (this.avatars?.seats() ?? []).filter((s) => !except.includes(s));
    seats.sort(() => Math.random() - 0.5);
    seats.slice(0, max).forEach((s, i) => this.reactSeat(s, r, delay + i * 0.12));
  }

  // -------------------------------------------------------------------------
  // Event batches
  // -------------------------------------------------------------------------

  private async runBatch(events: GameEvent[], view: PlayerView): Promise<void> {
    if (this.disposed) return;
    if (!this.mounted) {
      this.safeReconcile(view);
      return;
    }
    const backlog = this.pending - 1;
    if (backlog >= 3 || !events.length) {
      this.killAll();
      this.reconcile(view);
      return;
    }
    const gen = ++this.generation;
    const aborted = (): boolean => this.disposed || gen !== this.generation;
    this.speed = backlog >= 1 ? 2.2 : 1;
    this.ensureSeatCount(view);
    const steps = this.plan(events, view);
    const done: Promise<void>[] = [];
    for (const step of steps) {
      const r = step();
      done.push(r.done);
      if (r.gap > 0) await this.wait(this.sec(r.gap));
      if (aborted()) return; // sync() took over
    }
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, MAX_BATCH_SECONDS * 1000);
    });
    await Promise.race([Promise.all(done).then(() => undefined), timeout]);
    if (timer) clearTimeout(timer);
    if (aborted()) return;
    // normally only delayed reactions remain; after a timeout stop stray tile tweens too
    if (timedOut) this.killAll();
    this.reconcile(view);
    this.speed = 1;
  }

  private ensureSeatCount(view: PlayerView): void {
    const n = view.players.length;
    this.lastViewN = n;
    if (n && (n !== this.n || view.you !== this.you)) {
      this.n = n;
      this.you = view.you;
      this.rebuildSeatGeometry();
    }
  }

  private plan(events: GameEvent[], view: PlayerView): Step[] {
    const steps: Step[] = [];
    const hasReveal = events.some((e) => e.type === 'PORT_REVEAL');
    const portMelds = new Map<string, { seat: number; meld: Meld }>();
    for (const e of events) if (e.type === 'MELD_CREATED' && e.via === 'PORT') portMelds.set(e.meld.id, { seat: e.seat, meld: e.meld });
    const celebrated = events.some((e) => e.type === 'GAME_PAI' || e.type === 'INSTANT_WIN');
    const noop: StepResult = { done: Promise.resolve(), gap: 0 };

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'HAND_START':
          steps.push(() => this.animHandStart(e, view));
          break;
        case 'DEAL': {
          const deals: { seat: number; count: number }[] = [];
          while (i < events.length) {
            const d = events[i];
            if (d.type !== 'DEAL') break;
            deals.push({ seat: d.seat, count: d.count });
            i++;
          }
          i--;
          steps.push(() => this.animDeal(deals, view));
          break;
        }
        case 'INSTANT_OFFER':
          steps.push(() => {
            this.reactSeat(e.seat, 'think');
            return noop;
          });
          break;
        case 'INSTANT_WIN':
          steps.push(() => this.animInstantWin(e.seat, e.tiles));
          break;
        case 'PORT_SUBMITTED':
          steps.push(() => this.animPortSubmitted(e.seat));
          break;
        case 'PORT_REVEAL':
          steps.push(() => this.animPortReveal(e.ports, portMelds, view));
          break;
        case 'QUANCAN':
          steps.push(() => this.animDead(e.seat, true));
          break;
        case 'MELD_CREATED':
          if (e.via === 'PORT' && hasReveal) break; // animated together by PORT_REVEAL
          steps.push(() => this.animMeldCreated(e.seat, e.meld, e.via === 'CUT'));
          break;
        case 'MELD_EXTENDED':
          steps.push(() => this.animAddToMeld(e.seat, e.meldId, e.low, e.high, false));
          break;
        case 'SET_FOLLOWED':
          steps.push(() => this.animAddToMeld(e.seat, e.meldId, [], e.added, true));
          break;
        case 'JOKER_SWAPPED':
          steps.push(() => this.animSwap(e.seat, e.meldId, e.jokerTileId, e.withTileId));
          break;
        case 'TURN':
          steps.push(() => {
            this.setActiveSeat(e.seat);
            if (!this.isOwnSeat(e.seat) && Math.random() < 0.3) this.reactSeat(e.seat, 'think');
            return noop;
          });
          break;
        case 'TIMEOUT':
          steps.push(() => {
            this.reactSeat(e.seat, 'surprised');
            return noop;
          });
          break;
        case 'PLAYER_DEAD':
          steps.push(() => this.animDead(e.seat, false));
          break;
        case 'GAME_PAI':
          steps.push(() => this.celebrate(e.seat, 1));
          break;
        case 'HAND_END':
          steps.push(() => this.animHandEnd(e.result, celebrated));
          break;
        case 'MATCH_END':
          steps.push(() => this.animMatchEnd(e.standings));
          break;
      }
    }
    return steps;
  }

  // --- individual animations ------------------------------------------------

  private animHandStart(e: Extract<GameEvent, { type: 'HAND_START' }>, view: PlayerView): StepResult {
    this.setActiveSeat(null);
    this.statuses.clear();
    for (const seat of this.avatars?.seats() ?? []) this.avatars?.setMood(seat, 'normal');
    this.highlighted.clear();

    // sweep last hand's tiles into the middle and sink them
    const old: Tile3D[] = [];
    for (const vis of [...this.melds.values()]) {
      old.push(...vis.tiles);
      vis.tiles = [];
      this.removeMeldVis(vis);
    }
    for (const rack of this.racks.values()) {
      old.push(...rack.tiles);
      rack.tiles = [];
      rack.state = 'stand';
    }
    old.push(...this.deadWall, ...this.wall);
    this.deadWall = [];
    this.wall = [];
    this.wallCursor = 0;
    for (const t of old) {
      const p = t.obj.position;
      void this.move(t, { pos: new THREE.Vector3(p.x * 0.25, -0.03, p.z * 0.25), quat: t.obj.quaternion.clone(), scale: 0.5 }, {
        dur: 0.3,
        delay: Math.random() * 0.06,
        ease: 'power2.in',
      }).then(() => this.releaseTile(t));
    }
    if (this.dice) for (const m of this.dice.meshes) m.visible = false;

    const total = 104 + (view.cfg.jokers ?? 8);
    // the wall must have settled before the deal starts taking tiles from it:
    // sweep-out 0.2 + rise 0.26 + stagger 27 * 0.004 = 0.57 s
    const jobs = [this.buildWall(total, e.wallBreak, true, old.length ? 0.2 : 0), this.rollDice(e.wallBreak.dice, e.dealer, 0.2)];
    this.reactSeat(e.dealer, 'wave', 0.15);
    return { done: Promise.all(jobs).then(() => undefined), gap: old.length ? 0.6 : 0.4 };
  }

  private animDeal(deals: { seat: number; count: number }[], view: PlayerView): StepResult {
    const totals = new Map<number, number>();
    for (const d of deals) totals.set(d.seat, (totals.get(d.seat) ?? 0) + d.count);
    const order = [...totals.keys()];
    const dealt = [...totals.values()].reduce((a, b) => a + b, 0);
    if (this.wall.length - this.wallCursor < dealt) {
      void this.buildWall(dealt + view.deadWallCount, view.wallBreak, false);
    }
    for (const seat of order) if (!this.isOwnSeat(seat)) this.clearRack(seat);

    const jobs: Promise<void>[] = [];
    const received = new Map<number, number>(order.map((s) => [s, 0]));
    // ~20 grabs of 4 tiles: ~0.65 s of grabbing, the last grab lands ~0.38 s later
    const interval = 0.034;
    let grab = 0;
    let more = true;
    while (more) {
      more = false;
      for (const seat of order) {
        const total = totals.get(seat) ?? 0;
        const got = received.get(seat) ?? 0;
        const k = Math.min(4, total - got);
        if (k <= 0) continue;
        more = true;
        const delay = grab * interval;
        grab++;
        for (let j = 0; j < k; j++) {
          let t = this.wall[this.wallCursor];
          if (t) this.wallCursor++;
          else {
            t = this.newTile(null);
            this.setXform(t.obj, { pos: new THREE.Vector3(0, TILE_D / 2, 0), quat: quatX(Math.PI / 2), scale: 1 });
          }
          const tile = t;
          if (this.isOwnSeat(seat)) {
            const xf = ownOriginXform(j, k, true);
            xf.scale = 0.8;
            jobs.push(this.move(tile, xf, { dur: 0.32, delay: delay + j * 0.012, arc: 0.12 }).then(() => this.releaseTile(tile)));
          } else {
            const rack = this.rack(seat);
            rack.state = 'stand';
            const idx = got + j;
            rack.tiles.push(tile);
            jobs.push(this.move(tile, rackXform(this.angleOf(seat), idx, total, 'stand'), { dur: 0.34, delay: delay + j * 0.012, arc: 0.1 }));
          }
        }
        received.set(seat, got + k);
      }
    }
    // what is left of the wall becomes the dead wall
    const leftover = this.wall.slice(this.wallCursor);
    this.wall = [];
    this.wallCursor = 0;
    const deadCount = view.deadWallCount;
    while (leftover.length > deadCount) {
      const t = leftover.pop();
      if (t) this.releaseTile(t);
    }
    while (leftover.length < deadCount) {
      const t = this.newTile(null);
      this.setXform(t.obj, deadWallXform(leftover.length, deadCount, this.n));
      leftover.push(t);
    }
    this.deadWall = leftover;
    // the dead wall gathers while the last grabs are still in the air
    const base = Math.max(0, grab * interval - 0.15);
    const stagger = Math.min(0.006, 0.2 / Math.max(1, leftover.length));
    leftover.forEach((t, i) => {
      jobs.push(this.move(t, deadWallXform(i, deadCount, this.n), { dur: 0.3, delay: base + i * stagger, arc: 0.05 }));
    });
    return { done: Promise.all(jobs).then(() => undefined), gap: base + 0.3 };
  }

  private animPortSubmitted(seat: number): StepResult {
    const rack = this.racks.get(seat);
    if (rack && rack.state === 'stand') {
      // a little "ready" hop along the rack
      rack.tiles.forEach((t, i) => {
        const p = t.obj.position;
        const y0 = p.y;
        const tw = gsap.to(p, {
          y: y0 + 0.012,
          duration: this.sec(0.12),
          delay: this.sec(i * 0.012),
          yoyo: true,
          repeat: 1,
          ease: 'power1.out',
          onComplete: () => this.untrack(tw),
        });
        this.track(tw, () => undefined);
      });
    }
    this.reactSeat(seat, 'happy');
    return { done: Promise.resolve(), gap: 0.08 };
  }

  private animPortReveal(
    ports: { seat: number; meldIds: string[] }[],
    portMelds: Map<string, { seat: number; meld: Meld }>,
    view: PlayerView,
  ): StepResult {
    const created: { seat: number; vis: MeldVis }[] = [];
    for (const p of ports) {
      for (const id of p.meldIds) {
        if (this.melds.has(id)) continue;
        const meld = portMelds.get(id)?.meld ?? view.melds.find((m) => m.id === id);
        if (!meld) continue;
        created.push({ seat: p.seat, vis: this.createMeldVis(meld) });
      }
    }
    if (!created.length) return { done: Promise.resolve(), gap: 0 };

    // take tiles from each seat's hand and assign them to the new melds
    const fresh = new Set<Tile3D>();
    const bySeat = new Map<number, MeldVis[]>();
    for (const c of created) bySeat.set(c.seat, [...(bySeat.get(c.seat) ?? []), c.vis]);
    for (const [seat, list] of bySeat) {
      const count = list.reduce((a, v) => a + v.meld.tiles.length, 0);
      const src = this.takeFromHand(seat, count);
      let k = 0;
      for (const vis of list) {
        vis.tiles = vis.meld.tiles.map((mt) => {
          const t = src[k++];
          this.tiles?.setFace(t, mt.tileId);
          fresh.add(t);
          return t;
        });
      }
    }
    this.relayoutMelds(true, fresh);

    const jobs: Promise<void>[] = [];
    let seatIdx = 0;
    for (const [seat, list] of bySeat) {
      const delay = seatIdx * 0.12;
      let local = 0;
      for (const vis of list) {
        jobs.push(this.flyIntoMeld(vis, vis.tiles, { delay: delay + local * 0.05, slam: false, stagger: 0.03 }));
        local++;
      }
      this.reactSeat(seat, 'play', delay);
      jobs.push(this.reflowRack(seat, 0.3, delay + 0.45));
      seatIdx++;
    }
    const total = seatIdx * 0.12 + 0.9;
    this.later(this.sec(total - 0.2), () => this.shake(0.004));
    return { done: Promise.all(jobs).then(() => undefined), gap: total };
  }

  private animMeldCreated(seat: number, meld: Meld, slam: boolean): StepResult {
    if (this.melds.has(meld.id)) return { done: Promise.resolve(), gap: 0 };
    const vis = this.createMeldVis(meld);
    const src = this.takeFromHand(seat, meld.tiles.length);
    vis.tiles = meld.tiles.map((mt, i) => {
      this.tiles?.setFace(src[i], mt.tileId);
      return src[i];
    });
    this.relayoutMelds(true, new Set(vis.tiles));
    this.reactSeat(seat, 'play');
    const flown = this.flyIntoMeld(vis, vis.tiles, { delay: 0.12, slam });
    const land = 0.12 + (slam ? 0.42 : 0.5) + vis.tiles.length * 0.035;
    this.later(this.sec(land - 0.05), () => {
      if (slam) {
        this.shake(0.007);
        this.flashes?.ripple(this.meldWorldCentre(vis), 0.28, 0.5, 0.8);
        this.othersReact([seat], 'surprised', 2, 0.05);
        this.reactSeat(seat, 'happy', 0.5);
      } else {
        this.flashes?.ripple(this.meldWorldCentre(vis), 0.18, 0.4, 0.4);
      }
    });
    const rackDone = this.reflowRack(seat, 0.3, 0.35);
    return { done: Promise.all([flown, rackDone]).then(() => undefined), gap: land + 0.1 };
  }

  private animAddToMeld(seat: number, meldId: string, low: MeldTile[], high: MeldTile[], slam: boolean): StepResult {
    const vis = this.melds.get(meldId);
    if (!vis) return { done: Promise.resolve(), gap: 0 };
    const k = low.length + high.length;
    const src = this.takeFromHand(seat, k);
    const lowObjs = src.slice(0, low.length);
    const highObjs = src.slice(low.length);
    low.forEach((mt, i) => this.tiles?.setFace(lowObjs[i], mt.tileId));
    high.forEach((mt, i) => this.tiles?.setFace(highObjs[i], mt.tileId));
    vis.meld = { ...vis.meld, tiles: [...low, ...vis.meld.tiles, ...high].map((t) => ({ tileId: t.tileId, rep: { ...t.rep } })) };
    vis.tiles = [...lowObjs, ...vis.tiles, ...highObjs];
    this.relayoutMelds(true, new Set(src));
    this.reactSeat(seat, 'play');
    const flown = this.flyIntoMeld(vis, src, { delay: 0.12, slam });
    const land = 0.12 + (slam ? 0.42 : 0.5) + k * 0.035;
    this.later(this.sec(land - 0.05), () => {
      this.flashes?.ripple(this.meldWorldCentre(vis), slam ? 0.24 : 0.16, 0.4, slam ? 0.7 : 0.4);
      if (slam) this.shake(0.004);
      if (k >= 3) this.othersReact([seat], 'surprised', 1);
      if (slam) this.reactSeat(seat, 'happy', 0.4);
    });
    const rackDone = this.reflowRack(seat, 0.3, 0.35);
    return { done: Promise.all([flown, rackDone]).then(() => undefined), gap: land + 0.1 };
  }

  private animSwap(seat: number, meldId: string, jokerTileId: string, withTileId: string): StepResult {
    const vis = this.melds.get(meldId);
    const idx = vis ? vis.meld.tiles.findIndex((t) => t.tileId === jokerTileId) : -1;
    if (!vis || idx < 0 || !vis.slot) return { done: Promise.resolve(), gap: 0 };
    const jokerObj = vis.tiles[idx];
    const [nat] = this.takeFromHand(seat, 1);
    this.tiles?.setFace(nat, withTileId);
    vis.meld.tiles[idx] = { tileId: withTileId, rep: { ...vis.meld.tiles[idx].rep } };
    vis.tiles[idx] = nat;
    const jobs: Promise<void>[] = [];
    // the natural tile dips in low while the joker loops high over it
    jobs.push(this.move(nat, meldTileXform(vis.slot, idx), { dur: 0.6, delay: 0.1, arc: 0.06 }));
    if (jokerObj) {
      if (this.isOwnSeat(seat)) {
        jobs.push(
          this.move(jokerObj, ownOriginXform(0, 1), { dur: 0.6, delay: 0.1, arc: 0.18 }).then(() => this.releaseTile(jokerObj)),
        );
      } else {
        const rack = this.rack(seat);
        rack.tiles.push(jokerObj);
        const angle = this.angleOf(seat);
        const count = rack.tiles.length;
        jobs.push(
          this.move(jokerObj, rackXform(angle, count - 1, count, rack.state), { dur: 0.6, delay: 0.1, arc: 0.18 }).then(() => {
            this.tiles?.setFace(jokerObj, rack.state === 'revealed' ? jokerTileId : null);
          }),
        );
        jobs.push(this.reflowRack(seat, 0.3, 0.75));
      }
    }
    this.reactSeat(seat, 'play');
    this.reactSeat(seat, 'laugh', 0.75);
    this.later(this.sec(0.65), () => this.flashes?.ripple(this.meldWorldCentre(vis), 0.16, 0.4, 0.5));
    return { done: Promise.all(jobs).then(() => undefined), gap: 0.85 };
  }

  private animDead(seat: number, quancan: boolean): StepResult {
    this.statuses.set(seat, quancan ? 'QUANCAN' : 'DEAD');
    if (this.isOwnSeat(seat)) {
      this.othersReact([seat], 'laugh', 1, 0.3);
      return { done: Promise.resolve(), gap: 0.3 };
    }
    const rack = this.rack(seat);
    rack.state = 'dead';
    const angle = this.angleOf(seat);
    const count = rack.tiles.length;
    const jobs = rack.tiles.map((t, i) => {
      this.tiles?.setDead(t, true);
      return this.move(t, rackXform(angle, i, count, 'dead'), { dur: 0.45, delay: i * 0.012, arc: 0.015, ease: 'power2.in' });
    });
    this.later(this.sec(0.45 + count * 0.012), () => this.shake(0.002));
    this.avatars?.setMood(seat, 'dead');
    this.reactSeat(seat, quancan ? 'cry' : 'sad');
    if (Math.random() < 0.4) this.othersReact([seat], 'laugh', 1, 0.6);
    return { done: Promise.all(jobs).then(() => undefined), gap: 0.55 };
  }

  /** Game牌 / 天糊: camera push, confetti, glow, winner celebrates, others deflate. */
  private celebrate(seat: number, power: number): StepResult {
    const own = this.isOwnSeat(seat);
    const focus = new THREE.Vector3();
    if (own) focus.set(0, TABLE_Y + 0.12, 0.15);
    else this.avatars?.headWorld(seat, focus) ?? focus.set(0, TABLE_Y + 0.4, 0);
    this.pushFocus.copy(focus);
    gsap.killTweensOf(this.push);
    gsap.to(this.push, { v: 1, duration: 0.6, ease: 'power2.out' });
    gsap.to(this.push, { v: 0, duration: 1.2, delay: 2.3, ease: 'power2.inOut' });

    const burstAt = own ? new THREE.Vector3(0, TABLE_Y + 0.05, 0.1) : focus.clone().lerp(new THREE.Vector3(0, TABLE_Y, 0), 0.35);
    this.confetti?.burst(burstAt, power);
    this.flashes?.glow(focus, 1.5 * power, 1.6);
    this.flashes?.ripple(new THREE.Vector3(0, TABLE_Y + 0.003, 0), 1.3, 1.1, 0.9);
    this.shake(0.006);
    if (!own) {
      this.avatars?.setMood(seat, 'winner');
      this.reactSeat(seat, 'win');
    }
    this.statuses.set(seat, 'OUT');
    this.othersReact([seat], 'surprised', 3);
    this.othersReact([seat], 'lose', 3, 1.1);
    return { done: this.wait(this.sec(1.8)), gap: 1.8 };
  }

  private animInstantWin(seat: number, groups: string[][]): StepResult {
    const r = this.celebrate(seat, 1.25);
    if (!this.isOwnSeat(seat)) {
      // lay the winning hand face up in front of the winner
      const ids = groups.flat();
      const rack = this.rack(seat);
      while (rack.tiles.length > ids.length) {
        const t = rack.tiles.pop();
        if (t) this.releaseTile(t);
      }
      while (rack.tiles.length < ids.length) {
        const t = this.newTile(null);
        this.setXform(t.obj, rackXform(this.angleOf(seat), rack.tiles.length, ids.length, 'stand'));
        rack.tiles.push(t);
      }
      rack.state = 'revealed';
      const angle = this.angleOf(seat);
      const jobs = rack.tiles.map((t, i) => {
        this.tiles?.setFace(t, ids[i]);
        this.tiles?.setDead(t, false);
        return this.move(t, rackXform(angle, i, ids.length, 'revealed'), { dur: 0.5, delay: 0.2 + i * 0.02, arc: 0.06 });
      });
      return { done: Promise.all([r.done, ...jobs]).then(() => undefined), gap: r.gap };
    }
    return r;
  }

  private animHandEnd(result: HandResult, celebrated: boolean): StepResult {
    const jobs: Promise<void>[] = [];
    let seatIdx = 0;
    for (const rk of result.rankings) {
      if (this.isOwnSeat(rk.seat)) continue;
      const rack = this.rack(rk.seat);
      const ids = sortTiles(rk.tiles);
      if (rack.state === 'revealed' && rack.tiles.length === ids.length && rack.tiles.every((t, i) => t.id === ids[i])) continue;
      const angle = this.angleOf(rk.seat);
      while (rack.tiles.length > ids.length) {
        const t = rack.tiles.pop();
        if (t) this.releaseTile(t);
      }
      while (rack.tiles.length < ids.length) {
        const t = this.newTile(null);
        this.setXform(t.obj, rackXform(angle, rack.tiles.length, ids.length, 'stand'));
        rack.tiles.push(t);
      }
      rack.state = 'revealed';
      const delay = seatIdx * 0.1;
      rack.tiles.forEach((t, i) => {
        this.tiles?.setFace(t, ids[i]);
        this.tiles?.setDead(t, false);
        jobs.push(this.move(t, rackXform(angle, i, ids.length, 'revealed'), { dur: 0.5, delay: delay + i * 0.018, arc: 0.05 }));
      });
      seatIdx++;
    }
    for (const rk of result.rankings) {
      if (rk.rank === 1 && !celebrated) this.reactSeat(rk.seat, 'happy', 0.3);
      else if (rk.title === 'DAGE') this.reactSeat(rk.seat, 'cry', celebrated ? 1.4 : 0.4);
    }
    this.setActiveSeat(null);
    return { done: Promise.all(jobs).then(() => undefined), gap: 0.4 + seatIdx * 0.1 };
  }

  private animMatchEnd(standings: MatchStanding[]): StepResult {
    const last = standings.reduce((m, s) => Math.max(m, s.place), 0);
    for (const s of standings) {
      if (s.place === 1) this.reactSeat(s.seat, 'cheer');
      else if (s.place === last) this.reactSeat(s.seat, 'cry', 0.3);
      else this.reactSeat(s.seat, 'wave', 0.5);
    }
    if (standings.some((s) => s.place === 1 && this.isOwnSeat(s.seat))) this.confetti?.burst(new THREE.Vector3(0, TABLE_Y + 0.05, 0.1), 1);
    return { done: Promise.resolve(), gap: 0.3 };
  }

  // -------------------------------------------------------------------------
  // Reconcile with the authoritative view (no animation)
  // -------------------------------------------------------------------------

  private safeReconcile(view: PlayerView): void {
    try {
      this.reconcile(view);
    } catch (err) {
      console.error('[scene] sync failed', err);
    }
  }

  private reconcile(view: PlayerView): void {
    if (!this.mounted || !this.tiles) return;
    this.ensureSeatCount(view);
    this.releaseWall();

    // melds
    const wanted = new Set(view.melds.map((m) => m.id));
    for (const vis of [...this.melds.values()]) if (!wanted.has(vis.meld.id)) this.removeMeldVis(vis);
    for (const m of view.melds) {
      const vis = this.melds.get(m.id) ?? this.createMeldVis(m);
      const want = m.tiles.map((t) => t.tileId);
      const same = vis.tiles.length === want.length && vis.tiles.every((t, i) => t.id === want[i]);
      if (!same) {
        const byId = new Map<string, Tile3D>();
        for (const t of vis.tiles) if (t.id) byId.set(t.id, t);
        vis.tiles = want.map((id) => {
          const t = byId.get(id);
          if (t) {
            byId.delete(id);
            return t;
          }
          return this.newTile(id);
        });
        for (const t of byId.values()) this.releaseTile(t);
      }
      for (const t of vis.tiles) this.tiles.setDead(t, false);
      vis.meld = cloneMeld(m);
    }

    // racks
    const handOver = view.phase === 'HAND_END' || view.phase === 'MATCH_END';
    for (const p of view.players) {
      this.statuses.set(p.seat, p.status);
      if (this.isOwnSeat(p.seat)) {
        this.clearRack(p.seat);
        continue;
      }
      if (handOver && p.revealed) this.setRack(p.seat, 'revealed', sortTiles(p.revealed));
      else if (p.status === 'DEAD' || p.status === 'QUANCAN') this.setRack(p.seat, 'dead', new Array(p.handCount).fill(null));
      else this.setRack(p.seat, 'stand', new Array(p.handCount).fill(null));
      this.avatars?.setMood(
        p.seat,
        p.status === 'DEAD' || p.status === 'QUANCAN' ? 'dead' : p.status === 'OUT' ? 'winner' : 'normal',
      );
    }
    for (const seat of [...this.racks.keys()]) if (seat >= this.n) this.clearRack(seat);

    this.setDeadWall(view.phase === 'LOBBY' ? 0 : view.deadWallCount);
    this.placeDice(view.phase !== 'LOBBY' && view.wallBreak ? view.wallBreak.dice : null);
    // melds last: their layout keeps clear of the racks and dead wall placed above
    this.relayoutMelds(false);

    const sequentialPort = view.phase === 'PORT' && view.cfg.portTiming === 'sequential';
    this.setActiveSeat(view.phase === 'PLAY' || sequentialPort ? view.turn : null);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private setPointer(ev: PointerEvent): void {
    const c = this.renderer?.domElement;
    if (!c) return;
    const r = c.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  private onPointerMove = (ev: PointerEvent): void => {
    this.setPointer(ev);
    this.pointerInside = true;
    this.pointerDirty = true;
  };

  private onPointerLeave = (): void => {
    this.pointerInside = false;
    this.pointerDirty = true;
  };

  private onPointerDown = (ev: PointerEvent): void => {
    this.downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const d = this.downAt;
    this.downAt = null;
    if (!d) return;
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 10 || performance.now() - d.t > 800) return;
    this.setPointer(ev);
    const hit = this.pickMeld();
    if (!hit) return;
    const vis = this.melds.get(hit.meldId);
    if (!vis) return;
    let end: MeldPick['end'] = null;
    if (vis.meld.type === 'RUN' && vis.slot) {
      const local = this.table.worldToLocal(hit.point.clone());
      end = local.x < vis.slot.cx ? 'low' : 'high';
    }
    const pick: MeldPick = { meldId: hit.meldId, end };
    for (const cb of this.pickCbs) cb(pick);
  };

  private pickMeld(): { meldId: string; point: THREE.Vector3 } | null {
    if (!this.melds.size) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      [...this.melds.values()].map((v) => v.hit),
      false,
    );
    const h = hits[0];
    if (!h) return null;
    return { meldId: String(h.object.userData.meldId), point: h.point };
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  /** Apply a chosen quality level; also resets the automatic FPS governor. */
  private applyQuality(q: Quality): void {
    this.resScale = 1;
    this.perf.reset(performance.now());
    this.applyRenderSettings(q);
  }

  /** Effective device pixel ratio: quality cap times the governor's resolution scale. */
  private applyPixelRatio(): void {
    const r = this.renderer;
    if (!r) return;
    const dpr = window.devicePixelRatio || 1;
    const q = this.quality;
    const cap = q === 'low' ? 1 : Math.min(dpr, q === 'high' ? 2 : 1.25);
    r.setPixelRatio(Math.max(0.6, cap * this.resScale));
  }

  private applyRenderSettings(q: Quality): void {
    const r = this.renderer;
    if (!r) return;
    this.applyPixelRatio();
    const shadows = q !== 'low' && !this.perf.shadowsOff;
    const tileCast = shadows && q === 'high';
    const changed = r.shadowMap.enabled !== shadows;
    r.shadowMap.enabled = shadows;
    this.env?.setQuality(shadows ? q : 'low');
    this.tiles?.setShadows(shadows, tileCast);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && o.parent === this.table && mesh.geometry !== this.hitGeo) {
        o.castShadow = tileCast;
      }
    });
    for (const t of this.allTiles()) {
      t.body.castShadow = tileCast;
      t.body.receiveShadow = shadows;
    }
    this.avatars?.setSpringBones(q !== 'low' && !this.perf.springOff);
    this.avatars?.setRender({ castShadow: shadows && q === 'high', outlines: q !== 'low' && !this.perf.outlinesOff });
    if (changed) {
      this.scene.traverse((o) => {
        const mats = (o as THREE.Mesh).material;
        if (!mats) return;
        for (const m of Array.isArray(mats) ? mats : [mats]) m.needsUpdate = true;
      });
      // new shader variants: compile in parallel where supported instead of freezing a frame
      this.compiling = true;
      r.compileAsync(this.scene, this.camera)
        .catch(() => undefined)
        .finally(() => {
          this.compiling = false;
        });
    }
    this.resize();
  }

  private allTiles(): Tile3D[] {
    const out: Tile3D[] = [...this.wall, ...this.deadWall];
    for (const v of this.melds.values()) out.push(...v.tiles);
    for (const r of this.racks.values()) out.push(...r.tiles);
    return out;
  }

  private resize(): void {
    const r = this.renderer;
    const c = this.container;
    if (!r || !c) return;
    const w = Math.max(1, c.clientWidth);
    const h = Math.max(1, c.clientHeight);
    r.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Landscape: ~66 degrees of horizontal view from a low, Mahjong-Soul-like angle.
    // Portrait / narrow: widen the fov a little, then go steeper and back far enough that
    // the whole table still fits across the screen (side avatars may be cropped).
    // (the meld layout keeps clear of the racks for these same framings)
    const rig = cameraRig(aspect);
    this.camera.fov = rig.fov;
    this.camera.updateProjectionMatrix();
    this.camLook.copy(rig.look);
    this.camBase.copy(rig.pos);
  }

  private tick(): void {
    const r = this.renderer;
    if (!r) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.elapsed += dt;
    const t = this.elapsed;

    this.env?.update(t);
    this.updateCamera(dt);
    this.avatars?.update(dt, this.camera.position);
    this.confetti?.update(dt);
    this.flashes?.update(dt);

    if (this.pointerDirty) {
      this.pointerDirty = false;
      const hit = this.pointerInside ? this.pickMeld() : null;
      this.hovered = hit ? hit.meldId : null;
      r.domElement.style.cursor = hit ? 'pointer' : '';
    }

    // meld glows: highlighted targets pulse, hover brightens
    for (const vis of this.melds.values()) {
      const hl = this.highlighted.has(vis.meld.id);
      const hov = this.hovered === vis.meld.id;
      const target = (hl ? 0.55 + Math.sin(t * 4.2) * 0.2 : 0) + (hov ? (hl ? 0.35 : 0.22) : 0);
      vis.glowLevel += (target - vis.glowLevel) * (1 - Math.exp(-12 * dt));
      vis.glowMat.opacity = vis.glowLevel;
      vis.glow.visible = vis.glowLevel > 0.01;
    }

    // seat strips: active seat glows, dead seats go grey
    for (const [seat, strip] of this.strips) {
      const mat = strip.material as THREE.MeshBasicMaterial;
      const st = this.statuses.get(seat);
      const dead = st === 'DEAD' || st === 'QUANCAN';
      const active = this.activeSeat === seat;
      mat.color.set(dead ? COLOURS_3D.dead : COLOURS_3D.turn);
      const target = active ? 0.75 + Math.sin(t * 5) * 0.25 : dead ? 0.12 : 0.1;
      mat.opacity += (target - mat.opacity) * (1 - Math.exp(-8 * dt));
    }

    if (!this.compiling) r.render(this.scene, this.camera);
    this.governFps(now);
  }

  /**
   * Automatic quality governor. Measures real frame rate once per second and, when it stays
   * below FPS_FLOOR, first lowers the render resolution step by step, then switches shadows
   * off. It never raises quality on its own (avoids oscillation); choosing a quality in
   * Settings resets it. Optional readout with ?fps in the page URL.
   */
  private governFps(now: number): void {
    const p = this.perf;
    p.frames++;
    const span = now - p.windowStart;
    if (span < 1000) return;
    const fps = (p.frames * 1000) / span;
    p.frames = 0;
    p.windowStart = now;
    if (this.fpsEl && this.renderer) {
      const info = this.renderer.info.render;
      this.fpsEl.textContent = `${fps.toFixed(0)} fps | ${info.calls} calls | ${(info.triangles / 1000).toFixed(0)}k tris | x${this.renderer.getPixelRatio().toFixed(2)}${p.shadowsOff ? ' | no shadows' : ''}${p.outlinesOff ? ' | no outlines' : ''}${p.springOff ? ' | no hair physics' : ''}`;
    }
    // ignore warm-up, hidden tabs, shader compiles and loading hitches
    if (now < p.graceUntil || document.hidden || this.compiling) {
      p.slowSeconds = 0;
      return;
    }
    p.slowSeconds = fps < FPS_FLOOR ? p.slowSeconds + 1 : 0;
    if (p.slowSeconds < 2) return;
    p.slowSeconds = 0;
    p.graceUntil = now + 2500;
    if (this.resScale > 0.7) {
      this.resScale = Math.round((this.resScale - 0.15) * 100) / 100;
      this.applyPixelRatio();
      this.resize();
    } else if (!p.shadowsOff && this.quality !== 'low') {
      p.shadowsOff = true;
      this.applyRenderSettings(this.quality);
    } else if (!p.outlinesOff && this.quality !== 'low') {
      p.outlinesOff = true;
      this.applyRenderSettings(this.quality);
    } else if (!p.springOff && this.quality !== 'low') {
      // hair/cloth physics is the largest remaining CPU cost per avatar
      p.springOff = true;
      this.avatars?.setSpringBones(false);
    }
  }

  private camPos = new THREE.Vector3();
  private camTgt = new THREE.Vector3();

  private updateCamera(dt: number): void {
    const t = this.elapsed;
    this.camPos.copy(this.camBase);
    this.camPos.x += Math.sin(t * 0.23) * 0.012;
    this.camPos.y += Math.sin(t * 0.31) * 0.006;
    this.camTgt.copy(this.camLook);
    const p = this.push.v;
    if (p > 0) {
      this.camPos.lerp(this.pushFocus, 0.32 * p);
      this.camTgt.lerp(this.pushFocus, 0.55 * p);
    }
    if (this.shakeAmp > 0.0001) {
      this.camPos.x += (Math.random() - 0.5) * this.shakeAmp;
      this.camPos.y += (Math.random() - 0.5) * this.shakeAmp;
      this.shakeAmp *= Math.exp(-14 * dt);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTgt);
  }
}

export function createTableScene(): TableSceneApi {
  return new TableScene();
}

/** Tile dimensions, exported for UI overlays that want to align with table tiles. */
export const TABLE_TILE_SIZE = { w: TILE_W, h: TILE_H, d: TILE_D };
