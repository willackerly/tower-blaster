// validateLevel at scale (docs/game/spectacle-mode.md, G2.4): a grid instead of
// the sweep and the all-pairs support pass, the same issues as before on every
// level the old one could judge, a 10k city in well under 2 s, and the new
// budget checks (count per engine, watched bodies, nothing to bring down).
import { describe, expect, it } from 'vitest';
import { compileLevel, ENGINE_MAX_BODIES, type Issue, type LevelDef, LEVELS, MATERIALS, MAX_WATCHED, type Part, ROLES, validateLevel } from '@tb/keystone';
import { validateLevelRef } from './validate-ref.ts';

/** mulberry32, seeded: the same draws everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const base: Omit<LevelDef, 'parts'> = {
  id: 'V', name: 'v', version: 1, world: 0, lot: { min: [-6, -6], max: [6, 6] }, crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'cannonball'], launcher: { radius: 12, y: 1, dropY: 12 },
};

/**
 * A small random level that trips every structural check now and then: stacked and floating blocks,
 * slabs and rods on half-cell grids (overlaps, overhangs, levers), mixed materials (mass ratios), random roles.
 */
function randomLevel(seed: number): LevelDef {
  const r = rng(seed), pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!, int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const half = () => int(-8, 8) / 2;
  const parts: Part[] = [];
  for (let k = int(1, 8); k > 0; k--) {
    const material = pick(MATERIALS).name, role = r() < 0.7 ? undefined : pick(ROLES);
    if (r() < 0.6) parts.push({ kind: 'block', at: [half(), r() < 0.6 ? 0 : int(0, 4), half()], size: [int(1, 3), int(1, 4), int(1, 3)], material, ...(role ? { role } : {}) });
    else parts.push({ kind: r() < 0.5 ? 'slab' : 'rod', at: [half(), int(0, 5) / (r() < 0.5 ? 1 : 2), half()], half: [int(1, 6) / 4, int(1, 4) / 8, int(1, 6) / 4], material, ...(role ? { role } : {}) });
  }
  return { ...base, id: `R${seed}`, parts, crownLine: int(0, 3) };
}

/** The checks both versions make, in a canonical order (the new one sorts its pairs; the old one swept on x). */
const OLD_CODES = new Set<Issue['code']>(['count', 'overlap', 'unsupported', 'mass-ratio', 'tunnelling', 'crown-start', 'rack', 'empty']);
const canon = (issues: Issue[]) => issues.filter((i) => OLD_CODES.has(i.code)).map((i) => `${i.code}|${i.message}`).sort();

describe('validateLevel at scale', () => {
  it('gives the old validator\'s issues on every shipped level and 200 random small ones', () => {
    for (const def of LEVELS) expect(validateLevel(compileLevel(def)), def.id).toEqual(validateLevelRef(compileLevel(def)));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const c = compileLevel(randomLevel(seed));
      const now = validateLevel(c, { engine: 'rapier' }), old = validateLevelRef(c);
      expect(canon(now), `seed ${seed}`).toEqual(canon(old));
      for (const i of old) seen.add(i.code);
    }
    // The draws exercise every structural check, not only clean levels.
    for (const code of ['overlap', 'unsupported', 'mass-ratio', 'crown-start'] as const) expect(seen, code).toContain(code);
  });

  it('validates the 10k S4 city in under 2 s, clean on the GPU and over Rapier\'s budget', () => {
    const def: LevelDef = { ...base, id: 'city', scoring: 'outcome', objective: { kind: 'collapse', min: 0.3 }, lot: { min: [-60, -60], max: [60, 60] }, parts: [{ kind: 'scenario', id: 'S4', material: 'stone' }] };
    const c = compileLevel(def);
    expect(c.meta.n).toBe(10_000);
    const t0 = performance.now();
    const issues = validateLevel(c);
    const ms = performance.now() - t0;
    expect(issues).toEqual([]);
    expect(ms).toBeLessThan(2000);
    expect(validateLevel(c, { engine: 'rapier' }).map((i) => i.code)).toEqual(['count']);
  });

  it('counts bodies against the engine\'s budget: Rapier\'s for par levels, the GPU\'s for outcome levels', () => {
    expect(ENGINE_MAX_BODIES).toEqual({ rapier: 2500, gpu: 10_000 });
    const wall = (W: number, scoring?: LevelDef['scoring']): LevelDef => ({ ...base, ...(scoring ? { scoring } : {}), lot: { min: [-60, -2], max: [60, 2] }, parts: [{ kind: 'scenario', id: 'S3', params: { W, H: 26 }, material: 'plaster' }] });
    const codes = (d: LevelDef, engine?: 'rapier' | 'gpu') => validateLevel(compileLevel(d), engine ? { engine } : {}).filter((i) => i.code === 'count').map((i) => i.message);
    expect(codes(wall(96))).toEqual([]); // 2,496
    expect(codes(wall(97))).toEqual(['2522 bodies > 2500 (the rapier engine\'s budget)']);
    expect(codes(wall(97, 'outcome'))).toEqual([]);
    expect(codes(wall(97, 'outcome'), 'rapier')).toHaveLength(1);
    expect(codes(wall(97), 'gpu')).toEqual([]);
  });

  it('flags more than 64 watched bodies (crowns plus heritage)', () => {
    const row = (n: number, role: 'crown' | 'heritage'): Part => ({ kind: 'block', at: [-20, 0, 0], size: [n, 1, 1], material: 'plaster', role });
    const watched = (crowns: number, heritage: number) => validateLevel(compileLevel({ ...base, crownLine: 0, lot: { min: [-30, -30], max: [30, 30] }, parts: [row(crowns, 'crown'), { ...row(heritage, 'heritage'), at: [-20, 0, 3] }] })).filter((i) => i.code === 'watched');
    expect(MAX_WATCHED).toBe(64);
    expect(watched(40, 24)).toEqual([]);
    expect(watched(40, 25)).toEqual([expect.objectContaining({ message: expect.stringMatching(/40 crowns \+ 25 heritage = 65 watched bodies > 64/) })]);
  });

  it('flags a structure with nothing to bring down: under one common block falling 1 h above lying flat', () => {
    const flat = (parts: Part[]) => validateLevel(compileLevel({ ...base, parts })).filter((i) => i.code === 'flat').length;
    // A course of cubes on the ground is already flat; one cube on top is exactly one block 1 h up: enough.
    expect(flat([{ kind: 'block', at: [0, 0, 0], size: [3, 1, 1], material: 'plaster' }])).toBe(1);
    expect(flat([{ kind: 'block', at: [0, 0, 0], size: [3, 1, 1], material: 'plaster' }, { kind: 'block', at: [1, 1, 0], size: [1, 1, 1], material: 'plaster' }])).toBe(0);
    // A slab standing on its edge can fall: from half-height 0.5 h to 0.125 h, with a plain cube's weight below it.
    expect(flat([{ kind: 'slab', at: [0, 0, 0], half: [1, 0.125, 1], material: 'plaster' }])).toBe(1);
    expect(flat([{ kind: 'rod', at: [0, 0, 0], half: [0.25, 2, 0.25], material: 'stone' }])).toBe(0);
  });
});
