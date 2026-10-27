// Restitution (AvbdParams.restitution) on manifold records 1, the GPU engine's default contact layout (#79). The
// pass reads a slot's points through one view of either layout (src/restitution.ts: POINT_VIEW, RECORD_VIEW) and
// releases a bounced point's force in its record. Records 1 is the point form's physics bit for bit
// (records.test.ts), so with restitution on it moves every body exactly as points do and bounces the same points
// with the same impulses (restitutionStats, every step). The scenes: a cube landing on its edge and one landing
// flat (ground slots, the centroid step), a cube dropped flat onto two cubes (pair slots and supports), a ball onto
// a resting cube (supports in a ground slot), and a ball knocking a 48-cube city down at e 0.3 (hundreds of
// bounced points and lambda resets), that one also with gapSlop at 40 iterations and with colorMode 3.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import type { AvbdParams } from '@tb/physics-ref';
import { GpuAvbdEngine, restitutionKernels } from '../src/index.ts';
import { ball, cube, dropScene, floats, G, gpuRun, knock, ON, type Run, sceneOf, withE } from './bounce.ts';
import { gpu } from './harness.ts';

const onTwo = () => sceneOf([cube([-0.55, 0.5, 0], { e: 0.9 }), cube([0.55, 0.5, 0], { e: 0.9 }), cube([0, 1.5 + 25 / (2 * G), 0], { e: 0.9 })], { groundE: 0.9 });
const edge = dropScene('edge', 6, 0.7), flat = dropScene('cube', 5, 0.9, { groundE: 0.5 });
const CASES: Array<[string, () => SceneDesc, number, Partial<AvbdParams>]> = [
  ['a cube landing on its edge at 6 m/s (e 0.7)', () => edge.scene, edge.steps, {}],
  ['a cube landing flat at 5 m/s (e 0.9, the ground 0.5)', () => flat.scene, flat.steps, {}],
  ['a cube dropped flat onto two cubes (e 0.9)', onTwo, 200, {}],
  ['a ball onto a cube resting on the ground (e 0.9)', () => sceneOf([cube([0, 0.5, 0], { e: 0.9 }), ball([0.2, 2.2, 0.1], { e: 0.9, linVel: [0, -5, 0] })], { groundE: 0.9 }), 120, {}],
  ['a ball knocking a 48-cube city down (e 0.3)', () => withE(knock(15), 0.3), 150, {}],
  ['the knockdown at e 0.6 with gapSlop 3e-5 at 40 iterations', () => withE(knock(12), 0.6), 100, { gapSlop: 3e-5, iterations: 40 }],
  ['the knockdown with colorMode 3', () => withE(knock(15), 0.3), 150, { colorMode: 3 }],
];
const bounced = (r: Run) => r.stats.reduce((s, x) => s + (x?.contacts ?? 0), 0);

describe('GPU AVBD engine: restitution on manifold records 1', () => {
  it('unset, restitution runs on records 1, or points with the array Hessian; records 2 still refuses it; each kernel binds the layout it reads', () => {
    expect([new GpuAvbdEngine({ restitution: true }).records, new GpuAvbdEngine({ records: 1, restitution: true }).records, new GpuAvbdEngine({ restitution: true }, { hessian: 'array' }).records]).toEqual([1, 1, 0]);
    expect(() => new GpuAvbdEngine({ records: 2, restitution: true })).toThrow('GpuAvbdEngine: AvbdParams.restitution is not implemented with AvbdParams.records 2 on the GPU yet');
    // The kernels' contact bindings: SolverContact points, or SolverRecord records, never both; restArgs binds neither.
    const decls = (code: string) => code.split('\n').filter((l) => l.includes('var<storage')).join('\n');
    for (const [layout, own, other] of [[{ records: 0 } as const, 'array<SolverContact>', 'array<SolverRecord>'], [{ records: 1, head: '' } as const, 'array<SolverRecord>', 'array<SolverContact>']] as const) {
      for (const k of restitutionKernels('', layout)) {
        const reads = k.bindings.includes('contacts') || k.bindings.includes('contactsRw');
        expect(decls(k.code).includes(own), `${k.entry}, records ${layout.records}`).toBe(reads);
        expect(decls(k.code).includes(other), `${k.entry}, records ${layout.records}`).toBe(false);
        // Only restFinish writes them (the lambda reset).
        expect(decls(k.code).includes(`read_write> ${layout.records ? 'records' : 'contacts'}`)).toBe(k.entry === 'restFinish');
      }
    }
  });

  for (const [name, scene, steps, params] of CASES) {
    it(`${name}: the same floats and restitution stats every step as on points`, { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const points = await gpuRun(scene(), steps, { ...ON, ...params, records: 0 }, {}, true);
      const records = await gpuRun(scene(), steps, { ...ON, ...params }, {}, true);
      expect(bounced(points)).toBeGreaterThan(0);
      expect(floats(records)).toEqual(floats(points));
      expect(records.stats).toEqual(points.stats);
    });
  }

  it('records 1 given is records 1 unset', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const [, scene, steps] = CASES[2]!;
    const unset = await gpuRun(scene(), steps, ON, {}, true), given = await gpuRun(scene(), steps, { ...ON, records: 1 }, {}, true);
    expect(floats(given)).toEqual(floats(unset));
    expect(given.stats).toEqual(unset.stats);
  });
});
