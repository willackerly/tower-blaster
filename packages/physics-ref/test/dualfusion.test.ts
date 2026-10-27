// AvbdParams.dualFusion (off by default): each contact's dual update runs at
// its first visit in the next sweep instead of in a pass between sweeps.
// Neither of the contact's bodies has moved in between, so it is the same
// arithmetic on the same values: every body and every contact's lambda, k and
// stick must match the separate pass bit for bit.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { type AvbdParams, AvbdReferenceEngine, AvbdWorld, DEFAULT_AVBD } from '../src/index.ts';

/**
 * Run `steps` steps, spawning the scene's inputs when due; the state of every body and contact after each step, and
 * how often the restitution pass bounced a point and the main iterations excused a loaded gap (gapSlop).
 */
function run(scene: SceneDesc, steps: number, params: Partial<AvbdParams>) {
  const w = new AvbdWorld(scene, { ...DEFAULT_AVBD, ...params });
  for (const b of scene.bodies) w.add(b);
  const pending = [...scene.inputs].sort((a, b) => a.step - b.step);
  const states: Float64Array[] = [];
  let colors = 0, bounced = 0, slopped = 0;
  for (let s = 0; s < steps; s++) {
    while (pending.length && pending[0]!.step <= s) w.add(pending.shift()!.body);
    w.step();
    colors = Math.max(colors, w.stats.colors);
    bounced += w.stats.restitution.contacts;
    slopped += w.contacts.filter((c) => c.gs > 0).length;
    states.push(Float64Array.from([
      ...w.bodies.flatMap((b) => [...b.pos, ...b.rot, ...b.linVel, ...b.angVel]),
      ...w.contacts.flatMap((c) => [...c.lambda, ...c.k, c.stick ? 1 : 0]),
    ]));
  }
  return { states, colors, bounced, slopped, bodies: w.bodies.length, contacts: w.contacts.length };
}

/** A ball into two towers with restitution (every cube's e 0.5, the ball's 0.8): the restitution pass bounces points. */
function bouncyKnock(): SceneDesc {
  const s = buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);
  return { ...s, bodies: s.bodies.map((b) => ({ ...b, restitution: 0.5 })), inputs: s.inputs.map((e) => ({ ...e, body: { ...e.body, restitution: 0.8 } })) };
}

describe('AvbdParams.dualFusion: the dual update at the first visit of the next sweep', () => {
  it.for([
    ['S13 20-cube column at 20 iterations', buildScenario('S13', { H: 20, deg: 4 }, 1), 80, { iterations: 20 }],
    ['S12 wall with a hole', buildScenario('S12', {}, 1), 30, {}],
    // A ball spawned into a small city: rolling contacts (a sphere's points are fresh each step and matched by its arm).
    ['S5 ball impact', buildScenario('S5', { N: 64, F: 4, H: 4, fireStep: 2, radius: 1 }, 1), 30, { iterations: 6 }],
    ['S1 tower at 2 iterations (one fused update)', buildScenario('S1', { F: 3, H: 6, gap: 0 }, 1), 40, { iterations: 2 }],
    ['S1 tower at 1 iteration (nothing to fuse)', buildScenario('S1', { F: 3, H: 6, gap: 0 }, 1), 20, { iterations: 1 }],
    ['S13 column without post-stabilization', buildScenario('S13', { H: 12, deg: 4 }, 1), 40, { postStabilize: false }],
    // The restitution pass runs after the stabilization sweep on the last main iteration's forces, and zeroes a
    // bounced point's: both as without fusion.
    ['a ball into two towers with restitution', bouncyKnock(), 40, { iterations: 6, restitution: true }],
    // The fused update's C excuses a loaded point's gap as the separate pass's does.
    ['S1 tower with the loaded-gap slop', buildScenario('S1', { F: 3, H: 8, gap: 0 }, 1), 120, { gapSlop: 3e-5 }],
  ] as const)('every body and contact is bit-identical to the separate dual pass: %s', ([, scene, steps, p]) => {
    const a = run(scene, steps, p), b = run(scene, steps, { ...p, dualFusion: true });
    expect(b.states.length).toBe(steps);
    expect(a.contacts).toBeGreaterThan(0);
    expect(a.colors).toBeGreaterThan(1);
    // The cases with restitution or gapSlop exercise them.
    const q: Partial<AvbdParams> = p;
    if (q.restitution) expect(a.bounced).toBeGreaterThan(0);
    if (q.gapSlop) expect(a.slopped).toBeGreaterThan(0);
    expect([b.bounced, b.slopped]).toEqual([a.bounced, a.slopped]);
    b.states.forEach((s, k) => expect(new Uint32Array(s.buffer), `step ${k}`).toEqual(new Uint32Array(a.states[k]!.buffer)));
  });

  it('S5: the ball is spawned and hits (contacts on the sphere exist)', () => {
    const scene = buildScenario('S5', { N: 64, F: 4, H: 4, fireStep: 2, radius: 1 }, 1);
    const w = new AvbdWorld(scene, { ...DEFAULT_AVBD, iterations: 6, dualFusion: true });
    for (const b of scene.bodies) w.add(b);
    const pending = [...scene.inputs];
    let ballContacts = 0;
    for (let s = 0; s < 30; s++) {
      while (pending.length && pending[0]!.step <= s) w.add(pending.shift()!.body);
      w.step();
      const ball = w.bodies.findIndex((b) => b.desc.shape.kind === 'sphere');
      if (ball >= 0) ballContacts += w.contacts.filter((c) => c.a === ball || c.b === ball).length;
    }
    expect(scene.inputs.length).toBeGreaterThan(0);
    expect(ballContacts).toBeGreaterThan(0);
  });
});

describe('AvbdParams.dualFusion: checked, and recorded only when on', () => {
  it('the engine rejects a non-boolean, as the GPU engine does; the variant omits it when off', () => {
    expect(() => new AvbdReferenceEngine({ dualFusion: 1 as never })).toThrow('AvbdParams.dualFusion must be a boolean, got 1');
    expect(() => new AvbdReferenceEngine({ dualFusion: 'yes' as never })).toThrow('AvbdParams.dualFusion must be a boolean, got yes');
    expect(new AvbdReferenceEngine({ dualFusion: true }).info.variant).toMatchObject({ dualFusion: true });
    // Off and unset run the same engine, so they record the same variant.
    expect(new AvbdReferenceEngine({ dualFusion: false }).info.variant).toEqual(new AvbdReferenceEngine().info.variant);
    expect(new AvbdReferenceEngine().info.variant).toMatchObject({ iterations: 10, loadCap: 1.25 });
  });
});
