// Outcome measures and scoring (docs/game/spectacle-mode.md, sections 4 and 6),
// on synthetic body states: no engine involved. The tally and star cases sit on
// the boundaries, so changing any weight or turning any comparison strict (or
// not) fails a case.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import {
  baselineOf, collapseFraction, compileLevel, floorPotential_mJ, L1, homePotential_mJ, homeSkyline, type LevelDef, metricValue, objectiveMet, OUTCOME_WEIGHTS, type OutcomeFacts,
  outcomeScore, outcomeStars, outcomeTally, type Part, peOf_mJ, potential_mJ, QUIET_SPEED, QUIET_SPIN, rackSizeProblem, reduceCpu, Session, skyline, type StarsDef, validateLevel,
} from '@tb/keystone';

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

const parts: Part[] = [
  { kind: 'block', at: [0, 0, 0], size: [2, 4, 1], material: 'plaster', courses: [{ k: 3, role: 'crown' }] },
  { kind: 'slab', at: [4, 0, 0], half: [2, 0.25, 1], material: 'stone' },
  { kind: 'rod', at: [4, 0.5, 0], half: [0.25, 2, 0.25], material: 'iron' },
  { kind: 'block', at: [-3, 0, 0], size: [1, 2, 1], material: 'ice', role: 'heritage' },
];
const def: LevelDef = {
  id: 'O', name: 'o', version: 1, world: 0, lot: { min: [-6, -4], max: [8, 4] }, crownLine: 2, objective: { kind: 'collapse', min: 0.5 }, par: 2,
  rack: ['marble', 'cannonball'], launcher: { radius: 10, y: 1, dropY: 10 }, parts, scoring: 'outcome',
};
const c = compileLevel(def);
const n = c.meta.n, h = c.frame.unit;
const minHalf = (i: number) => Math.min(c.meta.half[3 * i]!, c.meta.half[3 * i + 1]!, c.meta.half[3 * i + 2]!);

function atHome(extra = 0): Snapshot {
  const s = emptySnapshot(n + extra);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}
const heights = (s: Snapshot) => s.pos.slice(0, 3 * n);

describe('collapse fraction', () => {
  it('floor energy is every body on its largest face; D is 0 at home and 1 all flat', () => {
    expect(floorPotential_mJ(c)).toBe(Array.from({ length: n }, (_, i) => peOf_mJ(c.meta.mass[i]!, minHalf(i))).reduce((a, b) => a + b));
    const pe0 = homePotential_mJ(c), floor = floorPotential_mJ(c);
    expect(pe0).toBe(potential_mJ(atHome(), c));
    expect(collapseFraction(pe0, pe0, floor)).toBe(0);
    const flat = atHome();
    for (let i = 0; i < n; i++) flat.pos[3 * i + 1] = minHalf(i);
    expect(collapseFraction(pe0, potential_mJ(flat, c), floor)).toBe(1);
  });

  it('clamps to [0, 1], and is 0 when there is nothing to bring down', () => {
    expect(collapseFraction(1000, 1200, 100)).toBe(0); // lifted
    expect(collapseFraction(1000, 50, 100)).toBe(1); // under the floor (sunk into the ground)
    expect(collapseFraction(1000, 550, 100)).toBe(0.5);
    expect(collapseFraction(100, 50, 100)).toBe(0);
    expect(collapseFraction(90, 50, 100)).toBe(0);
  });

  it('never grows when a body is raised, and never shrinks when one is lowered', () => {
    const r = rng(7), pe0 = homePotential_mJ(c), floor = floorPotential_mJ(c);
    let pos = heights(atHome());
    for (let t = 0; t < 2000; t++) {
      const i = Math.floor(r() * n), before = collapseFraction(pe0, homePotential_mJ(c, pos), floor);
      const next = pos.slice();
      next[3 * i + 1] = Math.max(0, next[3 * i + 1]! + (r() - 0.5) * 4 * h);
      const after = collapseFraction(pe0, homePotential_mJ(c, next), floor);
      if (next[3 * i + 1]! > pos[3 * i + 1]!) expect(after).toBeLessThanOrEqual(before);
      else expect(after).toBeGreaterThanOrEqual(before);
      pos = next;
    }
  });

  it('is the same number whatever order the bodies come in', () => {
    // One body per part, so a permutation of the parts is a permutation of the bodies.
    const single: Part[] = Array.from({ length: 24 }, (_, k) => ({ kind: 'slab', at: [k * 3, (k % 5) * 0.37, (k % 3) * 2], half: [1, 0.25 + (k % 4) * 0.1, 0.5], material: k % 2 ? 'stone' : 'plaster' }));
    const r = rng(3), order = single.map((_, k) => k).sort(() => r() - 0.5);
    const a = compileLevel({ ...def, parts: single }), b = compileLevel({ ...def, parts: order.map((k) => single[k]!) });
    const drop = (k: number) => (k * 0.137) % 0.4; // each body lowered by its own amount
    const endA = new Float64Array(3 * 24), endB = new Float64Array(3 * 24);
    for (let k = 0; k < 24; k++) endA[3 * k + 1] = a.meta.home[3 * k + 1]! - drop(k);
    order.forEach((k, j) => { endB[3 * j + 1] = b.meta.home[3 * j + 1]! - drop(k); });
    const D = (x: typeof a, end: Float64Array) => collapseFraction(homePotential_mJ(x), homePotential_mJ(x, end), floorPotential_mJ(x));
    expect(D(a, endA)).toBeGreaterThan(0);
    expect(D(b, endB)).toBe(D(a, endA));
  });

  it('a Session measures D from its home: the pre-settled poses, not the authored ones', () => {
    const home = heights(atHome());
    home[1] = home[1]! - 0.001; // settled 1 mm
    const se = new Session(c, home);
    expect(se.startPe_mJ).toBe(homePotential_mJ(c, home));
    expect(se.floorPe_mJ).toBe(floorPotential_mJ(c));
    expect(se.collapse(se.startPe_mJ)).toBe(0);
    expect(se.collapse(se.floorPe_mJ)).toBe(1);
  });
});

describe('moving bodies', () => {
  it('counts awake structure bodies over the quiet speed or spin, and boxes their centres', () => {
    const s = atHome(1), base = baselineOf(s, c, 0);
    s.awake.fill(1);
    s.linVel[3 * 0] = QUIET_SPEED; // exactly quiet: not moving
    s.linVel[3 * 1] = QUIET_SPEED * 1.01;
    s.angVel[3 * 2 + 1] = QUIET_SPIN * 1.01;
    s.linVel[3 * 3 + 2] = -5; s.awake[3] = 0; // asleep: not counted
    s.linVel[3 * n] = 20; // ammo: not structure
    const r = reduceCpu(s, null, c, base, 1);
    expect(r.nMoving).toBe(2);
    const p = (i: number, k: number) => c.meta.home[3 * i + k]!;
    expect(Array.from(r.movingBox)).toEqual([0, 1, 2].map((k) => Math.min(p(1, k), p(2, k))).concat([0, 1, 2].map((k) => Math.max(p(1, k), p(2, k)))));
  });
  it('the box is empty when nothing moves', () => {
    const s = atHome();
    const r = reduceCpu(s, null, c, baselineOf(s, c, 0), 1);
    expect(r.nMoving).toBe(0);
    expect(Array.from(r.movingBox)).toEqual([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  });
});

describe('objectives', () => {
  const s = atHome(), red = reduceCpu(s, null, c, baselineOf(s, c, 0), 1);
  it('collapse is met at its minimum, not below it', () => {
    expect(objectiveMet(c, { red, crownsTotal: 0, collapse: 0.5 }, 'outcome')).toBe(true);
    expect(objectiveMet(c, { red, crownsTotal: 0, collapse: 0.5 - 1e-12 }, 'outcome')).toBe(false);
  });
  it('crowns needs every crown down', () => {
    const nc = c.meta.crowns.length;
    expect(objectiveMet(c, { red, crownsTotal: nc, collapse: 0 }, 'par', { kind: 'crowns' })).toBe(true);
    expect(objectiveMet(c, { red, crownsTotal: nc - 1, collapse: 0 }, 'par', { kind: 'crowns' })).toBe(false);
  });
  it('a skyline footprint limit is part of the objective on par levels and only costs points on outcome levels', () => {
    const outside = { ...red, outOfLot: 3 }, obj = { kind: 'skyline' as const, maxH: 10, footprintMax: 2 / n };
    expect(objectiveMet(c, { red: outside, crownsTotal: 0, collapse: 0 }, 'par', obj)).toBe(false);
    expect(objectiveMet(c, { red: outside, crownsTotal: 0, collapse: 0 }, 'outcome', obj)).toBe(true);
    expect(objectiveMet(c, { red, crownsTotal: 0, collapse: 0 }, 'par', { kind: 'skyline', maxH: skyline(red.heightHist, c.height) / h - 0.01 })).toBe(false);
  });
  it('the home skyline is the skyline the observer reads at home', () => {
    expect(homeSkyline(c)).toBe(skyline(red.heightHist, c.height));
  });
});

const facts = (o: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  met: true, collapse: 0.5, leverage: 3, comboMax: 3, hasCrowns: true, rackLeft: 2, heritageBroken: 1, outOfLot: 0.25, footprintMax: 0.125, crownsDown: 4, skylineRatio: 0.4, pulled: 0, ...o,
});
const lines = (f: OutcomeFacts) => Object.fromEntries(outcomeTally(f).map((l) => [l.label, l.value]));

describe('tally', () => {
  it('scores each line by its weight', () => {
    expect(OUTCOME_WEIGHTS).toEqual({ objective: 1000, collapse: 3000, leverage: 300, combo: 50, comboCap: 12, rackLeft: 400, pulled: 3000, condemned: 500, heritage: -500, footprint: -3000, spill: -3000 });
    expect(outcomeTally(facts())).toEqual([
      { label: 'Objective', value: 1000 },
      { label: 'Collapse', value: 1500 },
      { label: 'Leverage', value: 600 }, // 300 log2(1 + 3)
      { label: 'Combo', value: 300 }, // 50 T(3)
      { label: 'Rack left', value: 800 },
      { label: 'Heritage', value: -500 },
      { label: 'Footprint', value: -375 }, // -3000 (0.25 - 0.125)
    ]);
  });
  it.each([
    ['not met: no objective line and no rack-left points', facts({ met: false }), { Collapse: 1500, Leverage: 600, Combo: 300, Heritage: -500, Footprint: -375 }],
    ['the combo counts at most 12 crowns in one shot', facts({ comboMax: 20, heritageBroken: 0, footprintMax: undefined }), { Objective: 1000, Collapse: 1500, Leverage: 600, Combo: 3900, 'Rack left': 800 }],
    ['no crowns: no combo line; nothing left: no rack line', facts({ hasCrowns: false, rackLeft: 0, heritageBroken: 0 }), { Objective: 1000, Collapse: 1500, Leverage: 600, Footprint: -375 }],
    ['footprint exactly at the limit costs nothing', facts({ outOfLot: 0.125, heritageBroken: 0, rackLeft: 0 }), { Objective: 1000, Collapse: 1500, Leverage: 600, Combo: 300 }],
    ['collapse and leverage round down', facts({ collapse: 0.33334, leverage: 0.5, comboMax: 0, heritageBroken: 0, rackLeft: 0, footprintMax: undefined }), { Objective: 1000, Collapse: 1000, Leverage: 175, Combo: 0 }],
  ])('%s', (_name, f, want) => {
    expect(lines(f)).toEqual(want);
  });
});

describe('stars', () => {
  const cast: StarsDef = { metric: 'collapse', t2: 0.4, t3: 0.6, best: 0.8 };
  it.each([
    ['not met', undefined, 'collapse', 0.9, false, 0, { stars: 0, beatBot: false, uncast: true }],
    ['uncast: the objective star only', undefined, 'collapse', 0.9, true, 0, { stars: 1, beatBot: false, uncast: true }],
    ['cast for another metric counts as uncast', cast, 'score', 9999, true, 0, { stars: 1, beatBot: false, uncast: true }],
    ['just under t2', cast, 'collapse', 0.4 - 1e-12, true, 0, { stars: 1, beatBot: false, uncast: false }],
    ['at t2', cast, 'collapse', 0.4, true, 0, { stars: 2, beatBot: false, uncast: false }],
    ['at t3', cast, 'collapse', 0.6, true, 0, { stars: 3, beatBot: false, uncast: false }],
    ['at t3 with heritage broken', cast, 'collapse', 0.6, true, 1, { stars: 2, beatBot: false, uncast: false }],
    // PT28: heritage costs a star at every tier, not only the third, down to none.
    ['at t2 with heritage broken', cast, 'collapse', 0.4, true, 1, { stars: 1, beatBot: false, uncast: false }],
    ['met under t2 with heritage broken: no star', cast, 'collapse', 0.3, true, 25, { stars: 0, beatBot: false, uncast: false }],
    ['uncast with heritage broken: no star', undefined, 'collapse', 0.9, true, 1, { stars: 0, beatBot: false, uncast: true }],
    ['past the best with heritage broken', cast, 'collapse', 0.9, true, 1, { stars: 2, beatBot: true, uncast: false }],
    ['at the best is not beating it', cast, 'collapse', 0.8, true, 0, { stars: 3, beatBot: false, uncast: false }],
    ['past the best', cast, 'collapse', 0.8 + 1e-12, true, 0, { stars: 3, beatBot: true, uncast: false }],
  ] as const)('%s', (_name, k, metric, value, met, broken, want) => {
    expect(outcomeStars(k, metric, value, met, broken)).toEqual(want);
  });
  it('skyline: lower is better', () => {
    const sky: StarsDef = { metric: 'skyline', t2: 0.5, t3: 0.3, best: 0.2 };
    expect(outcomeStars(sky, 'skyline', 0.5, true, 0).stars).toBe(2);
    expect(outcomeStars(sky, 'skyline', 0.5 + 1e-12, true, 0).stars).toBe(1);
    expect(outcomeStars(sky, 'skyline', 0.3, true, 0).stars).toBe(3);
    expect(outcomeStars(sky, 'skyline', 0.2, true, 0).beatBot).toBe(false);
    expect(outcomeStars(sky, 'skyline', 0.2 - 1e-12, true, 0).beatBot).toBe(true);
  });
  it('each metric reads its own fact', () => {
    const f = facts();
    expect([metricValue('collapse', f, 7), metricValue('crowns', f, 7), metricValue('skyline', f, 7), metricValue('score', f, 7)]).toEqual([0.5, 4, 0.4, 7]);
  });
  it('the score: total, stars on the level metric, and a stamp saying how much came down', () => {
    const s = outcomeScore(facts({ heritageBroken: 0 }), cast);
    expect(s.total).toBe(1000 + 1500 + 600 + 300 + 800 - 375);
    expect(s).toMatchObject({ stars: 2, stamp: '50% DOWN', leverage: 3, outcome: { collapse: 0.5, metric: 'collapse', value: 0.5, beatBot: false, uncast: false } });
    expect(outcomeScore(facts({ met: false }), cast)).toMatchObject({ stars: 0, stamp: 'INCOMPLETE' });
    expect(outcomeScore(facts({ collapse: 0.9, heritageBroken: 0 }), cast)).toMatchObject({ stamp: 'BEAT THE BOT' });
    // PT28: met with heritage broken is never a gold stamp, even past the bot.
    expect(outcomeScore(facts({ collapse: 0.9 }), cast)).toMatchObject({ stamp: 'HERITAGE LOST', outcome: { beatBot: true } });
    expect(outcomeScore(facts({ met: false }), cast).stamp).toBe('INCOMPLETE');
    const byScore = outcomeScore(facts(), { metric: 'score', t2: 3000, t3: 3325 });
    expect(byScore).toMatchObject({ total: 3325, stars: 2, outcome: { metric: 'score', value: 3325 } }); // heritage broken: no third star
    expect(outcomeScore(facts({ heritageBroken: 0 }), undefined)).toMatchObject({ stars: 1, outcome: { metric: 'collapse', uncast: true } });
    expect(outcomeScore(facts(), undefined)).toMatchObject({ stars: 0, stamp: 'HERITAGE LOST', heritageStarsLost: 1 }); // PT28
  });
});

describe('level fields', () => {
  it('stars are not part of the level hash; scoring is, with par the same as absent', () => {
    const { scoring: _s, ...par } = def;
    expect(compileLevel({ ...def, stars: { metric: 'collapse', t2: 0.1, t3: 0.2 } }).hash).toBe(c.hash);
    expect(compileLevel({ ...par, scoring: 'par' }).hash).toBe(compileLevel(par).hash);
    expect(compileLevel(par).hash).not.toBe(c.hash);
    expect(compileLevel({ ...def, objective: { kind: 'collapse', min: 0.6 } }).hash).not.toBe(c.hash);
  });
});

describe('hold objective (Undercut, docs/game/undercut-bullet-time.md)', () => {
  const holdDef: LevelDef = { ...L1, id: 'H', scoring: 'outcome', objective: { kind: 'hold' }, rack: ['pull', 'pull'] };
  const hc = compileLevel(holdDef);
  const red0 = reduceCpu((() => { const s = emptySnapshot(hc.meta.n); s.pos.set(hc.meta.home); for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1; return s; })(), null, hc, baselineOf((() => { const s = emptySnapshot(hc.meta.n); s.pos.set(hc.meta.home); return s; })(), hc, 0), 0);
  it('is met while every crown is up, not once one is down', () => {
    expect(objectiveMet(hc, { red: red0, crownsTotal: 0, collapse: 0 }, 'outcome')).toBe(true);
    expect(objectiveMet(hc, { red: red0, crownsTotal: 1, collapse: 0 }, 'outcome')).toBe(false);
  });
  it('tallies the objective and what was pulled only, and stamps PULLED or TOPPLED', () => {
    const held = outcomeScore(facts({ hold: true, pulled: 0.35, heritageBroken: 0, outOfLot: 0 }), undefined);
    expect(held.lines).toEqual([{ label: 'Objective', value: 1000 }, { label: 'Pulled', value: 1050 }]);
    expect(held.stamp).toBe('35% PULLED');
    expect(held.outcome.metric).toBe('pulled');
    expect(held.outcome.value).toBe(0.35);
    const fell = outcomeScore(facts({ hold: true, met: false, pulled: 0.4, heritageBroken: 0, outOfLot: 0 }), undefined);
    expect(fell.lines).toEqual([]);
    expect(fell.stamp).toBe('TOPPLED');
    expect(fell.stars).toBe(0);
    // Cast thresholds on the pulled share give stars as for any metric.
    expect(outcomeScore(facts({ hold: true, pulled: 0.5, heritageBroken: 0 }), { metric: 'pulled', t2: 0.2, t3: 0.4 }).stars).toBe(3);
  });
  it('validates only on outcome levels with a crown', () => {
    expect(validateLevel(hc).filter((i) => i.code === 'objective')).toEqual([]);
    expect(validateLevel(compileLevel({ ...holdDef, scoring: 'par' })).map((i) => i.message)).toContain('a hold objective needs outcome scoring (a par level ends at its clear)');
    const crownless = compileLevel({ ...holdDef, parts: [{ kind: 'block', at: [-1, 0, -1], size: [2, 4, 2], material: 'plaster' }] });
    expect(validateLevel(crownless).map((i) => i.message)).toContain('a hold objective needs a crown to keep up');
  });
  it('counts pulls apart from fired items in the rack size', () => {
    expect(rackSizeProblem(Array(24).fill('pull'))).toBeNull();
    expect(rackSizeProblem([...Array(24).fill('pull'), ...Array(8).fill('marble')])).toBeNull();
    expect(rackSizeProblem(Array(25).fill('pull'))).toMatch(/25 pulls, over 24/);
    expect(rackSizeProblem(Array(9).fill('marble'))).toMatch(/9 fired items, over 8/);
    expect(rackSizeProblem([])).toMatch(/empty/);
  });
});
