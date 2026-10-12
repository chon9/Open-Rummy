/**
 * Synthesized sound effects (WebAudio, no audio files). The AudioContext is created
 * (and resumed) only from inside a user gesture (pointerdown / keydown / touchstart),
 * so browsers never log autoplay-policy warnings on load. Sounds requested before the
 * first gesture are silently skipped.
 */
import { getPrefs } from './prefs';

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;

/** Create or resume the context; must run inside a user gesture handler. */
function unlock(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) {
        removeGestureListeners();
        return;
      }
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    // stay subscribed: a context suspended later (mobile interruption) resumes on the next gesture
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err: unknown) => console.debug('[sound] resume failed', err));
    }
  } catch (err) {
    console.debug('[sound] audio unavailable', err);
    removeGestureListeners();
  }
}

function removeGestureListeners(): void {
  for (const ev of GESTURES) window.removeEventListener(ev, unlock, true);
}

if (typeof window !== 'undefined') {
  for (const ev of GESTURES) window.addEventListener(ev, unlock, { capture: true, passive: true });
}

function audio(): { ctx: Ctx; out: GainNode } | null {
  const p = getPrefs();
  if (!p.sound || !ctx || !master || ctx.state !== 'running') return null;
  master.gain.value = 0.5 * p.volume;
  return { ctx, out: master };
}

function noise(c: Ctx): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const len = Math.floor(c.sampleRate * 0.25);
  noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** One enveloped oscillator note. */
function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.3): void {
  const a = audio();
  if (!a) return;
  const t0 = a.ctx.currentTime + start;
  const osc = a.ctx.createOscillator();
  const g = a.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Short filtered noise burst: the "clack" of a tile. */
function clack(start = 0, pitch = 2400, gain = 0.5): void {
  const a = audio();
  if (!a) return;
  const t0 = a.ctx.currentTime + start;
  const src = a.ctx.createBufferSource();
  src.buffer = noise(a.ctx);
  const bp = a.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = pitch;
  bp.Q.value = 3;
  const g = a.ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
  src.connect(bp).connect(g).connect(a.out);
  src.start(t0);
  src.stop(t0 + 0.1);
  tone(pitch / 3, start, 0.05, 'triangle', gain * 0.25);
}

export const sound = {
  click(): void {
    tone(880, 0, 0.06, 'triangle', 0.12);
  },
  select(): void {
    clack(0, 3000, 0.35);
  },
  deselect(): void {
    clack(0, 2000, 0.25);
  },
  tile(): void {
    clack(0, 2400, 0.55);
    clack(0.05, 1900, 0.3);
  },
  deal(): void {
    for (let i = 0; i < 4; i++) clack(i * 0.06, 2200 + i * 80, 0.3);
  },
  turn(): void {
    tone(659, 0, 0.18, 'sine', 0.2);
    tone(988, 0.1, 0.25, 'sine', 0.18);
  },
  tick(): void {
    tone(1320, 0, 0.04, 'square', 0.05);
  },
  chime(): void {
    [784, 988, 1175].forEach((f, i) => tone(f, i * 0.08, 0.5, 'sine', 0.16));
  },
  win(): void {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.1, 0.7, 'triangle', 0.18));
    [1047, 1568].forEach((f, i) => tone(f, 0.55 + i * 0.12, 0.9, 'sine', 0.12));
  },
  sad(): void {
    [440, 392, 330].forEach((f, i) => tone(f, i * 0.16, 0.4, 'sine', 0.14));
  },
  error(): void {
    tone(220, 0, 0.12, 'square', 0.08);
    tone(180, 0.1, 0.16, 'square', 0.08);
  },
  pop(): void {
    tone(600, 0, 0.08, 'sine', 0.15);
    tone(900, 0.04, 0.08, 'sine', 0.12);
  },
};
