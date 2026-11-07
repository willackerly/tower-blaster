// X6, resonance under a gravity schedule and the far-blast shove: the shake is
// field events (engine-api field.ts; CPU, on the f64 reference: a free cube's
// velocity is the schedule's sum), the envelope grows as stated, the
// columns stand clear, and the far blast's own definition gives every body
// exactly maxDv along its direction. At CI size on the GPU engine
// (SwiftShader) the far kick is maxDv to 1 % on every free cube, a standing
// building moves on at about maxDv, and the shake fells a column but none
// below its static tipping load. Which height falls first is not asserted:
// with one column of each and a fast CI ramp it changes with the ramp (the
// tallest first at 15% a cycle from 0.02 g, the shortest at 15% from 0.1 g);
// the full probe's eight nudges per height and slow ramp decide it. The
// full probe runs with pnpm probe:modes X6.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blastKick, checkBlast, type BodyDesc, FIELD_QUANTUM, fieldGravity, quantiseField, quantiseVec3, scheduleEvents, type Vec3 } from '@tb/engine-api';
import { boxBoxSeparation, obb } from '@tb/geom';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { requireWebGPU } from '@tb/testkit';
import { box, drive, DT, gameScene, GRAVITY, type Meter, probeById, type RunSpec } from '../src/index.ts';
import { A0, A_MAX, columns, envelope, HEIGHTS, shakeSteps, SHOVE_DV, shoveWorld, X6, type X6Case, type X6Result, x6Spec } from '../src/x6-shake.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const ob = (b: BodyDesc) => obb(b.pos, b.rot, (b.shape as { half: [number, number, number] }).half);

describe('X6 schedule, columns and shove', () => {
  it('a gravity schedule as field events: a free cube\'s velocity is the quantised schedule\'s sum times dt', async () => {
    const base = quantiseVec3([0, -GRAVITY, 0]), sched = (i: number): Vec3 => [Math.sin(0.3 * i), base[1], 0.1 * i];
    const scene = gameScene('x6-free', {}, [box([0, 50, 0], [0.25, 0.25, 0.25])], scheduleEvents(0, 40, sched, base), { ground: null, gravity: base });
    const spec: RunSpec = { scene, steps: 40, params: { iterations: 4 }, opts: {} };
    let vx = 0, vz = 0;
    const meter: Meter<null> = { every: 40, sample: (step, s) => { if (step === 40) { vx = s.linVel[0]!; vz = s.linVel[2]!; } }, result: () => null };
    await drive(new AvbdReferenceEngine({ iterations: 4 }), spec, meter);
    let ex = 0, ez = 0;
    for (let i = 0; i < 40; i++) { ex += quantiseField(sched(i)[0]) * DT; ez += quantiseField(sched(i)[2]) * DT; }
    expect(vx).toBeCloseTo(ex, 9);
    expect(vz).toBeCloseTo(ez, 9);
  });

  it('the envelope starts at A0, grows by `growth` a cycle and tops out at A_MAX by shakeSteps', () => {
    const c = { f: 2, growth: 1.05 };
    expect(envelope(c, 0)).toBeCloseTo(A0, 12);
    expect(envelope(c, 1 / c.f) / envelope(c, 0)).toBeCloseTo(1.05, 12);
    expect(envelope(c, shakeSteps(c) * DT)).toBe(A_MAX);
    expect(envelope(c, (shakeSteps(c) - 2) * DT)).toBeLessThan(A_MAX);
    // A case's own bounds: from a0 to aMax in log(aMax / a0) / log(growth) cycles.
    const b = { ...c, a0: 0.1, aMax: 0.5 };
    expect(envelope(b, 0)).toBeCloseTo(0.1, 12);
    expect(envelope(b, shakeSteps(b) * DT)).toBe(0.5);
    expect(shakeSteps(b)).toBe(Math.ceil(Math.log(5) / Math.log(1.05) / 2 / DT));
    // The CI shake case uses them, and starts above a 20-cube column's static tipping load.
    const ci = X6.cases('ci').find((x) => x.kind === 'shake')!;
    expect(ci).toMatchObject({ a0: 0.1, aMax: 0.7 });
    expect(x6Spec(ci).steps).toBeLessThan(1000);
    const spec = x6Spec({ kind: 'shake', ...c, nudges: 1, presettle: 10 }), base = quantiseVec3([0, -GRAVITY, 0]);
    expect(spec.scene.gravity).toEqual(base);
    expect(fieldGravity(spec.scene, 9)).toEqual(base);
    expect(fieldGravity(spec.scene, 10)[0]).toBe(0);
    const t = DT, want = envelope(c, t) * GRAVITY * Math.sin(2 * Math.PI * c.f * t);
    expect(Math.abs(fieldGravity(spec.scene, 11)[0] - want)).toBeLessThanOrEqual(FIELD_QUANTUM / 2);
    expect(spec.opts.sleep).toBeFalsy();
  });

  it('columns: every height per nudge, 4 m apart, standing on the ground and clear of each other', () => {
    const { bodies, cols } = columns(3, 1);
    expect(cols).toHaveLength(3 * HEIGHTS.length);
    expect(bodies).toHaveLength(3 * (5 + 10 + 20));
    for (const k of cols) {
      const own = bodies.slice(k.first, k.first + k.height);
      expect(Math.min(...own.map((b) => b.pos[1]))).toBeCloseTo(0.25, 12);
      for (let i = 1; i < own.length; i++) expect(boxBoxSeparation(ob(own[i - 1]!), ob(own[i]!))).toBeGreaterThan(-1e-9);
    }
  });

  it('the far blast\'s definition gives every body exactly maxDv along (p - centre) / |p - centre|', () => {
    for (const design of ['floating', 'standing'] as const) {
      const c: Extract<X6Case, { kind: 'shove' }> = { kind: 'shove', design, dist: 1000, presettle: 10 }, w = shoveWorld(c);
      const ev = x6Spec(c).scene.inputs[0]!;
      if (ev.kind !== 'blast') throw new Error('no blast');
      const b = checkBlast(ev.blast);
      for (let i = 0; i < w.bodies.length; i++) {
        const p = w.bodies[i]!.pos, m = 250 * 0.125, area = 2 * 3 * 0.0625, k = blastKick(b, w.centre, i, p, m, area)!;
        expect(Math.hypot(...k)).toBeCloseTo(SHOVE_DV, 9);
        const d = Math.hypot(p[0] - w.centre[0], p[1] - w.centre[1], p[2] - w.centre[2]);
        for (let a = 0; a < 3; a++) expect(k[a]).toBeCloseTo((SHOVE_DV * (p[a]! - w.centre[a]!)) / d, 9);
      }
    }
    expect(probeById('X6')).toBe(X6);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X6 on the GPU engine at game settings (CI size)', () => {
  it('the far shove is uniform to 1%, and the shake fells a column but none below its static tipping load', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X6, 'ci', { log: (l) => console.log(l) });
    console.log(run.verdict.table.join('\n'));
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    for (const ch of run.verdict.checks.filter((x) => x.name.startsWith('shove at') || x.name.startsWith('no engine'))) expect(ch.pass, `${ch.name}: ${ch.detail}`).toBe(true);
    for (const r of run.runs) {
      const res = r.result as X6Result;
      if (res.kind === 'shove') {
        // The standing building takes the kick less what its contacts take in the step: it moves on at about maxDv.
        if ((r.c as X6Case & { kind: 'shove' }).design === 'standing') { expect(res.meanAlong, r.label).toBeGreaterThan(0.9); expect(res.meanAlong, r.label).toBeLessThan(1); }
        continue;
      }
      for (const col of res.columns) {
        // A rigid column cannot lift off below g b / h = g / n; the envelope is read at the last upright sample.
        if (col.failA !== null) expect(col.failA, `${r.label} ${col.height} cubes`).toBeGreaterThan(0.8 / col.height);
      }
      // The schedule shakes hard enough to fell something by its cap.
      expect(res.columns.some((x) => x.failA !== null), r.label).toBe(true);
    }
  });
});
