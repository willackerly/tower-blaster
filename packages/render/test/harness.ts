// Shared setup for the GPU render tests (render*.test.ts): one browser page
// per test file with the page.ts drivers loaded.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './page.ts';

export let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__render');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

export type D = typeof Drivers;
export function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __render: Record<string, (...x: unknown[]) => unknown> }).__render[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}
