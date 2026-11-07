// Mason's Trial's grammar, worlds and rules (M8, docs/game/masons-trial.md): the
// levels validate and pin 40 iterations whatever asks otherwise, the hash sees
// the test, world 0 is the build as placed and the other worlds' jitter is
// seeded, bounded and never pushes a piece into another, the pass rule counts
// per island in fixed point, and the score's two lines, stars and thresholds
// agree. Physics (the judge on the reference and the GPU) is in keystone-lab.
import { describe, expect, it } from 'vitest';
import { Islands, reduceIslands, type Snapshot } from '@tb/engine-api';
import {
  BuildSession, compileLevel, type Hit, type LevelDef, MASON_CLASS, MASON_CLEAR, MASON_HOLD, MASON_ITERATIONS, MASON_JITTER, MASON_LEVELS, MASON_WORLDS,
  masonBodies, masonClass, masonIssues, masonLines, masonPasses, masonProbes, masonQuestions, masonScore, masonStars, masonThresholds, masonTimeline,
  masonWorld, MT1, MT2, MT4, obbOfBody, obbOverlap, physicsOf, TOUCH, unitOf, validateLevel,
} from '@tb/keystone';

const ground = (def: LevelDef, x: number, z: number): Hit => {
  const h = unitOf(def);
  return { body: -1, point: [x * h, 0, z * h], normal: [0, 1, 0], t: 1 };
};
/** MT2 with two piers placed by the build tool (side by side, so the jitter's overlap guard has neighbours). */
function builtMT2(extra: Partial<LevelDef> = {}): LevelDef {
  const s = new BuildSession({ ...MT2, ...extra });
  for (const x of [-1, 1, 0]) {
    const g = s.ghost(ground(MT2, x, x === 0 ? 1.1 : 0), { item: x === 0 ? 'cube' : 'pier3', yaw: 0, tip: 0 });
    expect(s.place(g), g.why).toBe(true);
  }
  return s.def();
}

describe("Mason's Trial levels", () => {
  it('every level validates, has an empty rack and a budget, and plays at 40 iterations', () => {
    expect(MASON_LEVELS.map((d) => d.id)).toEqual(['MT1', 'MT2', 'MT3', 'MT4']);
    for (const def of MASON_LEVELS) {
      const c = compileLevel(def);
      expect(validateLevel(c), def.id).toEqual([]);
      expect(def.rack).toEqual([]);
      expect(def.objective.kind).toBe('trial');
      expect(def.build!.budget).toBeGreaterThan(0);
      expect(physicsOf(def).iterations).toBe(MASON_ITERATIONS);
      expect(MASON_ITERATIONS).toBe(40);
    }
  });

  it('40 iterations hold whatever the physics block says (a URL override rewrites it), and validation says so', () => {
    for (const iterations of [1, 8, 20, 39, 80, 200]) {
      const def: LevelDef = { ...MT1, physics: { iterations } };
      expect(physicsOf(def).iterations, `asked ${iterations}`).toBe(40);
      expect(masonIssues(def).some((m) => m.includes('40 iterations'))).toBe(true);
    }
    expect(masonIssues({ ...MT1, physics: { iterations: 40 } })).toEqual([]);
    // A non-Mason level still takes its block's iterations.
    const { mason: _, ...plain } = MT1;
    expect(physicsOf({ ...plain, physics: { iterations: 12 } }).iterations).toBe(12);
  });

  it('the test is part of the level hash (stars, run, probes, pass rule)', () => {
    const base = compileLevel(MT1).hash, m = MT1.mason!;
    const variants: LevelDef[] = [
      { ...MT1, mason: { ...m, stars: [m.stars[0] - 10, m.stars[1]] } },
      { ...MT1, mason: { ...m, run: m.run + 1 } },
      { ...MT1, mason: { ...m, probes: [{ ...m.probes[0]!, radius: 0.44 } as (typeof m.probes)[number]] } },
      { ...MT1, mason: { ...m, pass: [m.pass[0]!] } },
    ];
    const hashes = new Set([base, ...variants.map((d) => compileLevel(d).hash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('validation refuses malformed tests, and a drop threshold on a resting height', () => {
    const m = MT4.mason!, issues = (mason: Partial<typeof m>, extra: Partial<LevelDef> = {}) => masonIssues({ ...MT4, ...extra, mason: { ...m, ...mason } });
    expect(issues({ pass: [{ who: 'probe', test: 'dropped', d: 2, atMost: 0 }] }).join()).toMatch(/resting height/);
    expect(issues({ pass: [{ who: 'probe', test: 'dropped', d: 1.97, atMost: 0 }] }).join()).toMatch(/resting height/);
    expect(issues({ pass: [{ who: 'probe', test: 'dropped', d: 1.94, atMost: 0 }] })).toEqual([]);
    expect(issues({ pass: [{ who: 'heritage', test: 'moved', d: 0.25, atMost: 0 }] }).join()).toMatch(/has none/);
    expect(issues({ pass: [{ who: 'probe', test: 'advanced', d: 1, atLeast: 1 }] }).join()).toMatch(/needs a dir/);
    expect(issues({ pass: [{ who: 'probe', test: 'moved', d: 1 }] }).join()).toMatch(/atMost or atLeast/);
    expect(issues({ stars: [500, 400] }).join()).toMatch(/stars/);
    expect(issues({ run: 0 }).join()).toMatch(/run/);
    expect(issues({ probes: [] }).join()).toMatch(/probe or a quake/);
    expect(issues({ quake: { peak: 3, hz: 2, seconds: 2, axis: 'x' } }).join()).toMatch(/quake/);
    expect(issues({}, { build: { budget: 0, pieces: ['cube'] } }).join()).toMatch(/budget/);
    // A rack on a Mason level is refused by validateLevel (the test replaces the shots).
    expect(validateLevel(compileLevel({ ...MT4, rack: ['cannonball'] })).map((i) => i.code)).toContain('mason');
  });

  it('the timeline: pre-settle, then the hold, then the run', () => {
    for (const def of MASON_LEVELS) {
      const t = masonTimeline(compileLevel(def));
      expect(t.presettle).toBe(physicsOf(def).presettle);
      expect(t.test).toBe(t.presettle + (def.mason!.hold ?? MASON_HOLD));
      expect(t.end).toBe(t.test + def.mason!.run);
    }
  });
});

describe('the worlds', () => {
  it('world 0 is the build as placed; the other worlds are seeded, bounded, and move only placed, unpinned pieces', () => {
    const c = compileLevel(builtMT2()), h = unitOf(c.def), a = MASON_JITTER.place * h;
    expect(masonBodies(c, 0)).toEqual(c.scene.bodies);
    expect(masonBodies(c, 5)).toEqual(masonBodies(c, 5));
    let movedSome = 0;
    for (let k = 1; k < MASON_WORLDS; k++) {
      const w = masonBodies(c, k);
      w.forEach((b, i) => {
        const o = c.scene.bodies[i]!, dx = b.pos[0] - o.pos[0], dz = b.pos[2] - o.pos[2];
        expect(b.pos[1]).toBe(o.pos[1]);
        expect(Math.abs(dx)).toBeLessThanOrEqual(a);
        expect(Math.abs(dz)).toBeLessThanOrEqual(a);
        const placed = 'placed' in c.def.parts[c.meta.part[i]!]!;
        if (!placed) expect([dx, dz]).toEqual([0, 0]);
        else if (dx || dz) movedSome++;
      });
    }
    expect(movedSome).toBeGreaterThan(0);
    expect(masonBodies(c, 1)).not.toEqual(masonBodies(c, 2));
  });

  it('a jitter never pushes a piece into a neighbour deeper than the build had it (even a jitter of half a cell)', () => {
    const big = builtMT2({ mason: { ...MT2.mason!, jitter: { place: 0.5 } } }), c = compileLevel(big), h = unitOf(c.def);
    const base = c.scene.bodies.map(obbOfBody);
    let reverted = 0;
    for (let k = 1; k < MASON_WORLDS; k++) {
      const w = masonBodies(c, k), obb = w.map(obbOfBody);
      for (let i = 0; i < w.length; i++) {
        if (w[i]!.pos[0] === c.scene.bodies[i]!.pos[0] && 'placed' in c.def.parts[c.meta.part[i]!]!) reverted++;
        for (let j = i + 1; j < w.length; j++) expect(obbOverlap(obb[i]!, obb[j]!), `world ${k}: ${i} into ${j}`).toBeLessThanOrEqual(Math.max(obbOverlap(base[i]!, base[j]!), 0) + 2 * TOUCH * h + 1e-12);
      }
    }
    expect(reverted, 'some shifts were refused').toBeGreaterThan(0);
  });

  it("the probes spawn at the test's start: as authored in world 0, nudged and their speed varied within the jitter elsewhere", () => {
    const c = compileLevel(MT1), m = MT1.mason!, h = unitOf(MT1), step = masonTimeline(c).test, p = m.probes[0]!;
    const [e0] = masonProbes(c, 0);
    expect(e0!.step).toBe(step);
    expect(e0!.body.pos).toEqual([p.at[0] * h, p.at[1] * h, p.at[2] * h]);
    expect(e0!.body.linVel).toEqual(p.vel!.map((v) => v * h));
    const pj = m.jitter!.probe! * h, sj = MASON_JITTER.speed;
    for (let k = 1; k < MASON_WORLDS; k++) {
      const [e] = masonProbes(c, k);
      expect(e!.step).toBe(step);
      expect(Math.abs(e!.body.pos[0] - p.at[0] * h)).toBeLessThanOrEqual(pj);
      expect(Math.abs(e!.body.pos[2] - p.at[2] * h)).toBeLessThanOrEqual(pj);
      expect(e!.body.pos[1]).toBe(p.at[1] * h);
      const s = e!.body.linVel[0] / (p.vel![0] * h);
      expect(Math.abs(s - 1)).toBeLessThanOrEqual(sj);
    }
    expect(masonWorld(c, 3).inputs).toEqual(masonProbes(c, 3));
  });
});

describe('the pass rule', () => {
  it('masonClass: heritage, probes (past the structure) and everything else', () => {
    const c = compileLevel(MT2);
    expect(masonClass(c, 0)).toBe(MASON_CLASS.heritage);
    expect(masonClass(c, c.meta.n)).toBe(MASON_CLASS.probe);
    const c1 = compileLevel(MT1);
    expect(masonClass(c1, 0)).toBe(MASON_CLASS.other);
  });

  it('counts heritage moved per island, in each island\'s own frame, either side of the threshold', () => {
    const c = compileLevel(MT2), h = unitOf(MT2), isl = new Islands([0, 1, 2].map((k) => masonWorld(c, k)));
    const ref = Float64Array.from(isl.scene.bodies.flatMap((b) => b.pos));
    const pos = ref.slice(), n = c.scene.bodies.length;
    // World 1's urn 0.26 h along x, world 2's 0.18 h along x and along z (0.255 h): both moved; world 0 stays.
    pos[3 * n]! += 0.26 * h;
    pos[3 * 2 * n]! += 0.18 * h;
    pos[3 * 2 * n + 2]! += 0.18 * h;
    const count = pos.length / 3;
    const snap: Snapshot = { count, pos, rot: new Float64Array(4 * count), linVel: new Float64Array(3 * count), angVel: new Float64Array(3 * count), awake: new Uint8Array(count) };
    const counts = reduceIslands(isl, snap, masonQuestions(c), { refs: [ref, ref], tagWords: 2, fill: (id, row) => { row[1] = masonClass(c, isl.localOf(id)); } }).counts;
    expect(Array.from(counts[0]!)).toEqual([0, 1, 1]);
    // Just under the threshold is not moved.
    pos.set(ref);
    pos[3 * n]! += 0.249 * h;
    const under = reduceIslands(isl, snap, masonQuestions(c), { refs: [ref, ref], tagWords: 2, fill: (id, row) => { row[1] = masonClass(c, isl.localOf(id)); } }).counts;
    expect(Array.from(under[0]!)).toEqual([0, 0, 0]);
  });

  it('masonPasses reads atMost and atLeast per clause', () => {
    const m = MT1.mason!;
    expect(masonPasses(m, [1, 0])).toBe(true);
    expect(masonPasses(m, [0, 0])).toBe(false);
    expect(masonPasses(m, [1, 1])).toBe(false);
    expect(masonPasses(MT2.mason!, [0])).toBe(true);
    expect(masonPasses(MT2.mason!, [1])).toBe(false);
  });
});

describe("Mason's score", () => {
  it('the two lines sum to the total, a robust build that spends the budget scores 500', () => {
    for (const [p, K, l, b] of [[64, 64, 0, 12], [64, 64, 5, 12], [40, 64, 3, 10], [0, 64, 16, 16], [31, 64, 10, 12]] as const) {
      const lines = masonLines(p, K, l, b), total = lines[0]!.value + lines[1]!.value;
      expect(Math.abs(total - (1000 * (p / K) * (1 + l / b)) / 2)).toBeLessThanOrEqual(1);
      expect(lines[0]!.label).toBe(`Robust ${p}/${K}`);
      expect(lines[1]!.label).toBe(`Budget left ${l}/${b}`);
    }
    expect(masonScore(MT1, 64, 64, 12).total).toBe(500);
  });

  it('uncleared builds get no stars whatever their points; stamps; thresholds agree with the stars', () => {
    const K = 64, one = Math.ceil(K * MASON_CLEAR), stars: [number, number] = [450, 630];
    const def: LevelDef = { ...MT1, mason: { ...MT1.mason!, stars } };
    // 31 of 64 with most of the budget left scores past t2, and is still uncleared: 0 stars.
    const s31 = masonScore(def, one - 1, K, 1);
    expect(s31.total).toBeGreaterThanOrEqual(stars[0]);
    expect(s31.stars).toBe(0);
    expect(s31.stamp).toBe('WOBBLY');
    expect(masonScore(def, one, K, 12).stamp).toBe('STANDS');
    expect(masonScore(def, K, K, 12).stamp).toBe('ROBUST');
    for (const spent of [1, 5, 7, 12]) {
      const left = 12 - spent, th = masonThresholds(K, left, 12, stars);
      expect(th[0]).toBe(one);
      expect(th[1]).toBeGreaterThanOrEqual(th[0]);
      expect(th[2]).toBeGreaterThanOrEqual(th[1]);
      for (let p = 0; p <= K; p++) {
        const s = masonScore(def, p, K, spent);
        expect(s.stars, `spent ${spent}, ${p} passes`).toBe(p >= th[2] ? 3 : p >= th[1] ? 2 : p >= th[0] ? 1 : 0);
        expect(s.worlds).toEqual({ cleared: p, of: K, thresholds: th });
        expect(s.mason).toEqual({ left, budget: 12 });
        expect(s.leverage).toBe(0);
      }
    }
    // Out of reach: a build that spends the whole budget never makes 630.
    expect(masonThresholds(K, 0, 12, stars)[2]).toBe(K + 1);
    expect(masonStars(true, 629, stars)).toBe(2);
    expect(masonStars(true, 630, stars)).toBe(3);
  });
});
