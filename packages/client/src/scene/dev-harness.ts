/**
 * Throwaway dev harness for the 3D table (open /scene-dev.html with `vite`).
 * Mounts the scene with a fake PlayerView and plays a scripted hand.
 * Not part of the game bundle.
 */
import { DEFAULT_RULES, type GameEvent, type HandResult, type Meld, type PlayerStatus, type PlayerView } from '@open-rummy/shared';
import { createTableScene } from './table';
import type { Quality, Reaction } from './api';
import { AVATARS } from '../avatars/catalog';
import { AvatarStage, renderAvatarPortrait } from '../avatars/portrait';
import { tileArt } from '../art/tileArt';

const stage = document.getElementById('stage') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;
const portraitBox = document.getElementById('portrait') as HTMLElement;
const stageBox = document.getElementById('stageBox') as HTMLElement;

const params = new URLSearchParams(location.search);
const quality = (params.get('q') as Quality | null) ?? 'medium';
const YOU = 0;
/** ?n=3|4|5 picks the player count (default 4) */
const N = Math.min(5, Math.max(3, Number(params.get('n')) || 4));
const SEATS = Array.from({ length: N }, (_, i) => i);
const AV = ['mei', 'kaya', 'pandan', 'lingling', 'rambutan'].slice(0, N);

const scene = createTableScene();
const log = (s: string): void => {
  logEl.textContent = s;
  console.log('[harness]', s);
};

// --- fake game model ---------------------------------------------------------
const counts = SEATS.map(() => 0);
const status: PlayerStatus[] = SEATS.map(() => 'ALIVE');
let melds: Meld[] = [];
let phase: PlayerView['phase'] = 'LOBBY';
let turn: number | null = null;
let deadWall = 0;
let revealed: (string[] | null)[] = SEATS.map(() => null);
let version = 0;

function run(id: string, owner: number, colour: 'B' | 'R' | 'Y' | 'G', tiles: [string, number][]): Meld {
  return { id, type: 'RUN', ownerSeat: owner, colour, tiles: tiles.map(([tileId, rank]) => ({ tileId, rep: { colour, rank } })) };
}
function set(id: string, owner: number, rank: 9, tiles: string[]): Meld {
  return { id, type: 'SET', ownerSeat: owner, rank, tiles: tiles.map((tileId) => ({ tileId, rep: { colour: null, rank } })) };
}

const RANK_CODE: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const COLS = ['B', 'R', 'Y', 'G'] as const;
/** 4 x 14-tile runs, 6 runs of 8, 6 sets of 6 (only the first `limit` melds). */
function worstCaseMelds(limit: number): Meld[] {
  const out: Meld[] = [];
  let k = 0;
  const id = (c: string, r: number): string => `${c}${RANK_CODE[r] ?? r}_${(k++ % 2) + 1}`;
  COLS.forEach((c, i) => out.push(run(`w${i + 1}`, i % N, c, Array.from({ length: 14 }, (_, j) => [id(c, j + 1), j + 1] as [string, number]))));
  for (let i = 0; i < 6; i++) {
    const c = COLS[i % 4];
    const lo = 2 + (i % 3);
    out.push(run(`w${5 + i}`, i % N, c, Array.from({ length: 8 }, (_, j) => [id(c, lo + j), lo + j] as [string, number])));
  }
  for (let i = 0; i < 6; i++) {
    const rank = 2 + i;
    const tiles = Array.from({ length: 6 }, (_, j) => `${COLS[j % 4]}${rank}_${(j >> 2) + 1}`);
    out.push({ id: `w${11 + i}`, type: 'SET', ownerSeat: i % N, rank: rank as 9, tiles: tiles.map((tileId) => ({ tileId, rep: { colour: null, rank } })) });
  }
  return out.slice(0, limit);
}

function view(): PlayerView {
  version++;
  return {
    you: YOU,
    cfg: { ...DEFAULT_RULES, players: N },
    phase,
    handNo: 1,
    dealer: 0,
    firstSeat: 1,
    wallBreak: phase === 'LOBBY' ? null : { dice: [3, 5], wallSeat: 0, stack: 7 },
    turn,
    deadline: null,
    players: SEATS.map((seat) => ({
      seat,
      name: `P${seat}`,
      isBot: seat !== YOU,
      avatar: AV[seat],
      status: status[seat],
      handCount: counts[seat],
      ported: phase !== 'PORT',
      portSubmitted: false,
      chips: 1000,
      totalPoints: 0,
      connected: true,
      revealed: revealed[seat],
    })),
    melds: melds.map((m) => ({ ...m, tiles: m.tiles.map((t) => ({ ...t, rep: { ...t.rep } })) })),
    deadWallCount: deadWall,
    hand: [],
    pendingPort: null,
    instantOffer: null,
    legal: null,
    lastResult: null,
    standings: null,
    version,
  };
}

async function play(events: GameEvent[]): Promise<void> {
  const t0 = performance.now();
  await scene.playEvents(events, view());
  log(`${events.map((e) => e.type).join(', ')} -> ${Math.round(performance.now() - t0)} ms`);
}

// --- script ------------------------------------------------------------------
const steps: Record<string, () => Promise<void>> = {
  async deal() {
    phase = 'PORT';
    counts.fill(20);
    status.fill('ALIVE');
    revealed = SEATS.map(() => null);
    melds = [];
    deadWall = 112 - 20 * N;
    turn = null;
    await play([
      { type: 'HAND_START', handNo: 1, dealer: 0, wallBreak: { dice: [3, 5], wallSeat: 0, stack: 7 }, firstSeat: 1 },
      ...SEATS.slice(1).map((seat) => ({ type: 'DEAL' as const, seat, count: 20 })),
      { type: 'DEAL', seat: 0, count: 20 },
    ]);
  },
  async port() {
    const created = [
      run('m1', 0, 'R', [['R3_1', 3], ['R4_1', 4], ['R5_2', 5]]),
      run('m2', 0, 'B', [['B9_1', 9], ['B10_1', 10], ['BJ_1', 11]]),
      run('m3', 1, 'Y', [['Y5_1', 5], ['Y6_1', 6], ['Y7_2', 7], ['Y8_1', 8]]),
      run('m4', 2, 'G', [['G2_1', 2], ['G3_1', 3], ['JK_7', 4]]),
      run('m5', 2, 'R', [['RQ_1', 12], ['RK_2', 13], ['RA_1', 14]]),
      run('m6', 3, 'B', [['B2_1', 2], ['B3_2', 3], ['B4_1', 4], ['B5_1', 5]]),
    ];
    melds = created;
    counts[0] = 14;
    counts[1] = 16;
    counts[2] = 14;
    counts[3] = 16;
    phase = 'PLAY';
    turn = 1;
    await play([
      { type: 'PORT_SUBMITTED', seat: 1 },
      { type: 'PORT_SUBMITTED', seat: 2 },
      { type: 'PORT_SUBMITTED', seat: 3 },
      {
        type: 'PORT_REVEAL',
        ports: [
          { seat: 0, meldIds: ['m1', 'm2'] },
          { seat: 1, meldIds: ['m3'] },
          { seat: 2, meldIds: ['m4', 'm5'] },
          { seat: 3, meldIds: ['m6'] },
        ],
      },
      ...created.map((m) => ({ type: 'MELD_CREATED' as const, seat: m.ownerSeat, meld: m, via: 'PORT' as const })),
      { type: 'TURN', seat: 1, deadline: null },
    ]);
  },
  async extend() {
    const m = melds.find((x) => x.id === 'm1');
    if (!m) return;
    const low = [{ tileId: 'R2_1', rep: { colour: 'R' as const, rank: 2 } }];
    const high = [
      { tileId: 'R6_1', rep: { colour: 'R' as const, rank: 6 } },
      { tileId: 'R7_1', rep: { colour: 'R' as const, rank: 7 } },
    ];
    m.tiles = [...low, ...m.tiles, ...high];
    counts[1] -= 3;
    turn = 2;
    await play([
      { type: 'MELD_EXTENDED', seat: 1, meldId: 'm1', low, high },
      { type: 'TURN', seat: 2, deadline: null },
    ]);
  },
  async cut() {
    const m = set('m7', 2, 9, ['Y9_1', 'G9_1', 'R9_1']);
    melds.push(m);
    counts[2] -= 3;
    turn = 3;
    await play([
      { type: 'MELD_CREATED', seat: 2, meld: m, via: 'CUT' },
      { type: 'TURN', seat: 3, deadline: null },
    ]);
  },
  async follow() {
    const m = melds.find((x) => x.id === 'm7');
    if (!m) return;
    const added = [{ tileId: 'B9_2', rep: { colour: null, rank: 9 } }];
    m.tiles.push(...added);
    counts[3] -= 1;
    turn = 0;
    await play([
      { type: 'SET_FOLLOWED', seat: 3, meldId: 'm7', added },
      { type: 'TURN', seat: 0, deadline: null },
    ]);
  },
  async own() {
    const m = melds.find((x) => x.id === 'm6');
    if (!m) return;
    const high = [{ tileId: 'B6_1', rep: { colour: 'B' as const, rank: 6 } }];
    m.tiles.push(...high);
    counts[0] -= 1;
    turn = 1;
    await play([
      { type: 'MELD_EXTENDED', seat: 0, meldId: 'm6', low: [], high },
      { type: 'TURN', seat: 1, deadline: null },
    ]);
  },
  async swap() {
    const m = melds.find((x) => x.id === 'm4');
    if (!m) return;
    const i = m.tiles.findIndex((t) => t.tileId === 'JK_7');
    if (i >= 0) m.tiles[i] = { tileId: 'G4_1', rep: m.tiles[i].rep };
    const m3 = melds.find((x) => x.id === 'm3');
    const high = [{ tileId: 'Y9_2', rep: { colour: 'Y' as const, rank: 9 } }];
    if (m3) m3.tiles.push(...high);
    counts[1] -= 1;
    turn = 2;
    await play([
      { type: 'JOKER_SWAPPED', seat: 1, meldId: 'm4', jokerTileId: 'JK_7', withTileId: 'G4_1' },
      { type: 'MELD_EXTENDED', seat: 1, meldId: 'm3', low: [], high },
      { type: 'TURN', seat: 2, deadline: null },
    ]);
  },
  async dead() {
    status[2] = 'DEAD';
    turn = 3;
    await play([
      { type: 'PLAYER_DEAD', seat: 2, reason: 'NO_MOVE' },
      { type: 'TURN', seat: 3, deadline: null },
    ]);
  },
  async game() {
    counts[1] = 0;
    status[1] = 'OUT';
    phase = 'HAND_END';
    turn = null;
    const hands: Record<number, string[]> = {
      0: ['R8_1', 'R9_2', 'BQ_1', 'BK_1', 'G7_1', 'G8_2', 'Y2_1', 'Y3_1', 'JK_1', 'GA_1', 'B7_2', 'R10_2', 'YJ_1'],
      1: [],
      2: ['BA_1', 'B8_1', 'G10_1', 'GJ_2', 'GQ_1', 'Y4_2', 'YQ_1', 'R6_2', 'JK_3', 'B10_2', 'GK_1'],
      3: ['G5_1', 'G6_1', 'Y10_1', 'YK_1', 'R2_2', 'R3_2', 'BJ_2', 'B5_2', 'JK_5', 'Y5_2', 'G2_2', 'YA_2', 'R4_2', 'B3_1', 'RJ_1'],
    };
    revealed = SEATS.map((seat) => hands[seat] ?? []);
    const result: HandResult = {
      handNo: 1,
      kind: 'GAME',
      winnerSeat: 1,
      rankings: [
        { seat: 1, rank: 1, title: 'WINNER', points: 0, tiles: [], chipsDelta: 720, status: 'OUT' },
        { seat: 0, rank: 2, title: 'XIAOGE', points: 100, tiles: hands[0], chipsDelta: -240, status: 'ALIVE' },
        { seat: 2, rank: 3, title: 'ERGE', points: 120, tiles: hands[2], chipsDelta: -240, status: 'DEAD' },
        { seat: 3, rank: 4, title: 'DAGE', points: 140, tiles: hands[3], chipsDelta: -240, status: 'ALIVE' },
      ],
    };
    await play([
      { type: 'GAME_PAI', seat: 1 },
      { type: 'HAND_END', result },
    ]);
  },
  /**
   * Late hand: a worst-case table (4 x 14-tile runs, 6 runs of 8, 6 sets of 6) snapped in
   * with sync(). ?racks=<count> sets the opponents' hand size (default 6).
   */
  async late() {
    phase = 'PLAY';
    deadWall = 112 - 20 * N;
    revealed = SEATS.map(() => null);
    status.fill('ALIVE');
    const rk = Number(params.get('racks')) || 6;
    for (const s of SEATS) counts[s] = s === YOU ? 4 : rk;
    melds = worstCaseMelds(Number(params.get('melds')) || 16);
    turn = 1;
    scene.sync(view());
    log(`late: ${melds.length} melds, ${melds.reduce((a, m) => a + m.tiles.length, 0)} tiles`);
  },
  async all() {
    for (const k of ['deal', 'port', 'extend', 'cut', 'follow', 'own', 'swap', 'dead', 'game']) {
      await steps[k]();
      await new Promise((r) => setTimeout(r, 250));
    }
  },
  async rapid() {
    // fire several batches without awaiting: the scene must queue and speed up
    await steps.deal();
    const p: Promise<void>[] = [];
    for (const k of ['port', 'extend', 'cut', 'follow', 'own']) p.push(steps[k]());
    await Promise.all(p);
    log('rapid done');
  },
  async reactions() {
    const list: Reaction[] = ['wave', 'happy', 'think', 'surprised', 'sad', 'angry', 'laugh', 'cheer', 'cry', 'lose', 'play', 'win'];
    for (const r of list) {
      log(`reaction: ${r}`);
      for (const s of [1, 2, 3]) scene.react(s, r);
      await new Promise((res) => setTimeout(res, 1600));
    }
  },
  async highlight() {
    scene.highlightMelds(melds.filter((m) => m.type === 'RUN').map((m) => m.id));
  },
  async sync() {
    scene.sync(view());
  },
};

function button(label: string, fn: () => void | Promise<void>): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => void fn();
  panel.appendChild(b);
}

async function main(): Promise<void> {
  const t0 = performance.now();
  await scene.mount(stage, { quality, onProgress: (p) => log(`progress ${Math.round(p * 100)}%`) });
  scene.onMeldPick((pick) => log(`picked ${pick.meldId} end=${pick.end}`));
  await scene.setSeats(
    AV.map((avatarId, seat) => ({ seat, avatarId, name: `P${seat}` })),
    YOU,
  );
  log(`mounted + avatars in ${Math.round(performance.now() - t0)} ms`);
  scene.sync(view());
  for (const k of Object.keys(steps)) button(k, steps[k]);
  for (const q of ['low', 'medium', 'high'] as Quality[]) button(`q:${q}`, () => scene.setQuality(q));
  button('dispose', () => scene.dispose());

  // tile art + portraits preview
  const img = document.createElement('img');
  img.src = tileArt.faceUrl('JK_3');
  img.style.cssText = 'width:36px;height:48px;border-radius:0';
  portraitBox.appendChild(img);
  for (const def of AVATARS) {
    const p = document.createElement('img');
    p.title = def.nameEn;
    portraitBox.appendChild(p);
    renderAvatarPortrait(def.id, 144)
      .then((url) => {
        p.src = url;
      })
      .catch((e: unknown) => console.warn(e));
  }
  if (params.get('stage') !== '0') {
    const st = new AvatarStage(stageBox, { quality });
    void st.setAvatar('rambutan');
    (window as unknown as Record<string, unknown>).__stage = st;
  }
  (window as unknown as Record<string, unknown>).__harness = { scene, steps, view };
  const auto = params.get('auto');
  if (auto) void (steps[auto] ?? steps.all)();
  // ?ui=0 hides the harness chrome (clean screenshots)
  if (params.get('ui') === '0') for (const el of [panel, logEl, portraitBox, stageBox]) el.style.display = 'none';
}

void main();
