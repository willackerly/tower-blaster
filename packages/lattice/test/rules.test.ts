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

  it('a push that takes both the total and the change over capacity wakes once it has slid slideMin', async () => {
    const { push, log } = await settledCube();
    expect(await push([-40, -98, 0])).toBe(TIER_LATTICE);
    // Total 140 N, change 100 N: 46.3 N over the 53.7 N capacity on 1 kg slides 5 cm in about 0.047 s.
    const tiers = [];
    for (let s = 0; s < 4; s++) tiers.push(await push([-140, -98, 0]));
    expect(tiers).toEqual([TIER_LATTICE, TIER_LATTICE, TIER_ACTIVE, TIER_ACTIVE]);
    expect(log.at(-1)).toBe('force');
  });

  it('a cell that never settled has no reference: the total alone decides', async () => {
    const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
    const host = new ScriptedHost();
    const e = new TieredEngine(host);
    await e.init(scene);
    for (let s = 0; s < 3 && e.tier[0] === TIER_LATTICE; s++) { host.next.set(0, [-50, 0, 0]); await e.step(); } // capacity 0.48 * 9.81 + 2 = 6.7 N
    expect(e.tier[0]).toBe(TIER_ACTIVE);
  });
});

describe('W3 slides', () => {
  // One loose cube: capacity 0.48 * 9.81 + 2 = 6.7 N on 1 kg, so 40 N over
  // one step leaves it at 0.55 m/s, and friction stops it 2.8 cm later.
  async function cubes(F: number) {
    const host = new ScriptedHost();
    const e = new TieredEngine(host);
    await e.init(buildScenario('S1', { F, H: 1 }, 1));
    const run = async (id: number, f: Vec3, steps: number, then = 0) => {
      for (let s = 0; s < steps + then; s++) { if (s < steps) host.next.set(id, f); await e.step(); }
      return e.tier[id];
    };
    return { e, run };
  }

  it('a one-step spike that would slide a cube 2.8 cm never wakes it; the same push held for 4 steps does', async () => {
    const a = await cubes(1);
    expect(await a.run(0, [40, 0, 0], 1, 60)).toBe(TIER_LATTICE);
    const b = await cubes(1);
    expect(await b.run(0, [40, 0, 0], 3)).toBe(TIER_LATTICE);
    expect(await b.run(0, [40, 0, 0], 1)).toBe(TIER_ACTIVE);
  });

  it('a push coasts: a 60 N spike slides the cube 5.9 cm in all, and it wakes after the push is gone', async () => {
    const { e, run } = await cubes(1);
    expect(await run(0, [60, 0, 0], 1)).toBe(TIER_LATTICE);
    expect(await run(0, [0, 0, 0], 0, 30)).toBe(TIER_ACTIVE);
    expect(e.stats.total.byForce).toBe(1);
  });

  it('a cell holds with the whole line of cells ahead of it, and slides alone when nothing is ahead', async () => {
    // A 4 x 4 layer: pushed in +x at i = 0, four columns hold 4 * 0.48 * 9.81 + 2 = 20.8 N; at i = 3, 6.7 N.
    const { e, run } = await cubes(4);
    const lat = e.lattices[0]!, ids: number[] = [];
    lat.forEach((_i, _j, k, id) => { if (k === 2) ids.push(id); }); // one row along x (the lattice is padded)
    const first = ids[0]!, last = ids.at(-1)!;
    expect(ids.length).toBe(4);
    expect(e.scene!.bodies[last]!.pos[0]).toBeGreaterThan(e.scene!.bodies[first]!.pos[0]);
    expect(await run(first, [18, 0, 0], 120)).toBe(TIER_LATTICE);
    expect(await run(last, [18, 0, 0], 10)).toBe(TIER_ACTIVE);
    expect(await run(first, [-18, 0, 0], 10)).toBe(TIER_ACTIVE); // -x from i = 0: nothing ahead
  });

  it('slideMin 0 wakes on the first step over capacity', async () => {
    const host = new ScriptedHost();
    const e = new TieredEngine(host, { slideMin: 0 });
    await e.init(buildScenario('S1', { F: 1, H: 1 }, 1));
    host.next.set(0, [7, 0, 0]);
    await e.step();
    expect(e.tier[0]).toBe(TIER_ACTIVE);
  });
});

describe('W2 plugs', () => {
  // A 1 x 1 x 2 column and a ball of 0.52 kg beside its top cell.
  async function ballBeside(vel: Vec3) {
    const scene = buildScenario('S1', { F: 1, H: 2 }, 1);
    scene.bodies.push({ ...scene.bodies[0]!, shape: { kind: 'sphere', radius: 0.5 }, pos: [1.01, 1.5, 0], linVel: vel });
    const host = new ScriptedHost();
    const e = new TieredEngine(host, { rubble: false });
    await e.init(scene);
    host.vel.set(2, vel);
    await e.step();
    return [e.tier[0], e.tier[1]];
  }

  it('wake only when sharing the momentum would move the plug slideMin', async () => {
    // Up at 1 m/s: the ball and both cells (2.52 kg) share 0.21 m/s and lift 2 mm. At 20 m/s: 4.1 m/s, 0.87 m.
    expect(await ballBeside([0, 1, 0])).toEqual([TIER_LATTICE, TIER_LATTICE]);
    expect(await ballBeside([0, 20, 0])).toEqual([TIER_ACTIVE, TIER_ACTIVE]);
    // Sideways at 1 m/s: the ball overlaps both rows, so the column slides on the ground (hold 0.48 * 19.6 + 2 = 11.4 N), 4.7 mm; at 20 m/s, 1.9 m.
    expect(await ballBeside([-1, 0, 0])).toEqual([TIER_LATTICE, TIER_LATTICE]);
    expect(await ballBeside([-20, 0, 0])).toEqual([TIER_ACTIVE, TIER_ACTIVE]);
  });
});

describe('unwedge', () => {
  // A 3 x 3 layer; waking its middle cell leaves it between dormant cells along x and z.
  async function wakeMiddle(unwedge: boolean) {
    const host = new ScriptedHost();
    const e = new TieredEngine(host, { unwedge, rubble: false });
    await e.init(buildScenario('S1', { F: 3, H: 1 }, 1));
    const lat = e.lattices[0]!, at = new Map<number, string>();
    let i0 = Infinity, k0 = Infinity;
    lat.forEach((i, _j, k) => { i0 = Math.min(i0, i); k0 = Math.min(k0, k); });
    lat.forEach((i, _j, k, id) => at.set(id, `${i - i0},${k - k0}`));
    const middle = [...at].find(([, c]) => c === '1,1')![0];
    e.wakeSphere(e.scene!.bodies[middle]!.pos, 0.1);
    await e.step();
    return [...at].filter(([id]) => e.tier[id] === TIER_ACTIVE).map(([, c]) => c).sort();
  }

  it('wakes the thinner dormant side of every row a woken cell is wedged in, until none is', async () => {
    // Middle (1,1): wedged along x and z, so (0,1) and (1,0) wake (ties take -x, -z); each of
    // those is wedged along the other axis by (0,0), which wakes too. The corner block is free.
    expect(await wakeMiddle(true)).toEqual(['0,0', '0,1', '1,0', '1,1']);
    expect(await wakeMiddle(false)).toEqual(['1,1']);
  });
});
