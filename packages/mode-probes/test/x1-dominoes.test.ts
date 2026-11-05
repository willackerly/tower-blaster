// X1, domino propagation and sleep: the scenes are what the probe says they
// are (CPU), the meter reads a run the way the probe means (on the f64
// reference, CPU), and the CI-size cases propagate on the GPU engine at game
// settings, with sleep leaving the dominoes alone (SwiftShader in CI). The
// full-size probe runs with pnpm probe:modes X1 (docs/game/mode-probes.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BodyDesc } from '@tb/engine-api';
import { boxBoxSeparation, obb, signedDepth } from '@tb/geom';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { requireWebGPU } from '@tb/testkit';
import { corners, drive, GAME_PARAMS, probeById, tiltDeg, yaw } from '../src/index.ts';
import { curvePath, fieldPath, linePath, PUSH_STEP, type RunResult, SPACING, X1, type X1Case, x1Spec } from '../src/x1-dominoes.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const ob = (b: BodyDesc) => obb(b.pos, b.rot, (b.shape as { half: [number, number, number] }).half);

describe('X1 scenes', () => {
  it('a line and a curve place a domino every 0.6 h along the centre line, facing along it', () => {
    const line = linePath(5);
    expect(line.map((p) => p.z)).toEqual([0, 0.6, 1.2, 1.8, 2.4].map((z) => expect.closeTo(z, 12)));
    for (const r of [3, 5, 8]) {
      const c = curvePath(r, 8);
      expect(c.length).toBe(1 + Math.floor((2 * 7 * SPACING + Math.PI * r) / SPACING + 1e-9));
      for (let k = 1; k < c.length; k++) {
        const chord = Math.hypot(c[k]!.x - c[k - 1]!.x, c[k]!.z - c[k - 1]!.z);
        // Exactly the spacing on the straights, a chord of it on the arc.
        expect(chord).toBeGreaterThan(SPACING * (1 - SPACING ** 2 / (24 * r * r)) - 1e-9);
        expect(chord).toBeLessThanOrEqual(SPACING + 1e-9);
        // The heading is the direction of travel (tangent), to within the half step.
        const travel = Math.atan2(c[k]!.x - c[k - 1]!.x, c[k]!.z - c[k - 1]!.z);
        expect(Math.abs(Math.atan2(Math.sin(travel - c[k]!.heading), Math.cos(travel - c[k]!.heading)))).toBeLessThan(SPACING / r / 2 + 1e-9);
      }
      expect(c.at(-1)!.x).toBeCloseTo(2 * r, 9);
      expect(c.at(-1)!.heading).toBe(Math.PI);
    }
    const f = fieldPath(3, 4);
    expect(f).toHaveLength(12);
    expect(f[4]!.x - f[0]!.x).toBeCloseTo(0.375, 12);
  });

  const runCases: X1Case[] = [
    { kind: 'line', n: 30, nudge: 3, sleep: false },
    { kind: 'curve', r: 3, lead: 8, nudge: 5, sleep: true },
    { kind: 'field', rows: 5, cols: 7, nudge: 2, sleep: true },
  ];
  it.for(runCases)('$kind: dominoes stand clear of each other and the ground, and each push starts just behind its first domino', (c) => {
    const s = x1Spec(c), dominoes = s.scene.bodies;
    for (const b of dominoes) expect(Math.min(...corners(b).map((p) => p[1]))).toBeGreaterThan(0);
    for (let i = 0; i < dominoes.length; i++) for (let j = i + 1; j < dominoes.length; j++) {
      const d = Math.hypot(dominoes[i]!.pos[0] - dominoes[j]!.pos[0], dominoes[i]!.pos[2] - dominoes[j]!.pos[2]);
      if (d < 1.2) expect(boxBoxSeparation(ob(dominoes[i]!), ob(dominoes[j]!))).toBeGreaterThan(0.1);
    }
    const pushes = s.scene.inputs.filter((e) => e.kind === 'spawn');
    expect(pushes).toHaveLength(c.kind === 'field' ? c.cols : 1);
    for (const [k, e] of pushes.entries()) {
      if (e.kind !== 'spawn' || e.body.shape.kind !== 'sphere') throw new Error('push is a ball');
      expect(e.step).toBe(PUSH_STEP);
      const target = dominoes[k]!, gap = -signedDepth(e.body.shape, e.body.pos, e.body.rot, target.shape, target.pos, target.rot);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(0.07);
      // Moving toward its domino, at about 1 m/s.
      const to = [0, 2].map((a) => target.pos[a]! - e.body.pos[a]!), v = [e.body.linVel[0], e.body.linVel[2]];
      expect(to[0]! * v[0]! + to[1]! * v[1]!).toBeGreaterThan(0);
      expect(Math.hypot(...v)).toBeGreaterThan(0.89);
      expect(Math.hypot(...v)).toBeLessThan(1.11);
    }
    expect(s.params).toEqual(GAME_PARAMS);
    expect(s.opts.sleep).toBe(c.sleep);
    expect(s.scene.frictionCombine).toBe('min');
  });

  it.for([20, 40])('a domino cocked at %i deg rests on the ground on its front edge and on the block on its top edge', (deg) => {
    const [d, block] = x1Spec({ kind: 'cocked', deg, steps: 1, sleep: true }).scene.bodies as [BodyDesc, BodyDesc];
    expect(tiltDeg(Float64Array.from(d.rot), 0)).toBeCloseTo(deg, 9);
    expect(Math.min(...corners(d).map((p) => p[1]))).toBeCloseTo(0, 5);
    expect(boxBoxSeparation(ob(d), ob(block))).toBeGreaterThan(0);
    expect(boxBoxSeparation(ob(d), ob(block))).toBeLessThan(1e-5);
  });

  it('tilt is the angle between a body\'s up and the world\'s, whatever its yaw', () => {
    const tilt = (q: number[]) => tiltDeg(Float64Array.from(q), 0);
    expect(tilt(yaw(1.3))).toBeCloseTo(0, 9);
    const a = (30 * Math.PI) / 180;
    expect(tilt([Math.sin(a / 2), 0, 0, Math.cos(a / 2)])).toBeCloseTo(30, 9);
    expect(tilt([0, 0, Math.sin(a / 2), Math.cos(a / 2)])).toBeCloseTo(30, 9);
  });

  it('the probe is registered and every full-size case builds', () => {
    expect(probeById('x1')).toBe(X1);
    const full = X1.cases('full');
    expect(full.filter((c) => c.kind === 'line')).toHaveLength(64);
    expect(full.filter((c) => c.kind === 'curve')).toHaveLength(192);
    for (const c of full.filter((x) => x.kind !== 'field')) expect(() => X1.spec(c)).not.toThrow();
    expect(x1Spec({ kind: 'field', rows: 100, cols: 100, nudge: 0, sleep: true }).scene.bodies).toHaveLength(10_000);
  });
});

describe('X1 meter on the f64 reference', () => {
  it('a line of 6 dominoes falls end to end; the front is timed', { timeout: 120_000 }, async () => {
    const c: X1Case = { kind: 'line', n: 6, nudge: 1, sleep: false }, spec = x1Spec(c), meter = X1.meter(c, spec);
    const { steps } = await drive(new AvbdReferenceEngine(spec.params), spec, meter);
    const r = meter.result() as RunResult;
    expect(r).toMatchObject({ n: 6, fallen: 6, end: true, stalled: false });
    expect(steps).toBeLessThan(spec.steps);
    expect(r.lastFallStep).toBeGreaterThan(0);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X1 on the GPU engine at game settings (CI size)', () => {
  it('lines and a field propagate end to end, sleep freezes no domino mid-fall, a cocked domino sleeps and holds', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X1, 'ci', { log: (l) => console.log(l) });
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    console.log(run.verdict.table.join('\n'));
    const failed = run.verdict.checks.filter((c) => !c.pass);
    expect(failed).toEqual([]);
    expect(run.verdict.pass).toBeNull();
    // With sleep, standing dominoes ahead of the front stay asleep until it reaches them.
    for (const r of run.runs) {
      const x = r.result as RunResult | { kind: 'cocked' };
      if (x.kind !== 'cocked' && r.label.includes('sleep')) expect(x.aheadAwakeMax, r.label).toBe(0);
    }
  });
});
