// The draft big levels (keystone-lab drafts.ts) explored on Metal before B1 to
// B4 are authored: each compiles and validates clean on the GPU budget, has the
// roles its design names, and its competent shots can reach what they aim at
// from the launcher ring (a cannonball cannot across a 12-15 m ring; the wrecking
// ball, 15 m/s, misses the top of B1's wall from the far azimuths: 83%).
import { describe, expect, it } from 'vitest';
import { aimAt, compileLevel, type LaunchShot, physicsOf, validateLevel } from '@tb/keystone';
import { competentIntents, DRAFTS, exposedFaces, intentShot, REACH, surfaceTarget, targetFaces } from '../src/index.ts';

describe('draft big levels', () => {
  it.each(Object.keys(DRAFTS))('%s compiles and validates clean on the GPU', (name) => {
    const c = compileLevel(DRAFTS[name]!);
    expect(validateLevel(c, { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    expect(c.def.scoring).toBe('outcome');
  });
  it('sizes and roles: B1 1,000, B2 about 5k with 16 crowns (B2c 4) and 32 heritage, B3 10,000, B4 30 columns', () => {
    const n = (k: string) => compileLevel(DRAFTS[k]!).meta;
    expect(n('B1a').n).toBe(1000);
    expect([n('B2a').n, n('B2a').crowns.length, n('B2a').heritage.length]).toEqual([5184, 16, 32]);
    // B2c: the roof's middle 4 only, on the same tower.
    expect(n('B2c').crowns.length).toBe(4);
    expect(n('B2c').crowns.every((i) => n('B2a').crowns.includes(i))).toBe(true);
    for (const k of ['B3a', 'B3b', 'B3c']) expect(n(k).n).toBe(10_000);
    expect([n('B4a').n, n('B4a').crowns.length]).toEqual([30 * 56, 4]);
  });
  it('B5 Kapla Spire: about 3,000 planks of 1.5 x 0.3 x 0.1 m at h 0.3 m, GPU sleep on (B5c off), launcher 27 m up', () => {
    const at = (k: string) => compileLevel(DRAFTS[k]!);
    expect([at('B5a').meta.n, at('B5b').meta.n, at('B5c').meta.n]).toEqual([2884, 3106, 2884]);
    for (const k of ['B5a', 'B5b', 'B5c']) {
      const c = at(k), half = (c.scene.bodies[0]!.shape as { half: number[] }).half.map((x) => +(2 * x).toFixed(4)).sort((a, b) => a - b);
      expect(half).toEqual([0.1, 0.3, 1.5]);
      expect(c.frame.unit).toBe(0.3);
      expect(c.frame.launcher.y * c.frame.unit).toBeCloseTo(27, 6);
      expect(physicsOf(DRAFTS[k]!).sleep).toBe(k !== 'B5c');
    }
    // B5c differs from B5a only by sleep, which is in the hash.
    expect(at('B5c').hash).not.toBe(at('B5a').hash);
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
  it('on a crowns level the competent player aims at the crown tower; elsewhere at any exposed face', () => {
    const b2 = compileLevel(DRAFTS.B2c!), m = b2.meta, g = b2.frame.unit * b2.frame.pitch;
    const cx = m.crowns.map((i) => m.home[3 * i]!), cz = m.crowns.map((i) => m.home[3 * i + 2]!);
    // The crown tower is 4 x 4; its middle 4 crowns span 2 cells, so its bodies lie within 2 cells of them.
    const nearCrowns = (i: number) => m.home[3 * i]! > Math.min(...cx) - 2.5 * g && m.home[3 * i]! < Math.max(...cx) + 2.5 * g && m.home[3 * i + 2]! > Math.min(...cz) - 2.5 * g && m.home[3 * i + 2]! < Math.max(...cz) + 2.5 * g;
    const faces = targetFaces(b2);
    expect(faces.flat().length).toBeGreaterThan(0);
    expect(faces.flat().every(nearCrowns)).toBe(true);
    for (const line of competentIntents(b2, 16, 1)) for (const it of line) if (it.item !== 'drop') expect(nearCrowns(surfaceTarget(b2, it).body)).toBe(true);
    // A collapse level aims anywhere.
    const b1 = compileLevel(DRAFTS.B1c!);
    expect(targetFaces(b1)).toEqual(exposedFaces(b1));
  });
});
