// The opt-in variants together (AvbdParams.records, colorMode and
// colorPriority, and main's restitution and gapSlop): each combination runs,
// with finite state, and does what its switches say (records 2 keeps records,
// restitution bounces points, gapSlop excuses loaded gaps, the lattice modes
// colour the scenes differently from the default).
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { type AvbdParams, AvbdReferenceEngine, AvbdWorld, DEFAULT_AVBD } from '../src/index.ts';

/**
 * Run `steps` steps, spawning the scene's inputs when due; the state of every body, contact and record after each
 * step, every step's colours, and how often the restitution pass bounced a point and a loaded gap was excused (gapSlop).
 */
function run(scene: SceneDesc, steps: number, params: Partial<AvbdParams>) {
  const w = new AvbdWorld(scene, { ...DEFAULT_AVBD, ...params });
  for (const b of scene.bodies) w.add(b);
  const pending = [...scene.inputs].sort((a, b) => a.step - b.step);
  const states: Float64Array[] = [], colours: number[][] = [];
  let records = 0, bounced = 0, slopped = 0;
  for (let s = 0; s < steps; s++) {
    while (pending.length && pending[0]!.step <= s) w.add(pending.shift()!.body);
    w.step();
    colours.push([...w.stats.colorOf!]);
    records = Math.max(records, w.records.length);
    bounced += w.stats.restitution.contacts;
    slopped += w.contacts.filter((c) => c.gs > 0).length;
    states.push(Float64Array.from([
      ...w.bodies.flatMap((b) => [...b.pos, ...b.rot, ...b.linVel, ...b.angVel]),
      ...w.contacts.flatMap((c) => [...c.lambda, ...c.k, c.stick ? 1 : 0]),
      ...w.records.flatMap((q) => [...q.lamT, q.kT, q.stick ? 1 : 0]),
    ]));
  }
  return { states, colours, records, bounced, slopped, contacts: w.contacts.length };
}

describe('the opt-in variants together: records, the lattice colouring, restitution and gapSlop', () => {
  // S1 towers stand on the world lattice, so the lattice modes colour them differently from the default; the ball
  // into two towers breaks the lattice, so the colouring changes from step to step.
  const tower = buildScenario('S1', { F: 3, H: 6, gap: 0 }, 1);
  const knock = buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);
  // The same with restitution (every cube's e 0.5, the ball's 0.8), so the restitution pass bounces points.
  const bouncy = { ...knock, bodies: knock.bodies.map((b) => ({ ...b, restitution: 0.5 })), inputs: knock.inputs.map((e) => ({ ...e, body: { ...e.body, restitution: 0.8 } })) };
  it.for([
    ['records 2, S13 20-cube column at 20 iterations', buildScenario('S13', { H: 20, deg: 4 }, 1), 80, { iterations: 20, records: 2 }],
    ['records 2, a ball into two towers (rolling contacts)', knock, 30, { iterations: 6, records: 2 }],
    ['records 2, S1 tower at 2 iterations', tower, 40, { iterations: 2, records: 2 }],
    ['records 1 (the point form here)', knock, 30, { iterations: 6, records: 1 }],
    ['colorMode 3, S1 tower', tower, 40, { iterations: 6, colorMode: 3 }],
    ['colorMode 4 and colorPriority 1, a ball into two towers', knock, 30, { iterations: 6, colorMode: 4, colorPriority: 1 }],
    ['records 2 and colorMode 3, a ball into two towers', knock, 30, { iterations: 6, records: 2, colorMode: 3 }],
    ['records 2 and colorMode 4, S1 tower without post-stabilization', tower, 30, { records: 2, colorMode: 4, postStabilize: false }],
    // Main's opt-in switches: the restitution pass after the stabilization sweep, and the loaded-gap slop in the
    // main iterations' C, records 2's points included.
    ['restitution, records 2, a ball into two towers', bouncy, 40, { iterations: 6, restitution: true, records: 2 }],
    ['restitution, colorMode 4, a ball into two towers', bouncy, 40, { iterations: 6, restitution: true, colorMode: 4 }],
    ['gapSlop, records 2, S1 tower', buildScenario('S1', { F: 3, H: 8, gap: 0 }, 1), 120, { records: 2, gapSlop: 3e-5 }],
    ['gapSlop, records 2 and colorMode 3, S13 12-cube column', buildScenario('S13', { H: 12, deg: 2 }, 1), 120, { records: 2, colorMode: 3, gapSlop: 3e-5 }],
  ] as const)('runs, with finite state, and exercises its switches: %s', ([, scene, steps, params]) => {
    const p: Partial<AvbdParams> = params;
    const a = run(scene, steps, p);
    expect(a.states.length).toBe(steps);
    expect(a.contacts).toBeGreaterThan(0);
    if (p.records === 2) expect(a.records).toBeGreaterThan(0);
    if (p.restitution) expect(a.bounced).toBeGreaterThan(0);
    if (p.gapSlop) expect(a.slopped).toBeGreaterThan(0);
    expect(Math.max(...a.colours.flat())).toBeGreaterThan(0);
    a.states.forEach((s, k) => expect(s.every(Number.isFinite), `step ${k}`).toBe(true));
  });

  it('the lattice modes colour those scenes differently from the default, so the cases above do not repeat it', () => {
    for (const [scene, p] of [[tower, { colorMode: 3 }], [knock, { colorMode: 4, colorPriority: 1 }], [knock, { records: 2, colorMode: 3 }]] as const) {
      const a = run(scene, 5, { iterations: 6 }), b = run(scene, 5, { iterations: 6, ...p });
      expect(b.colours[0], JSON.stringify(p)).not.toEqual(a.colours[0]);
    }
  });

  it('every combination is accepted and recorded in the variant, with main\'s opt-in switches too', () => {
    const all = { records: 2, colorMode: 3, colorPriority: 1 } as const;
    expect(new AvbdReferenceEngine(all).info.variant).toMatchObject(all);
    expect(new AvbdReferenceEngine({ ...all, restitution: true, gapSlop: 3e-5 }).info.variant).toMatchObject({ ...all, restitution: true, restitutionRounds: 8, gapSlop: 3e-5 });
    // Off, none of them is in the variant: the default's keys.
    const off = { records: 0, colorMode: 0, colorPriority: 0, restitution: false, gapSlop: 0 } as const;
    expect(new AvbdReferenceEngine(off).info.variant).toEqual(new AvbdReferenceEngine().info.variant);
  });

  it('the fused dual (AvbdParams.dualFusion) was removed: given, on or off, the engine throws instead of running without it', () => {
    for (const dualFusion of [true, false]) expect(() => new AvbdReferenceEngine({ dualFusion } as never)).toThrow(/dualFusion \(the fused dual\) was removed after the M5 sweep .*41% higher/);
  });
});
