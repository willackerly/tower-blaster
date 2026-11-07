// The trials (trial-levels.ts): every scenario, draft and mode-probe structure
// the game offers unrated. Each compiles inside the GPU budget as an uncast
// outcome level, carries only the validator issues its note names (and every
// code it names does turn up, so a note never outlives its issue). That its
// rack reaches across its launcher ring is keystone-lab's trial-reach.test.ts.
import { describe, expect, it } from 'vitest';
import { archWall, BuildSession, compileLevel, DRAFTS, dominoRun, findLevel, IceBreaker, isTrial, LEVELS, BIG_LEVELS, materialId, scoringOf, slabBuilding, towerChain, TRIAL_LEVELS, TRIAL_NOTES, UNDERCUT_LEVELS, validateLevel, WORKSHOP_RADIUS } from '@tb/keystone';

const sizes = new Map(TRIAL_LEVELS.map((d) => [d.id, compileLevel(d)]));

describe('trial levels', () => {
  it('ids are T-<source>, unique, apart from every rated level, and each has a note naming its source', () => {
    const ids = TRIAL_LEVELS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^T-[SXBIW]\d+[A-Z]?$/);
      expect(isTrial(id) && isTrial(id.toLowerCase())).toBe(true);
      expect(TRIAL_NOTES[id]?.from, id).toBeTruthy();
      expect(findLevel(id)).toBe(TRIAL_LEVELS.find((d) => d.id === id));
    }
    for (const d of [...LEVELS, ...BIG_LEVELS, ...UNDERCUT_LEVELS]) expect(isTrial(d.id), d.id).toBe(false);
    expect(Object.keys(TRIAL_NOTES).sort()).toEqual([...ids].sort());
  });

  it('covers every scenario but the seven left out, every draft but B1c and B3d, and the mode probes X1 to X4', () => {
    const scen = new Set(TRIAL_LEVELS.map((d) => /^T-(S\d+)/.exec(d.id)?.[1]).filter(Boolean));
    expect([...scen].sort()).toEqual(['S1', 'S12', 'S14', 'S2', 'S3', 'S4', 'S8']);
    const drafts = TRIAL_LEVELS.filter((d) => /^T-B/.test(d.id)).map((d) => d.id.slice(2));
    expect(drafts).toEqual(Object.keys(DRAFTS).filter((k) => k !== 'B1c' && k !== 'B3d').map((k) => k.toUpperCase()));
    expect(TRIAL_LEVELS.filter((d) => /^T-X/.test(d.id)).map((d) => d.id)).toEqual(['T-X1', 'T-X2', 'T-X3', 'T-X3B', 'T-X3K', 'T-X4']);
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

  it('T-W1, the Domino Workshop: three crown dominoes on a circle facing along it, one marble, a domino-only brush budget', () => {
    const def = findLevel('T-W1')!, c = sizes.get('T-W1')!;
    expect(def.rack).toEqual(['marble']);
    expect(def.build).toEqual({ budget: 30, pieces: ['domino'], brush: true });
    expect(c.meta.n).toBe(3);
    expect(Array.from(c.meta.crowns)).toEqual([0, 1, 2]);
    const h = c.frame.unit;
    for (const b of c.scene.bodies) {
      const [x, y, z] = b.pos, q = b.rot;
      expect(Math.hypot(x, z) / h).toBeCloseTo(WORKSHOP_RADIUS, 6);
      expect(y / h).toBeCloseTo(1, 6); // standing on the ground
      // The thin axis (z rotated by q) is the circle's tangent: perpendicular to the radius.
      const zx = 2 * (q[0] * q[2] + q[3] * q[1]), zz = 1 - 2 * (q[0] ** 2 + q[1] ** 2);
      expect(Math.abs(zx * x + zz * z) / h).toBeLessThan(1e-9);
    }
    // Every other trial has no build phase.
    expect(TRIAL_LEVELS.filter((d) => d.build).map((d) => d.id)).toEqual(['T-W1']);
    expect(new BuildSession(def).items.map((i) => i.name)).toEqual(['domino']);
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
    // X3: 12 towers of 32 cubes, or of 16 bricks; the last tower's top course crowned.
    expect(sizes.get('T-X3')!.meta.n).toBe(12 * 32);
    expect(sizes.get('T-X3')!.meta.crowns.length).toBe(4);
    expect(towerChain(12, 'bricks').length).toBe(12 * 16);
    expect(sizes.get('T-X3K')!.meta.n).toBe(12 * 28);
    expect(sizes.get('T-X3K')!.meta.crowns.length).toBe(2);
    // X4: 20 x 25 running bond (even courses 20 bricks, odd 19 and two halves = 512) less the half disc of R 5 m.
    const full = archWall(20, 25, 0).length, arch = archWall(20, 25, 5).length;
    expect(full).toBe(13 * 20 + 12 * 21);
    expect(arch).toBe(sizes.get('T-X4')!.meta.n);
    expect(full - arch).toBeGreaterThan(50);
  });
});
