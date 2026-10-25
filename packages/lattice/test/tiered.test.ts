import { describe, expect, it } from 'vitest';
import { MODE_STATIC, type SceneDesc } from '@tb/engine-api';
import { RapierHost } from '@tb/adapter-rapier';
import { buildScenario } from '@tb/scenarios';
import { checkTiers, TIER_ACTIVE, TIER_LATTICE, TieredEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, every = 1, e = new TieredEngine(new RapierHost())) {
  await e.init(scene);
  const problems: string[] = [];
  for (let s = 1; s <= steps; s++) {
    await e.step();
    if (s % every === 0) problems.push(...(await checkTiers(e)).map((p) => `step ${s}: ${p}`));
  }
  return { e, problems };
}

describe('TieredEngine on Rapier', () => {
  it('reports the host variant as the host fills it in at init (Rapier: its version)', async () => {
    const host = new RapierHost(), e = new TieredEngine(host);
    await e.init(buildScenario('S1', { F: 1, H: 1 }, 1));
    expect(e.info.variant['host.version']).toBe(host.info.variant.version);
    expect(e.info.variant['host.version']).not.toBe('uninitialised');
    e.dispose();
  });

  it('an intact tower costs nothing: no host bodies, no proxies, exact poses', async () => {
    const scene = buildScenario('S1', { F: 4, H: 12 }, 1);
    const { e, problems } = await run(scene, 60, 10);
    expect(problems).toEqual([]);
    expect(e.stats.active).toBe(0);
    expect(e.stats.proxies).toBe(0);
    const s = await e.snapshot();
    scene.bodies.forEach((b, id) => {
      expect(Array.from(s.pos.subarray(3 * id, 3 * id + 3))).toEqual(b.pos);
      expect(s.awake[id]).toBe(0);
    });
    e.dispose();
  });

  it('waking a cell wakes the column above it (support closure) with rest-load hints, and the column stands', async () => {
    const scene = buildScenario('S1', { F: 1, H: 10 }, 1);
    const e = new TieredEngine(new RapierHost());
    await e.init(scene);
    e.wakeSphere([0, 4.5, 0], 0.1); // cell j = 4
    await e.step();
    expect(e.stats.wokenBySupport).toBe(5);
    expect(e.stats.wokenByImpact).toBe(1);
    for (let id = 0; id < 10; id++) expect(e.tier[id]).toBe(id < 4 ? TIER_LATTICE : TIER_ACTIVE);
    // The cell under the woken run is a proxy now (the run rests on it).
    expect(e.host.modeOf(3)).toBe(MODE_STATIC);
    for (let s = 0; s < 120; s++) { await e.step(); expect(await checkTiers(e)).toEqual([]); }
    const snap = await e.snapshot();
    for (let id = 0; id < 10; id++) expect(Math.abs(snap.pos[3 * id + 1]! - (0.5 + id))).toBeLessThan(0.02);
    e.dispose();
  });

  it('a ball through a tower keeps every invariant at every step and wakes cells before it touches them', async () => {
    // Four towers in a 2x2 block; the ball flies along the first row.
    const scene = buildScenario('S5', { N: 1024, F: 4, H: 16, radius: 1, speed: 20, fireStep: 2 }, 1);
    const { e, problems } = await run(scene, 150);
    expect(problems).toEqual([]);
    expect(e.stats.total.byImpact).toBeGreaterThan(20);
    expect(e.stats.active).toBeGreaterThan(50);
    expect(e.stats.lattice).toBeGreaterThan(400); // the second row stays dormant
    e.dispose();
  });

  it('cubes that start off the lattice fall onto towers and stay outside them', async () => {
    const scene = buildScenario('S1', { F: 4, H: 6 }, 1);
    const drop = { ...scene.bodies[0]!, pos: [0.2, 9, 0.3] as [number, number, number], rot: [0.1, 0.2, 0, 0.97] as [number, number, number, number] };
    const len = Math.hypot(...drop.rot);
    drop.rot = drop.rot.map((x) => x / len) as typeof drop.rot;
    scene.bodies.push(drop);
    const { e, problems } = await run(scene, 120);
    expect(problems).toEqual([]);
    const s = await e.snapshot();
    expect(s.pos[3 * 96 + 1]).toBeGreaterThan(6.4); // resting on the roof, not inside
    e.dispose();
  });
});
