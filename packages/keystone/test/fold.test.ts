// Fuse & Fold's rules (docs/game/fuse-and-fold.md): frame sites build clean levels, the building's spill
// in the reductions is C11's spill with the lot as the mask, the fold objective and metric, a fold
// plunger fires every charge, collapse counts the building alone, and nudged builds are small and repeatable.
import { describe, expect, it } from 'vitest';
import { boxBoxSeparation, obb } from '@tb/geom';
import { emptySnapshot, maskScore, reduceGrid, type Snapshot, TIER_FREE } from '@tb/engine-api';
import {
  baselineOf, compileLevel, FOLD_SITES, foldCandidate, foldLevel, foldValue, frameBuilding, gramsOf, lotGrid, NUDGE_DEG, NUDGE_MM, nudgedLevel, objectiveMet,
  outcomeTally, reduceCpu, Session, siteLot, spillOf, storeyCutters, validateLevel,
} from '@tb/keystone';

const lvl = foldCandidate('FC-1');
const c = compileLevel(lvl);
const building = Array.from({ length: c.meta.n }, (_, i) => i).filter((i) => c.meta.role[i] !== 2);
const heritage = Array.from(c.meta.heritage);

function atHome(): Snapshot {
  const s = emptySnapshot(c.meta.n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}

describe('fold sites', () => {
  it.for(Object.keys(FOLD_SITES))('%s compiles to a clean fold level: frame, cutters on the cut storeys, neighbours outside the lot', (id) => {
    const d = foldCandidate(id), k = compileLevel(d), site = FOLD_SITES[id]!.site;
    expect(validateLevel(k)).toEqual([]);
    expect(d.objective.kind).toBe('fold');
    expect(d.rack).toEqual(['plunger']);
    const fr = frameBuilding(site.frame);
    const per = site.frame.nx * site.frame.nz;
    expect(d.charges).toHaveLength(per * (site.cuts.length + (site.relays?.length ?? 0)));
    // Every charge (cutter, or relay armed at start) rides a frame column, inside the frame's first n bodies, never heritage.
    for (const ch of d.charges!) { expect(ch.host).toBeLessThan(fr.n); expect(k.meta.role[ch.host]).toBe(0); }
    expect(d.charges!.filter((ch) => ch.weapon === 'relay')).toHaveLength(per * (site.relays?.length ?? 0));
    for (const ch of d.charges!) if (ch.weapon === 'relay') expect(ch.arm).toBe('start');
    // Heritage stands wholly outside the lot; the frame wholly inside it.
    for (const i of k.meta.heritage) expect(Math.abs(k.meta.home[3 * i]!) > 0 || Math.abs(k.meta.home[3 * i + 2]!) > 0).toBe(true);
    const [x0, x1, z0, z1] = siteLot(site).map((v) => v * k.frame.pitch * k.frame.unit);
    for (let i = 0; i < k.meta.n; i++) {
      const x = k.meta.home[3 * i]!, z = k.meta.home[3 * i + 2]!, hx = k.meta.half[3 * i]!, hz = k.meta.half[3 * i + 2]!;
      const inside = x - hx >= x0! - 1e-9 && x + hx <= x1! + 1e-9 && z - hz >= z0! - 1e-9 && z + hz <= z1! + 1e-9;
      const outside = x + hx <= x0! || x - hx >= x1! || z + hz <= z0! || z - hz >= z1!;
      expect(k.meta.role[i] === 2 ? outside : inside, `body ${i}`).toBe(true);
    }
  });

  it('storeyCutters names the bottom body of each column of the storeys asked for', () => {
    const f = { nx: 3, nz: 2, span: 2, storeys: 4, colH: 2, slab: 0.5, column: 'cubes' as const };
    const fr = frameBuilding(f), cut = storeyCutters(f, [0, 2]);
    expect(cut.map((x) => x.host).slice(0, 6)).toEqual(fr.ground.flat());
    // Storey 2's first column starts after two storeys of 6 two-cube columns and a slab each.
    expect(cut[6]!.host).toBe(2 * (6 * 2 + 1));
    expect(() => storeyCutters(f, [4])).toThrow(/storey 4/);
  });
});

describe('spill in the reductions', () => {
  it('is the building mass outside the lot grown by 0.5 h, in grams; heritage and removed bodies count for nothing', () => {
    const s = atHome(), base = baselineOf(s, c, 0), g = gramsOf(c);
    let r = reduceCpu(s, null, c, base, 1);
    expect(r.spill_g).toBe(0);
    expect(r.mass_g).toBe(building.reduce((a, i) => a + g[i]!, 0));
    expect(spillOf(r)).toBe(0);
    // The top slab thrown far east (outside), a column removed, a house course moved off: only the slab spills.
    const slab = building.reduce((a, i) => (c.meta.mass[i]! > c.meta.mass[a]! ? i : a), building[0]!);
    s.pos[3 * slab] = 100;
    s.tier = new Uint8Array(c.meta.n);
    s.tier[lvl.charges![0]!.host] = TIER_FREE;
    s.pos[3 * heritage[0]!] = 100;
    r = reduceCpu(s, null, c, base, 2);
    expect(r.spill_g).toBe(g[slab]);
    expect(r.mass_g).toBe(building.reduce((a, i) => a + g[i]!, 0) - g[lvl.charges![0]!.host]!);
    expect(spillOf(r)).toBeCloseTo(g[slab]! / r.mass_g, 15);
  });

  it("agrees with C11's grid spill (engine-api maskScore) against the lot as the mask, for bodies clear of its edge", () => {
    const s = atHome(), base = baselineOf(s, c, 0);
    // Scatter the building: every third body three cells west of the lot, the rest where they stand.
    const p = c.frame.pitch * c.frame.unit;
    building.forEach((i, k) => { if (k % 3 === 0) s.pos[3 * i] = c.lot.min[0] - 3 * p; });
    const grid = lotGrid(c, { margin: 8 }), [nu, nv] = grid.n, mask = new Uint8Array(nu * nv);
    // The lot's cells: lotGrid's cells are lattice cells, the lot's corners are cell edges, margin 8 around it.
    for (let v = 8; v < nv - 8; v++) for (let u = 8; u < nu - 8; u++) mask[v * nu + u] = 1;
    const sc = maskScore(reduceGrid(grid, { snap: s, shapes: c.scene.bodies.map((b) => b.shape), ids: Int32Array.from(building), weight: gramsOf(c) }), mask);
    expect(spillOf(reduceCpu(s, null, c, base, 1))).toBeCloseTo(sc.spill, 12);
    expect(sc.spill).toBeGreaterThan(0.2);
  });
});

describe('the fold objective, metric and tally', () => {
  const red = (spill_g: number) => ({ ...reduceCpu(atHome(), null, c, baselineOf(atHome(), c, 0), 1), spill_g, mass_g: 1000 });
  it('is met by enough collapse, spill at most spillMax and no heritage broken', () => {
    const obj = { kind: 'fold' as const, min: 0.6, spillMax: 0.05 };
    expect(objectiveMet(c, { red: red(50), crownsTotal: 0, collapse: 0.6, heritage: 0 }, 'outcome', obj)).toBe(true);
    expect(objectiveMet(c, { red: red(51), crownsTotal: 0, collapse: 0.9, heritage: 0 }, 'outcome', obj)).toBe(false);
    expect(objectiveMet(c, { red: red(0), crownsTotal: 0, collapse: 0.59, heritage: 0 }, 'outcome', obj)).toBe(false);
    expect(objectiveMet(c, { red: red(0), crownsTotal: 0, collapse: 0.9, heritage: 1 }, 'outcome', obj)).toBe(false);
    // A domino fuse that never cut its row (M5b): a misfire fails it, however well the rest fell.
    expect(objectiveMet(c, { red: red(0), crownsTotal: 0, collapse: 0.9, heritage: 0, misfires: 1 }, 'outcome', obj)).toBe(false);
    expect(objectiveMet(c, { red: red(0), crownsTotal: 0, collapse: 0.9, heritage: 0, misfires: 0 }, 'outcome', obj)).toBe(true);
  });
  it('scores fold as collapse discounted by spill, with a Spill cost line only on fold levels', () => {
    expect(foldValue(0.8, 0.25)).toBeCloseTo(0.6, 15);
    const f = { met: true, collapse: 0.8, leverage: 1, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 0.3, pulled: 0 };
    expect(outcomeTally({ ...f, spill: 0.25 }).find((l) => l.label === 'Spill')?.value).toBe(-750);
    expect(outcomeTally({ ...f, spill: 0 }).some((l) => l.label === 'Spill')).toBe(false);
    expect(outcomeTally(f).some((l) => l.label === 'Spill')).toBe(false);
    // A Misfire line costs 200 a column a fuse never cut; none when every charge fired.
    expect(outcomeTally({ ...f, met: false, misfires: 3 }).find((l) => l.label === 'Misfire')?.value).toBe(-600);
    expect(outcomeTally({ ...f, misfires: 0 }).some((l) => l.label === 'Misfire')).toBe(false);
  });
  it('is refused on a par level and with out-of-range bounds', () => {
    const bad = (o: Partial<typeof lvl>) => validateLevel(compileLevel({ ...lvl, ...o })).filter((i) => i.code === 'objective').length;
    expect(bad({})).toBe(0);
    expect(bad({ scoring: 'par' })).toBeGreaterThan(0);
    expect(bad({ objective: { kind: 'fold', min: 0, spillMax: 0.1 } })).toBeGreaterThan(0);
    expect(bad({ objective: { kind: 'fold', min: 0.5, spillMax: 1 } })).toBeGreaterThan(0);
  });
});

describe('a fold level session', () => {
  it("refuses a plunger that leaves a charge out, and takes one that names them all", () => {
    const s = new Session(c);
    const all = lvl.charges!.map((_, i): [number, number] => [i, 6 * i]);
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: all.slice(1) })).toMatch(/fires every charge: 1 not named \(0\)/);
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: all })).toBeNull();
    // Not a fold level: a plunger may name any of its charges, as C5 built it.
    const loose = new Session(compileLevel({ ...lvl, objective: { kind: 'collapse', min: 0.5 } }));
    expect(loose.plungerRefusal({ ammo: 'plunger', fuse: all.slice(1) })).toBeNull();
  });
  it('counts collapse over the building alone: heritage holds no share of the range', () => {
    const s = new Session(c), withHeritage = new Session(compileLevel({ ...lvl, objective: { kind: 'collapse', min: 0.5 } }));
    expect(s.building).toBe(true);
    expect(withHeritage.building).toBe(false);
    expect(s.startPe_mJ).toBeLessThan(withHeritage.startPe_mJ);
    const r = reduceCpu(atHome(), null, c, baselineOf(atHome(), c, 0), 1);
    // At home nothing has come down either way; the building's PE excludes the houses'.
    expect(s.collapse(s.peOf(r))).toBe(0);
    expect(s.peOf(r)).toBe(r.pe_mJ - r.peAside_mJ);
    expect(r.peAside_mJ).toBeGreaterThan(0);
  });
});

describe('nudged builds', () => {
  it('nudge 0 is the level itself; others move every body at most NUDGE_MM across and turn it at most NUDGE_DEG, the same way every time', () => {
    expect(nudgedLevel(c, 0)).toBe(c);
    const a = nudgedLevel(c, 3), b = nudgedLevel(c, 3), d = nudgedLevel(c, 4);
    expect(a.scene.bodies).toEqual(b.scene.bodies);
    expect(a.scene.bodies).not.toEqual(d.scene.bodies);
    expect(a.hash).toBe(c.hash);
    expect(a.meta).toBe(c.meta);
    let moved = 0;
    a.scene.bodies.forEach((x, i) => {
      const o = c.scene.bodies[i]!;
      expect(x.pos[1]).toBe(o.pos[1]);
      expect(Math.abs(x.pos[0] - o.pos[0])).toBeLessThanOrEqual(NUDGE_MM * 1e-3);
      expect(Math.abs(x.pos[2] - o.pos[2])).toBeLessThanOrEqual(NUDGE_MM * 1e-3);
      // A yaw from identity: 2 asin(|q_y|) is the angle.
      const deg = (2 * Math.asin(Math.abs(x.rot[1])) * 180) / Math.PI;
      expect(deg).toBeLessThanOrEqual(NUDGE_DEG + 1e-9);
      expect(Math.hypot(...x.rot)).toBeCloseTo(1, 12);
      if (x.pos[0] !== o.pos[0]) moved++;
    });
    expect(moved).toBe(c.meta.n);
  });
  it('a nudged build leaves every pair of bodies at one height clear of each other (the jitter opens no overlap)', () => {
    for (const id of Object.keys(FOLD_SITES)) {
      const bodies = nudgedLevel(compileLevel(foldCandidate(id)), 7).scene.bodies, ob = (i: number) => obb(bodies[i]!.pos, bodies[i]!.rot, (bodies[i]!.shape as { half: [number, number, number] }).half);
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        if (Math.abs(bodies[i]!.pos[1] - bodies[j]!.pos[1]) < 1e-6) expect(boxBoxSeparation(ob(i), ob(j)), `${id} ${i} ${j}`).toBeGreaterThan(0.002);
      }
    }
  });
});
