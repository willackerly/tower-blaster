// Page bundle for pnpm bench:quality: runs one quality case on the GPU engine.
import type { SceneDesc } from '@tb/engine-api';
import type { AvbdParams } from '@tb/physics-ref';
import { GpuAvbdEngine, type GpuEngineOptions } from './engine.ts';
import { type CaseRun, simulateCase } from './quality-run.ts';

export async function runGpuCase(scene: SceneDesc, steps: number, every: number, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'>): Promise<{ run: CaseRun | null; backend: string; error: string | null }> {
  const e = new GpuAvbdEngine(params, opts);
  try {
    const run = await simulateCase(e, scene, steps, every);
    return { run, backend: e.info.backend, error: null };
  } catch (err) {
    return { run: null, backend: e.info.backend, error: String((err as Error)?.stack ?? err) };
  }
}
