// GpuAvbdEngine.checkpoint() (engine-api EngineCheckpoint; the game's undo). After a checkpoint, a
// different future (other inputs, other steps), then restore(), the engine steps bit for bit as the
// run that never left: every snapshot field at every step, the step index and the limit counters.
// With every storage range the checkpoint does not carry overwritten with garbage after the
// restore, it still does: the carried list (checkpoint.ts, each stage's carried()) is complete.
// And the negative controls: garbage over a carried range (the contact history, the solver
// bodies) does change the run, so the comparison can see a missing range.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BodyDesc, InputEvent, SceneDesc, Vec3 } from '@tb/engine-api';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './checkpoint-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./checkpoint-page.ts', import.meta.url)), '__cp');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

const run = (c: Drivers.CheckpointCase) => gpu!.page.evaluate((x) => (window as unknown as { __cp: typeof Drivers }).__cp.checkpointCase(x), c);

const cube = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0,
});
const ball = (pos: Vec3, linVel: Vec3, restitution = 0): BodyDesc => ({
  shape: { kind: 'sphere', radius: 0.4 }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 4, friction: 0.4, restitution, tag: -1,
});
/** Two columns of k unit cubes, side by side along x. */
const columns = (k: number): BodyDesc[] => [0, 1.02].flatMap((x) => Array.from({ length: k }, (_, j) => cube([x, 0.5 + j, 0])));
const scene = (bodies: BodyDesc[], inputs: InputEvent[] = [], sleep = false): SceneDesc => ({
  id: 'checkpoint', params: {}, seed: 1, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep, bodies, inputs,
});

/**
 * A ball fired into two columns (spawned at step 4), struck mid-collision at the checkpoint (step
 * 24); inputs both before it and pending at it (a removal, a blast and a second ball after it).
 * The thrown-away future fires a third ball and a blast the kept one never had.
 */
const knock = (k = 6): Pick<Drivers.CheckpointCase, 'scene' | 'at' | 'diverge' | 'divergeSteps' | 'after'> => ({
  scene: scene(columns(k), [
    { step: 4, kind: 'spawn', body: ball([-4, 2.5, 0], [14, 1, 0]) },
    { step: 30, kind: 'remove', id: 1 },
    { step: 36, kind: 'blast', blast: { centre: [1, 1.5, 0.8], radius: 2, impulse: 3 } },
    { step: 40, kind: 'spawn', body: ball([-4, 4.5, 0.2], [12, 0, 0]) },
  ]),
  at: 24,
  diverge: [
    { step: 26, kind: 'spawn', body: ball([4, 3.5, 0], [-15, 0, 0]) },
    { step: 28, kind: 'blast', blast: { centre: [0.5, 3, -0.6], radius: 2.5, impulse: 6 } },
  ],
  divergeSteps: 20,
  after: 36,
});

type Result = Awaited<ReturnType<typeof Drivers.checkpointCase>>;

/** The restored runs equal the reference, step for step; the thrown-away future did differ. */
function expectExact(r: Result) {
  expect(r.error).toBeNull();
  expect(r.restoredAt.every((h) => h === r.atCheckpoint)).toBe(true);
  for (const [k, run] of r.runs.entries()) {
    const first = run.steps.findIndex((h, i) => h !== r.reference.steps[i]);
    expect(first, `restore ${k + 1}: first step that differs from the run that never left`).toBe(-1);
    expect(run.step).toBe(r.reference.step);
    expect(run.diag).toEqual(r.reference.diag);
  }
  // The future thrown away was a different one (else the test proves nothing).
  expect(r.thrown.steps.at(-1)).not.toBe(r.reference.steps[r.thrown.steps.length - 1]);
}

describe('GPU AVBD engine: checkpoint and restore', () => {
  it('a restored engine steps bit for bit as the run that never left, mid-collision, with inputs pending', { timeout: 240_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await run({ ...knock(), params: { iterations: 10 }, poison: true });
    expectExact(r);
    expect(r.step).toBe(24);
    // Garbage went over every storage buffer the checkpoint does not carry, the contacts' other half included.
    expect(Object.keys(r.poisoned)).toEqual(expect.arrayContaining(['avbd contacts', 'inflated spheres', 'bp pairs', 'col order', 'pair history lookup']));
    // About half the contact buffer: the history half the last step wrote.
    const contacts = r.regions.filter((x) => x.label === 'avbd contacts');
    expect(contacts.length).toBe(1);
    // Restore and dispose: a disposed checkpoint refuses, and so does one from before init(); the pool reuses buffers.
    expect(r.restoreAfterDispose).toMatch(/disposed checkpoint/);
    expect(r.restoreAfterInit).toMatch(/init\(\)ed again/);
    expect(r.reused).toBe(true);
    expect(r.poolAfter.spareBytes).toBe(r.regions.reduce((a, x) => a + x.size, 0));
    console.log(`checkpoint of ${columns(6).length + 2} bodies: ${r.bytes} B in ${r.regions.length} ranges; poisoned ${Object.entries(r.poisoned).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  });

  // pi's bits are no valid index or SAT axis, so a stage may read them as "none" and do what it does
  // without history. Small integers are valid ones: garbage of that kind is read as history.
  it('the same with small-integer garbage (valid indices and axes) over the uncarried ranges', { timeout: 240_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const pattern of [1, 3]) expectExact(await run({ ...knock(), params: { iterations: 10 }, poison: true, pattern }));
  });

  it('the same with points instead of records (AvbdParams.records 0)', { timeout: 240_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    expectExact(await run({ ...knock(4), params: { iterations: 8, records: 0 }, poison: true }));
  });

  it('the same with restitution on: a ball bouncing on the columns', { timeout: 240_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const s = scene(columns(4).map((b) => ({ ...b, restitution: 0.5 })), [{ step: 2, kind: 'spawn', body: ball([0.5, 7, 0], [0, -6, 0], 0.8) }]);
    expectExact(await run({
      scene: s, params: { iterations: 8, restitution: true }, poison: true,
      at: 22, diverge: [{ step: 23, kind: 'spawn', body: ball([3, 3, 0], [-10, 2, 0], 0.8) }], divergeSteps: 15, after: 30,
    }));
  });

  it('the same with sleep: checkpointed while settling, then asleep with steps skipped, then a blast wakes it', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A thrown cube (a ball would roll on and never sleep) knocks the columns at about step 15; checkpointed at 30 while they still move (awake,
    // quiet counters part way): in the kept future they settle and fall asleep, steps are skipped,
    // and the blast at 160 wakes them.
    const s = scene(columns(3), [
      { step: 2, kind: 'spawn', body: cube([-4, 1.5, 0], [10, 0.5, 0]) },
      { step: 160, kind: 'blast', blast: { centre: [-0.8, 0.5, 0], radius: 2.5, impulse: 3 } },
    ], true);
    const r = await run({
      scene: s, params: { iterations: 8 }, opts: { sleep: true }, poison: true,
      at: 30, diverge: [{ step: 32, kind: 'spawn', body: cube([0, 6, 0], [0, -4, 0]) }], divergeSteps: 20, after: 150,
    });
    // Still moving at the checkpoint, so the quiet counters it carries decide when they sleep.
    expect(r.reference.steps[0]).not.toBe(r.reference.steps[1]);
    expectExact(r);
    // Steps were skipped while all slept, in the kept future as in the reference.
    expect(r.reference.skipped).toBeGreaterThan(0);
    expect(r.runs.every((x) => x.skipped > 0)).toBe(true);
  });

  it('negative controls: garbage over the contact history or the solver bodies does change the run', { timeout: 240_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const corrupt of ['avbd contacts', 'avbd solver bodies']) {
      const r = await run({ ...knock(4), params: { iterations: 8 }, poison: false, corrupt, restores: 1 });
      expect(r.error).toBeNull();
      expect(r.runs[0]!.steps.some((h, i) => h !== r.reference.steps[i]), `${corrupt} corrupted`).toBe(true);
    }
  });
});
