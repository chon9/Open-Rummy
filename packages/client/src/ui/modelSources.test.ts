import { describe, expect, it } from 'vitest';
import { AVATARS } from '../avatars/catalog';
import { MODEL_SOURCES } from './modelSources';

describe('credits model sources', () => {
  it('names the source model of every bundled character', () => {
    for (const a of AVATARS) expect(a.credit || MODEL_SOURCES[a.id], a.id).toBeTruthy();
  });

  it('no longer credits removed models (VirtualCast / Seed-san)', () => {
    const all = [...Object.values(MODEL_SOURCES), ...AVATARS.map((a) => a.credit)].join(' ');
    expect(all).not.toMatch(/VirtualCast|Seed-san/i);
    expect(MODEL_SOURCES.pandan).toMatch(/AvatarSample_E/);
  });
});
