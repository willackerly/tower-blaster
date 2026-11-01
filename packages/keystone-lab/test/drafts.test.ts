// The draft big levels (keystone-lab drafts.ts) explored on Metal before B1 to
// B4 are authored: each compiles and validates clean on the GPU budget, has the
// roles its design names, and its competent shots can reach what they aim at
// from the launcher ring (a cannonball cannot across a 12-15 m ring; the wrecking
// ball, 15 m/s, misses the top of B1's wall from the far azimuths: 83%).
import { describe, expect, it } from 'vitest';
import { aimAt, compileLevel, type LaunchShot, validateLevel } from '@tb/keystone';
import { competentIntents, DRAFTS, intentShot, REACH, surfaceTarget } from '../src/index.ts';

describe('draft big levels', () => {
  it.each(Object.keys(DRAFTS))('%s compiles and validates clean on the GPU', (name) => {
    const c = compileLevel(DRAFTS[name]!);
    expect(validateLevel(c, { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    expect(c.def.scoring).toBe('outcome');
  });
  it('sizes and roles: B1 1,000, B2 about 5k with 16 crowns and 32 heritage, B3 10,000, B4 30 columns', () => {
    const n = (k: string) => compileLevel(DRAFTS[k]!).meta;
    expect(n('B1a').n).toBe(1000);
    expect([n('B2a').n, n('B2a').crowns.length, n('B2a').heritage.length]).toEqual([5184, 16, 32]);
    for (const k of ['B3a', 'B3b', 'B3c']) expect(n(k).n).toBe(10_000);
    expect([n('B4a').n, n('B4a').crowns.length]).toEqual([30 * 56, 4]);
  });
  it.each(Object.keys(DRAFTS))('%s: at least 80% of competent launch shots reach their target', (name) => {
    const c = compileLevel(DRAFTS[name]!);
    let launched = 0, reached = 0;
    for (const line of competentIntents(c, 16, 1)) for (const it of line) {
      if (it.item === 'drop') continue;
      const shot = intentShot(c, it, 1) as LaunchShot;
      launched++;
      if (aimAt(c.frame, shot.ammo, { az: shot.az, y: shot.y, power: shot.power }, surfaceTarget(c, it).point).error <= REACH * c.frame.unit) reached++;
    }
    expect(reached / launched).toBeGreaterThanOrEqual(0.8);
  });
});
