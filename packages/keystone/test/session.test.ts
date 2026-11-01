// The state machine driven by synthetic body states: no engine involved.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { compileLevel, CpuObserver, type Feedback, GRAVITY, homeSkyline, type LevelDef, type OutcomeScore, peOf_mJ, SETTLE_MIN, SETTLE_QUIET, Session, type Shot } from '@tb/keystone';

const def: LevelDef = {
  id: 'S', name: 's', version: 1, world: 0, lot: { min: [-4, -4], max: [4, 4] }, crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'cannonball'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [0, 0, 0], size: [1, 3, 1], material: 'plaster', courses: [{ k: 2, role: 'crown' }] },
    { kind: 'block', at: [2, 0, 0], size: [1, 1, 1], material: 'plaster', role: 'heritage' },
  ],
};
const c = compileLevel(def);
const n = c.meta.n, crown = c.meta.crowns[0]!, heritage = c.meta.heritage[0]!;
const marble: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 100 };

function world(ammo: number): Snapshot {
  const s = emptySnapshot(n + ammo);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}

/** Fires, then feeds `frames` (each mutates a fresh copy of the world) and collects feedback. */
function play(session: Session, obs: CpuObserver, s: Snapshot, frames: Array<(s: Snapshot, t: number) => void>, start: number): Feedback[] {
  const out: Feedback[] = [];
  frames.forEach((mutate, t) => {
    mutate(s, t);
    out.push(...session.observe(obs.observe(s, start + 1 + t, session.watchIdx)));
  });
  return out;
}

const still = (count: number) => Array.from({ length: count }, () => (s: Snapshot) => { s.awake.fill(0); s.linVel.fill(0); });

describe('Session', () => {
  it('fires only while aiming, only with ammo left in the rack', () => {
    const se = new Session(c);
    expect(se.canFire('cue')).toBe(false);
    expect(() => se.fire({ ammo: 'drop', x: 0, z: 0 }, 0)).toThrow(/cannot fire drop/);
    const { spawn, feedback } = se.fire(marble, 10);
    expect(spawn.step).toBe(10);
    expect(feedback).toEqual([expect.objectContaining({ t: 'fired', body: n, ammo: 'marble' })]);
    expect(se.phase).toBe('running');
    expect(se.rackLeft).toEqual(['cannonball']);
    expect(() => se.fire({ ...marble, ammo: 'cannonball' }, 11)).toThrow(/phase running/);
    expect(Array.from(se.watchIdx)).toEqual([crown, heritage, n]);
  });

  it('a quiet miss settles back to aiming with a zero-leverage outcome', () => {
    const se = new Session(c), s = world(1), obs = new CpuObserver(c, s);
    se.fire(marble, 0);
    const fb = play(se, obs, s, still(SETTLE_MIN + SETTLE_QUIET), 0);
    const settled = fb.find((f) => f.t === 'settled');
    expect(settled).toMatchObject({ t: 'settled', shot: 0, outcome: { crownsDown: 0, leverage: 0, heritageNew: 0 } });
    expect(se.phase).toBe('aiming');
    expect(se.strokes).toBe(1);
  });

  it('reports first contact once, crowns in order, slow motion, tier crossings, and clears', () => {
    const se = new Session(c), s = world(1), obs = new CpuObserver(c, s);
    se.fire(marble, 0);
    const dt = 1 / 60;
    const frames = [
      // Free flight: velocity changes only by gravity.
      (w: Snapshot) => { w.awake[n] = 1; w.pos.set([2, 1, 0], 3 * n); w.linVel.set([-15, 0, 0], 3 * n); },
      (w: Snapshot) => { w.linVel.set([-15, -GRAVITY * dt, 0], 3 * n); },
      // Contact: the marble stops dead.
      (w: Snapshot) => { w.linVel.set([0, 0, 0], 3 * n); },
      (w: Snapshot) => { w.linVel.set([0.3, -1, 0], 3 * n); },
      // The crown falls fast and lands below the crown line.
      (w: Snapshot) => { w.awake[crown] = 1; w.linVel.set([0, -3, 0], 3 * crown); w.pos[3 * crown + 1] = 0.25; },
      ...still(SETTLE_QUIET + SETTLE_MIN),
    ];
    const fb = play(se, obs, s, frames, 0);
    const kinds = fb.map((f) => f.t).filter((t) => t !== 'impacts');
    expect(kinds.filter((k) => k === 'contact')).toHaveLength(1);
    expect(fb.find((f) => f.t === 'contact')).toMatchObject({ step: 3 });
    expect(fb.filter((f) => f.t === 'crownDown')).toEqual([{ t: 'crownDown', step: 5, body: crown, ordinal: 0 }]);
    expect(fb.filter((f) => f.t === 'slowMo')).toHaveLength(1);
    const tiers = fb.filter((f) => f.t === 'tier').map((f) => (f as { tier: number }).tier);
    expect(tiers).toEqual([...new Set(tiers)]); // each tier at most once
    expect(kinds.slice(-2)).toEqual(['settled', 'levelEnd']);
    expect(se.phase).toBe('cleared');
    expect(se.score).toMatchObject({ stars: expect.any(Number), stamp: 'PAR' });
    expect(se.outcomes[0]!.crownsDown).toBe(1);
    expect(se.outcomes[0]!.dPE_mJ).toBeGreaterThan(0);
  });

  it('breaks heritage once and fails when the rack runs out', () => {
    const se = new Session(c), s = world(2), obs = new CpuObserver(c, s);
    se.fire(marble, 0);
    let fb = play(se, obs, s, [(w) => { w.pos[3 * heritage] = w.pos[3 * heritage]! + 0.5; }, ...still(SETTLE_MIN + SETTLE_QUIET)], 0);
    expect(fb.filter((f) => f.t === 'heritageCrack')).toHaveLength(1);
    expect(se.phase).toBe('aiming');
    se.fire({ ...marble, ammo: 'cannonball' }, 100);
    obs.setBaseline(s, 100);
    fb = play(se, obs, s, still(SETTLE_MIN + SETTLE_QUIET), 100);
    expect(fb.filter((f) => f.t === 'heritageCrack')).toHaveLength(0);
    expect(fb.at(-1)).toMatchObject({ t: 'levelEnd', cleared: false });
    expect(se.phase).toBe('failed');
    expect(se.score!.lines.find((l) => l.label === 'Heritage')!.value).toBe(-500);
  });

  it('judges heritage against the settled home it was given, not the authored pose', () => {
    const home = c.meta.home.slice();
    home[3 * heritage + 1]! -= 0.2 * c.frame.unit; // the engine compressed the stack a little
    const se = new Session(c, home), s = world(1);
    s.pos[3 * heritage + 1] = home[3 * heritage + 1]!;
    const obs = new CpuObserver(c, s);
    se.fire(marble, 0);
    const fb = play(se, obs, s, still(SETTLE_MIN + SETTLE_QUIET), 0);
    expect(fb.filter((f) => f.t === 'heritageCrack')).toHaveLength(0);
  });
});

describe('Session, outcome levels', () => {
  // The same two bodies scored on what comes down: three items, so a shot can settle with two left.
  const out: LevelDef = { ...def, id: 'SO', scoring: 'outcome', rack: ['marble', 'marble', 'cannonball'], par: 3 };
  const oc = compileLevel(out);
  const drop = (w: Snapshot) => { w.awake[crown] = 1; w.linVel.set([0, -3, 0], 3 * crown); w.pos[3 * crown + 1] = 0.25; };
  const run = (se: Session, obs: CpuObserver, s: Snapshot, frames: Array<(s: Snapshot, t: number) => void>, start: number) => {
    const fb: Feedback[] = [];
    frames.forEach((mutate, t) => { mutate(s, t); fb.push(...se.observe(obs.observe(s, start + 1 + t, se.watchIdx))); });
    return fb;
  };
  const fresh = () => { const s = world(3), obs = new CpuObserver(oc, s); return { se: new Session(oc), s, obs }; };

  it('refuses a bank on a par level, before any shot, and while a shot runs', () => {
    expect(() => new Session(c).bank(0)).toThrow(/par level ends at its clear/);
    const { se } = fresh();
    expect(se.canBank()).toBe(false);
    expect(() => se.bank(0)).toThrow(/no shot has settled yet/);
    se.fire(marble, 0);
    expect(se.canBank()).toBe(false);
    expect(() => se.bank(1)).toThrow(/phase running/);
  });

  it('a clear does not end the level: it aims again with the objective met, and a bank ends it with the rack left', () => {
    const { se, s, obs } = fresh();
    se.fire(marble, 0);
    const fb = run(se, obs, s, [drop, ...still(SETTLE_MIN + SETTLE_QUIET)], 0);
    expect(fb.filter((f) => f.t === 'levelEnd')).toEqual([]);
    expect(se.phase).toBe('aiming');
    expect(se.objectiveDone).toBe(true);
    expect(se.liveCollapse).toBeGreaterThan(0);
    const [end] = se.bank(200);
    expect(end).toMatchObject({ t: 'levelEnd', step: 200, cleared: true });
    expect(se.phase).toBe('cleared');
    const score = se.score as OutcomeScore;
    // The crown fell from course 2 to the ground: D is its drop over what the level could release.
    const m = oc.meta, h = oc.frame.unit;
    const pe0 = Array.from({ length: m.n }, (_, i) => peOf_mJ(m.mass[i]!, m.home[3 * i + 1]!)).reduce((a, b) => a + b);
    const floor = Array.from({ length: m.n }, (_, i) => peOf_mJ(m.mass[i]!, h / 2)).reduce((a, b) => a + b);
    const D = (peOf_mJ(m.mass[crown]!, m.home[3 * crown + 1]!) - peOf_mJ(m.mass[crown]!, 0.25)) / (pe0 - floor);
    expect(score.outcome.collapse).toBe(D);
    expect(score.lines).toEqual(expect.arrayContaining([{ label: 'Objective', value: 1000 }, { label: 'Collapse', value: Math.floor(3000 * D) }, { label: 'Rack left', value: 800 }, { label: 'Combo', value: 50 }]));
    expect(score).toMatchObject({ stars: 1, stamp: `${Math.floor(100 * D)}% DOWN`, outcome: { uncast: true } });
    expect(() => se.bank(201)).toThrow(/phase cleared/);
    expect(() => se.fire(marble, 201)).toThrow(/phase cleared/);
  });

  it('the level ends when the rack runs out, failed when the objective is not met, with no rack-left line', () => {
    const { se, s, obs } = fresh();
    const shots: Shot[] = [marble, marble, { ...marble, ammo: 'cannonball' }];
    let fb: Feedback[] = [];
    shots.forEach((shot, k) => {
      se.fire(shot, 100 * k);
      obs.setBaseline(s, 100 * k);
      fb = run(se, obs, s, still(SETTLE_MIN + SETTLE_QUIET), 100 * k);
    });
    expect(fb.at(-1)).toMatchObject({ t: 'levelEnd', cleared: false });
    expect(se.phase).toBe('failed');
    expect(se.score!.lines.map((l) => l.label)).toEqual(['Collapse', 'Leverage', 'Combo']);
    expect(se.score).toMatchObject({ stars: 0, stamp: 'INCOMPLETE', outcome: { collapse: 0 } });
    // No height bin holds the 3 bodies a skyline needs here, so the ratio falls back to 1 (unchanged).
    expect(homeSkyline(oc)).toBe(0);
    expect(se.outcomeFacts().skylineRatio).toBe(1);
  });

  it('autobank ends at the first settle where the objective is met', () => {
    const ac = compileLevel({ ...out, autobank: true }), s = world(3), obs = new CpuObserver(ac, s), se = new Session(ac);
    se.fire(marble, 0);
    const fb = run(se, obs, s, [drop, ...still(SETTLE_MIN + SETTLE_QUIET)], 0);
    expect(fb.at(-1)).toMatchObject({ t: 'levelEnd', cleared: true });
    expect(se.score!.lines).toContainEqual({ label: 'Rack left', value: 800 });
    expect(ac.hash).not.toBe(oc.hash); // autobank changes when the level ends, so it is part of the level
  });
});
