import { describe, expect, it } from 'vitest';
import { bodiesAt, type BodyDesc, type InputEvent, type SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { RapierEngine } from '../src/index.ts';

function dropScene(y0: number): SceneDesc {
  return {
    id: 'drop', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: null, sleep: false,
    bodies: [{ shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos: [0, y0, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 }],
    inputs: [],
  };
}

describe('RapierEngine', () => {
  it('free fall: exact velocity, position between continuous and one-substep Euler', async () => {
    const e = new RapierEngine();
    const scene = dropScene(100);
    await e.init(scene);
    const n = 30, g = 9.81, dt = scene.dt;
    for (let i = 0; i < n; i++) e.step();
    const s = e.snapshot();
    // Rapier substeps internally, so the drop lies between the exact g t^2/2
    // and symplectic Euler with one substep, g dt^2 n(n+1)/2.
    const drop = 100 - s.pos[1]!;
    expect(drop).toBeGreaterThan((g * (n * dt) ** 2) / 2 - 1e-4);
    expect(drop).toBeLessThan((g * dt ** 2 * n * (n + 1)) / 2 + 1e-4);
    expect(s.linVel[1]).toBeCloseTo(-g * n * dt, 4);
    e.dispose();
  });

  it('keeps a small tower standing and lets it sleep', async () => {
    const e = new RapierEngine();
    const scene = buildScenario('S1', { F: 2, H: 5, gap: 0.02 });
    await e.init(scene);
    for (let i = 0; i < 240; i++) e.step();
    const s = e.snapshot();
    const top = Math.max(...Array.from({ length: s.count }, (_, i) => s.pos[3 * i + 1]!));
    expect(top).toBeGreaterThan(0.98 * 4.5);
    expect(s.awake.every((a) => a === 0)).toBe(true);
    e.dispose();
  });

  it('spawns input bodies at their step, matching bodiesAt', async () => {
    const e = new RapierEngine();
    const scene = buildScenario('S5', { N: 200, F: 4, H: 5, fireStep: 3 });
    await e.init(scene);
    for (let i = 0; i < 3; i++) e.step();
    expect(e.snapshot().count).toBe(bodiesAt(scene, 3).length);
    e.step();
    const s = e.snapshot();
    expect(s.count).toBe(bodiesAt(scene, 4).length);
    expect(s.count).toBe(201);
    expect(s.linVel[3 * 200]).toBeGreaterThan(15); // ball moving +x
    e.dispose();
  });

  it('honours the iteration option and reports it in the variant', () => {
    expect(new RapierEngine({ iterations: 8 }).info.variant.iterations).toBe(8);
  });

  it('push() during a run replays exactly as the same events in scene.inputs', async () => {
    const ball = (x: number): BodyDesc => ({ shape: { kind: 'sphere', radius: 0.4 }, pos: [x, 3, -6], rot: [0, 0, 0, 1], linVel: [0, 0, 12], angVel: [0, 0, 0], density: 5, friction: 0.5, restitution: 0.1, tag: -1 });
    // Pushed at step 10 for "step 3" (already past): applies at step 10.
    // Two events for step 20 keep push order; one is pushed before an
    // earlier-step event to exercise the stable insert.
    const live = new RapierEngine();
    const base = buildScenario('S1', { F: 2, H: 4, gap: 0.02 });
    await live.init(base);
    const pushedAt: InputEvent[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 10) {
        const evs: InputEvent[] = [{ step: 20, kind: 'spawn', body: ball(10) }, { step: 3, kind: 'spawn', body: ball(-10) }, { step: 20, kind: 'spawn', body: ball(20) }];
        live.push(evs);
        // What a recorder stores: past steps clamp to the current step.
        pushedAt.push(...evs.map((e) => ({ ...e, step: Math.max(e.step, i) })));
      }
      live.step();
    }
    const replay = new RapierEngine();
    await replay.init({ ...base, inputs: [...pushedAt].sort((a, b) => a.step - b.step) });
    for (let i = 0; i < 40; i++) replay.step();
    const a = live.snapshot(), b = replay.snapshot();
    expect(a.count).toBe(base.bodies.length + 3);
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.rot)).toEqual(Array.from(b.rot));
    // Spawn order: the step-10 ball first, then the two step-20 balls in push order.
    const n = base.bodies.length;
    expect([a.pos[3 * n], a.pos[3 * (n + 1)], a.pos[3 * (n + 2)]].map((x) => Math.round(x!))).toEqual([-10, 10, 20]);
    live.dispose();
    replay.dispose();
  });
});
