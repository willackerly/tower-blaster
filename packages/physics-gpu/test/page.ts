// Page-side drivers for the GPU physics tests (bundled by loadBundle).
import { createDevice, readBuffer } from '@tb/gpu';
import { boundingRadius, spherePairs } from '@tb/geom';
import { buildScenario } from '@tb/scenarios';
import { bodiesAt } from '@tb/engine-api';
import { Broadphase } from '../src/index.ts';

export interface BroadCase {
  kind: 'scenario' | 'cloud' | 'pile';
  scenario?: string;
  params?: Record<string, number>;
  n?: number;
  margin: number;
  maxPairs?: number;
  seed?: number;
  tableBits?: number;
}

function input(c: BroadCase): { centers: Float64Array; radii: Float64Array } {
  if (c.kind === 'scenario') {
    const scene = buildScenario(c.scenario!, c.params ?? {}, c.seed ?? 1);
    const bodies = bodiesAt(scene, Number.MAX_SAFE_INTEGER);
    return { centers: Float64Array.from(bodies.flatMap((b) => b.pos)), radii: Float64Array.from(bodies.map((b) => boundingRadius(b.shape))) };
  }
  const n = c.n!;
  let s = (c.seed ?? 1) >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const centers = new Float64Array(3 * n), radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) centers[3 * i + k] = c.kind === 'pile' ? 0.001 * r() : -15 + 30 * r();
    radii[i] = c.kind === 'pile' ? 0.5 : 0.1 + 0.9 * r();
  }
  return { centers, radii };
}

/**
 * Run the GPU broadphase and check it against the double-precision oracle.
 * f32 rounding can flip pairs within about 1e-4 of touching, so the GPU set
 * must contain every pair at margin - eps and only pairs at margin + eps.
 */
export async function broadphase(c: BroadCase, repeat = 1) {
  const { centers, radii } = input(c);
  const n = radii.length;
  const { device } = await createDevice();
  const spheres = new Float32Array(4 * Math.max(1, n));
  let rmax = 0;
  for (let i = 0; i < n; i++) {
    spheres.set([centers[3 * i]!, centers[3 * i + 1]!, centers[3 * i + 2]!, radii[i]!], 4 * i);
    rmax = Math.max(rmax, radii[i]!);
  }
  const sb = device.createBuffer({ size: spheres.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(sb, 0, spheres);
  const oracleExact = spherePairs(centers, radii, c.margin);
  const maxPairs = c.maxPairs ?? Math.max(16, Math.ceil(oracleExact.length * 1.2) + 64);
  const bp = new Broadphase(device, sb, Math.max(1, n), maxPairs, c.tableBits);
  const runs: number[][] = [];
  let total: number[] = [];
  device.pushErrorScope('validation');
  for (let rep = 0; rep < repeat; rep++) {
    const enc = device.createCommandEncoder();
    bp.encode(enc, n, { cellSize: Math.max(1e-3, 2 * rmax + c.margin), margin: c.margin });
    device.queue.submit([enc.finish()]);
    total = Array.from(new Uint32Array(await readBuffer(device, bp.total)));
    runs.push(Array.from(new Uint32Array(await readBuffer(device, bp.pairs, Math.max(8, total[3]! * 8)))).slice(0, 2 * total[3]!));
  }
  const error = await device.popErrorScope();
  const flat = runs[0]!;
  const got: Array<[number, number]> = [];
  for (let k = 0; k < flat.length; k += 2) got.push([flat[k]!, flat[k + 1]!]);
  const eps = 1e-4;
  const key = (p: [number, number]) => p[0] * 1e7 + p[1];
  const gotKeys = new Set(got.map(key));
  const lo = spherePairs(centers, radii, c.margin - eps), hi = new Set(spherePairs(centers, radii, c.margin + eps).map(key));
  const groupedByI = got.every((p, k) => k === 0 || got[k - 1]![0] <= p[0]);
  const res = {
    n, error: error?.message ?? null,
    written: total[3], required: total[5], indirectGroups: total[0], oracle: oracleExact.length,
    duplicates: got.length - gotKeys.size,
    ordered: got.every((p) => p[0] < p[1]),
    groupedByI,
    missing: lo.filter((p) => !gotKeys.has(key(p))).length,
    extra: got.filter((p) => !hi.has(key(p))).length,
    deterministic: runs.every((r) => r.length === flat.length && r.every((x, k) => x === flat[k])),
  };
  bp.destroy();
  device.destroy();
  return res;
}
