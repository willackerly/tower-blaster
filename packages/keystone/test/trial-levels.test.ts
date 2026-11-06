// The trials (trial-levels.ts): every scenario, draft and mode-probe structure
// the game offers unrated. Each compiles inside the GPU budget as an uncast
// outcome level, carries only the validator issues its note names (and every
// code it names does turn up, so a note never outlives its issue). That its
// rack reaches across its launcher ring is keystone-lab's trial-reach.test.ts.
import { describe, expect, it } from 'vitest';
import { archWall, compileLevel, DRAFTS, dominoRun, findLevel, gateWall, IceBreaker, isTrial, LEVELS, BIG_LEVELS, materialId, scoringOf, slabBuilding, towerChain, TRIAL_DRAFTS, TRIAL_DROPS, TRIAL_LEVELS, TRIAL_NOTES, TRIAL_PROMOTE, UNDERCUT_LEVELS, validateLevel } from '@tb/keystone';

const sizes = new Map(TRIAL_LEVELS.map((d) => [d.id, compileLevel(d)]));

describe('trial levels', () => {
  it('ids are T-<source>, unique, apart from every rated level, and each has a note naming its source', () => {
    const ids = TRIAL_LEVELS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^T-[SXBI]\d+[A-Z]?$/);
      expect(isTrial(id) && isTrial(id.toLowerCase())).toBe(true);
      expect(TRIAL_NOTES[id]?.from, id).toBeTruthy();
      expect(findLevel(id)).toBe(TRIAL_LEVELS.find((d) => d.id === id));
    }
    for (const d of [...LEVELS, ...BIG_LEVELS, ...UNDERCUT_LEVELS]) expect(isTrial(d.id), d.id).toBe(false);
    expect(Object.keys(TRIAL_NOTES).sort()).toEqual([...ids].sort());
  });

  it('the list is the agent playtest\'s (PT11): judge 3\'s keeps, reworks and promotions, its drops gone with a reason each', () => {
    const ids = TRIAL_LEVELS.map((d) => d.id);
    expect(ids).toEqual(['T-S3', 'T-S4', 'T-S8', 'T-S14', 'T-S14T', 'T-X1', 'T-X2', 'T-X3B', 'T-X4', 'T-B1B', 'T-B2C', 'T-B3B', 'T-B4A', 'T-I1', 'T-I2', 'T-I3']);
    expect(Object.keys(TRIAL_DROPS).sort()).toEqual(['T-B1A', 'T-B2A', 'T-B2B', 'T-B2D', 'T-B2E', 'T-B3A', 'T-B3C', 'T-B3E', 'T-S1', 'T-S12', 'T-S2', 'T-S3R', 'T-X3', 'T-X3K']);
    for (const id of Object.keys(TRIAL_DROPS)) { expect(ids, id).not.toContain(id); expect(TRIAL_DROPS[id]!.length, id).toBeGreaterThan(10); }
    for (const id of TRIAL_PROMOTE) expect(ids, id).toContain(id);
    // Every draft is a kept trial or a dropped one (B1c and B3d, the rated levels' own drafts, neither).
    const drafts = Object.keys(DRAFTS).filter((k) => k !== 'B1c' && k !== 'B3d');
    expect(drafts.filter((k) => !TRIAL_DRAFTS.includes(k)).map((k) => `T-${k.toUpperCase()}`).sort()).toEqual(Object.keys(TRIAL_DROPS).filter((id) => id.startsWith('T-B')).sort());
  });

  it('the ice trials are ice: all of T-I1 and T-I2, the top four courses of T-I3 (crowned) over stone; each budgets its pieces', () => {
    const ice = materialId('ice'), stone = materialId('stone');
    const ids = TRIAL_LEVELS.filter((d) => /^T-I/.test(d.id)).map((d) => d.id);
    expect(ids).toEqual(['T-I1', 'T-I2', 'T-I3']);
    for (const id of ['T-I1', 'T-I2']) expect([...sizes.get(id)!.meta.material].every((m) => m === ice), id).toBe(true);
    const k = sizes.get('T-I3')!.meta;
    expect([...k.material].filter((m) => m === ice)).toHaveLength(36);
    expect([...k.material].filter((m) => m === stone)).toHaveLength(36);
    expect(k.crowns.every((b) => k.material[b] === ice)).toBe(true);
    for (const id of ids) expect(IceBreaker.budget(sizes.get(id)!), id).toBeGreaterThan(0);
  });

  it.each(TRIAL_LEVELS.map((d) => d.id))('%s: an uncast outcome level inside the GPU budget, with exactly the issues its note names', (id) => {
    const def = TRIAL_LEVELS.find((d) => d.id === id)!, c = sizes.get(id)!;
    expect(scoringOf(def)).toBe('outcome');
    expect(def.stars).toBeUndefined();
    expect(def.solutions).toBeUndefined();
    expect(c.meta.n).toBeGreaterThan(0);
    expect(c.meta.n).toBeLessThanOrEqual(10_000);
    const codes = [...new Set(validateLevel(c, { engine: 'gpu' }).filter((i) => !i.warning).map((i) => i.code))].sort();
    expect(codes).toEqual([...(TRIAL_NOTES[id]!.issues?.codes ?? [])].sort());
  });

  it('the probe structures keep the probes\' shapes', () => {
    // X1: 30 dominoes 0.15 h thick, 1.2 h apart, the last the crown.
    const run = dominoRun(30);
    expect(run.length).toBe(30);
    expect(run.filter((p) => p.kind === 'rod' && p.role === 'crown').length).toBe(1);
    expect(sizes.get('T-X1')!.meta.crowns.length).toBe(1);
    // X2: a 6 x 6 footprint has a 20-cell ring and a 2 x 2 core, two courses a storey, and a slab on each.
    const slabs = slabBuilding(6, 6, 5);
    expect(slabs.filter((p) => p.kind === 'slab').length).toBe(5);
    expect(sizes.get('T-X2')!.meta.n).toBe(5 * (2 * 24 + 1));
    // X3: 12 towers of 16 bricks (the cube and Kapla chains were dropped); the last tower's top course crowned.
    expect(towerChain(12, 'bricks').length).toBe(12 * 16);
    expect(sizes.get('T-X3B')!.meta.n).toBe(12 * 16);
    expect(towerChain(12, 'cubes').length).toBe(12);
    // X4: 20 x 25 running bond (even courses 20 bricks, odd 19 and two halves = 512) less the half disc of R 5 m, as the probe built it.
    const full = archWall(20, 25, 0).length, arch = archWall(20, 25, 5).length;
    expect(full).toBe(13 * 20 + 12 * 21);
    expect(full - arch).toBeGreaterThan(50);
    // The trial's doorway (gateWall): 6 m wide, 8 courses high, plumb jambs, one lintel bearing 1 m each side.
    const gate = gateWall(20, 25, 3, 8), m = sizes.get('T-X4')!.meta, h = 0.5;
    expect(gate.length).toBe(m.n);
    const lintel = gate.filter((p) => p.kind === 'rod' && p.half[0] > 2);
    expect(lintel).toHaveLength(1);
    expect(lintel[0]!.kind === 'rod' && [lintel[0]!.half[0] * h, lintel[0]!.at[1] * h]).toEqual([4, 4]);
    for (let i = 0; i < m.n; i++) {
      const lo = m.home[3 * i]! - m.half[3 * i]!, hi = m.home[3 * i]! + m.half[3 * i]!, y = m.home[3 * i + 1]!;
      if (y < 4) expect(hi <= -3 + 1e-9 || lo >= 3 - 1e-9, `body ${i} in the doorway`).toBe(true);
      expect(hi - lo, `body ${i}`).toBeGreaterThanOrEqual(0.2 - 1e-9);
    }
  });
});
