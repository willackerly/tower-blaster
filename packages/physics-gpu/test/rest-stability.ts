// Rest stability at the game's settings (roadmap F3): big structures left
// idle, and struck then left, must stay where they came to rest. The cases,
// the verdict and the vitest suite (restSuite), shared by
// rest-stability.test.ts (CI's idle case, and the opt-in matrix) and
// rest-stability-struck.test.ts (CI's struck case), in headless Chromium
// (SwiftShader in CI) or installed Chrome with TB_CHANNEL=chrome.
//
// A structure is the S3 wall (1,000 cubes is Will's favourite scene), the S4
// city, or the S15 Kapla tower at real plank size (117 mm planks, real
// gravity in plank widths, autoSubsteps engine steps a frame, the viewer's
// world: worldScene, froudeParams). Frames are 1/60 s of scene time, so
// 3,600 frames is a minute however many engine steps a frame takes.
//
// - idle: nothing happens; the window runs from frame 120 (the start
//   positions settle by a few um) to the end.
// - struck: a ball hits at about one second (S3: a 10 kg ball at 20 m/s,
//   radius 1, into the wall at a height of 3; S4: S5's ball, radius 2, 10x a
//   cube's mass, 20 m/s, into the first tower; S15: its own topple ball,
//   which brings the whole tower down), then the window is the second half
//   of the run, when what was hit has had at least half the run to settle.
//
// Verdict: over the window no structure body moved more than a tenth of the
// smallest body's thickness (cubes 0.1, planks 1/30 of a width), its
// highest body stayed put to that much, the engine hit no limit, and
// nothing errored. Bodies the run spawned (the ball) are left out.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BodyDesc, limitsHit, type SceneDesc, volumeOf } from '@tb/engine-api';
import { AVBD_GAP_SLOP } from '@tb/keystone';
import { type AvbdParams, froudeParams } from '@tb/physics-ref';
import { buildScenario, KAPLA_SCALE, SCENARIOS } from '@tb/scenarios';
import { autoSubsteps, worldScene } from '@tb/viewer';
import type { GpuEngineOptions } from '../src/index.ts';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type { RestPlan, RestResult } from './rest-page.ts';

export const STRUCTURES = ['wall', 'city', 'kapla'] as const;
export type Structure = (typeof STRUCTURES)[number];
export type Mode = 'idle' | 'struck';

export interface RestCase {
  structure: Structure;
  mode: Mode;
  /** Bodies in the structure (the wall rounds to 20 courses; the city and the tower build this many). */
  n: number;
  iterations: number;
  gapSlop: boolean;
  frames: number;
  /** Kapla only: engine steps a frame, in place of autoSubsteps(KAPLA_SCALE) (7); the E5 hold study (kapla-hold.test.ts) sweeps it. */
  substeps?: number;
}

export const caseName = (c: RestCase) => `${c.structure} ${c.n} ${c.mode}, ${c.iterations} it${c.substeps === undefined ? '' : ` x ${c.substeps} substeps`}, gapSlop ${c.gapSlop ? 'on' : 'off'}, ${c.frames} frames`;

const STRIKE_FRAME = 60;

/** The wall: S3, 20 courses high, n / 20 cubes long. */
function wall(n: number, struck: boolean): SceneDesc {
  const s = buildScenario('S3', { W: Math.max(1, Math.round(n / 20)), H: 20 }, 1);
  if (!struck) return s;
  const radius = 1, ball: BodyDesc = {
    shape: { kind: 'sphere', radius }, pos: [0, 3, -6], rot: [0, 0, 0, 1], linVel: [0, 0, 20], angVel: [0, 0, 0],
    density: 10 / volumeOf({ kind: 'sphere', radius }), friction: 0.6, restitution: 0, tag: 0,
  };
  return { ...s, inputs: [{ step: STRIKE_FRAME, kind: 'spawn', body: ball }] };
}

/** The scene, solver parameters, engine options and window for a case. */
export function restSetup(c: RestCase): { scene: SceneDesc; params: Partial<AvbdParams>; opts: Omit<GpuEngineOptions, 'device'>; plan: RestPlan } {
  const struck = c.mode === 'struck';
  const slop = c.gapSlop ? { gapSlop: AVBD_GAP_SLOP } : { gapSlop: 0 };
  let scene: SceneDesc, params: Partial<AvbdParams> = { iterations: c.iterations, ...slop }, opts: Omit<GpuEngineOptions, 'device'> = {}, substeps = 1, thick = 1;
  if (c.substeps !== undefined && (c.structure !== 'kapla' || !Number.isInteger(c.substeps) || c.substeps < 1)) throw new Error(`${caseName(c)}: substeps is for the Kapla tower only, a whole number from 1`);
  if (c.structure === 'wall') scene = wall(c.n, struck);
  else if (c.structure === 'city') scene = struck ? buildScenario('S5', { N: c.n, fireStep: STRIKE_FRAME }, 1) : buildScenario('S4', { N: c.n }, 1);
  else {
    // S15 as the viewer runs it: its own engine options (box test, 32 pair slots a body) under the case's
    // iterations and slop, at real plank size.
    const { iterations: _i, gapSlop: _g, boxBroadphase, pairsPerBody } = SCENARIOS.S15!.avbd as Record<string, number | boolean>;
    opts = { boxBroadphase: boxBroadphase as boolean, pairsPerBody: pairsPerBody as number };
    substeps = c.substeps ?? autoSubsteps(KAPLA_SCALE);
    scene = worldScene(buildScenario('S15', { planks: c.n, topple: struck }, 1), KAPLA_SCALE, substeps);
    params = froudeParams(params, 1 / KAPLA_SCALE);
    thick = Math.min(...scene.bodies.map((b) => (b.shape.kind === 'box' ? 2 * Math.min(...b.shape.half) : 2 * b.shape.radius)));
  }
  return {
    scene, params, opts,
    plan: { frames: c.frames, substeps, watchFrom: struck ? Math.floor(c.frames / 2) : Math.min(120, Math.floor(c.frames / 4)), structure: scene.bodies.length, tol: 0.1 * thick, sampleEvery: 60 },
  };
}

/** Every case of the matrix at these sizes and frames: structures x modes x 20 and 40 iterations x slop on and off. */
export function restMatrix(sizes: number[], frames: number): RestCase[] {
  const out: RestCase[] = [];
  for (const n of sizes) for (const structure of STRUCTURES) for (const mode of ['idle', 'struck'] as const)
    for (const iterations of [40, 20]) for (const gapSlop of [true, false]) out.push({ structure, mode, n, iterations, gapSlop, frames });
  return out;
}

/**
 * Registers a vitest suite (this file's browser, beforeAll / afterAll, one test per case): each case
 * logs a line starting "rest:" with what it measured (also appended to the file REST_LOG names) and
 * fails naming the bound it broke. REST_ONLY=<text> keeps the cases whose name contains it.
 */
export function restSuite(cases: RestCase[]): void {
  let gpu: WebGPUSession | null = null;
  beforeAll(async () => {
    gpu = await openWebGPU([], { channel: process.env.TB_CHANNEL });
    if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./rest-page.ts', import.meta.url)), '__rest');
  }, 120_000);
  afterAll(async () => { await gpu?.close(); });

  const only = process.env.REST_ONLY;
  const mine = cases.filter((c) => !only || caseName(c).includes(only));
  describe('GPU AVBD engine: structures stay at rest at the game\'s settings', () => {
    it.for(mine.map((c) => [caseName(c), c] as const))('%s', { timeout: 3_600_000 }, async ([, c], ctx) => {
      if (!gpu) return ctx.skip();
      const { scene, params, opts, plan } = restSetup(c);
      const r: RestResult = await gpu.page.evaluate(([s, p, o, pl]) => (window as unknown as { __rest: typeof import('./rest-page.ts') }).__rest.restRun(s, p, o, pl), [scene, params, opts, plan] as const);
      const f = (x: number) => x.toExponential(2);
      const line = `rest: ${caseName(c)} (${r.adapter}): window from frame ${plan.watchFrom}, max move ${f(r.maxDisp)} (tol ${plan.tol.toFixed(3)}), ${r.moved} moved; speed end ${f(r.endSpeed)} window max ${f(r.windowSpeed)}; top ${r.topFrom.toFixed(3)} -> ${r.topEnd.toFixed(3)}; mean y ${r.meanY.map((y) => y.toFixed(3)).join(' -> ')}; limits ${limitsHit(r.health).length}; ${(r.wallMs / 1000).toFixed(1)} s, ${r.stepsPerSecond.toFixed(0)} steps/s`;
      console.log(line);
      if (process.env.REST_LOG) appendFileSync(process.env.REST_LOG, `${line}\n`);
      expect(r.error).toBeNull();
      expect(limitsHit(r.health).map((l) => l.message)).toEqual([]);
      expect({ moved: r.moved, maxDispUnderTol: r.maxDisp <= plan.tol, topHeld: Math.abs(r.topEnd - r.topFrom) <= plan.tol }).toEqual({ moved: 0, maxDispUnderTol: true, topHeld: true });
    });
  });
}
