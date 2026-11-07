// The build session (C9, build.ts): place, overlap refusal, budget, stamps,
// tipping and turning, remove, the domino brush, undo, and the rule that
// matters most: Play is the level a saved file would load (same hash, same
// bodies), however the edits got there.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import { BuildSession, catalog, compileLevel, DOMINO_PITCH, type Hit, type Hold, L1, type LevelDef, type P2, stampHalf, tipped, validateLevel } from '@tb/keystone';

const h = 0.5;
/** A level with one 2-course block to build on and a build budget. */
const level = (build: LevelDef['build'] = { budget: 10 }): LevelDef => ({
  id: 'BUILD', name: 'build', version: 1, world: 0, lot: { min: [-10, -10], max: [10, 10] }, crownLine: 1, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble'], launcher: { radius: 12, y: 1, dropY: 8 }, build,
  parts: [{ kind: 'block', at: [0, 0, 0], size: [2, 2, 1], material: 'plaster' }],
});
const ground = (x: number, z: number): Hit => ({ body: -1, point: [x, 0, z], normal: [0, 1, 0], t: 1 });
/** The face hit by a ray straight down onto (x, z). */
const down = (s: BuildSession, x: number, z: number) => s.pick({ origin: [x, 50, z], dir: [0, -1, 0] })!;
/** Play: the edited level as a file would carry it, compiled fresh. */
const play = (s: BuildSession) => compileLevel(JSON.parse(JSON.stringify(s.def())) as LevelDef);

describe('build session', () => {
  it('places a cube on the ground and on top of the block; Play is the level a saved file loads', () => {
    const s = new BuildSession(level());
    const g = s.ghost(ground(3, 0), { item: 'cube', yaw: 0, tip: 0 });
    expect(g.ok).toBe(true);
    expect(s.place(g)).toBe(true);
    const top = down(s, 0.26, 0.26);
    expect(top.body).toBeGreaterThanOrEqual(0);
    expect(s.place(s.ghost(top, { item: 'cube', yaw: 0, tip: 0 }))).toBe(true);
    expect(s.spent()).toBe(2);
    expect(s.left()).toBe(8);
    const c = s.compiled(), p = play(s);
    expect(p.hash).toBe(c.hash);
    expect(p.scene.bodies).toEqual(c.scene.bodies);
    // The cube on top sits exactly on course 2 over the block's corner cube.
    const placed = c.scene.bodies.at(-1)!;
    expect(placed.pos[1]).toBeCloseTo(2.5 * h, 12);
    expect(placed.pos[0]).toBeCloseTo(0.5 * 1.02 * h, 9);
    expect(validateLevel(c).filter((i) => i.code === 'overlap' || i.code === 'unsupported')).toEqual([]);
  });

  it('refuses a ghost that overlaps the world or goes into the ground, and one over budget', () => {
    const s = new BuildSession(level({ budget: 2 }));
    // Snap off, straight into the block's first cube.
    const inBlock = s.ghost(ground(0.25, 0.25), { item: 'cube', yaw: 0, tip: 0 }, { snap: false });
    expect(inBlock.ok).toBe(false);
    expect(inBlock.why).toMatch(/overlaps 1 body/);
    expect(inBlock.clash).toEqual([0]);
    expect(s.place(inBlock)).toBe(false);
    // A beam costs 3, more than 2 left.
    const beam = s.ghost(ground(4, 4), { item: 'beam', yaw: 0, tip: 0 });
    expect(beam.ok).toBe(false);
    expect(beam.why).toBe('costs 3, 2 left');
    // A turned cube just clear of the block's side passes; nudged into it, it fails.
    const side: Hit = { body: 0, point: [0, 0.25, 0.26], normal: [-1, 0, 0], t: 1 };
    expect(s.ghost(side, { item: 'cube', yaw: 0, tip: 0 }).ok).toBe(true);
    expect(s.ghost({ ...side, point: [0.3, 0.25, 0.26] }, { item: 'cube', yaw: 20, tip: 0 }, { snap: false }).ok).toBe(false);
  });

  it('stamps place every box on the lattice, turned with the hold; tip stands a plank on its edge', () => {
    const s = new BuildSession(level({ budget: 20 }));
    const g = s.ghost(ground(5, 0), { item: 'wall4x2', yaw: 90, tip: 0 });
    expect(g.ok).toBe(true);
    expect(g.parts.length).toBe(8);
    expect(g.cost).toBe(8);
    s.place(g);
    const c = s.compiled(), wall = c.scene.bodies.slice(-8);
    // Turned 90 deg: the course runs along z, one pitch apart, two courses.
    const zs = [...new Set(wall.map((b) => b.pos[2].toFixed(6)))].map(Number).sort((a, b) => a - b);
    expect(zs.length).toBe(4);
    for (let i = 1; i < 4; i++) expect(zs[i]! - zs[i - 1]!).toBeCloseTo(1.02 * h, 5);
    expect([...new Set(wall.map((b) => b.pos[1]))].sort()).toEqual([0.5 * h, 1.5 * h]);
    expect(validateLevel(c).filter((i) => i.code === 'overlap' || i.code === 'unsupported')).toEqual([]);
    const plank = catalog(1.02).find((i) => i.name === 'plank')!;
    expect(stampHalf(tipped(plank, 0))).toEqual([2.5, 1 / 6, 0.5]);
    expect(stampHalf(tipped(plank, 2))).toEqual([2.5, 0.5, 1 / 6]);
    const edge = s.ghost(ground(-6, 0), { item: 'plank', yaw: 0, tip: 2 });
    expect(edge.boxes[0]!.c[1]).toBeCloseTo(0.5 * h, 12);
  });

  it('a slide moves the piece along its own x in half-cells, off the point it is placed at, and no further than keeps the point under it', () => {
    const s = new BuildSession(level({ budget: 20 })), step = (1.02 * h) / 2;
    const at = (hold: Partial<Hold>, hit = ground(-6, 0)) => s.ghost(hit, { item: 'plank', yaw: 0, tip: 0, ...hold }).boxes[0]!.c;
    const c0 = at({});
    // Along x, both ways, on the same half-cell grid as the unslid piece.
    expect(at({ slide: 2 })[0] - c0[0]).toBeCloseTo(2 * step, 9);
    expect(at({ slide: -3 })[0] - c0[0]).toBeCloseTo(-3 * step, 9);
    expect(at({ slide: 2 })[2]).toBeCloseTo(c0[2], 12);
    // Turned 90 deg it slides along the plank's own x, which now runs along -z.
    const t0 = at({ yaw: 90 }), t2 = at({ yaw: 90, slide: 2 });
    expect(Math.hypot(t2[0] - t0[0], t2[2] - t0[2])).toBeCloseTo(2 * step, 9);
    expect(t2[0]).toBeCloseTo(t0[0], 9);
    // A plank (half 2.5 h) may slide 4 half-cells; tipped up on x it is 1/6 h along x, and a cube 0.5 h: neither slides.
    expect(s.slideMax({ item: 'plank', yaw: 0, tip: 0 })).toBe(4);
    expect(s.slideMax({ item: 'plank', yaw: 0, tip: 1 })).toBe(0);
    expect(s.slideMax({ item: 'cube', yaw: 0, tip: 0 })).toBe(0);
    expect(at({ slide: 9 })[0] - c0[0]).toBeCloseTo(4 * step, 9);
    expect(s.ghost(ground(3, 3), { item: 'cube', yaw: 0, tip: 0, slide: 2 }).boxes[0]!.c).toEqual(s.ghost(ground(3, 3), { item: 'cube', yaw: 0, tip: 0 }).boxes[0]!.c);
    // Off a ledge: pointing on the block's top near its edge, a slid plank reaches out past it, still resting on it.
    const blockEdge = Math.max(...s.compiled().scene.bodies.slice(0, 4).map((b) => b.pos[0] + 0.5 * h)); // the block ends here (x)
    const edge = down(s, blockEdge - 0.05, 0.26), out = s.ghost(edge, { item: 'plank', yaw: 0, tip: 0, slide: 4 });
    expect(edge.body).toBeGreaterThanOrEqual(0);
    expect(out.ok).toBe(true);
    // It rests on the block (its back end over it) and reaches out more than half its length past the edge.
    expect(out.boxes[0]!.c[0] - 2.5 * h).toBeLessThan(blockEdge);
    expect(out.boxes[0]!.c[0] + 2.5 * h - blockEdge).toBeGreaterThan(2.5 * h);
    expect(s.place(out)).toBe(true);
    expect(play(s).hash).toBe(s.compiled().hash);
  });

  it('removes only what was placed, a run domino by domino; undo restores the level exactly', () => {
    const base = level({ budget: 50 }), s = new BuildSession(base);
    const before = s.compiled().hash;
    expect(s.remove(0)).toBe(false); // the authored block
    s.place(s.ghost(ground(4, 0), { item: 'cube', yaw: 0, tip: 0 }));
    const path: P2[] = [[-8, -6], [-8, 6]];
    const run = s.stroke(path);
    expect(run.ok).toBe(true);
    expect(run.cost).toBe(Math.floor(12 / DOMINO_PITCH) + 1);
    s.lay(run);
    const n = s.compiled().meta.n;
    expect(s.spent()).toBe(1 + run.cost);
    // Take out the run's third domino: the run stays, with it omitted.
    const third = n - run.cost + 2;
    expect(s.removable(third)).toBe(true);
    expect(s.remove(third)).toBe(true);
    expect(s.compiled().meta.n).toBe(n - 1);
    expect(s.def().parts.at(-1)).toMatchObject({ kind: 'run', omit: [2] });
    expect(s.spent()).toBe(run.cost);
    expect(play(s).hash).toBe(s.compiled().hash);
    // The placed cube (body 4, after the block's 4 cubes) goes; then undo three times is the level as authored.
    expect(s.remove(4)).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(false);
    expect(s.compiled().hash).toBe(before);
    expect(s.def()).toEqual(base);
  });

  it('the brush drops dominoes that would cross the world or one another, and keeps the rest', () => {
    const s = new BuildSession(level({ budget: 100 }));
    // A straight run through the block: the dominoes inside it are left out.
    const through = s.stroke([[-3, 0.5], [6, 0.5]]);
    const inside = through.boxes.map((b, i) => [b.c[0], through.clash[i]] as const);
    for (const [x, bad] of inside) if (x > -0.1 * h && x < 2.1 * h) expect(bad).toBe(true);
    expect(through.part.omit!.length).toBe(through.clash.filter(Boolean).length);
    expect(through.ok).toBe(true);
    // A hairpin tighter than a domino is wide: the run's own dominoes would cross, so some drop.
    const hairpin: P2[] = [[-8, 0], [-8, 5], [-7.6, 5.4], [-7.2, 5], [-7.2, 0]];
    const tight = s.stroke(hairpin);
    expect(tight.clash.some(Boolean)).toBe(true);
    const c = compileLevel({ ...s.def(), parts: [...s.def().parts, tight.part] });
    expect(validateLevel(c).filter((i) => i.code === 'overlap')).toEqual([]);
  });

  it('honours the build block: items offered, brush off, budget absent; author mode removes anything and has no budget', () => {
    const s = new BuildSession(level({ pieces: ['cube'], brush: false }));
    expect(s.items.map((i) => i.name)).toEqual(['cube']);
    expect(s.budget).toBeNull();
    expect(s.ghost(ground(4, 0), { item: 'beam', yaw: 0, tip: 0 }).why).toMatch(/not offered/);
    expect(s.stroke([[0, 5], [5, 5]]).why).toMatch(/brush is not offered/);
    const a = new BuildSession({ ...L1, build: { budget: 0 } }, { author: true });
    expect(a.budget).toBeNull();
    a.place(a.ghost(ground(8, 8), { item: 'cube', yaw: 0, tip: 0 }));
    expect(a.def().parts.at(-1)).not.toHaveProperty('placed');
    expect(a.remove(a.compiled().meta.n - 1)).toBe(true);
    expect(a.compiled().hash).toBe(compileLevel({ ...L1, build: { budget: 0 } }).hash);
  });

  it('a placed piece re-reads exactly: its numbers are short and JSON round-trips them', () => {
    const s = new BuildSession(level());
    s.place(s.ghost(ground(1.234567891, -2.2), { item: 'domino', yaw: 33.3333333, tip: 0 }, { snap: false }));
    const p = s.def().parts.at(-1)!;
    expect(p).toMatchObject({ kind: 'piece', yaw: 33.333333, placed: true });
    for (const x of (p as { at: Vec3 }).at) expect(String(x).replace(/^-?\d*\.?/, '').length).toBeLessThanOrEqual(6);
    expect(play(s).scene.bodies).toEqual(s.compiled().scene.bodies);
  });
});
