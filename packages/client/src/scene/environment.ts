/**
 * Static set dressing: warm room, lanterns, the table (felt + wooden rim), chairs, lights.
 * Everything is procedural (canvas textures), no external assets.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Quality } from './api';
import { COLOURS_3D, RIM_HEIGHT, RIM_WIDTH, TABLE_HALF, TABLE_Y } from './constants';

function canvasTexture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) paint(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Deterministic pseudo-random for texture noise (stable across reloads). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feltTexture(): THREE.CanvasTexture {
  return canvasTexture(1024, 1024, (ctx) => {
    const rnd = prng(7);
    const g = ctx.createRadialGradient(512, 512, 60, 512, 512, 720);
    g.addColorStop(0, '#16786c');
    g.addColorStop(0.55, COLOURS_3D.felt);
    g.addColorStop(1, COLOURS_3D.feltDeep);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);
    // felt fibres
    for (let i = 0; i < 26000; i++) {
      const x = rnd() * 1024;
      const y = rnd() * 1024;
      const a = rnd() * 0.06;
      ctx.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`;
      ctx.fillRect(x, y, 1 + rnd() * 2, 1);
    }
    // inset gold pin-stripe
    ctx.strokeStyle = 'rgba(243,196,97,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(46, 46, 932, 932);
    ctx.strokeStyle = 'rgba(243,196,97,0.25)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(60, 60, 904, 904);
    // corner flourishes
    ctx.fillStyle = 'rgba(243,196,97,0.45)';
    for (const [cx, cy] of [
      [46, 46],
      [978, 46],
      [46, 978],
      [978, 978],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 14);
      ctx.lineTo(cx + 14, cy);
      ctx.lineTo(cx, cy + 14);
      ctx.lineTo(cx - 14, cy);
      ctx.closePath();
      ctx.fill();
    }
    // faint centre medallion (melds sit on it)
    ctx.save();
    ctx.translate(512, 512);
    ctx.strokeStyle = 'rgba(255,230,170,0.07)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, 230, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 250, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,230,170,0.06)';
    ctx.font = '700 170px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('拉米', 0, 6);
    ctx.restore();
  });
}

function woodTexture(seed: number, base: string, dark: string): THREE.CanvasTexture {
  const tex = canvasTexture(512, 128, (ctx) => {
    const rnd = prng(seed);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 70; i++) {
      const y = rnd() * 128;
      ctx.strokeStyle = rnd() < 0.5 ? dark : 'rgba(255,220,180,0.08)';
      ctx.globalAlpha = 0.15 + rnd() * 0.35;
      ctx.lineWidth = 0.5 + rnd() * 2.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 3 * rnd());
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function floorTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(1024, 1024, (ctx) => {
    const rnd = prng(11);
    const plankH = 64;
    for (let row = 0; row < 1024 / plankH; row++) {
      let x = -rnd() * 300;
      while (x < 1024) {
        const len = 260 + rnd() * 260;
        const l = 22 + rnd() * 10;
        ctx.fillStyle = `hsl(${18 + rnd() * 8}, ${38 + rnd() * 10}%, ${l}%)`;
        ctx.fillRect(x, row * plankH, len, plankH);
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, row * plankH, len, plankH);
        for (let k = 0; k < 6; k++) {
          ctx.strokeStyle = 'rgba(0,0,0,0.12)';
          ctx.lineWidth = 1;
          const yy = row * plankH + 6 + rnd() * (plankH - 12);
          ctx.beginPath();
          ctx.moveTo(x, yy);
          ctx.lineTo(x + len, yy + (rnd() - 0.5) * 4);
          ctx.stroke();
        }
        x += len;
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

function backdropTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 512, (ctx) => {
    const g = ctx.createLinearGradient(0, 512, 0, 0);
    g.addColorStop(0, '#1a0e0a');
    g.addColorStop(0.25, '#3b1d14');
    g.addColorStop(0.5, '#5a2c1c');
    g.addColorStop(0.75, '#3a1a12');
    g.addColorStop(1, '#140a08');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 512);
  });
}

/** Peranakan-style lattice window with warm light behind. */
function windowTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 384, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 384);
    g.addColorStop(0, '#ffd99a');
    g.addColorStop(1, '#ff9a4a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 384);
    ctx.strokeStyle = '#3a1a0e';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 246, 374);
    ctx.lineWidth = 6;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((256 / 4) * i, 0);
      ctx.lineTo((256 / 4) * i, 384);
      ctx.stroke();
    }
    for (let j = 1; j < 6; j++) {
      ctx.beginPath();
      ctx.moveTo(0, (384 / 6) * j);
      ctx.lineTo(256, (384 / 6) * j);
      ctx.stroke();
    }
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 6; j++) {
        const cx = 32 + i * 64;
        const cy = 32 + j * 64;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 18);
        ctx.lineTo(cx + 18, cy);
        ctx.lineTo(cx, cy + 18);
        ctx.lineTo(cx - 18, cy);
        ctx.closePath();
        ctx.stroke();
      }
    }
  });
}

export function glowTexture(inner = 'rgba(255,220,150,1)', outer = 'rgba(255,160,60,0)'): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.45)'));
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

function makeLantern(tex: THREE.Texture, red: THREE.Material, gold: THREE.Material, scale: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14), red);
  body.scale.set(1, 0.82, 1);
  g.add(body);
  const capGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.05, 16);
  const top = new THREE.Mesh(capGeo, gold);
  top.position.y = 0.185;
  g.add(top);
  const bottom = new THREE.Mesh(capGeo, gold);
  bottom.position.y = -0.185;
  g.add(bottom);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 3, 4), gold);
  cord.position.y = 1.7;
  g.add(cord);
  const tassel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.04, 0.22, 8), red);
  tassel.position.y = -0.32;
  g.add(tassel);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, color: 0xff7a4a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }),
  );
  halo.scale.setScalar(1.3);
  g.add(halo);
  g.scale.setScalar(scale);
  return g;
}

export interface Environment {
  root: THREE.Group;
  keyLight: THREE.DirectionalLight;
  lanterns: THREE.Group[];
  update(t: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export function buildEnvironment(scene: THREE.Scene): Environment {
  const root = new THREE.Group();
  root.name = 'environment';
  scene.add(root);
  scene.background = new THREE.Color(COLOURS_3D.background);
  scene.fog = new THREE.Fog(COLOURS_3D.background, 5.5, 12);

  // --- lights ---------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xffe2c0, 0x2a1810, 1.25);
  root.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.3);
  key.position.set(0.9, 3.0, 1.5);
  key.target.position.set(0, TABLE_Y, 0);
  root.add(key);
  root.add(key.target);
  key.shadow.camera.left = -1.15;
  key.shadow.camera.right = 1.15;
  key.shadow.camera.top = 1.15;
  key.shadow.camera.bottom = -1.15;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 6;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  const rim = new THREE.DirectionalLight(0xffc7a0, 1.3);
  rim.position.set(-0.6, 2.4, -2.6);
  root.add(rim);
  const fill = new THREE.DirectionalLight(0xffe6d0, 0.45);
  fill.position.set(-1.5, 1.4, 2.5);
  root.add(fill);
  // warm pool of light over the felt
  const pool = new THREE.SpotLight(0xffd9a0, 1.6, 0, 0.62, 0.85, 0);
  pool.position.set(0, 2.6, 0.1);
  pool.target.position.set(0, TABLE_Y, 0);
  root.add(pool);
  root.add(pool.target);

  // --- room -------------------------------------------------------------------
  const backdropTex = backdropTexture();
  const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(7, 7, 6, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: backdropTex, side: THREE.BackSide, fog: false }),
  );
  backdrop.position.y = 2.6;
  root.add(backdrop);

  const floorTex = floorTexture();
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(7, 48),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.75, metalness: 0, envMapIntensity: 0.3 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // round rug under the table
  const rugTex = canvasTexture(512, 512, (ctx) => {
    const g = ctx.createRadialGradient(256, 256, 40, 256, 256, 256);
    g.addColorStop(0, '#8c2a22');
    g.addColorStop(0.8, '#6e1e18');
    g.addColorStop(0.86, '#d8a24a');
    g.addColorStop(0.9, '#6e1e18');
    g.addColorStop(1, '#4a120e');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(256, 256, 255, 0, Math.PI * 2);
    ctx.fill();
  });
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(1.9, 64),
    new THREE.MeshStandardMaterial({ map: rugTex, roughness: 0.95, metalness: 0, envMapIntensity: 0.1 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.004;
  rug.receiveShadow = true;
  root.add(rug);

  // windows and lanterns behind the far seats
  const winTex = windowTexture();
  const winMat = new THREE.MeshBasicMaterial({ map: winTex, fog: false });
  for (const a of [-0.75, 0.75]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.1), winMat);
    const ang = Math.PI + a;
    w.position.set(Math.sin(ang) * 6.6, 2.3, Math.cos(ang) * 6.6);
    w.lookAt(0, 2.3, 0);
    root.add(w);
  }
  const glowTex = glowTexture();
  const red = new THREE.MeshStandardMaterial({ color: 0xc81e1e, emissive: 0xff3a24, emissiveIntensity: 0.9, roughness: 0.6 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd9a443, metalness: 0.6, roughness: 0.35, emissive: 0x3a2400 });
  const lanterns: THREE.Group[] = [];
  const lanternSpots: [number, number, number, number][] = [
    [-1.9, 2.55, -2.6, 1.0],
    [1.8, 2.7, -2.9, 1.1],
    [0.2, 3.0, -4.2, 1.2],
    [-3.2, 2.9, -1.0, 1.2],
    [3.3, 2.8, -0.6, 1.2],
  ];
  for (const [x, y, z, s] of lanternSpots) {
    const l = makeLantern(glowTex, red, gold, s);
    l.position.set(x, y, z);
    root.add(l);
    lanterns.push(l);
  }

  // --- table --------------------------------------------------------------------
  const feltTex = feltTexture();
  feltTex.anisotropy = 4;
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE_HALF * 2, TABLE_HALF * 2),
    new THREE.MeshStandardMaterial({ map: feltTex, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 }),
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = TABLE_Y;
  felt.receiveShadow = true;
  root.add(felt);

  const woodTex = woodTexture(3, '#5a2e1a', 'rgba(30,10,4,0.9)');
  const wood = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.38, metalness: 0.05, envMapIntensity: 0.8 });
  const rimLen = TABLE_HALF * 2 + RIM_WIDTH * 2;
  const rimGeoLong = new RoundedBoxGeometry(rimLen, RIM_HEIGHT + 0.03, RIM_WIDTH, 3, 0.012);
  for (let k = 0; k < 4; k++) {
    const bar = new THREE.Mesh(rimGeoLong, wood);
    const a = (k * Math.PI) / 2;
    const r = TABLE_HALF + RIM_WIDTH / 2;
    bar.position.set(Math.sin(a) * r, TABLE_Y + RIM_HEIGHT / 2 - 0.015, Math.cos(a) * r);
    bar.rotation.y = a;
    bar.castShadow = true;
    bar.receiveShadow = true;
    root.add(bar);
  }
  // brass inlay strip on the rim top
  const brass = new THREE.MeshStandardMaterial({ color: 0xc89b4a, metalness: 0.8, roughness: 0.3, envMapIntensity: 1 });
  const inlayGeo = new THREE.BoxGeometry(rimLen - 0.04, 0.002, 0.006);
  for (let k = 0; k < 4; k++) {
    const s = new THREE.Mesh(inlayGeo, brass);
    const a = (k * Math.PI) / 2;
    const r = TABLE_HALF + RIM_WIDTH / 2;
    s.position.set(Math.sin(a) * r, TABLE_Y + RIM_HEIGHT + 0.0, Math.cos(a) * r);
    s.rotation.y = a;
    root.add(s);
  }
  // table body and legs
  const bodyMat = new THREE.MeshStandardMaterial({ map: woodTex, color: 0x9a7060, roughness: 0.5, metalness: 0.05 });
  const tableBody = new THREE.Mesh(new RoundedBoxGeometry(rimLen - 0.02, 0.09, rimLen - 0.02, 2, 0.02), bodyMat);
  tableBody.position.y = TABLE_Y - 0.06;
  tableBody.castShadow = true;
  root.add(tableBody);
  const legGeo = new THREE.CylinderGeometry(0.035, 0.028, TABLE_Y - 0.1, 12);
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.set(sx * (TABLE_HALF - 0.04), (TABLE_Y - 0.1) / 2, sz * (TABLE_HALF - 0.04));
    leg.castShadow = true;
    root.add(leg);
  }

  // soft contact shadow under the table (works even with shadows off)
  const contactTex = glowTexture('rgba(0,0,0,0.6)', 'rgba(0,0,0,0)');
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.006;
  root.add(contact);

  const env: Environment = {
    root,
    keyLight: key,
    lanterns,
    update(t: number) {
      lanterns.forEach((l, i) => {
        l.rotation.z = Math.sin(t * 0.6 + i * 1.7) * 0.03;
        l.rotation.x = Math.sin(t * 0.45 + i) * 0.02;
      });
    },
    setQuality(q: Quality) {
      key.castShadow = q !== 'low';
      const size = q === 'high' ? 2048 : 1024;
      if (key.shadow.mapSize.x !== size) {
        key.shadow.mapSize.set(size, size);
        key.shadow.map?.dispose();
        key.shadow.map = null;
      }
    },
    dispose() {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
        for (const m of mats) {
          const mm = m as THREE.MeshStandardMaterial;
          mm.map?.dispose();
          mm.dispose();
        }
      });
      key.shadow.map?.dispose();
      root.removeFromParent();
    },
  };
  return env;
}
