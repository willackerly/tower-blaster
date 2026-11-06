// Page bundle for the mode probes (loadBundle): runs one case of a probe on
// the GPU engine, on the page's shared device, and returns the meter's result.
import { limitProblems } from '@tb/engine-api';
import { isSoftwareAdapter, sharedDevice } from '@tb/gpu';
import { GpuAvbdEngine } from '@tb/physics-gpu';
import { drive, type Size } from './probe.ts';
import { probeById } from './probes.ts';

export interface PageRun { result: unknown; steps: number; wallMs: number; limits: string[]; error: string | null }

export async function adapter(): Promise<{ text: string; software: boolean }> {
  const { adapter: a } = await sharedDevice();
  const info = a.info;
  return { text: [info.vendor, info.architecture, info.description].filter(Boolean).join(' / '), software: isSoftwareAdapter(info) };
}

export function caseCount(id: string, size: Size): number {
  return probeById(id).cases(size).length;
}

export async function runCase(id: string, size: Size, index: number): Promise<PageRun> {
  const probe = probeById(id), c = probe.cases(size)[index];
  if (c === undefined) throw new Error(`${id} has no case ${index} at size ${size}`);
  const spec = probe.spec(c), meter = probe.meter(c, spec);
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(spec.params, { ...spec.opts, device });
  try {
    const { steps, wallMs } = await drive(e, spec, meter);
    const limits = limitProblems(await e.health(), 'gpu');
    const err = await device.popErrorScope();
    return { result: meter.result(), steps, wallMs, limits, error: err?.message ?? null };
  } catch (err) {
    await device.popErrorScope().catch(() => null);
    return { result: null, steps: 0, wallMs: 0, limits: [], error: String((err as Error)?.stack ?? err) };
  } finally {
    e.dispose();
  }
}
