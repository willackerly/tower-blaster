import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { type TransitionCause, TIER_ACTIVE, TIER_LATTICE, TieredEngine } from '../src/index.ts';
import { ScriptedHost } from './scripted-host.ts';

async function settledCube() {
  // One cube on the ground: column weight 9.81 N, friction 0.6, so with
  // kappa 0.8 and forceMin 2 it holds 0.48 * (load from above + 9.81) + 2 N sideways.
  const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
  const host = new ScriptedHost();
  const e = new TieredEngine(host);
  const log: TransitionCause[] = [];
  e.onTransition = (_id, _to, cause) => log.push(cause);
  await e.init(scene);
  e.wakeSphere(scene.bodies[0]!.pos, 0.1);
  for (let s = 0; s <= e.p.minActiveSteps + 1; s++) await e.step();
  expect(log).toEqual(['command', 'settle']);
  const push = async (f: Vec3) => { host.next.set(0, f); await e.step(); return e.tier[0]; };
  return { e, log, push };
}

describe('settle snaps', () => {
  it('are refused when they would push a cube into a moving neighbour, and allowed when clear', async () => {
    for (const ballX of [0.985, 1.2]) {
      // The cube sits 1.5 cm off its cell in -x; a ball touches its +x face.
      const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
      scene.bodies.push({ ...scene.bodies[0]!, shape: { kind: 'sphere', radius: 0.5 }, pos: [ballX, 0.5, 0] });
      const host = new ScriptedHost();
      const e = new TieredEngine(host, { rubble: false }); // a refused cube would freeze as rubble instead
      await e.init(scene);
      e.wakeSphere(scene.bodies[0]!.pos, 0.1);
      await e.step();
      host.place(0, [-0.015, 0.5, 0]);
      for (let s = 0; s < 2 * e.p.minActiveSteps; s++) await e.step();
      expect(e.tier[0], `ball at x = ${ballX}`).toBe(ballX < 1 ? TIER_ACTIVE : TIER_LATTICE);
    }
  });
});

describe('W3 force wakes after a settle', () => {
  it('the first force after settling is the reference and never wakes', async () => {
    const { push } = await settledCube();
    expect(await push([-300, -98, 0])).toBe(TIER_LATTICE);
  });

  it('a held sideways load that reverses within capacity does not wake (measured case: -40 N to +30 N under 10 cubes of rubble)', async () => {
    const { push, log } = await settledCube();
    expect(await push([-40, -97.6, 10.8])).toBe(TIER_LATTICE);
    // Change since the reference: 70.6 N > capacity 67.6 N; total: 30.4 N, well held.
    expect(await push([30.4, -126.9, 1])).toBe(TIER_LATTICE);
    expect(log).toEqual(['command', 'settle']);
  });

  it('a total over capacity that the cube already carried when it settled does not wake', async () => {
    const { push } = await settledCube();
    expect(await push([-80, -98, 0])).toBe(TIER_LATTICE);
    expect(await push([-80, -98, 0])).toBe(TIER_LATTICE); // 80 N > 53.7 N capacity, but unchanged
  });

  it('a push that takes both the total and the change over capacity wakes', async () => {
    const { push, log } = await settledCube();
    expect(await push([-40, -98, 0])).toBe(TIER_LATTICE);
    expect(await push([-100, -98, 0])).toBe(TIER_ACTIVE); // total 100 N and change 60 N > 53.7 N
    expect(log.at(-1)).toBe('force');
  });

  it('a cell that never settled has no reference: the total alone decides', async () => {
    const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
    const host = new ScriptedHost();
    const e = new TieredEngine(host);
    await e.init(scene);
    host.next.set(0, [-50, 0, 0]); // capacity with no load from above: 0.48 * 9.81 + 2 = 6.7 N
    await e.step();
    expect(e.tier[0]).toBe(TIER_ACTIVE);
  });
});
