// Footprints (footprint.ts, docs/design/grid.md) on synthetic body states: the lattice grid, the home
// mask of a known building, known moves of it, and lot-sheet footprint terms. No engine.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, maskScore, type Snapshot, TIER_FREE } from '@tb/engine-api';
import {
  checkLotSheet, compileLevel, footprintFacts, footprintGrid, goalMet, type LevelDef, lotGrid, type LotSheet, makeFootprint, roundFacts, type RoundState,
  selectFootprints, selectGroup, selectGroups,
} from '@tb/keystone';

// A 3 x 2 x 4 building of plaster cubes on cells x 0..2, z 0..1 (part 0), and a lone heritage cube at x -4 (part 1).
const def: LevelDef = {
  id: 'F', name: 'f', version: 1, world: 0, lot: { min: [-5, -3], max: [5, 3] }, crownLine: 2, objective: { kind: 'collapse', min: 0.3 }, par: 1,
  rack: ['cannonball'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [0, 0, 0], size: [3, 4, 2], material: 'plaster' },
    { kind: 'block', at: [-4, 0, 0], size: [1, 1, 1], material: 'stone', role: 'heritage' },
  ],
};
const c = compileLevel(def);
const n = c.meta.n, h = c.frame.unit, p = c.frame.pitch * h;
const building = selectGroup(c, { parts: [0] });

function world(): Snapshot {
  const s = emptySnapshot(n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < n; i++) s.rot[4 * i + 3] = 1;
  return s;
}
/** Grid cell (i, j) of lotGrid(c) at res 1, margin 4 holding lattice cell (x, z). */
const cellOf = (x: number, z: number) => (z - def.lot.min[1] + 4) * (def.lot.max[0] - def.lot.min[0] + 8) + (x - def.lot.min[0] + 4);
const cells = (m: ArrayLike<number>) => Array.from(m).flatMap((v, k) => (v ? [k] : [])).sort((a, b) => a - b);

describe('lotGrid', () => {
  it('lays cells on lattice cells and covers the lot grown by the margin', () => {
    const g = lotGrid(c);
    expect(g.n).toEqual([10 + 8, 6 + 8]);
    expect(g.cell[0]).toBeCloseTo(p, 12);
    expect(g.origin[0]).toBeCloseTo((-5 - 4) * p, 12);
    expect(lotGrid(c, { res: 2, margin: 0 }).n).toEqual([20, 12]);
    expect(() => lotGrid(c, { res: 5 })).toThrow(/res/);
    expect(() => lotGrid(c, { margin: -1 })).toThrow(/margin/);
  });

  it("masks a building's home cells, grown by k cells with diagonals", () => {
    const f0 = makeFootprint(c, building, 0);
    expect(cells(f0.mask)).toEqual([cellOf(0, 0), cellOf(1, 0), cellOf(2, 0), cellOf(0, 1), cellOf(1, 1), cellOf(2, 1)].sort((a, b) => a - b));
    const f1 = makeFootprint(c, building, 1);
    expect(cells(f1.mask)).toHaveLength(5 * 4);
    expect(f1.mask[cellOf(-1, -1)]).toBe(1);
    expect(f1.mask[cellOf(3, 2)]).toBe(1);
    expect(f1.mask[cellOf(4, 0)]).toBe(0);
    // Sub-cells: at res 2 the home cover is 6 x 4 sub-cells, grown by one lattice cell = 2 sub-cells.
    expect(cells(makeFootprint(c, building, 0, { res: 2 }).mask)).toHaveLength(24);
    expect(cells(makeFootprint(c, building, 1, { res: 2 }).mask)).toHaveLength(10 * 8);
  });
});

describe('footprint facts', () => {
  it('reads a building at home as perfect, its height in h', () => {
    const f = footprintFacts(c, makeFootprint(c, building, 0), world());
    expect(f).toMatchObject({ spill: 0, fill: 1, iou: 1, reach: 0, heightOut: 0 });
    expect(f.height).toBeCloseTo(4, 3);
  });

  it('reads the building moved one cell east: known IoU, fill, spill and reach', () => {
    const s = world();
    for (const i of building) s.pos[3 * i] = s.pos[3 * i]! + p;
    const f = footprintFacts(c, makeFootprint(c, building, 0), s);
    // Cells x 1..3 against x 0..2, both two deep: 4 shared of 6, union 8; a third of the mass (the x 3 column) is out, one cell beyond.
    expect(f).toMatchObject({ fill: 4 / 6, iou: 4 / 8, reach: 1 });
    expect(f.spill).toBeCloseTo(1 / 3, 12);
    expect(f.heightOut).toBeCloseTo(4, 3);
    // Grown by one cell, the same move spills nothing.
    expect(footprintFacts(c, makeFootprint(c, building, 1), s)).toMatchObject({ spill: 0, reach: 0 });
  });

  it('weights spill by mass and skips removed bodies (the X2 "remaining mass")', () => {
    const s = world(), all = Int32Array.from({ length: n }, (_, i) => i), heritage = c.meta.heritage[0]!;
    // Mask the building only, but reduce every body: the stone cube (heavier than a plaster one) is out.
    const fp = { ...makeFootprint(c, building, 0), idx: all };
    const out = c.meta.mass[heritage]!, total = c.meta.mass.reduce((a, m) => a + m, 0);
    expect(footprintFacts(c, fp, s).spill).toBeCloseTo(out / total, 6);
    s.tier = new Uint8Array(n);
    s.tier[heritage] = TIER_FREE;
    expect(footprintFacts(c, fp, s).spill).toBe(0);
    expect(footprintGrid(c, fp, s).removed).toBe(1);
  });

  it('a building laid flat to the east: height drops, the mask is overrun', () => {
    const s = world();
    // Course k of column x lands on the ground at x + k + 1 (a fold east), still on rows z 0..1.
    for (const i of building) {
      const x = Math.floor(c.meta.home[3 * i]! / p), k = Math.floor(c.meta.home[3 * i + 1]! / h);
      s.pos[3 * i] = (x + k + 1.5) * p;
      s.pos[3 * i + 1] = 0.5 * h;
    }
    const f = footprintFacts(c, makeFootprint(c, building, 1), s);
    // Columns land at x 1..6; the mask (grown by 1) reaches x 3, so x 4..6 is out: reach 3.
    expect(f.reach).toBe(3);
    expect(f.height).toBeCloseTo(1, 3);
    expect(f.spill).toBeGreaterThan(0.3);
    expect(f.fill).toBeLessThan(1);
  });

  it('agrees with the engine-api mask score it is built on', () => {
    const fp = makeFootprint(c, building, 1), s = world();
    s.pos[3 * building[0]!] = 20 * p; // one cube far off, past the margin
    const sc = maskScore(footprintGrid(c, fp, s), fp.mask);
    const f = footprintFacts(c, fp, s);
    expect(f.spill).toBe(sc.spill);
    expect(sc.outWeight).toBe(Math.round(c.meta.mass[building[0]!]! * 1000));
  });
});

describe('lot-sheet footprint terms', () => {
  const sheet = (o: Partial<LotSheet> = {}): LotSheet => ({
    level: 'F', engine: 'ref', groups: { block: { parts: [0] } }, footprints: { lot: { group: 'block', grow: 1 }, tight: { group: 'block', grow: 0 } },
    goals: [{ id: 'fold', text: 'Fold it into its own lot', when: { all: [{ footprint: 'lot', of: 'spill', op: '<=', value: 0.1 }, { footprint: 'lot', of: 'height', op: '<=', value: 2 }] } }],
    ...o,
  });
  const round = (): RoundState => ({
    phase: 'cleared', rackLeft: [], outcomes: [], inputs: [], crownDown: new Uint8Array(0), heritageBroken: new Uint8Array(c.meta.heritage.length), score: null, home: c.meta.home.slice(),
  });

  it('judges a fold into the footprint, and not a building still standing or one thrown clear', () => {
    const s = sheet(), groups = selectGroups(c, s.groups!), fps = selectFootprints(c, s), goal = s.goals[0]!.when;
    expect(() => checkLotSheet(c, s)).not.toThrow();
    const standing = roundFacts(c, round(), world(), groups, fps);
    expect(standing.footprints.lot).toMatchObject({ spill: 0, iou: expect.any(Number) });
    expect(goalMet(goal, standing), 'still 4 h tall').toBe(false);
    const folded = world();
    for (const i of building) folded.pos[3 * i + 1] = 0.5 * h + (c.meta.home[3 * i + 1]! > 2 * h ? h : 0); // two courses high
    expect(goalMet(goal, roundFacts(c, round(), folded, groups, fps))).toBe(true);
    const thrown = world();
    for (const i of building) { thrown.pos[3 * i] = thrown.pos[3 * i]! + 6 * p; thrown.pos[3 * i + 1] = 0.5 * h; }
    expect(goalMet(goal, roundFacts(c, round(), thrown, groups, fps))).toBe(false);
    // A sheet with footprints judged without them refuses to guess.
    expect(() => goalMet(goal, roundFacts(c, round(), folded, groups))).toThrow(/footprint lot/);
  });

  it('refuses malformed footprints and terms, naming them', () => {
    const bad: [Partial<LotSheet>, RegExp][] = [
      [{ footprints: { x: { group: 'nope' } } }, /footprints\.x\.group: no group nope/],
      [{ footprints: { x: { grow: 9 } } }, /footprints\.x\.grow/],
      [{ footprints: { x: { res: 0 } } }, /footprints\.x\.res/],
      [{ footprints: { x: { margin: 17 } } }, /footprints\.x\.margin/],
      [{ footprints: { x: { size: 1 } as never } }, /footprints\.x: unknown field size/],
      [{ goals: [{ id: 'a', text: 'a', when: { footprint: 'gone', of: 'spill', op: '<=', value: 0 } }] }, /no footprint gone/],
      [{ goals: [{ id: 'a', text: 'a', when: { footprint: 'lot', of: 'mass' as never, op: '<=', value: 0 } }] }, /of must be one of spill/],
    ];
    for (const [o, re] of bad) expect(() => checkLotSheet(c, sheet(o)), re.source).toThrow(re);
  });

  it('a whole-structure footprint needs no group', () => {
    const fps = selectFootprints(c, { footprints: { all: {}, exact: { grow: 0 } } });
    expect(fps.all!.idx).toHaveLength(n);
    // Grown by the default one cell, the mask holds more than the structure covers.
    expect(footprintFacts(c, fps.all!, world())).toMatchObject({ spill: 0, reach: 0 });
    expect(footprintFacts(c, fps.all!, world()).fill).toBeLessThan(1);
    expect(footprintFacts(c, fps.exact!, world())).toMatchObject({ spill: 0, fill: 1, iou: 1 });
  });
});
