// The quality protocol's Q5 on the GPU through pnpm bench:quality's page entry
// (quality-case.ts), apart from quality.test.ts so CI's shard planner can put
// it on another worker: the brief's gates at 20 iterations, and equivalent to
// the f64 reference.
import { describe, it } from 'vitest';
import { AGAINST_REF, againstRef, gpu } from './quality-case.ts';

describe('quality protocol on the GPU (pnpm bench:quality\'s page entry)', () => {
  it(`Q5 ${AGAINST_REF}`, { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await againstRef('Q5');
  });
});
