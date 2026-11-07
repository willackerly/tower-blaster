// Every level stands at load on Rapier, the game's smoke and CPU-fallback engine (the agent playtest's PT11,
// which played on Rapier): its pre-settle moves no body half a cell (Rapier compresses a loaded stack 2 to 4 mm a
// contact, about 0.17 m at the top of a 10k city, under the half cell), and the 300 steps after move none 0.1 m.
// RAPIER_HEAPS names the levels Rapier cannot hold, with why; the test holds each to still falling, so a note
// never outlives its cause.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, SERIES } from '@tb/keystone';
import { loadReport, REST_BOUND_M } from '../src/index.ts';

const RAPIER_HEAPS: Record<string, string> = {
  'T-S8': 'slabs 80 x the rods under them (mass-ratio): Rapier heaps it in the pre-settle, the GPU solver and the reference hold it',
  // The Kapla Spire drafts (G5, after PT11): on Rapier the pre-settle moves 890 to 1,154 planks past half a cell
  // (0.15 m at h 0.3 m; the most 0.32 to 0.54 m), as hundreds of 0.1 m plank contacts stacked each compress a few
  // mm. Whether some also topple is not checked here; their GPU check is the Metal run of level-stability-gpu.
  'T-B5A': 'a 2,884-plank spire: Rapier compresses the stack past half a cell',
  'T-B5B': 'five plank towers (3,106 planks): Rapier compresses the stacks past half a cell',
  'T-B5C': 'T-B5A without GPU sleep: Rapier compresses the stack past half a cell',
};

describe('every level stands at load on Rapier', () => {
  for (const def of SERIES.flat()) it(`${def.id}`, async () => {
    const c = compileLevel(def), r = await loadReport(new RapierEngine(), c);
    if (RAPIER_HEAPS[def.id]) { expect(r.settle.fell, RAPIER_HEAPS[def.id]).toBeGreaterThan(0); return; }
    expect(r.settle.fell, `bodies that fell in the pre-settle (most moved ${r.settle.maxMove.toFixed(3)} m)`).toBe(0);
    expect(r.maxMove).toBeLessThan(REST_BOUND_M);
  }, 120_000);
});
