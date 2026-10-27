// The loaded-gap slop (AvbdParams.gapSlop) with records 2 (centre friction,
// AvbdParams.records): its points keep their normal rows, so a loaded point
// excuses its gap as a point does (solver.ts evalN(), the reference's evalC0),
// and the sideways-kicked column comes back to rest as on the reference's
// records 2. Apart from engine-gapslop-records.test.ts so CI's shard planner
// can put them on different workers. The probe: gapslop-case.ts.
import { describe, expect, it } from 'vitest';
import { settled } from './gapslop-case.ts';
import { gpu } from './harness.ts';

describe('GPU AVBD engine: the loaded-gap slop (AvbdParams.gapSlop) with records 2', () => {
  // The reference's records 2 (physics-ref/test/records.test.ts): 0.15 m/s over steps 1201-1500 at 10 iterations
  // without the slop, 8.4e-5 m/s with it. Measured on SwiftShader (2026-10-27): 0.149 m/s without, 8.35e-5 m/s and
  // 0.020 mm sideways with it.
  it('records 2: with gapSlop 3e-5 the kicked 8-cube column comes back to rest, without it it keeps rocking (10 iterations)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const params = { iterations: 10, records: 2 };
    const [on, off] = [await settled({ ...params, gapSlop: 3e-5 }), await settled(params)];
    console.log(`records 2 kicked column, 10 iterations: with gapSlop maxV ${on.maxV.toExponential(2)} m/s side ${on.side.toExponential(2)} m; without maxV ${off.maxV.toExponential(2)} m/s`);
    expect(on.maxV).toBeLessThan(1e-3);
    expect(on.side).toBeLessThan(1e-3);
    expect(off.maxV).toBeGreaterThan(1e-2);
  });
});
