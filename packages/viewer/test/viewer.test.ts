import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildScenario } from '@tb/scenarios';
import { massOf, TAG_BALL } from '@tb/engine-api';
import {
  alphaAt, arrived, DEFAULT_PROJECTILE, engineSpec, escapeHtml, eyeOf, frame, FREE_MAX_LAG_MS, GPU_SPARE, invert, MAX_STEPS_LIMIT, multiply,
  newArrivals, newClock, newPacer, PACE_SLACK, parseProjectile, parseViewerConfig, presetSearch, projectileBody, projectileMass, proposeScene,
  pushRadiusLimit, rayThrough, runFree, SIM_SPEED_TAU, stepDue, stepped, stepsDue, taskYield, toSearch, trackSimSpeed, transform, viewProj, Window,
  withOption, type FreeHooks, type Orbit,
} from '../src/index.ts';

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
 * The viewer's loop=free schedule on a virtual clock: runFree (as main.ts
 * runs it) with display frames at phaseMs + k periodMs (plus jitter); each
 * step costs stepMs and its snapshot snapMs. Frames in `gaps` never fire (a
 * hidden tab); frames in `paused` find the loop paused. Each frame draws the
 * two newest snapshots at alphaAt; `shown` is the step it draws, (newest - 1)
 * + alpha, and `simSpeed` what the frame loop's trackSimSpeed reads at the end.
 */
async function simulateFree(o: {
  periodMs: number; stepMs: number; snapMs?: number; frames: number; phaseMs?: number;
  jitter?: (k: number) => number; gaps?: Array<[number, number]>; paused?: [number, number];
}) {
  const dtMs = 1000 / 60;
  const frameAt = (k: number) => (o.phaseMs ?? 0) + k * o.periodMs + (o.jitter?.(k) ?? 0);
  const skipped = (k: number) => (o.gaps ?? []).some(([from, to]) => k >= from && k < to);
  const done: number[] = []; // completion time of each step
  let t = 0, waits = 0, k = 0;
  const end = frameAt(o.frames);
  await runFree({
    running: () => t < end,
    // k is the frame the loop last woke on.
    paused: () => !!o.paused && k >= o.paused[0] && k < o.paused[1],
    now: () => t,
    dtMs: () => dtMs,
    resetIfAsked: async () => false,
    step: async () => { t += o.stepMs; },
    refresh: async () => { t += o.snapMs ?? 0; done.push(t); },
    yields: () => true,
    nextFrame: async () => {
      while (frameAt(k) <= t || skipped(k)) k++;
      t = frameAt(k);
      waits++;
    },
    nextTask: async () => {},
  }, newPacer(), newArrivals());
  // Frames: steps completed since the previous frame, and the step drawn.
  const perFrame: number[] = [], shown: number[] = [];
  const replay = newArrivals();
  const clock = newClock();
  let j = 0, last = 0;
  for (let f = 0; f < o.frames; f++) {
    if (skipped(f)) continue;
    const now = frameAt(f);
    let n = 0;
    while (j < done.length && done[j]! <= now) { arrived(replay, done[j]!, dtMs); j++; n++; }
    perFrame.push(n);
    shown.push(j === 0 ? 0 : j - 1 + alphaAt(replay, now, dtMs));
    if (f > 0) trackSimSpeed(clock, n, now - last, 1 / 60);
    last = now;
  }
  return { steps: done.length, waits, perFrame, shown, dtMs, simSpeed: clock.simSpeed };
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
  });
  it('a fast engine on a 120 Hz display steps every other frame, and sim speed reads real time', async () => {
    const r = await simulateFree({ periodMs: 1000 / 120, stepMs: 2, frames: 1200 });
    expect(Math.max(...r.perFrame)).toBe(1);
    expect(r.steps).toBeGreaterThanOrEqual(599);
    expect(r.steps).toBeLessThanOrEqual(601);
    expect(r.simSpeed).toBeGreaterThan(0.98);
  });
  it('a display slightly slower than 60 Hz (59.94) gets one step a frame, plus one extra every ~1000 frames, from any start phase', async () => {
    for (const phaseMs of [0, 3, 10, 14, 16]) {
      // A 9 ms step: finishing it inside the frame must not make the next step due in the same frame.
      const r = await simulateFree({ periodMs: 1000 / 59.94, phaseMs, stepMs: 8, snapMs: 1, frames: 2000 });
      // (Frame 1 can come before the second step is due: physics starts phaseMs before frame 0.)
      const odd = r.perFrame.slice(2).filter((n) => n !== 1);
      // 2000 frames at 59.94 Hz are 2002 steps of real time: two frames of 2, never a 0, 2, 0, 2 lock.
      expect(odd.every((n) => n === 2)).toBe(true);
      expect(odd.length).toBeLessThanOrEqual(3);
      expect(r.simSpeed).toBeGreaterThan(0.99);
    }
  });
  it('a fast engine on a 30 Hz display takes two steps per frame, so the sim keeps real time (loop=frame runs at half speed there)', async () => {
    const r = await simulateFree({ periodMs: 1000 / 30, stepMs: 2, frames: 300 });
    // Frame 1 shows the first step only (taken at t = 0); from then on two per frame.
    expect(r.perFrame.slice(0, 2)).toEqual([0, 1]);
    expect(r.perFrame.slice(2).every((n) => n === 2)).toBe(true);
    expect(r.steps).toBeGreaterThanOrEqual(599);
  });
  it('a slow engine steps back to back and never waits for a frame: sim speed is dt / (step + snapshot)', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 18, snapMs: 2, frames: 600 });
    expect(r.waits).toBe(0);
    expect(r.steps).toBe(500);
    expect(Math.abs(r.simSpeed - dtMs / 20)).toBeLessThan(1 / 60 / SIM_SPEED_TAU);
  });
  it('after a pause it resumes with one step, not a burst of the owed time', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 2, frames: 120, paused: [30, 60] });
    // perFrame[k] counts steps finished before frame k: frame 30's step (taken when it woke) is the last.
    expect(r.perFrame.slice(32, 61).every((n) => n === 0)).toBe(true);
    expect(r.perFrame.slice(61).every((n) => n === 1)).toBe(true);
    expect(r.steps).toBe(120 - 30);
  });
  it('after frames stop for 300 ms (a hidden tab), it catches up at most FREE_MAX_LAG_MS, then one step per frame', async () => {
    const r = await simulateFree({ periodMs: dtMs, stepMs: 2, frames: 120, gaps: [[30, 48]] });
    const at = r.perFrame.findIndex((n, i) => i > 25 && n > 1);
    expect(r.perFrame[at]).toBeLessThanOrEqual(Math.ceil(FREE_MAX_LAG_MS / dtMs) + 1);
    expect(r.perFrame.slice(at + 1).every((n) => n === 1)).toBe(true);
    // 18 frames (300 ms) were missed; all but about FREE_MAX_LAG_MS of it is dropped as slow motion.
    expect(120 - r.steps).toBeGreaterThanOrEqual(Math.floor((300 - FREE_MAX_LAG_MS) / dtMs) - 1);
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
    resetIfAsked: async () => false, step: async () => {}, refresh: async () => {}, yields: () => false,
    nextFrame: () => new Promise((resolve) => setTimeout(resolve, 16)), nextTask: async () => {}, ...o,
  });
  it('a CPU engine slower than real time gets a task boundary after every step, so timers (frames, input) still run', async () => {
    let steps = 0, ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const stop = performance.now() + 300;
    // 20 ms steps against a 16.7 ms dt: always due, so the loop never waits for a frame.
    // (Node drains a MessagePort's messages in one go, so the test's task boundary is a timer;
    // in a browser each message is its own task, which is what taskYield relies on.)
    await runFree(hooks({ running: () => performance.now() < stop, step: async () => { busy(20); steps++; }, nextTask: () => new Promise((resolve) => setTimeout(resolve, 0)) }), newPacer(), newArrivals());
    clearInterval(timer);
    expect(steps).toBeGreaterThanOrEqual(10);
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
      async resetIfAsked() { if (!ask) return false; ask = false; resets++; return true; },
      step: async () => { steps++; if (steps === 3) paused = true; if (steps === 5) ask = true; },
      now: () => steps * 1000, // always due once unpaused
    }), pacer, arrivals);
    expect({ steps, tasks, resets }).toEqual({ steps: 6, tasks: 0, resets: 1 });
    expect(frames).toBe(3); // the three paused passes
    // The reset after step 5 restarted the pacer at the next check (now = 5000); one step since.
    expect(pacer.next).toBeCloseTo(5000 + 1000 / 60, 6);
    expect(arrivals.last).toBe(6000);
    expect(arrivals.interval).toBeNaN();
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
    expect(toSearch(parseViewerConfig(''))).not.toMatch(/maxSteps|loop/);
  });
  it('a URL with maxSteps and no loop keeps the frame loop it was written for', () => {
    expect(parseViewerConfig('?maxSteps=2')).toMatchObject({ loop: 'frame', maxSteps: 2 });
    expect(parseViewerConfig('?maxSteps=1')).toMatchObject({ loop: 'frame', maxSteps: 1 });
  });
  it('rejects unknown scenarios, non-numeric params, a maxSteps outside 1-4, an unknown loop and maxSteps on the free loop', () => {
    expect(() => parseViewerConfig('?scenario=S99')).toThrow(/unknown scenario/);
    expect(() => parseViewerConfig('?param.N=lots')).toThrow(/not a number/);
    for (const m of ['0', '5', '1.5', 'two']) expect(() => parseViewerConfig(`?maxSteps=${m}`)).toThrow(/maxSteps/);
    expect(parseViewerConfig(`?maxSteps=${MAX_STEPS_LIMIT}`).maxSteps).toBe(MAX_STEPS_LIMIT);
    expect(() => parseViewerConfig('?loop=fast')).toThrow(/loop must be free or frame/);
    expect(() => parseViewerConfig('?loop=free&maxSteps=2')).toThrow(/maxSteps applies to loop=frame/);
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
