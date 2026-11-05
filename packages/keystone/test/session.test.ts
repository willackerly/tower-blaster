// The state machine driven by synthetic body states: no engine involved.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { compileLevel, CpuObserver, type Feedback, GRAVITY, homeSkyline, type LevelDef, type OutcomeScore, peOf_mJ, potential_mJ, SETTLE_CAP, SETTLE_CAP_V2, SETTLE_MIN, SETTLE_QUIET, Session, settleOf, type Shot } from '@tb/keystone';

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
  it('fires only with ammo left in the rack; a running shot can only be cut on an observed state', () => {
    const se = new Session(c);
    expect(se.canFire('cue')).toBe(false);
    expect(() => se.fire({ ammo: 'drop', x: 0, z: 0 }, 0)).toThrow(/cannot fire drop/);
    const { spawn, feedback } = se.fire(marble, 10);
    expect(spawn!.step).toBe(10);
    expect(feedback).toEqual([expect.objectContaining({ t: 'fired', body: n, ammo: 'marble' })]);
    expect(se.phase).toBe('running');
    expect(se.rackLeft).toEqual(['cannonball']);
    // Rapid fire: the rules allow a shot while one runs, but only with the state to cut the running one on.
    expect(se.canFire('cannonball')).toBe(true);
    expect(() => se.fire({ ...marble, ammo: 'cannonball' }, 11)).toThrow(/cutting it needs the observed state/);
    expect(se.rackLeft).toEqual(['cannonball']);
    expect(Array.from(se.watchIdx)).toEqual([crown, heritage, n]);
  });

  it('rapid fire cuts the running shot on the state fired from; dPE still sums to the whole drop', () => {
    const se = new Session(c), s = world(2), obs = new CpuObserver(c, s), pe0 = potential_mJ(s, c);
    se.fire(marble, 0);
    // The crown drops below the line while the marble's shot runs.
    let fb = play(se, obs, s, [(w) => { w.awake[crown] = 1; w.linVel.set([0, -3, 0], 3 * crown); w.pos[3 * crown + 1] = 0.25; }, (w) => { w.linVel.set([0, -1, 0], 3 * crown); }], 0);
    expect(fb.filter((f) => f.t === 'settled')).toHaveLength(0);
    const mid = potential_mJ(s, c);
    // Fired at step 3 from the state of step 2 (pipelined: the engine is a step ahead of what the rules saw).
    const now = obs.peek(s, 2, se.watchIdx);
    const cannon: Shot = { ...marble, ammo: 'cannonball', after: 99 };
    const r = se.fire(cannon, 3, n + 1, now);
    expect(r.feedback.map((f) => f.t)).toEqual(['cut', 'fired']);
    const cut = r.feedback[0] as Extract<Feedback, { t: 'cut' }>;
    expect(cut).toMatchObject({ step: 2, shot: 0, outcome: { cut: true, crownsDown: 1, crownsTotal: 1, spawnStep: 0, settleStep: 2 } });
    expect(cut.outcome.dPE_mJ).toBeCloseTo(pe0 - mid, 9);
    expect(se.phase).toBe('running');
    expect(se.strokes).toBe(2);
    // Recorded with the steps since the shot before, whatever `after` the caller passed.
    expect(se.inputs.map((i) => [i.step, i.shot.after])).toEqual([[0, undefined], [3, 3]]);
    expect(Array.from(se.watchIdx)).toEqual([crown, heritage, n + 1]);
    // The new shot starts from where the cut one was taken; the crown is already counted, so it is no combo of the second's.
    obs.setBaseline(s, 3);
    fb = play(se, obs, s, [(w) => { w.pos[3 * crown + 1] = 0.1; }, ...still(SETTLE_MIN + SETTLE_QUIET)], 3);
    const settled = fb.find((f) => f.t === 'settled') as Extract<Feedback, { t: 'settled' }>;
    expect(settled).toMatchObject({ shot: 1, outcome: { crownsDown: 0, crownsTotal: 1 } });
    expect(settled.outcome.cut).toBeUndefined();
    expect(se.outcomes[0]!.dPE_mJ + se.outcomes[1]!.dPE_mJ).toBeCloseTo(pe0 - potential_mJ(s, c), 9);
    // Par: the clear ends the level at the last shot's settle, with both strokes counted.
    expect(se.phase).toBe('cleared');
    expect(se.score!.lines.find((l) => l.label === 'Strokes')!.value).toBe(1000 * (def.par + 3 - 2));
  });

  it('a cut never ends the level: a hold level with its crown already down runs on until a settle', () => {
    const hc = compileLevel({ ...def, id: 'SH', scoring: 'outcome', objective: { kind: 'hold' }, rack: ['marble', 'marble'] });
    const se = new Session(hc), s = world(2), obs = new CpuObserver(hc, s);
    se.fire(marble, 0);
    play(se, obs, s, [(w) => { w.awake[crown] = 1; w.linVel.set([0, -3, 0], 3 * crown); w.pos[3 * crown + 1] = 0.25; }], 0);
    const r = se.fire(marble, 2, n + 1, obs.peek(s, 1, se.watchIdx));
    expect(r.feedback.map((f) => f.t)).toEqual(['cut', 'fired']);
    expect(se.outcomes[0]).toMatchObject({ cut: true, crownsTotal: 1 });
    expect(se.phase).toBe('running');
    // The settle after it is what ends the round: the crown is down, so the hold is lost.
    const fb = play(se, obs, s, still(SETTLE_MIN + SETTLE_QUIET), 2);
    expect(fb.map((f) => f.t).filter((t) => t === 'settled' || t === 'levelEnd')).toEqual(['settled', 'levelEnd']);
    expect(se.phase).toBe('failed');
  });

  it('a shot fired while aiming is recorded without `after`, whatever the caller passed', () => {
    const se = new Session(c);
    se.fire({ ...marble, after: 5 }, 7);
    expect(se.inputs).toEqual([{ step: 7, shot: marble }]);
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

describe('Session, settle rules', () => {
  const out: LevelDef = { ...def, id: 'SV', scoring: 'outcome', rack: ['marble', 'marble'], par: 2 };
  /** One structure body (the heritage block) creeping at 0.1 m/s for good, everything else still; the marble at rest. */
  const creeping = (steps: number) => Array.from({ length: steps }, () => (s: Snapshot) => {
    s.awake.fill(0); s.linVel.fill(0);
    s.awake[heritage] = 1; s.linVel[3 * heritage] = 0.1;
  });
  const settleStep = (d: LevelDef, steps: number) => {
    const lc = compileLevel(d), s = world(1), obs = new CpuObserver(lc, s), se = new Session(lc);
    se.fire(marble, 0);
    return (play(se, obs, s, creeping(steps), 0).find((f) => f.t === 'settled') as Extract<Feedback, { t: 'settled' }> | undefined)?.step ?? null;
  };
  it('par levels settle by v1 and outcome levels by v3, unless the level says', () => {
    expect(settleOf(def)).toBe('v1');
    expect(settleOf(out)).toBe('v3');
    expect(settleOf({ ...out, settle: 'v2' })).toBe('v2');
    expect(settleOf({ ...out, settle: 'v1' })).toBe('v1');
    expect(settleOf({ ...def, settle: 'v2' })).toBe('v2');
    expect(new Session(compileLevel(out)).settleRule).toBe('v3');
  });
  it('a lone creeping block holds a v1 shot to its cap; v2 lets it go after the quiet run', () => {
    expect(settleStep(out, SETTLE_CAP_V2 + 10)).toBe(SETTLE_QUIET);
    expect(settleStep({ ...out, settle: 'v1' }, SETTLE_CAP_V2 + 10)).toBe(SETTLE_CAP);
    expect(settleStep({ ...def, settle: 'v2' }, SETTLE_CAP_V2 + 10)).toBe(SETTLE_QUIET);
  });
  it('a pending weapon holds a v2 shot to the v2 cap', () => {
    const lc = compileLevel(out), s = world(1), obs = new CpuObserver(lc, s), se = new Session(lc);
    se.fire(marble, 0);
    let at: number | null = null;
    for (let t = 0; t < SETTLE_CAP_V2 + 5 && at === null; t++) {
      s.awake.fill(0); s.linVel.fill(0);
      if (se.observe(obs.observe(s, 1 + t, se.watchIdx), true).some((f) => f.t === 'settled')) at = 1 + t;
    }
    expect(at).toBe(SETTLE_CAP_V2);
  });
  it('par\'s v1 and outcome\'s v2 hash as absent (as before v3); outcome\'s default v3 and every other rule is a different level', () => {
    const h = (d: LevelDef) => compileLevel(d).hash;
    // The hashes these levels had before v3 (main at 2a4a436, where outcome levels defaulted to v2).
    expect(h(def)).toBe('d10e20fcf6e35479');
    expect(h({ ...out, settle: 'v2' })).toBe('c5fa2b075688c510');
    expect(h({ ...def, settle: 'v1' })).toBe(h(def));
    expect(h({ ...out, settle: 'v3' })).toBe(h(out));
    expect(h(out)).not.toBe(h({ ...out, settle: 'v2' })); // stars cast under v2 never show under v3
    expect(h({ ...out, settle: 'v1' })).not.toBe(h(out));
    expect(h({ ...def, settle: 'v2' })).not.toBe(h(def));
    expect(h({ ...def, settle: 'v3' })).not.toBe(h({ ...def, settle: 'v2' }));
    expect(() => compileLevel({ ...def, settle: 'v9' as never })).toThrow(/settle must be v1 or v2 or v3: v9/);
  });
});
