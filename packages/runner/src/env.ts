// What the result needs to say about where it ran. A timing result is only
// valid when the timer is fine-grained and, for GPU engines, the adapter is
// real hardware.
import { isSoftwareAdapter } from '@tb/gpu';

export interface BrowserEnv {
  userAgent: string;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  /** Smallest positive step of performance.now() observed, ms. */
  timerResolutionMs: number;
  gpu: null | { vendor: string; architecture: string; description: string; device: string; features: string[]; software: boolean };
}

export function timerResolution(samples = 200_000): number {
  let best = Infinity;
  let prev = performance.now();
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    const d = t - prev;
    if (d > 0 && d < best) best = d;
    prev = t;
  }
  return best;
}

export async function browserEnv(): Promise<BrowserEnv> {
  let gpu: BrowserEnv['gpu'] = null;
  if ('gpu' in navigator) {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (a) {
      const i = a.info;
      gpu = {
        vendor: i.vendor, architecture: i.architecture, description: i.description, device: i.device,
        features: [...a.features] as string[],
        software: isSoftwareAdapter(i),
      };
    }
  }
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency,
    timerResolutionMs: timerResolution(),
    gpu,
  };
}

/** Reasons a timing result from this environment should not be trusted. */
export function timingProblems(env: BrowserEnv, backends: string[]): string[] {
  const problems: string[] = [];
  if (!env.crossOriginIsolated) problems.push('page is not cross-origin isolated (timer clamped to 100 µs)');
  if (env.timerResolutionMs > 0.02) problems.push(`timer resolution ${env.timerResolutionMs.toFixed(3)} ms is too coarse`);
  if (backends.some((b) => b.startsWith('webgpu'))) {
    if (!env.gpu) problems.push('no WebGPU adapter');
    else if (env.gpu.software) problems.push(`software WebGPU adapter (${env.gpu.architecture || env.gpu.vendor})`);
  }
  return problems;
}
