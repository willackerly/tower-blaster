// The opt-in variants together on the GPU engine (AvbdParams.records,
// colorMode, colorPriority): the lattice colouring in effect with records 2,
// records 1 the point form bit for bit under the lattice colourings, and each
// combination against the reference's same combination, within the single
// variants' tolerances (records.test.ts, lattice-physics.test.ts).
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { GpuAvbdEngine } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, gpu, toSnap } from './harness.ts';

describe('GPU AVBD engine: the opt-in variants together', () => {
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  /** The scene with `params`: no error, contacts in use, finite at the end. */
  const checked = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every = 0) => {
    const base = await call('simulateGpu', scene, steps, params, every, {}, [], true);
    expect(base.error, JSON.stringify(params)).toBeNull();
    expect(base.contacts!.used).toBeGreaterThan(10);
    expect(nonFinite(toSnap(base.snaps.at(-1)!))).toBe(0);
    return base;
  };
  // A ball into two 2x2x8 towers (it reaches them at about step 17): contacts from the first step, and colours that change.
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

  describe('records with the lattice colouring', () => {
    it('colorMode 3 and 4 (4 with colorPriority 1), and both with records 2: they run, and with records 2 the colouring is in effect', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const unlatticed = await call('simulateGpu', knock(), 24, { iterations: 4, records: 2 }, 8, {});
      expect(unlatticed.error).toBeNull();
      for (const params of [{ colorMode: 3 }, { colorMode: 4, colorPriority: 1 }, { colorMode: 3, records: 2 }, { colorMode: 4, records: 2 }]) {
        const base = await checked(knock(), 24, { iterations: 4, ...params }, 8);
        // With records 2 the colouring is in effect: the order, and so the rounding, is not the default's.
        if ('records' in params) expect(state(base.snaps.at(-1)!), JSON.stringify(params)).not.toEqual(state(unlatticed.snaps.at(-1)!));
      }
    });

    it('records 1 under colorMode 3 and 4, also with colorPriority 1: the point form\'s bodies under the same colouring, bit for bit', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      // The record buffer is laid out unlike the contacts, so only the bodies compare (records.test.ts, for the default colouring).
      // The point form is records 0 (unset is records 1 on the GPU).
      const run = async (params: Partial<AvbdParams>) => {
        const r = await call('simulateGpu', knock(), 24, { iterations: 4, ...params }, 8, {});
        expect(r.error, JSON.stringify(params)).toBeNull();
        return r;
      };
      const unlatticed = await run({ records: 0 });
      for (const colorMode of [3, 4]) {
        const points = await run({ colorMode, records: 0 });
        // The colouring is in effect: the order, and so the rounding, is not the default's.
        expect(state(points.snaps.at(-1)!)).not.toEqual(state(unlatticed.snaps.at(-1)!));
        for (const p of [{}, { records: 1 }, { records: 1, colorPriority: 1 }]) {
          const r = await run({ colorMode, ...p });
          const base = 'colorPriority' in p ? await run({ colorMode, colorPriority: 1, records: 0 }) : points;
          expect(r.snaps.length).toBe(base.snaps.length);
          r.snaps.forEach((s, k) => expect(state(s), `colorMode ${colorMode} ${JSON.stringify(p)}, step ${s.step}`).toEqual(state(base.snaps[k]!)));
        }
      }
    });
  });

  /** Worst |GPU - reference| position over sampled steps, both with the same params (the reference in f64). */
  async function parity(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every: number) {
    const g = await call('simulateGpu', scene, steps, params, every, {}, []);
    expect(g.error).toBeNull();
    expect(g.worst.uncolored).toBe(0);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    let worst = 0;
    const at: Array<[number, number]> = [];
    for (let i = 1; i <= steps; i++) {
      e.step();
      const s = g.snaps.find((x) => x.step === i);
      if (!s) continue;
      const ref = e.snapshot().pos;
      let w = 0;
      for (let k = 0; k < ref.length; k++) w = Math.max(w, Math.abs(ref[k]! - s.pos[k]!));
      at.push([i, w]);
      worst = Math.max(worst, w);
    }
    return { worst, at, last: g.snaps.at(-1)! };
  }

  describe('each combination against the reference\'s same combination', () => {
    // lattice-physics.test.ts's bounds for a colorMode against the reference's: a 3x3x8 tower and an 8x8x5 block stand
    // for 120 steps, within 1e-3 of the reference variant and of where they started. A stand does that under any
    // colouring, so these are smoke tests of the combinations; that the colouring is applied is tested above (and in
    // lattice-colours and lattice-impact).
    it.for([
      [{ colorMode: 3, records: 2 }],
      [{ colorMode: 4, records: 2 }],
    ] as const)('%j: a 3x3x8 tower and an 8x8x5 block stand, matching the reference', { timeout: 300_000 }, async ([params], ctx) => {
      if (!gpu) return ctx.skip();
      for (const shape of [{ F: 3, H: 8, gap: 0 }, { F: 8, H: 5, gap: 0 }]) {
        const scene = buildScenario('S1', shape, 1);
        const g = await parity(scene, 120, params, 120);
        expect(g.worst, JSON.stringify(shape)).toBeLessThan(1e-3);
        let side = 0;
        scene.bodies.forEach((b, i) => { side = Math.max(side, Math.hypot(g.last.pos[3 * i]! - b.pos[0], g.last.pos[3 * i + 2]! - b.pos[2])); });
        expect(side, JSON.stringify(shape)).toBeLessThan(1e-3);
      }
    });
  });

  it('every combination is accepted and recorded in the variant; the fused dual\'s option and engine option, removed, throw', () => {
    const all = { records: 2, colorMode: 3, colorPriority: 1 } as const;
    expect(new GpuAvbdEngine(all).info.variant).toMatchObject(all);
    for (const dualFusion of [true, false]) expect(() => new GpuAvbdEngine({ dualFusion } as never)).toThrow(/dualFusion \(the fused dual\) was removed after the M5 sweep/);
    expect(() => new GpuAvbdEngine({}, { solveContactsRW: true } as never)).toThrow(/solveContactsRW was removed with the fused dual/);
  });
});
