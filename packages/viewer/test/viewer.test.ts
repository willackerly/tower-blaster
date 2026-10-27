import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildScenario } from '@tb/scenarios';
import { massOf, TAG_BALL } from '@tb/engine-api';
import { REAL_DEFAULTS, REAL_KNOBS } from '@tb/render';
import {
  albedoHex, alphaAt, arrived, hexAlbedo, realOverrides, DEFAULT_PROJECTILE, engineSpec, escapeHtml, eyeOf, frame, FREE_MAX_LAG_MS, GPU_SPARE, invert, MAX_STEPS_LIMIT, multiply,
  newArrivals, newClock, newPacer, PACE_SLACK, parseProjectile, pauseLatch, parseViewerConfig, presetSearch, projectileBody, projectileMass, proposeScene,
  pushRadiusLimit, rayThrough, runFree, SIM_SPEED_TAU, stepDue, stepped, stepsDue, taskYield, toSearch, trackSimSpeed, transform, viewProj, Window,
  withOption, type FreeHooks, type Orbit, orbitAt, parseCamera, parseSceneFile, poseOf, SCENE_FILE_FORMAT, sceneFile, sceneFileName, type ViewerConfig,
  autoSubsteps, froudeSpeed, MAX_SUBSTEPS, SCALE_LIMITS, sceneSummary, worldEngineSpec, worldScene,
} from '../src/index.ts';
import { SCENARIOS } from '@tb/scenarios';
import { parseSpec } from '@tb/bench';
import { DEFAULT_AVBD } from '@tb/physics-ref';

const orbit: Orbit = { target: [1, 2, 3], yaw: 0.7, pitch: 0.4, distance: 25, fovY: 0.9 };

describe('math and camera', () => {
  it('invert is a true inverse', () => {
    const m = viewProj(orbit, 1.6);
    const id = multiply(m, invert(m));
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) expect(id[c * 4 + r]).toBeCloseTo(c === r ? 1 : 0, 4);
  });

  it('projects the target to the screen centre, in front of the camera', () => {
    const p = transform(viewProj(orbit, 1.6), orbit.target);
    expect(p[0] / p[3]).toBeCloseTo(0, 5);
    expect(p[1] / p[3]).toBeCloseTo(0, 5);
    const z = p[2] / p[3];
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1);
  });

  it('the centre ray starts at the eye and points at the target', () => {
    const { origin, dir } = rayThrough(orbit, 1.6, 0, 0);
    const eye = eyeOf(orbit);
    expect(origin).toEqual(eye);
    const want = [0, 1, 2].map((k) => (orbit.target[k]! - eye[k]!) / orbit.distance);
    dir.forEach((d, k) => expect(d).toBeCloseTo(want[k]!, 4));
  });

  it('any ray re-projects to the pixel it was cast through', () => {
    fc.assert(fc.property(fc.double({ min: -0.95, max: 0.95, noNaN: true }), fc.double({ min: -0.95, max: 0.95, noNaN: true }), fc.double({ min: 2, max: 50, noNaN: true }), (x, y, t) => {
      const { origin, dir } = rayThrough(orbit, 1.6, x, y);
      const p = transform(viewProj(orbit, 1.6), [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]]);
      return Math.abs(p[0] / p[3] - x) < 1e-3 && Math.abs(p[1] / p[3] - y) < 1e-3;
    }));
  });

  it('frame() keeps the whole box on screen', () => {
    const o = frame([-20, 0, -20], [20, 25, 20]);
    const m = viewProj(o, 16 / 9);
    for (const x of [-20, 20]) for (const y of [0, 25]) for (const z of [-20, 20]) {
      const p = transform(m, [x, y, z]);
      expect(Math.abs(p[0] / p[3])).toBeLessThan(1);
      expect(Math.abs(p[1] / p[3])).toBeLessThan(1);
    }
  });
});

describe('stepsDue', () => {
  const dt = 1 / 60;
  it('at 60 fps takes one step per frame and tracks real time', () => {
    const c = newClock();
    let total = 0;
    for (let i = 0; i < 600; i++) total += stepsDue(c, 1000 / 60, dt);
    expect(total).toBeGreaterThanOrEqual(599);
    expect(total).toBeLessThanOrEqual(600);
    expect(c.simSpeed).toBeCloseTo(1, 2);
  });
  it('at 120 Hz display alternates zero and one steps, and sim speed reads real time', () => {
    const c = newClock();
    const steps = Array.from({ length: 240 }, () => stepsDue(c, 1000 / 120, dt));
    expect(steps.reduce((a, b) => a + b)).toBeGreaterThanOrEqual(119);
    expect(Math.max(...steps)).toBe(1);
    // Per frame the rate is 0 or 2; capping each frame at 1 before averaging read 50%.
    expect(c.simSpeed).toBeGreaterThan(0.98);
  });
  it('a slow frame takes one step and becomes slow motion, not a spiral', () => {
    const c = newClock();
    for (let i = 0; i < 100; i++) expect(stepsDue(c, 100, dt)).toBe(1);
    // The owed time is dropped, all but just under one step, so the renderer's alpha stays near 1.
    expect(c.acc).toBeLessThan(dt);
    expect(c.acc / dt).toBeGreaterThan(0.999);
    expect(c.simSpeed).toBeCloseTo(dt / 0.1, 2);
  });
  it('maxSteps allows catch-up steps, still capped', () => {
    const c = newClock();
    for (let i = 0; i < 100; i++) expect(stepsDue(c, 100, dt, 2)).toBe(2);
    expect(c.acc).toBeLessThan(dt);
    expect(c.simSpeed).toBeCloseTo((2 * dt) / 0.1, 2);
    // Two frames at 60 fps after a dropped frame: the second step is caught up, not lost.
    const d = newClock();
    expect([stepsDue(d, 1000 / 60, dt, 2), stepsDue(d, 2000 / 60, dt, 2)]).toEqual([1, 2]);
  });
  it('one dropped frame at 60 fps costs one step and no more, then one step per frame resumes', () => {
    const c = newClock();
    const frames = [1000 / 60, 2000 / 60, ...Array.from({ length: 58 }, () => 1000 / 60)];
    const steps = frames.map((f) => stepsDue(c, f, dt));
    expect(Math.max(...steps)).toBe(1);
    expect(steps.slice(2).every((n) => n === 1)).toBe(true);
    expect(steps.reduce((a, b) => a + b)).toBe(60);
  });
  it('a step that fits the frame again brings sim speed back to real time within a few SIM_SPEED_TAU', () => {
    const c = newClock();
    for (let i = 0; i < 60; i++) stepsDue(c, 50, dt);
    expect(c.simSpeed).toBeLessThan(0.4);
    let total = 0;
    for (let i = 0; i < 60; i++) total += stepsDue(c, 1000 / 60, dt);
    // One SIM_SPEED_TAU of real time (half of 60 frames) leaves e^-2 of the slow part.
    expect(1 - c.simSpeed).toBeCloseTo((2 / 3) * Math.exp(-1 / SIM_SPEED_TAU), 2);
    for (let i = 0; i < 120; i++) total += stepsDue(c, 1000 / 60, dt);
    expect(total).toBe(180);
    expect(c.simSpeed).toBeCloseTo(1, 2);
  });
  it('trackSimSpeed weighs frames by their real time', () => {
    // Half speed: one step every other 60 Hz frame.
    const c = newClock();
    for (let i = 0; i < 600; i++) trackSimSpeed(c, i % 2, 1000 / 60, dt);
    // Each step lands whole, so the reading wobbles by up to one step's share of SIM_SPEED_TAU.
    expect(Math.abs(c.simSpeed - 0.5)).toBeLessThan(dt / SIM_SPEED_TAU);
    // Frames of uneven length: 2 steps in a 33 ms frame, then 0 in a 0.1 ms one, is real time.
    const d = newClock();
    for (let i = 0; i < 600; i++) trackSimSpeed(d, i % 2 ? 0 : 2, i % 2 ? 0.1 : 2000 / 60, dt);
    expect(d.simSpeed).toBeGreaterThan(0.99);
    // A zero or negative frame changes nothing.
    trackSimSpeed(d, 5, 0, dt);
    trackSimSpeed(d, 5, -3, dt);
    expect(d.simSpeed).toBeGreaterThan(0.99);
    expect(d.simSpeed).toBeLessThanOrEqual(1);
  });
  it('Window quantiles', () => {
    const w = new Window(10);
    for (let i = 1; i <= 20; i++) w.push(i);
    expect(w.quantile(0)).toBe(11);
    expect(w.quantile(0.5)).toBe(16);
    expect(new Window().quantile(0.5)).toBeNaN();
  });
});

/**
 * A virtual clock for async code: wait(at) resolves when the clock reaches
 * at. run() lets every microtask settle, then moves the clock to the earliest
 * wait and resolves it, until the driven promise settles.
 */
function virtualClock() {
  let t = 0;
  const waits: Array<{ at: number; seq: number; resolve: () => void }> = [];
  let seq = 0;
  return {
    now: () => t,
    wait: (at: number) => new Promise<void>((resolve) => { waits.push({ at: Math.max(at, t), seq: seq++, resolve }); }),
    async run(p: Promise<unknown>) {
      let settled = false;
      const done = p.then(() => { settled = true; }, (e) => { settled = true; throw e; });
      for (;;) {
        await new Promise((r) => setImmediate(r));
        if (settled) return done;
        if (!waits.length) throw new Error('virtualClock: nothing to wait for (deadlock)');
        waits.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const w = waits.shift()!;
        t = w.at;
        w.resolve();
      }
    },
  };
}

/**
 * The viewer's loop=free schedule on a virtual clock: runFree (as main.ts
 * runs it, for a GPU engine) with display frames at phaseMs + k periodMs (plus
 * jitter). step() takes encodeMs of CPU time, then submits; the GPU runs
 * submitted steps one after another, each taking stepMs(i) of GPU time, and
 * finish() reports done callbackMs after the GPU is. A read lands snapMs after
 * the work queued before it is done (read-back, callback and upload), and is
 * timed as main.ts times it: from the call, or from when its step was done if
 * that was later (`readMs`). Frames in `gaps` never fire (a stall); frames
 * in `hidden` never fire either, and the tab is hidden from half a frame
 * before the first to half a frame before the last, with paused() from
 * pauseLatch as main.ts has it. From frame paused[0] to paused[1] the loop is
 * paused. `intervals` is runFree's arrival interval as each step starts. Each frame draws the
 * two newest reads at alphaAt: `shown` is the step it draws, interpolated
 * between the steps those reads hold; `perFrame` the steps newly shown;
 * `simSpeed` what the frame loop's trackSimSpeed reads at the end; `recorded`
 * the step times runFree recorded; `busy` the fraction of time the GPU ran.
 */
async function simulateFree(o: {
  periodMs: number; stepMs: number | ((i: number) => number); snapMs?: number; frames: number; phaseMs?: number; pipeline?: boolean;
  encodeMs?: number; callbackMs?: number; jitter?: (k: number) => number; gaps?: Array<[number, number]>; paused?: [number, number];
  hidden?: [number, number];
}) {
  const dtMs = 1000 / 60;
  const clock = virtualClock();
  const frameAt = (k: number) => (o.phaseMs ?? 0) + k * o.periodMs + (o.jitter?.(k) ?? 0);
  const skipped = (k: number) => [...(o.gaps ?? []), ...(o.hidden ? [o.hidden] : [])].some(([from, to]) => k >= from && k < to);
  const hideFrom = o.hidden ? frameAt(o.hidden[0]) - o.periodMs / 2 : NaN, hideTo = o.hidden ? frameAt(o.hidden[1]) - o.periodMs / 2 : NaN;
  const latch = pauseLatch();
  if (o.hidden) void clock.wait(hideFrom).then(() => latch.hidden());
  const arrivals = newArrivals(), intervals: number[] = [];
  const cost = (i: number) => (typeof o.stepMs === 'number' ? o.stepMs : o.stepMs(i));
  const reads: Array<{ at: number; step: number }> = [];
  const recorded: Array<{ ms: number; overlapped: boolean }> = [];
  const subs: number[] = [], doneAt: number[] = [], readMs: number[] = []; // when each step was submitted, and when it was done
  let waits = 0, k = 0, submitted = 0, gpu = 0, gpuBusy = 0;
  const end = frameAt(o.frames);
  await clock.run(runFree({
    running: () => clock.now() < end,
    paused: () => latch.paused(
      !!o.paused && clock.now() >= frameAt(o.paused[0]) && clock.now() < frameAt(o.paused[1]),
      !(clock.now() >= hideFrom && clock.now() < hideTo),
    ),
    now: clock.now,
    dtMs: () => dtMs,
    resetAsked: () => false,
    reset: async () => {},
    step: async () => {
      if (o.encodeMs) await clock.wait(clock.now() + o.encodeMs);
      intervals.push(arrivals.interval);
      subs.push(clock.now());
      const c = cost(submitted++);
      gpu = Math.max(gpu, clock.now()) + c;
      gpuBusy += c;
      doneAt.push(gpu);
    },
    finish: () => clock.wait(gpu + (o.callbackMs ?? 0)),
    record: (ms, overlapped) => { recorded.push({ ms, overlapped }); },
    refresh: async (done) => {
      const t0 = clock.now(), at = Math.max(gpu, t0) + (o.snapMs ?? 0), step = submitted;
      await clock.wait(at);
      reads.push({ at, step });
      readMs.push(at - Math.max(t0, done ? await done : t0));
      return at;
    },
    yields: () => true,
    pipeline: () => !!o.pipeline,
    nextFrame: () => {
      while (frameAt(k) <= clock.now() || skipped(k)) k++;
      waits++;
      return clock.wait(frameAt(k));
    },
    nextTask: async () => {},
  }, newPacer(), arrivals));
  // Frames: steps newly shown since the previous frame, and the step drawn.
  const perFrame: number[] = [], shown: number[] = [];
  const replay = newArrivals();
  const speed = newClock();
  let j = 0, last = 0, prevShown = 0;
  for (let f = 0; f < o.frames; f++) {
    if (skipped(f)) continue;
    const now = frameAt(f);
    while (j < reads.length && reads[j]!.at <= now) { arrived(replay, reads[j]!.at, dtMs); j++; }
    const newest = j ? reads[j - 1]!.step : 0, before = j > 1 ? reads[j - 2]!.step : 0;
    perFrame.push(newest - prevShown);
    if (f > 0) trackSimSpeed(speed, newest - prevShown, now - last, 1 / 60);
    prevShown = newest;
    shown.push(j === 0 ? 0 : before + (newest - before) * alphaAt(replay, now, dtMs));
    last = now;
  }
  const newestAt = (f: number) => reads.filter((r) => r.at <= frameAt(f)).at(-1)?.step ?? 0;
  const submittedBy = (f: number) => subs.filter((x) => x <= frameAt(f)).length;
  return {
    steps: submitted, shownSteps: reads.at(-1)?.step ?? 0, reads: reads.length, waits, perFrame, shown, dtMs, simSpeed: speed.simSpeed,
    // GPU time inside [0, end]: the work still queued at end runs back to back until gpu.
    recorded, busy: (gpuBusy - Math.max(0, gpu - end)) / end, newestAt, submittedBy, frameAt, landed: reads, doneAt, readMs, intervals,
  };
}

/** Deterministic jitter in [-amp, amp] ms. */
const jitter = (amp: number) => (k: number) => amp * Math.sin(k * 12.9898 + 78.233 * Math.sin(k));

describe('free loop (stepDue, alphaAt)', () => {
  const dtMs = 1000 / 60;
  it('a step is due at its time, or up to PACE_SLACK of a step early, and not before', () => {
    const p = newPacer();
    expect(stepDue(p, 1000, dtMs)).toBe(true);
    stepped(p, dtMs);
    expect(stepDue(p, 1000 + dtMs * (1 - PACE_SLACK) - 0.01, dtMs)).toBe(false);
    expect(stepDue(p, 1000 + dtMs * (1 - PACE_SLACK) + 0.01, dtMs)).toBe(true);
  });
  it('drops owed time beyond FREE_MAX_LAG_MS, so a stall is not followed by a long burst', () => {
    const p = newPacer();
    stepDue(p, 0, dtMs);
    stepped(p, dtMs);
    let n = 0;
    while (stepDue(p, 1000, dtMs)) { stepped(p, dtMs); n++; }
    expect(n).toBe(Math.floor(FREE_MAX_LAG_MS / dtMs + PACE_SLACK) + 1);
  });
  it('a fast engine on a 60 Hz display takes exactly one step per frame and keeps real time, despite frame jitter', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 2, snapMs: 0.5, frames: 600, jitter: jitter(1.5) });
    expect(r.perFrame.slice(1).every((n) => n === 1)).toBe(true);
    expect(r.steps).toBeGreaterThanOrEqual(599);
    expect(r.steps).toBeLessThanOrEqual(601);
    // An engine that keeps up gains nothing from pipelining, and loses nothing either: every frame
    // shows the same steps at the same pose, and no step is queued behind another.
    const p = await simulateFree({ periodMs: dtMs, stepMs: 2, snapMs: 0.5, frames: 600, jitter: jitter(1.5), pipeline: true });
    expect(p.perFrame).toEqual(r.perFrame);
    expect(p.shown).toEqual(r.shown);
    expect(p.recorded.some((x) => x.overlapped)).toBe(false);
    expect(p.recorded.every((x) => Math.abs(x.ms - 2) < 1e-9)).toBe(true);
  });
  it('a fast engine on a 120 Hz display steps every other frame, and sim speed reads real time', async () => {
    for (const pipeline of [false, true]) {
      const r = await simulateFree({ periodMs: 1000 / 120, stepMs: 2, frames: 1200, pipeline });
      expect(Math.max(...r.perFrame)).toBe(1);
      expect(r.steps).toBeGreaterThanOrEqual(599);
      expect(r.steps).toBeLessThanOrEqual(601);
      expect(r.simSpeed).toBeGreaterThan(0.98);
    }
  });
  it('a display slightly slower than 60 Hz (59.94) gets one step a frame, plus one extra every ~1000 frames, from any start phase', async () => {
    for (const phaseMs of [0, 3, 10, 14, 16]) {
      const runs = [];
      for (const pipeline of [false, true]) {
        // A 9 ms step: finishing it inside the frame must not make the next step due in the same frame.
        const r = await simulateFree({ periodMs: 1000 / 59.94, phaseMs, stepMs: 8, snapMs: 1, frames: 2000, pipeline });
        // (Frame 1 can come before the second step is due: physics starts phaseMs before frame 0.)
        const odd = r.perFrame.slice(2).filter((n) => n !== 1);
        // 2000 frames at 59.94 Hz are 2002 steps of real time: two frames of 2, never a 0, 2, 0, 2 lock.
        expect(odd.every((n) => n === 2)).toBe(true);
        expect(odd.length).toBeLessThanOrEqual(3);
        expect(r.simSpeed).toBeGreaterThan(0.99);
        runs.push(r);
      }
      // Pipelined, a frame's second step is queued behind its first rather than after its read, so it
      // can land a little sooner (the snapshot time); never later.
      const [serial, piped] = runs as [typeof runs[0], typeof runs[0]];
      expect(piped.perFrame).toEqual(serial.perFrame);
      for (let f = 0; f < 2000; f++) {
        expect(piped.newestAt(f)).toBeGreaterThanOrEqual(serial.newestAt(f));
        expect(Math.abs(piped.shown[f]! - serial.shown[f]!)).toBeLessThan(0.1);
      }
    }
  });
  it('a fast engine on a 30 Hz display takes two steps per frame, so the sim keeps real time (loop=frame runs at half speed there)', async () => {
    for (const pipeline of [false, true]) {
      const r = await simulateFree({ periodMs: 1000 / 30, stepMs: 2, frames: 300, pipeline });
      // Frame 1 shows the first step only (taken at t = 0); from then on two per frame.
      expect(r.perFrame.slice(0, 2)).toEqual([0, 1]);
      expect(r.perFrame.slice(2).every((n) => n === 2)).toBe(true);
      expect(r.steps).toBeGreaterThanOrEqual(599);
      // Every step is read back on its own and timed at its GPU time. Pipelined, a frame's second
      // step is submitted at once and queued behind its first (overlapped); serially, after it.
      expect(r.reads).toBe(r.steps);
      expect(r.recorded.every((x) => Math.abs(x.ms - 2) < 1e-9)).toBe(true);
      expect(r.recorded.filter((x) => x.overlapped).length).toBe(pipeline ? Math.floor(r.steps / 2) : 0);
    }
  });
  it('a slow engine steps back to back and never waits for a frame: sim speed is dt / (step + snapshot)', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 18, snapMs: 2, frames: 600 });
    expect(r.waits).toBe(0);
    expect(r.steps).toBe(500);
    expect(Math.abs(r.simSpeed - dtMs / 20)).toBeLessThan(1 / 60 / SIM_SPEED_TAU);
  });
  it('pipelined, a GPU engine that is behind keeps the GPU busy: sim speed dt / step instead of dt / (step + read)', async () => {
    const serial = await simulateFree({ periodMs: dtMs, stepMs: 18, snapMs: 2, frames: 1200 });
    const piped = await simulateFree({ periodMs: dtMs, stepMs: 18, snapMs: 2, frames: 1200, pipeline: true });
    expect(serial.busy).toBeCloseTo(0.9, 2);
    expect(piped.busy).toBeGreaterThan(0.999);
    expect(serial.steps).toBe(1000);
    // Steps run back to back from t = 0, plus at most two queued at the end.
    const end = 1200 * dtMs;
    expect(piped.steps - Math.floor(end / 18)).toBeGreaterThanOrEqual(0);
    expect(piped.steps - Math.floor(end / 18)).toBeLessThanOrEqual(2);
    expect(Math.abs(piped.simSpeed - dtMs / 18)).toBeLessThan(1 / 60 / SIM_SPEED_TAU);
    // At most two steps are queued past the newest read: one running, one waiting behind it.
    let most = 0;
    for (let f = 0; f < 1200; f++) most = Math.max(most, piped.submittedBy(f) - piped.newestAt(f));
    expect(most).toBe(2);
    // Each step's read is queued right behind it, so it lands snapMs after the step is done, as serially.
    expect(piped.landed.length).toBe(piped.steps);
    expect(piped.landed.every((r) => r.at === piped.doneAt[r.step - 1]! + 2)).toBe(true);
    // Every step queues behind the one before (at frames at first, then as soon as the read before
    // lands), except step 0 and step 12, where a read landed right on a frame and the GPU idled
    // 0.7 ms. Each is timed at its GPU time.
    expect(piped.recorded.length).toBe(piped.steps);
    expect(piped.recorded.every((x) => Math.abs(x.ms - 18) < 1e-9)).toBe(true);
    expect(piped.recorded.flatMap((x, i) => (x.overlapped ? [] : [i]))).toEqual([0, 12]);
    expect(serial.recorded.every((x) => !x.overlapped && Math.abs(x.ms - 18) < 1e-9)).toBe(true);
    // A read is timed from when its step was done, so pipelined and serial both read the 2 ms it takes.
    expect(piped.readMs.every((x) => Math.abs(x - 2) < 1e-9)).toBe(true);
    expect(serial.readMs.every((x) => Math.abs(x - 2) < 1e-9)).toBe(true);
    // Stopping waits for the reads in flight: the last read holds every step.
    expect(piped.shownSteps).toBe(piped.steps);
    // Motion stays smooth: every frame advances the drawn step by dt / 18.
    const d = piped.shown.slice(120).map((x, i, xs) => (i ? x - xs[i - 1]! : dtMs / 18)).slice(1);
    expect(Math.min(...d)).toBeCloseTo(dtMs / 18, 6);
    expect(Math.max(...d)).toBeCloseTo(dtMs / 18, 6);
  });
  it('pipelined, an engine whose step fits dt but whose step + read does not keeps real time, one step a frame', async () => {
    // 16 ms on the GPU plus a 2 ms read: serially 18 ms a step, so slow motion and a frame with no new step every ~13.
    const serial = await simulateFree({ periodMs: dtMs, stepMs: 16, snapMs: 2, frames: 1200 });
    const piped = await simulateFree({ periodMs: dtMs, stepMs: 16, snapMs: 2, frames: 1200, pipeline: true });
    expect(Math.abs(serial.simSpeed - dtMs / 18)).toBeLessThan(1 / 60 / SIM_SPEED_TAU);
    expect(serial.perFrame.slice(60).filter((n) => n === 0).length).toBeGreaterThan(60);
    expect(piped.simSpeed).toBeGreaterThan(0.99);
    expect(piped.perFrame.slice(2).every((n) => n === 1)).toBe(true);
    // Each frame's step is submitted when the frame wakes, so it never waits behind the one before.
    expect(piped.recorded.some((x) => x.overlapped)).toBe(false);
    expect(piped.busy).toBeCloseTo(16 / dtMs, 2);
  });
  it('pipelined, every step is timed within one callback latency of its GPU time, queued or not, on any display', async () => {
    // 1 ms to encode, each done reported 1.5 ms late (L), reads 1.8 ms after the GPU.
    const L = 1.5;
    const o = { snapMs: 1.8, encodeMs: 1, callbackMs: L, frames: 600, pipeline: true };
    const cases: Array<{ hz: number; stepMs: number | ((i: number) => number); gaps?: Array<[number, number]> }> = [
      // Keeping up, near dt (where timing from before encoding pinned steps to dt), slightly and well behind.
      ...[5, 13, 15, 16, 16.8, 18, 25].flatMap((stepMs) => [60, 75, 90, 120, 144].map((hz) => ({ hz, stepMs }))),
      // Fast and slow steps in turn; a 120 ms stall.
      { hz: 60, stepMs: (i: number) => (i % 2 ? 25 : 5) },
      { hz: 60, stepMs: (i: number) => (i === 100 ? 120 : 10) },
      // Steps faster than their reads, in a catch-up burst after frames stop.
      { hz: 60, stepMs: 0.5, gaps: [[30, 34]] },
    ];
    for (const c of cases) {
      const r = await simulateFree({ ...o, ...c, periodMs: 1000 / c.hz });
      const gpu = (i: number) => (typeof c.stepMs === 'number' ? c.stepMs : c.stepMs(i));
      const off = r.recorded.flatMap((x, i) => (x.ms >= gpu(i) - 1e-9 && x.ms <= gpu(i) + L + 1e-9 ? [] : [{ i, ...x, gpu: gpu(i) }]));
      expect({ hz: c.hz, off: off.slice(0, 3) }).toEqual({ hz: c.hz, off: [] });
    }
    // Steps that keep up at 60 Hz are not queued; steps well behind always are, and read exactly G.
    const fast = await simulateFree({ ...o, periodMs: dtMs, stepMs: 13 });
    expect(fast.recorded.some((x) => x.overlapped)).toBe(false);
    const behind = await simulateFree({ ...o, periodMs: dtMs, stepMs: 25 });
    expect(behind.recorded.slice(1).every((x) => x.overlapped && Math.abs(x.ms - 25) < 1e-9)).toBe(true);
    expect(Math.abs(behind.simSpeed - dtMs / 25)).toBeLessThan(1 / 60 / SIM_SPEED_TAU);
  });
  it('pipelined, an engine that catches up runs one step a frame, unqueued, and each frame shows the step the frame before took', async () => {
    // 25 ms GPU steps (behind) for 300 steps, then 5 ms ones (keeps up).
    const r = await simulateFree({ periodMs: dtMs, stepMs: (i) => (i < 300 ? 25 : 5), snapMs: 1, frames: 900, pipeline: true });
    // Behind, then back in step with frames.
    expect(r.recorded.slice(1, 300).every((x) => x.overlapped && Math.abs(x.ms - 25) < 1e-9)).toBe(true);
    expect(r.recorded.slice(-300).every((x) => !x.overlapped && Math.abs(x.ms - 5) < 1e-9)).toBe(true);
    // Reads are timed from their step's completion either way.
    expect(r.readMs.every((x) => Math.abs(x - 1) < 1e-9)).toBe(true);
    // Back in step with the display: one step a frame, and the frame shows the step just taken.
    expect(r.perFrame.slice(-200).every((n) => n === 1)).toBe(true);
    // (The step taken when frame f - 1 woke is read 6 ms later, before frame f.)
    for (let f = 700; f < 900; f += 37) {
      expect(r.newestAt(f)).toBe(r.submittedBy(f - 1));
      expect(r.submittedBy(f)).toBe(r.submittedBy(f - 1) + 1);
    }
  });
  it('pipelined, the steps in flight when a pause begins are read back, so the paused frames show the newest state', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 25, snapMs: 1, frames: 400, pipeline: true, paused: [200, 260] });
    expect(r.recorded.slice(1, 100).every((x) => x.overlapped)).toBe(true);
    // The two steps in flight when the pause began take up to 51 ms (3.06 frames) to land.
    for (let f = 204; f < 260; f += 5) {
      expect(r.newestAt(f)).toBe(r.submittedBy(f));
      expect(r.submittedBy(f)).toBe(r.submittedBy(203));
    }
  });
  it('after a pause it resumes with one step, not a burst of the owed time', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 2, frames: 120, paused: [30, 60] });
    // perFrame[k] counts steps finished before frame k: frame 30's step (taken when it woke) is the last.
    expect(r.perFrame.slice(32, 61).every((n) => n === 0)).toBe(true);
    expect(r.perFrame.slice(61).every((n) => n === 1)).toBe(true);
    expect(r.steps).toBe(120 - 30);
  });
  it('after frames stop for 300 ms (a stall: the tab stays visible), it catches up at most FREE_MAX_LAG_MS, then one step per frame', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 2, frames: 120, gaps: [[30, 48]] });
    const at = r.perFrame.findIndex((n, i) => i > 25 && n > 1);
    expect(r.perFrame[at]).toBeLessThanOrEqual(Math.ceil(FREE_MAX_LAG_MS / dtMs) + 1);
    expect(r.perFrame.slice(at + 1).every((n) => n === 1)).toBe(true);
    // 18 frames (300 ms) were missed; all but about FREE_MAX_LAG_MS of it is dropped as slow motion.
    expect(120 - r.steps).toBeGreaterThanOrEqual(Math.floor((300 - FREE_MAX_LAG_MS) / dtMs) - 1);
  });
  it('a tab hidden while the loop waits for a frame resumes with one step and fresh clocks, not a catch-up burst', async () => {
    for (const pipeline of [false, true]) {
      // A fast engine waits for a frame nearly all the time; frames 30-47 never come (300 ms hidden).
      const r = await simulateFree({ periodMs: dtMs, stepMs: 2, snapMs: 0.5, frames: 120, hidden: [30, 48], pipeline });
      // Frame 48 takes the paused pass (restarting both clocks), frame 49 the first step: one a frame,
      // never a burst of the time away.
      expect(Math.max(...r.perFrame.slice(1))).toBe(1);
      expect(r.steps).toBe(30 + (120 - 49));
      // The time away is no gap between arrivals: every interval is dt, or unset just after a restart.
      expect(r.intervals.every((x) => Number.isNaN(x) || Math.abs(x - dtMs) < 1e-9)).toBe(true);
      expect(r.intervals.slice(-60).every((x) => Math.abs(x - dtMs) < 1e-9)).toBe(true);
    }
  });
  it('pauseLatch is paused while paused or hidden, and once more after the tab is shown again', () => {
    const l = pauseLatch();
    expect([l.paused(false, true), l.paused(true, true)]).toEqual([false, true]);
    l.hidden();
    expect([l.paused(false, false), l.paused(true, true), l.paused(false, true), l.paused(false, true)]).toEqual([true, true, true, false]);
  });
  it('the drawn pose never goes backwards and moves smoothly when steps and frames run at different rates', async () => {
    // [step, snapshot, frames, frames to settle]; 300 ms steps are slower than the 8-step gap cap.
    for (const [stepMs, snapMs, frames, from] of [[18, 2, 600, 60], [28, 2, 600, 60], [9, 1, 600, 60], [2, 0.5, 600, 60], [298, 2, 1200, 600]] as const) {
      const r = await simulateFree({ periodMs: dtMs, stepMs, snapMs, frames });
      const rate = Math.min(1, dtMs / (stepMs + snapMs)); // steps per frame
      const d = r.shown.slice(from).map((x, i, xs) => (i ? x - xs[i - 1]! : rate));
      expect(Math.min(...d)).toBeGreaterThanOrEqual(0);
      // A frame advances about one frame's worth of steps; never a jump of a whole step on top.
      expect(Math.max(...d)).toBeLessThanOrEqual(rate * 1.2 + 1e-9);
    }
  });
  it('alphaAt is 1 before any snapshot, ramps over the usual interval (at least dt), and clamps', () => {
    const a = newArrivals();
    expect(alphaAt(a, 0, dtMs)).toBe(1);
    arrived(a, 100, dtMs);
    expect(alphaAt(a, 100, dtMs)).toBe(0);
    expect(alphaAt(a, 100 + dtMs / 2, dtMs)).toBeCloseTo(0.5, 9);
    expect(alphaAt(a, 500, dtMs)).toBe(1);
    expect(alphaAt(a, 50, dtMs)).toBe(0);
    for (let i = 1; i <= 50; i++) arrived(a, 100 + 30 * i, dtMs);
    expect(alphaAt(a, 1600 + 15, dtMs)).toBeCloseTo(0.5, 3);
    // A long stall counts as 8 steps, so it does not slow the ramp for long.
    arrived(a, 1600 + 5000, dtMs);
    expect(a.interval).toBeLessThanOrEqual(0.8 * 30 + 0.2 * 8 * dtMs + 1e-9);
    // An engine slower than 8 steps a step still reaches its own interval.
    const slow = newArrivals();
    for (let i = 0; i <= 40; i++) arrived(slow, 300 * i, dtMs);
    expect(slow.interval).toBeCloseTo(300, 0);
    expect(alphaAt(slow, 12_000 + 150, dtMs)).toBeCloseTo(0.5, 2);
  });
});

describe('runFree', () => {
  const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end); };
  const hooks = (o: Partial<FreeHooks>): FreeHooks => ({
    running: () => true, paused: () => false, now: () => performance.now(), dtMs: () => 1000 / 60,
    resetAsked: () => false, reset: async () => {}, step: async () => {}, finish: async () => {}, record: () => {}, refresh: async () => 0,
    yields: () => false, pipeline: () => false,
    nextFrame: () => new Promise((resolve) => setTimeout(resolve, 16)), nextTask: async () => {}, ...o,
  });
  it('a CPU engine slower than real time gets a task boundary after every step, so timers (frames, input) still run', async () => {
    let steps = 0, ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    // 20 ms steps against a 16.7 ms dt: always due, so the loop never waits for a frame. (A count,
    // not a time, ends the run, so a loaded host only makes it slower.)
    // (Node drains a MessagePort's messages in one go, so the test's task boundary is a timer;
    // in a browser each message is its own task, which is what taskYield relies on.)
    await runFree(hooks({ running: () => steps < 12, step: async () => { busy(20); steps++; }, nextTask: () => new Promise((resolve) => setTimeout(resolve, 0)) }), newPacer(), newArrivals());
    clearInterval(timer);
    expect(steps).toBe(12);
    expect(ticks).toBeGreaterThanOrEqual(steps - 1);
  });
  it('taskYield resolves each wait once, in order', async () => {
    const tasks = taskYield();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => tasks.next().then(() => order.push(i))));
    tasks.close();
    expect(order).toEqual([1, 2, 3]);
  });
  it('a GPU engine (yields) gets no extra task boundary; a paused loop waits for frames; a reset restarts both clocks', async () => {
    const pacer = newPacer(), arrivals = newArrivals();
    let steps = 0, tasks = 0, frames = 0, resets = 0, paused = false, ask = false;
    await runFree(hooks({
      running: () => steps < 6 || frames < 3,
      paused: () => paused,
      yields: () => true,
      nextTask: async () => { tasks++; },
      nextFrame: async () => { frames++; if (frames === 3) paused = false; },
      resetAsked: () => ask,
      reset: async () => { ask = false; resets++; },
      step: async () => { steps++; if (steps === 3) paused = true; if (steps === 5) ask = true; },
      refresh: async () => steps * 1000,
      now: () => steps * 1000, // always due once unpaused
    }), pacer, arrivals);
    expect({ steps, tasks, resets }).toEqual({ steps: 6, tasks: 0, resets: 1 });
    expect(frames).toBe(3); // the three paused passes
    // The reset after step 5 restarted the pacer at the next check (now = 5000); one step since.
    expect(pacer.next).toBeCloseTo(5000 + 1000 / 60, 6);
    expect(arrivals.last).toBe(6000);
    expect(arrivals.interval).toBeNaN();
  });
  /**
   * A pipelined GPU engine on the virtual clock: 25 ms steps (behind at 60 Hz), reads landing 1 ms
   * after the step they follow, frames every 16 ms. `log` records each read as it lands (by the
   * steps it holds), resets and errors. A step can fail as it is submitted (stepFails) or on the GPU
   * (finishFails: finish() rejects), and a read at once (readFails). The loop can be paused for
   * pauseMs from the step pauseAfter; hidden: no frames come while it is (a hidden tab, where
   * requestAnimationFrame does not fire). `seen` is the arrival clock's interval as each step starts.
   * Reads wait for their step's done, as main.ts's do, unless ignoreDone.
   */
  const piped = (o: {
    steps: number; resetAfter?: number; stepFails?: number; finishFails?: number; readFails?: number;
    pauseAfter?: number; pauseMs?: number; hidden?: boolean; ignoreDone?: boolean;
  }) => {
    const clock = virtualClock();
    const arrivals = newArrivals();
    const log: string[] = [], seen: Array<[number, number]> = [];
    let gpu = 0, n = 0, ask = false, pausedAt = NaN, failedAt = NaN;
    const pauseEnd = () => pausedAt + (o.pauseMs ?? 0);
    const run = runFree(hooks({
      running: () => n < o.steps,
      paused: () => clock.now() < pauseEnd(),
      now: clock.now,
      yields: () => true,
      pipeline: () => true,
      resetAsked: () => ask,
      reset: async () => { ask = false; log.push('reset'); await clock.wait(clock.now() + 5); },
      step: async () => {
        if (n + 1 === o.stepFails) throw new Error('step failed');
        seen.push([n + 1, arrivals.interval]);
        n++;
        if (n === o.pauseAfter) pausedAt = clock.now();
        gpu = Math.max(gpu, clock.now()) + 25;
        if (n === o.resetAfter) ask = true;
      },
      finish: () => {
        const i = n;
        return clock.wait(gpu).then(() => { if (i === o.finishFails) throw new Error(`step ${i} failed on the GPU`); });
      },
      // As main.ts: a read is applied once it lands and its step is done.
      refresh: (done) => {
        const i = n, at = gpu + 1;
        // A read that fails at once, as Readback.read does when its pool is destroyed.
        if (i === o.readFails) return Promise.reject(new Error(`read ${i} failed`));
        return clock.wait(at).then(async () => { if (done && !o.ignoreDone) await done; log.push(`read ${i}`); return at; });
      },
      nextFrame: () => {
        const next = Math.floor(clock.now() / 16) * 16 + 16;
        return clock.wait(o.hidden && clock.now() < pauseEnd() ? Math.max(next, Math.ceil(pauseEnd() / 16) * 16) : next);
      },
    }), newPacer(), arrivals);
    return {
      log, seen, pauseEnd, failedAt: () => failedAt,
      run: clock.run(run.catch((e: Error) => { log.push(e.message); failedAt = clock.now(); })),
    };
  };
  /** Runs f and returns the unhandled rejections it caused. */
  const unhandledBy = async (f: () => Promise<void>) => {
    const unhandled: unknown[] = [];
    const listen = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', listen);
    try {
      await f();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listen);
    }
    return unhandled;
  };
  it('pipelined, a reset waits for the reads in flight, so no read of the old scene lands after it', async () => {
    const r = piped({ steps: 10, resetAfter: 6 });
    await r.run;
    // Step 6 asked for the reset while read 5 and read 6 were in flight.
    expect(r.log).toEqual([...[1, 2, 3, 4, 5, 6].map((i) => `read ${i}`), 'reset', ...[7, 8, 9, 10].map((i) => `read ${i}`)]);
  });
  it('pipelined, a pause lets the reads in flight land before it restarts the arrival clock, so the time paused is no gap, even in a hidden tab', async () => {
    for (const hidden of [false, true]) {
      const r = piped({ steps: 14, pauseAfter: 6, pauseMs: 500, hidden });
      await r.run;
      expect(r.log).toEqual([...Array(14)].map((_, i) => `read ${i + 1}`));
      // Reads land 25 ms apart. Before the pause and after it, the interval is that, or unset just
      // after the clock starts. A read landing after the only restart of a hidden tab would have
      // counted the 500 ms away as a gap (capped at 8 steps), and made it 133 ms.
      expect(r.seen.filter(([, x]) => !Number.isNaN(x)).length).toBeGreaterThan(6);
      expect(r.seen.every(([, x]) => Number.isNaN(x) || Math.abs(x - 25) < 1e-9)).toBe(true);
    }
  });
  it('pipelined, an engine error rejects the loop after the read in flight has settled', async () => {
    const r = piped({ steps: 10, stepFails: 5 });
    await r.run;
    // Step 5 failed after step 4 was queued: the loop waited for read 4 before it rejected.
    expect(r.log).toEqual(['read 1', 'read 2', 'read 3', 'read 4', 'step failed']);
  });
  it('pipelined, a read that fails rejects the loop with its error, and is never left unhandled meanwhile', async () => {
    expect(await unhandledBy(async () => {
      const r = piped({ steps: 10, readFails: 3 });
      await r.run;
      // Read 3 failed at once, while the loop waited for read 2. The loop threw when it came to
      // read 3, after step 4, and first let read 4 land.
      expect(r.log).toEqual(['read 1', 'read 2', 'read 4', 'read 3 failed']);
    })).toEqual([]);
  });
  it('pipelined, a step that fails on the GPU fails its read, so the loop rejects at that read, even while paused', async () => {
    expect(await unhandledBy(async () => {
      // Step 4 is queued behind step 3, and step 5 behind step 4; read 4 fails, read 5 lands first.
      // The loop fails read 4 itself, whether or not refresh() waits for its step.
      for (const ignoreDone of [false, true]) {
        const r = piped({ steps: 10, finishFails: 4, ignoreDone });
        await r.run;
        expect(r.log.filter((x) => x !== 'read 4')).toEqual(['read 1', 'read 2', 'read 3', 'read 5', 'step 4 failed on the GPU']);
      }
      // Paused (or hidden) right after step 4: the pause waits for read 4, which fails, so the
      // error shows then, not when the pause ends and a later step() would fail.
      for (const hidden of [false, true]) {
        const p = piped({ steps: 10, finishFails: 4, pauseAfter: 4, pauseMs: 500, hidden });
        await p.run;
        expect(p.log).toEqual(['read 1', 'read 2', 'read 3', 'step 4 failed on the GPU']);
        expect(p.failedAt()).toBeLessThan(p.pauseEnd());
      }
    })).toEqual([]);
  });
});

describe('viewer config', () => {
  it('defaults to a 2k city on the GPU engine', () => {
    expect(parseViewerConfig('')).toMatchObject({ scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, engine: 'avbd-gpu', sleep: null });
  });
  it('gives the GPU and tiered engines room for fired balls unless the spec sets it, and leaves other engines alone', () => {
    expect(engineSpec('avbd-gpu')).toBe(`avbd-gpu:spare=${GPU_SPARE},maxRadius=0.7`);
    expect(engineSpec('avbd-gpu:iterations=4')).toBe(`avbd-gpu:iterations=4,spare=${GPU_SPARE},maxRadius=0.7`);
    expect(engineSpec('tiered')).toBe(`tiered:spare=${GPU_SPARE}`);
    expect(engineSpec('avbd-gpu:spare=3,maxRadius=2')).toBe('avbd-gpu:spare=3,maxRadius=2');
    expect(engineSpec('rapier')).toBe('rapier');
    expect(engineSpec('avbd-ref:iterations=4')).toBe('avbd-ref:iterations=4');
  });
  it('sizes the GPU engine for the projectile, which leaves the default scene engine as it was', () => {
    const cube = { ...DEFAULT_PROJECTILE, shape: 'cube' as const, size: 2 };
    expect(engineSpec('avbd-gpu', cube)).toBe(`avbd-gpu:spare=${GPU_SPARE},maxRadius=${Math.sqrt(3)}`);
    expect(engineSpec('tiered', cube)).toBe(`tiered:spare=${GPU_SPARE}`);
    expect(engineSpec('rapier', cube)).toBe('rapier');
    // The engine sizes its cells for max(maxRadius, the scene's largest body): a unit cube's
    // sqrt(3)/2 > 0.7 in every default scene, so the default ball changes nothing.
    const scene = buildScenario('S4', { N: 2000, F: 4, H: 12 });
    expect(pushRadiusLimit(engineSpec('avbd-gpu'), scene)).toBe(Math.sqrt(0.75));
    expect(pushRadiusLimit(engineSpec('avbd-gpu', cube), scene)).toBe(Math.sqrt(3));
    expect(pushRadiusLimit(engineSpec('avbd-gpu', { ...DEFAULT_PROJECTILE, size: 6 }), scene)).toBe(3);
    expect(pushRadiusLimit(engineSpec('rapier', cube), scene)).toBe(Infinity);
    expect(pushRadiusLimit(engineSpec('tiered', cube), scene)).toBe(Infinity);
  });
  it('sets, replaces and removes one engine option', () => {
    expect(withOption('avbd-gpu', 'iterations', 20)).toBe('avbd-gpu:iterations=20');
    expect(withOption('avbd-gpu:iterations=20,sweep=false', 'iterations', 40)).toBe('avbd-gpu:iterations=40,sweep=false');
    expect(withOption('avbd-gpu:iterations=20,sweep=false', 'iterations', undefined)).toBe('avbd-gpu:sweep=false');
    expect(withOption('avbd-gpu:iterations=20', 'iterations', undefined)).toBe('avbd-gpu');
  });
  it('takes a preset to its scene with the current engine, loop and projectile, so its button can tell it is on', () => {
    const cur = (q: string) => parseViewerConfig(q);
    const at = toSearch(cur('?scenario=S12&engine=rapier'));
    expect(presetSearch('?scenario=S12', cur('?engine=rapier'))).toBe(at);
    expect(presetSearch('?scenario=S12', cur('?scenario=S4&engine=avbd-gpu:iterations=20'))).toBe(toSearch(cur('?scenario=S12&engine=avbd-gpu:iterations=20')));
    expect(presetSearch('?scenario=S13', cur('?engine=rapier'))).not.toBe(at);
    const cube = { ...DEFAULT_PROJECTILE, shape: 'cube' as const };
    expect(parseViewerConfig(presetSearch('?scenario=S12', { ...cur('?engine=rapier'), projectile: cube })).projectile).toEqual(cube);
    // How physics is scheduled is the viewer's mode, like the engine: a preset keeps it.
    expect(parseViewerConfig(presetSearch('?scenario=S3', cur('?scenario=S1&loop=frame&maxSteps=2')))).toMatchObject({ scenario: 'S3', loop: 'frame', maxSteps: 2 });
    expect(parseViewerConfig(presetSearch('?scenario=S3', cur('?loop=frame')))).toMatchObject({ loop: 'frame', maxSteps: 1 });
    expect(parseViewerConfig(presetSearch('?scenario=S3', cur('?pipeline=0')))).toMatchObject({ scenario: 'S3', loop: 'free', pipeline: false });
  });
  it('escapes text for the HUD', () => {
    expect(escapeHtml(`rapier:x=<img src=x onerror="alert('1')">&`)).toBe('rapier:x=&#60;img src=x onerror=&#34;alert(&#39;1&#39;)&#34;&#62;&#38;');
    expect(escapeHtml('avbd-gpu:iterations=20')).toBe('avbd-gpu:iterations=20');
  });
  it('round-trips through the URL', () => {
    const c = parseViewerConfig('?scenario=s1&param.F=3&param.gap=0.02&sleep=0&autofire=30&seed=4&offscreen=1&loop=frame&maxSteps=2');
    expect(c).toMatchObject({ scenario: 'S1', params: { F: 3, gap: 0.02 }, sleep: false, autofire: 30, seed: 4, offscreen: true, loop: 'frame', maxSteps: 2 });
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(parseViewerConfig('?loop=frame')).toMatchObject({ loop: 'frame', maxSteps: 1 });
    expect(parseViewerConfig(toSearch(parseViewerConfig('?loop=frame')))).toMatchObject({ loop: 'frame', maxSteps: 1 });
    expect(parseViewerConfig('')).toMatchObject({ loop: 'free', maxSteps: 1 });
    expect(toSearch(parseViewerConfig(''))).not.toMatch(/maxSteps|loop|pipeline/);
    const serial = parseViewerConfig('?pipeline=0');
    expect(serial).toMatchObject({ loop: 'free', pipeline: false });
    expect(toSearch(serial)).toMatch(/(^|[?&])pipeline=0(&|$)/);
    expect(parseViewerConfig(toSearch(serial))).toEqual(serial);
    expect(parseViewerConfig('?pipeline=1')).toEqual(parseViewerConfig(''));
  });
  it('a URL with maxSteps and no loop keeps the frame loop it was written for', () => {
    expect(parseViewerConfig('?maxSteps=2')).toMatchObject({ loop: 'frame', maxSteps: 2 });
    expect(parseViewerConfig('?maxSteps=1')).toMatchObject({ loop: 'frame', maxSteps: 1 });
  });
  it('rejects unknown scenarios, non-numeric params, a maxSteps outside 1-4, an unknown loop, maxSteps on the free loop and pipeline=0 on the frame loop', () => {
    expect(() => parseViewerConfig('?scenario=S99')).toThrow(/unknown scenario/);
    expect(() => parseViewerConfig('?param.N=lots')).toThrow(/not a number/);
    for (const m of ['0', '5', '1.5', 'two']) expect(() => parseViewerConfig(`?maxSteps=${m}`)).toThrow(/maxSteps/);
    expect(parseViewerConfig(`?maxSteps=${MAX_STEPS_LIMIT}`).maxSteps).toBe(MAX_STEPS_LIMIT);
    expect(() => parseViewerConfig('?loop=fast')).toThrow(/loop must be free or frame/);
    expect(() => parseViewerConfig('?loop=free&maxSteps=2')).toThrow(/maxSteps applies to loop=frame/);
    for (const v of ['2', 'off', '']) expect(() => parseViewerConfig(`?pipeline=${v}`)).toThrow(/pipeline must be 0 or 1/);
    expect(() => parseViewerConfig('?loop=frame&pipeline=0')).toThrow(/pipeline applies to loop=free/);
    // maxSteps alone means the frame loop, so it does not take pipeline=0 either.
    expect(() => parseViewerConfig('?maxSteps=2&pipeline=0')).toThrow(/pipeline applies to loop=free/);
  });
});

describe('world scale (scale, substeps)', () => {
  it('parses, defaults to 1 and 1, round-trips, and leaves the defaults out of the URL', () => {
    expect(parseViewerConfig('')).toMatchObject({ scale: 1, substeps: 1 });
    expect(toSearch(parseViewerConfig(''))).not.toMatch(/scale|substeps/);
    const c = parseViewerConfig('?scenario=S14&scale=0.25&substeps=3');
    expect(c).toMatchObject({ scale: 0.25, substeps: 3 });
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    // Substeps default to the scale's own (autoSubsteps), and only others go in the URL, 1 included.
    expect(parseViewerConfig('?scale=0.25')).toMatchObject({ scale: 0.25, substeps: 2 });
    expect(toSearch(parseViewerConfig('?scale=0.25'))).not.toMatch(/substeps/);
    const one = parseViewerConfig('?scale=0.25&substeps=1');
    expect(toSearch(one)).toMatch(/substeps=1/);
    expect(parseViewerConfig(toSearch(one))).toEqual(one);
    expect(parseViewerConfig(`?scale=${SCALE_LIMITS[0]}&substeps=${MAX_SUBSTEPS}`)).toMatchObject({ scale: SCALE_LIMITS[0], substeps: MAX_SUBSTEPS });
  });
  it('rejects a scale outside its range or not a number, and substeps that are not a whole number from 1 to MAX_SUBSTEPS', () => {
    for (const v of ['0', '-1', '11', 'big', '']) expect(() => parseViewerConfig(`?scale=${v}`)).toThrow(/scale must be a number from 0.01 to 10/);
    for (const v of ['0', '9', '1.5', 'two']) expect(() => parseViewerConfig(`?substeps=${v}`)).toThrow(/substeps must be an integer from 1 to 8/);
  });
  it('a preset keeps a chosen scale and substeps set by hand; a scale left at its default stays the default', () => {
    const cur = parseViewerConfig('?scenario=S14&scale=0.25&substeps=3');
    expect(parseViewerConfig(presetSearch('?scenario=S4', cur))).toMatchObject({ scenario: 'S4', scale: 0.25, substeps: 3 });
    expect(parseViewerConfig(presetSearch('?scenario=S4', parseViewerConfig('?scenario=S14&scale=0.25')))).toMatchObject({ scale: 0.25, substeps: 2 });
    expect(parseViewerConfig(presetSearch('?scenario=S4', parseViewerConfig('?scenario=S14')))).toMatchObject({ scale: 1, substeps: 1 });
  });
  it('autoSubsteps keeps each step no coarser than the unit world\'s 1/60 s', () => {
    expect([1, 2, 10, 0.5, 0.25, 0.2, 0.0625, 0.01].map(autoSubsteps)).toEqual([1, 1, 1, 2, 2, 3, 4, 8]);
    for (const s of [0.03, 0.11, 0.25, 0.4, 0.7, 1]) if (autoSubsteps(s) < MAX_SUBSTEPS) expect(1 / Math.sqrt(s) / autoSubsteps(s)).toBeLessThanOrEqual(1 + 1e-12);
  });
  it('worldScene: gravity 1/scale as strong, starting and spawned velocities froudeSpeed as fast, steps split by substeps', () => {
    const s = buildScenario('S5', {}, 1);
    expect(worldScene(s, 1, 1)).toBe(s);
    const w = worldScene(s, 0.25, 3);
    expect(w.gravity).toEqual([0, -9.81 * 4, 0]);
    expect(w.dt).toBeCloseTo(1 / 180, 15);
    expect(froudeSpeed(0.25)).toBe(2);
    s.bodies.forEach((b, i) => { expect(w.bodies[i]!.linVel).toEqual(b.linVel.map((v) => v * 2)); expect(w.bodies[i]!.angVel).toEqual(b.angVel.map((v) => v * 2)); expect(w.bodies[i]!.pos).toEqual(b.pos); });
    expect(s.inputs.length).toBeGreaterThan(0); // S5 fires a ball
    s.inputs.forEach((e, i) => {
      const f = w.inputs[i]!;
      expect(f.step).toBe(e.step * 3);
      if (e.kind === 'spawn' && f.kind === 'spawn') expect(f.body.linVel).toEqual(e.body.linVel.map((v) => v * 2));
    });
    // The time of every event is kept: step x dt.
    s.inputs.forEach((e, i) => expect(w.inputs[i]!.step * w.dt).toBeCloseTo(e.step * s.dt, 12));
  });
  it('worldEngineSpec scales the AVBD engines\' penalties, beta and spin cap (froudeParams), their own values or the defaults, and leaves other engines alone', () => {
    expect(worldEngineSpec('avbd-gpu', 1)).toBe('avbd-gpu');
    const g = parseSpec(worldEngineSpec('avbd-gpu:iterations=20', 0.25)).options;
    expect(g).toMatchObject({ iterations: 20, beta: DEFAULT_AVBD.beta * 4, penaltyMin: DEFAULT_AVBD.penaltyMin * 4, penaltyMax: DEFAULT_AVBD.penaltyMax * 4, maxAngularSpeed: DEFAULT_AVBD.maxAngularSpeed * 2 });
    expect(parseSpec(worldEngineSpec('avbd-ref:beta=1000', 0.25)).options).toMatchObject({ beta: 4000 });
    expect(worldEngineSpec('rapier', 0.25)).toBe('rapier');
  });
  it('proposeScene checks the cube size and substeps; the summary says what they do', () => {
    const c = parseViewerConfig('?scenario=S14');
    expect(proposeScene(c, 'S14', c.params, 1, 0.25, 2)).toMatchObject({ ok: true, config: { scale: 0.25, substeps: 2 } });
    expect(proposeScene(c, 'S14', c.params, 1, 0, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/cube edge/) });
    expect(proposeScene(c, 'S14', c.params, 1, 1, 9)).toMatchObject({ ok: false, error: expect.stringMatching(/substeps/) });
    expect(sceneSummary(1200, 1, 1)).toBe('1,200 bodies');
    expect(sceneSummary(1200, 0.25, 2)).toBe('1,200 bodies, 4 g in cube units, 2x as fast, 2x physics cost');
  });
});

describe('look', () => {
  it('round-trips the look and the real knobs through the URL; a preset keeps them', () => {
    const c = parseViewerConfig('?look=real&real.sunElevation=4&real.visibility=12&real.ground=0.3,0.25,0.2&real.stone=granite&real.groundMaterial=dirt&real.groundScale=2&real.env=hall&real.hallSize=0.5');
    expect(c).toMatchObject({ look: 'real', real: { sunElevation: 4, visibility: 12, groundAlbedo: [0.3, 0.25, 0.2], stone: 'granite', groundMaterial: 'dirt', groundScale: 2, env: 'hall', hallSize: 0.5 } });
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(toSearch(parseViewerConfig(''))).not.toMatch(/look|real/);
    expect(parseViewerConfig(presetSearch('?scenario=S1', c))).toMatchObject({ scenario: 'S1', look: 'real', real: c.real });
  });
  it('rejects an unknown look and out-of-range knobs', () => {
    expect(() => parseViewerConfig('?look=photo')).toThrow(/unknown look/);
    expect(() => parseViewerConfig('?look=real&real.sunElevation=120')).toThrow(/real.sunElevation/);
  });
  it('the panel sends only knobs that differ from the defaults, and refuses out-of-range ones', () => {
    const values = { ...REAL_DEFAULTS } as Record<keyof typeof REAL_KNOBS, number>;
    const hex = albedoHex(REAL_DEFAULTS.groundAlbedo);
    expect(realOverrides(values, hex)).toEqual({});
    expect(realOverrides({ ...values, sunElevation: 5 }, hex)).toEqual({ sunElevation: 5 });
    expect(realOverrides(values, hex, { stone: 'granite' })).toEqual({ stone: 'granite' });
    expect(realOverrides(values, hex, { stone: 'granite', groundMaterial: 'dirt' })).toEqual({ stone: 'granite', groundMaterial: 'dirt' });
    expect(realOverrides(values, hex, { stone: 'limestone', env: 'hall' })).toEqual({ env: 'hall' });
    expect(realOverrides(values, '#808080').groundAlbedo).toEqual(hexAlbedo('#808080'));
    expect(hexAlbedo('#808080')[0]).toBeCloseTo(0.216, 3);
    expect(() => realOverrides({ ...values, autoExposure: 2 }, hex)).toThrow(/auto exposure/);
  });
});

describe('projectile', () => {
  const origin = [1, 2, 3] as [number, number, number], dir = [0.6, 0, -0.8] as [number, number, number];
  it('by default is the ball the viewer always fired, field for field', () => {
    expect(parseViewerConfig('').projectile).toEqual(DEFAULT_PROJECTILE);
    expect(projectileBody(DEFAULT_PROJECTILE, origin, dir)).toEqual({
      shape: { kind: 'sphere', radius: 0.7 },
      pos: [origin[0] + dir[0] * 2, origin[1] + dir[1] * 2, origin[2] + dir[2] * 2],
      rot: [0, 0, 0, 1],
      linVel: [dir[0] * 40, dir[1] * 40, dir[2] * 40],
      angVel: [0, 0, 0],
      density: 8,
      friction: 0.5,
      restitution: 0.1,
      tag: TAG_BALL,
    });
    expect(toSearch(parseViewerConfig(''))).not.toContain('proj');
  });
  it('has the size, mass and speed asked for, as a ball or a cube', () => {
    fc.assert(fc.property(fc.constantFrom('ball' as const, 'cube' as const), fc.double({ min: 0.1, max: 20, noNaN: true }), fc.option(fc.double({ min: 0.01, max: 1e6, noNaN: true })), fc.double({ min: 0, max: 500, noNaN: true }), (shape, size, mass, speed) => {
      const p = { shape, size, mass, speed };
      const b = projectileBody(p, origin, dir);
      if (shape === 'ball') expect(b.shape).toEqual({ kind: 'sphere', radius: size / 2 });
      else expect(b.shape).toEqual({ kind: 'box', half: [size / 2, size / 2, size / 2] });
      expect(massOf(b)).toBeCloseTo(projectileMass(p), 6);
      if (mass !== null) expect(massOf(b) / mass).toBeCloseTo(1, 12);
      expect(Math.hypot(...b.linVel)).toBeCloseTo(speed, 9);
      // Starts clear of the camera: further than its own radius plus a metre.
      const r = shape === 'ball' ? size / 2 : (size / 2) * Math.sqrt(3);
      expect(Math.hypot(b.pos[0] - origin[0], b.pos[1] - origin[1], b.pos[2] - origin[2])).toBeGreaterThanOrEqual(Math.min(r + 1, 2) - 1e-9);
      // Round-trips through the URL.
      const c = { ...parseViewerConfig(''), projectile: p };
      expect(parseViewerConfig(toSearch(c)).projectile).toEqual(p);
    }));
  });
  it('the default mass is density 8, so a cube of the same size is heavier', () => {
    expect(projectileMass(DEFAULT_PROJECTILE)).toBeCloseTo((8 * 4 * Math.PI * 0.343) / 3, 12);
    expect(projectileMass({ ...DEFAULT_PROJECTILE, shape: 'cube' })).toBeCloseTo(8 * 1.4 ** 3, 12);
  });
  it('rejects shapes and values out of range', () => {
    const q = (s: string) => parseProjectile(new URLSearchParams(s));
    expect(() => q('proj=cone')).toThrow(/ball or cube/);
    for (const s of ['proj.size=0', 'proj.size=21', 'proj.mass=0', 'proj.speed=-1', 'proj.speed=fast']) expect(() => q(s)).toThrow(/from/);
    expect(q('proj.mass=')).toEqual(DEFAULT_PROJECTILE);
  });
});

describe('scene controls', () => {
  it('proposes a scene with its body count, or says why it can not be built', () => {
    const c = parseViewerConfig('');
    const ok = proposeScene(c, 'S14', { towers: 3, W: 2, D: 3, H: 4, street: 2, vary: 0 }, 5);
    expect(ok).toMatchObject({ ok: true, bodies: 3 * 2 * 3 * 4, config: { scenario: 'S14', seed: 5, params: { towers: 3 }, engine: c.engine } });
    // What the panel proposes is what the URL then reproduces.
    if (ok.ok) expect(parseViewerConfig(toSearch(ok.config))).toEqual(ok.config);
    expect(proposeScene(c, 'S14', { towers: 0 }, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/towers/) });
    expect(proposeScene(c, 'S14', { towers: NaN }, 1)).toMatchObject({ ok: false });
    expect(proposeScene(c, 'S14', {}, 1.5)).toMatchObject({ ok: false, error: expect.stringMatching(/seed/) });
  });
});

describe('camera in the URL', () => {
  it('round-trips a pose, rounded to mm and mrad, and an orbit at it keeps it', () => {
    const pose = poseOf({ target: [1.23456, 2, -3.0004], yaw: 0.12345, pitch: 0.5, distance: 40.0001, fovY: 0.9 });
    expect(pose).toEqual({ target: [1.235, 2, -3], yaw: 0.123, pitch: 0.5, distance: 40 });
    const c = { ...parseViewerConfig('?scenario=S1'), camera: pose };
    expect(toSearch(c)).toContain('cam=1.235%2C2%2C-3%2C0.123%2C0.5%2C40');
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(poseOf(orbitAt(pose))).toEqual(pose);
    expect(orbitAt({ ...pose, pitch: 3 }).pitch).toBe(1.45); // clamped as dragging clamps it
    expect(parseViewerConfig('').camera).toBeNull();
    expect(toSearch(parseViewerConfig(''))).not.toContain('cam');
    for (const bad of ['1,2,3', '1,2,3,4,5,x', '1,2,3,4,5,0']) expect(() => parseCamera(bad)).toThrow(/cam must be/);
  });
  it('a preset and a rebuilt scene are framed afresh: the start camera is dropped', () => {
    const c = parseViewerConfig('?scenario=S1&cam=0,5,0,1,0.3,20');
    expect(parseViewerConfig(presetSearch('?scenario=S1', c)).camera).toBeNull();
    const p = proposeScene(c, 'S1', { F: 3 }, 1);
    expect(p.ok && p.config.camera).toBe(null);
  });
});

describe('scene file', () => {
  const at = new Date(2026, 9, 27, 1, 5);
  const pose = { target: [1, 2, 3] as [number, number, number], yaw: 0.6, pitch: 0.4, distance: 30 };
  const roundTrip = (c: ViewerConfig, camera = c.camera) => parseSceneFile(JSON.stringify(sceneFile(c, 'x', camera, at)));
  /** What a config loads back as: every scenario param written out, the page's offscreen flag left behind. */
  const settled = (c: ViewerConfig): ViewerConfig => ({ ...c, params: { ...SCENARIOS[c.scenario]!.defaults, ...c.params }, offscreen: false });

  it('lists every scenario param and real knob, splits the engine spec, and keeps the name and camera', () => {
    const c = parseViewerConfig('?scenario=S14&param.towers=3&engine=avbd-gpu:iterations=20,hessian=register&look=real&real.sunElevation=6&proj=cube&proj.mass=50');
    const f = sceneFile(c, '  Sunset city  ', pose, at);
    expect(f).toMatchObject({
      format: SCENE_FILE_FORMAT, version: 1, name: 'Sunset city', savedAt: at.toISOString(),
      scene: { scenario: 'S14', params: { ...SCENARIOS.S14!.defaults, towers: 3 }, seed: 1, sleep: null, scale: 1 },
      engine: { name: 'avbd-gpu', options: { iterations: 20, hessian: 'register' } },
      loop: { mode: 'free', pipeline: true, maxSteps: 1, substeps: 1 },
      projectile: { shape: 'cube', size: 1.4, mass: 50, speed: 40 },
      look: { preset: 'real', real: { ...REAL_DEFAULTS, sunElevation: 6 } },
      camera: pose,
    });
    expect(Object.keys(f.look.real).sort()).toEqual(Object.keys(REAL_DEFAULTS).sort());
  });

  it('loads back the config it was saved from, through JSON, for any URL the viewer takes', () => {
    const urls = [
      '', '?scenario=S1&param.gap=0.02&engine=rapier', '?scenario=S4&param.N=10000&param.F=6&param.H=20&sleep=0&seed=7&autofire=120',
      '?engine=tiered&loop=frame&maxSteps=3', '?pipeline=0&proj=cube&proj.size=3&proj.mass=200&proj.speed=15',
      '?look=hazy', '?scenario=S3&param.running=true&look=real&real.sunElevation=4&real.visibility=12&real.ground=0.3,0.25,0.2&real.stone=granite&real.groundMaterial=dirt&real.env=hall',
      '?scenario=S1&cam=0,4.5,0,0.8,0.3,25', '?offscreen=1&engine=avbd-gpu:iterations=40,sweep=false', '?scenario=S14&scale=0.25&substeps=2&loop=frame&maxSteps=2',
    ];
    for (const u of urls) {
      const c = parseViewerConfig(u);
      const back = roundTrip(c);
      expect(back.name).toBe('x');
      expect(back.config, u).toEqual(settled(c));
      // A loaded file is a URL like any other: the address bar reproduces it.
      expect(parseViewerConfig(toSearch(back.config))).toEqual(back.config);
    }
    expect(roundTrip(parseViewerConfig('?scenario=S1'), pose).config.camera).toEqual(pose);
  });

  it('any projectile and real knobs survive a round trip', () => {
    // + 0: a URL, like JSON, writes -0 as 0.
    const knob = (k: keyof typeof REAL_KNOBS) => fc.option(fc.double({ min: REAL_KNOBS[k].min, max: REAL_KNOBS[k].max, noNaN: true }).map((x) => x + 0), { nil: undefined });
    fc.assert(fc.property(
      fc.record({ shape: fc.constantFrom('ball' as const, 'cube' as const), size: fc.double({ min: 0.1, max: 20, noNaN: true }), mass: fc.option(fc.double({ min: 0.01, max: 1e6, noNaN: true })), speed: fc.double({ min: 0, max: 500, noNaN: true }) }),
      knob('sunElevation'), knob('visibility'), knob('dustOpacity'),
      (projectile, sunElevation, visibility, dustOpacity) => {
        const real = Object.fromEntries(Object.entries({ sunElevation, visibility, dustOpacity }).filter(([, v]) => v !== undefined));
        const c = { ...parseViewerConfig('?look=real'), projectile, real };
        const back = roundTrip(c).config;
        expect(back.projectile).toEqual(projectile);
        // Knobs that equal today's default are dropped on load (the URL stays short); the rest come back exactly.
        expect(back.real).toEqual(Object.fromEntries(Object.entries(real).filter(([k, v]) => v !== REAL_DEFAULTS[k as keyof typeof REAL_DEFAULTS])));
      }));
  });

  it('loading drops real knobs at their defaults, so the URL is as short as the panel keeps it', () => {
    const c = parseViewerConfig('?look=real&real.sunElevation=6');
    expect(toSearch(roundTrip(c).config)).toBe(toSearch(settled(c)));
    expect(toSearch(roundTrip(c).config)).not.toMatch(/real\.(?!sunElevation)/);
  });

  it('a hand-written file may leave out what it does not change', () => {
    const { config, name } = parseSceneFile(JSON.stringify({ format: SCENE_FILE_FORMAT, version: 1, scene: { scenario: 's12' }, engine: { name: 'rapier' } }));
    expect(name).toBe('');
    expect(config).toEqual({ ...parseViewerConfig('?scenario=S12&engine=rapier') });
  });

  it('names the download after the name, or after the scenario and the local time', () => {
    expect(sceneFileName('Sunset city: 10k!', 'S4', at)).toBe('sunset-city-10k.json');
    expect(sceneFileName('  ', 'S4', at)).toBe('S4-20261027-0105.json');
    expect(sceneFileName('../../etc/passwd', 'S4', at)).toBe('etc-passwd.json');
    expect(sceneFileName('城市', 'S14', at)).toBe('S14-20261027-0105.json');
    expect(sceneFileName('a'.repeat(100), 'S4', at)).toBe(`${'a'.repeat(60)}.json`);
  });

  it('refuses files it can not read, saying why', () => {
    const good = sceneFile(parseViewerConfig('?scenario=S1'), '', pose, at);
    const bad = (edit: (f: Record<string, any>) => void) => {
      const f = structuredClone(good) as Record<string, any>;
      edit(f);
      return () => parseSceneFile(JSON.stringify(f));
    };
    expect(() => parseSceneFile('{nope')).toThrow(/not a JSON file/);
    expect(() => parseSceneFile('[]')).toThrow(/must be an object/);
    expect(bad((f) => { f.format = 'something-else'; })).toThrow(/not a tower-blaster viewer scene/);
    expect(bad((f) => { f.version = 2; })).toThrow(/newer than this viewer reads/);
    expect(bad((f) => { f.secne = f.scene; })).toThrow(/unknown key secne/);
    expect(bad((f) => { f.look.real.sunElevaton = 3; })).toThrow(/look.real: unknown key sunElevaton/);
    expect(bad((f) => { f.scene.params.N = 5; })).toThrow(/scene.params \(S1\): unknown key N/);
    expect(bad((f) => { f.scene.scenario = 'S99'; })).toThrow(/unknown scenario S99/);
    expect(bad((f) => { f.scene.seed = 1.5; })).toThrow(/scene.seed must be an integer/);
    expect(bad((f) => { f.scene.params.H = '6'; })).toThrow(/scene.params.H must be a number/);
    expect(bad((f) => { f.engine.name = 'warp'; })).toThrow(/unknown engine warp/);
    expect(bad((f) => { f.engine.options = { iterations: 'many' }; })).toThrow(/takes a number/);
    expect(bad((f) => { f.engine.options = { 'a,b': 1 }; })).toThrow(/bad option name/);
    expect(bad((f) => { f.look.real.sunElevation = 120; })).toThrow(/real.sunElevation must be a number from -10 to 90/);
    expect(bad((f) => { f.look.real.stone = 'cheese'; })).toThrow(/look.real.stone must be one of/);
    expect(bad((f) => { f.look.real.env = 'moon'; })).toThrow(/look.real.env must be one of/);
    expect(bad((f) => { f.look.preset = 'photo'; })).toThrow(/unknown look photo/);
    expect(bad((f) => { f.projectile.size = 50; })).toThrow(/proj.size must be a number from 0.1 to 20/);
    expect(bad((f) => { f.loop = { mode: 'free', pipeline: true, maxSteps: 2 }; })).toThrow(/maxSteps applies to loop=frame/);
    expect(bad((f) => { f.camera.distance = 0; })).toThrow(/cam must be/);
    expect(bad((f) => { f.camera.target = [1, 2]; })).toThrow(/camera.target must be three numbers/);
  });
});
