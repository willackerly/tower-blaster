import { describe, expect, it } from 'vitest';
import { emptySnapshot, type PhysicsEngine, type SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { RapierEngine } from '@tb/adapter-rapier';
import { compareBlocks, makeEngine, parseSpec, qualityGates, qualityRun, SlowedEngine, slowdownArms, timeInterleaved, timingSummary } from '../src/index.ts';

/** An engine whose step "takes" cost(step) ms on a fake clock, and logs its order. */
function fakeEngine(name: string, clock: { t: number }, cost: (step: number) => number, log: string[]): PhysicsEngine {
  let stepIndex = 0;
  return {
    info: { name, variant: {}, backend: 'fake' },
    get stepIndex() { return stepIndex; },
    async init() { stepIndex = 0; },
    step() { clock.t += cost(stepIndex); log.push(name); stepIndex++; },
    snapshot: () => emptySnapshot(0),
    dispose() {},
  };
}

const tiny: SceneDesc = buildScenario('S1', { F: 1, H: 1 });

describe('timeInterleaved', () => {
  it('measures per-step time and alternates which engine goes first', async () => {
    const clock = { t: 0 }, log: string[] = [];
    const a = fakeEngine('A', clock, () => 2, log), b = fakeEngine('B', clock, () => 3, log);
    const [ta, tb] = await timeInterleaved([a, b], tiny, { warmup: 1, blockSteps: 2, blocks: 3, clock: () => clock.t });
    expect(ta!.map((x) => x.median)).toEqual([2, 2, 2]);
    expect(tb!.map((x) => x.median)).toEqual([3, 3, 3]);
    // warmup A, B; then blocks A A B B | B B A A | A A B B
    expect(log.join('')).toBe('AB' + 'AABB' + 'BBAA' + 'AABB');
    expect(timingSummary(ta!).wallMs.median).toBe(2);
  });

  it('pairs blocks by simulated phase, so a workload that changes over time compares fairly', async () => {
    const clock = { t: 0 }, log: string[] = [];
    // Cost falls over the run (e.g. bodies going to sleep); B is 10% cheaper at every step.
    const a = fakeEngine('A', clock, (s) => 100 / (1 + s), log);
    const b = fakeEngine('B', clock, (s) => 90 / (1 + s), log);
    const [ta, tb] = await timeInterleaved([a, b], tiny, { warmup: 0, blockSteps: 5, blocks: 8, clock: () => clock.t });
    const cmp = compareBlocks(ta!, tb!);
    expect(cmp.verdict).toBe('faster');
    expect(cmp.diff.estimate).toBeCloseTo(-0.1, 9);
  });
});

describe('engine registry and SlowedEngine', () => {
  it('parses specs', () => {
    expect(parseSpec('rapier:iterations=8,ccd=true')).toEqual({ name: 'rapier', options: { iterations: 8, ccd: true } });
    expect(() => makeEngine('nope')).toThrow(/unknown engine/);
    expect(makeEngine('rapier:iterations=6').info.variant.iterations).toBe(6);
    expect(makeEngine('avbd-ref:iterations=4,sweep=false').info.variant).toMatchObject({ iterations: 4, sweep: false });
  });

  it('slows each step by the requested fraction', async () => {
    const clock = { t: 0 }, log: string[] = [];
    const inner = fakeEngine('A', clock, () => 10, log);
    // The fake clock only moves when stepping, so spinning must advance it.
    const spinClock = () => (clock.t += 0.001);
    const slowed = new SlowedEngine(inner, 0.1, spinClock);
    await slowed.init(tiny);
    const t0 = clock.t;
    await slowed.step();
    expect(clock.t - t0).toBeGreaterThan(10 * 1.1 - 0.01);
    expect(clock.t - t0).toBeLessThan(10 * 1.1 + 0.01);
    expect(slowed.info.variant.slowed).toBe(0.1);
  });

  it('self-check arms: both wrapped, the baseline spins zero time and the copy the requested fraction', async () => {
    const clock = { t: 0 }, log: string[] = [];
    const spinClock = () => (clock.t += 0.001);
    const arms = slowdownArms(() => fakeEngine('A', clock, () => 10, log), 0.1, spinClock);
    expect(arms.map((e) => e instanceof SlowedEngine)).toEqual([true, true]);
    expect(arms.map((e) => e.info.variant.slowed)).toEqual([0, 0.1]);
    const took: number[] = [];
    for (const e of arms) {
      await e.init(tiny);
      const t0 = clock.t;
      await e.step();
      took.push(clock.t - t0);
    }
    // Three clock reads (start, end, one loop test) and no spinning on the baseline.
    expect(took[0]).toBeCloseTo(10.003, 9);
    expect(took[1]).toBeGreaterThan(10 * 1.1 - 0.01);
    expect(took[1]).toBeLessThan(10 * 1.1 + 0.01);
  });
});

describe('qualityRun on Rapier', () => {
  it('reports a standing, sleeping small tower as passing every gate', async () => {
    const scene = buildScenario('S1', { F: 3, H: 6, gap: 0.02 });
    const q = await qualityRun(new RapierEngine(), scene, { steps: 300, sampleEvery: 30 });
    expect(q.nonFinite).toBe(0);
    expect(q.survival).toBeGreaterThan(0.98);
    expect(q.allAsleepStep).not.toBeNull();
    expect(Object.values(qualityGates(q, true)).filter(Boolean)).toEqual([]);
    expect(q.series.length).toBe(11);
  });

  it('flags a collapse: a staggered column falls and fails survival', async () => {
    const scene = buildScenario('S1', { F: 1, H: 8 });
    // Shift every second cube sideways by 0.6: the column must fall over.
    scene.bodies.forEach((b, i) => { if (i % 2 === 1) b.pos[0] += 0.6; });
    const q = await qualityRun(new RapierEngine(), scene, { steps: 240, sampleEvery: 60 });
    expect(q.survival).toBeLessThan(0.9);
    expect(qualityGates(q, true).survival).toMatch(/survival/);
  });
});
