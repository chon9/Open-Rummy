/**
 * Small deterministic PRNG (mulberry32). State is a single uint32 so it can live
 * inside the serialisable GameState. Hosts seed it from a crypto source.
 */
export function nextRandom(state: number): [value: number, next: number] {
  let t = (state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, next];
}

/** Mutable helper for code that owns a local RNG (bots, tests). */
export class Rng {
  constructor(public state: number) {}
  next(): number {
    const [v, n] = nextRandom(this.state);
    this.state = n;
    return v;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** Cryptographically strong 32-bit seed (works in browsers and Node >= 19). */
export function cryptoSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] >>> 0;
}
