// The loaded-gap slop (AvbdParams.gapSlop) with manifold records
// (AvbdParams.records): setup marks a loaded point in its record (bit 8 + q of
// SolverRecord.flags or CentreRecord.stick, solver.ts LOADED_BIT), and the
// primal and the dual excuse its gap as the point form's. Records 1 is the
// point form bit for bit, so its oracle is exact. Records 2 bringing
// the kicked column to rest: engine-gapslop-records-rest.test.ts. The probe:
// gapslop-case.ts.
import { describe, expect, it } from 'vitest';
import { column, kicked } from './gapslop-case.ts';
import { gpu } from './harness.ts';

describe('GPU AVBD engine: the loaded-gap slop (AvbdParams.gapSlop) with manifold records', () => {
  // The points' floats with the slop, also with every colour in the tail. Without the mark in setup the records'
  // floats are those without the slop, which differ from the points' with it (checked 2026-10-27 by commenting the
  // mark out: this test and records 2's rest test fail).
  // The points are records 0 (unset is records 1 on the GPU, gpuRecordsLayout).
  it('records 1: the point form\'s floats with the slop, unset and given, and with every colour in the tail; on differs from off', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const on = await kicked({ gapSlop: 3e-5, records: 0 });
    const rec = await kicked({ gapSlop: 3e-5, records: 1 });
    expect(rec).toEqual(on);
    expect(await kicked({ gapSlop: 3e-5 })).toEqual(on);
    expect(rec).not.toEqual(await kicked({ records: 1 }));
    expect(await kicked({ gapSlop: 3e-5, records: 1 }, column(), { colorTail: 0 })).toEqual(on);
  });

  // evalN() takes the mark in the primal and in the dual pass (CENTRE_DUAL).
  it('records 2: the slop changes the floats', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const params = { iterations: 10, records: 2 };
    expect(await kicked({ ...params, gapSlop: 3e-5 })).not.toEqual(await kicked(params));
  });
});
