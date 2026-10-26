import { describe, expect, it } from 'vitest';
import { MODE_STATIC, type SceneDesc } from '@tb/engine-api';
import { RapierEngine, RapierHost } from '@tb/adapter-rapier';
import { appliedMu, slideScene } from '@tb/testkit';
import { buildScenario } from '@tb/scenarios';
import { checkTiers, TIER_ACTIVE, TIER_LATTICE, TieredEngine } from '../src/index.ts';
import { ScriptedHost } from './scripted-host.ts';

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

describe('TieredEngine host contract', () => {
  it('poses dormant cubes exactly at their cells in the host table, the cell changes and the snapshot', async () => {
    // A tower built slightly off its grid (within posTol) and turned 90 degrees about y.
    const scene = buildScenario('S1', { F: 2, H: 2 }, 1);
    const s = Math.SQRT1_2;
    for (const b of scene.bodies) { b.pos = [b.pos[0] + 3e-7, b.pos[1], b.pos[2] - 2e-7]; b.rot = [0, s + 1e-9, 0, s]; }
    const host = new ScriptedHost(), e = new TieredEngine(host);
    await e.init(scene);
    const cells = host.batches[0]!.cells!;
    expect(cells.map((c) => c.id).sort()).toEqual(scene.bodies.map((_, id) => id));
    const snap = await e.snapshot();
    for (const c of cells) {
      const pos = Array.from(snap.pos.subarray(3 * c.id, 3 * c.id + 3)), rot = Array.from(snap.rot.subarray(4 * c.id, 4 * c.id + 4));
      expect(pos).not.toEqual(scene.bodies[c.id]!.pos);
      expect(host.table[c.id]!.pos).toEqual(pos);
      expect(host.table[c.id]!.rot).toEqual(rot);
      expect(c.rot).toEqual(rot);
    }
    // A cube that settles back into its cell is sent with its rotation too.
    e.wakeSphere(snap.pos.subarray(9, 12) as unknown as [number, number, number], 0.1);
    await e.step();
    expect(e.tier[3]).toBe(TIER_ACTIVE);
    for (let k = 0; k <= e.p.minActiveSteps && e.tier[3] !== TIER_LATTICE; k++) await e.step();
    expect(e.tier[3]).toBe(TIER_LATTICE);
    const settled = host.batches.flatMap((b) => b.cells ?? []).filter((c) => c.id === 3);
    expect(settled.length).toBe(2);
    expect(settled[1]!.rot).toEqual(Array.from(snap.rot.subarray(12, 16)));
  });
});

describe('TieredEngine scene settings', () => {
  it.for(['average', 'min', 'max', 'multiply', undefined] as const)('frictionCombine %s reaches the host: the testkit slide matches RapierEngine', async (rule) => {
    const mu = async (e: TieredEngine | RapierEngine) => {
      await e.init(slideScene(rule));
      await e.step();
      const v1 = (await e.snapshot()).linVel[0]!;
      for (let i = 0; i < 10; i++) await e.step();
      const v11 = (await e.snapshot()).linVel[0]!;
      e.dispose();
      return appliedMu(v1, v11);
    };
    expect(await mu(new TieredEngine(new RapierHost()))).toBe(await mu(new RapierEngine()));
  });
});

describe('TieredEngine pushed bodies (TierParams.spare)', () => {
  const ballAt = (x: number, radius: number, step: number) => ({
    step, kind: 'spawn' as const,
    body: { shape: { kind: 'sphere' as const, radius }, pos: [x, radius + 1, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], linVel: [0, 0, 0] as [number, number, number], angVel: [0, 0, 0] as [number, number, number], density: 1, friction: 0.5, restitution: 0, tag: -1 },
  });

  it('spawn with their own shape on the host, in (step, push order), even ahead of a scene input; past the spare ids push() throws', async () => {
    const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
    scene.inputs = [ballAt(4, 1.2, 30)]; // a scene input due late
    const e = new TieredEngine(new RapierHost(), { spare: 2 });
    await e.init(scene);
    e.push([ballAt(-4, 0.4, 2)]); // due first: takes the scene input's id 1
    for (let k = 0; k < 10; k++) await e.step();
    e.push([ballAt(8, 0.8, e.stepIndex)]);
    expect(() => e.push([ballAt(12, 0.3, e.stepIndex)])).toThrow(/spare/);
    for (let k = 0; k < 150; k++) await e.step();
    const s = await e.snapshot();
    expect(s.count).toBe(4);
    // Each ball rests on the ground at its own radius (icosphere hulls sit within 1.2% of it).
    const rest = [1, 2, 3].map((id) => s.pos[3 * id + 1]!);
    const radii = [0.4, 0.8, 1.2];
    const x = [1, 2, 3].map((id) => s.pos[3 * id]!);
    expect(x.map(Math.round)).toEqual([-4, 8, 4]);
    rest.forEach((y, k) => expect(Math.abs(y / radii[k]! - 1)).toBeLessThan(0.02));
    e.dispose();
  });
});

