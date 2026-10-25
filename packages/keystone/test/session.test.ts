// The state machine driven by synthetic body states: no engine involved.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { compileLevel, CpuObserver, type Feedback, GRAVITY, type LevelDef, SETTLE_MIN, SETTLE_QUIET, Session, type Shot } from '@tb/keystone';

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
