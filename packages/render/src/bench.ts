// pnpm bench:render: frame cost of the renderer on frozen synthetic worlds,
// in a real browser. Runs inside the page (bench-entry.ts); bench-cli.ts
// drives it and writes results/. Software adapters (SwiftShader) complete
// the run but are flagged: their numbers are never performance results.
//
// Two measurements per case:
//   throughput  frames submitted back to back in batches, wall time per
//               frame from submit to onSubmittedWorkDone: what a frame
//               really costs, CPU encode included (median and 95% CI
//               over batches). The variants of a world run interleaved,
//               batch by batch, so slow drift (thermals, background
//               load) hits them alike; marginal costs are paired
//               differences over those batches.
//   passes      GPU timestamps per pass (cull, shadow, scene, bloom,
//               composite) on separately submitted frames: where the time
//               goes, for direction. GPU frame = span from the first pass
//               begin to the last pass end (p50, p95). The per-pass sum is
//               also kept, but on tile-based GPUs (Apple) it far exceeds
//               the frame: passes overlap, and the many small bloom passes
//               each report long intervals (M5 Max: bloom summed 3.7 ms in
//               a 0.66 ms frame; switching post off saved 0.17 ms).
// Variants change one thing at a time, so their difference from "full" is
// that thing's marginal cost: shadow, post, and the box paths.
import { emptySnapshot, type BodyDesc } from '@tb/engine-api';
import { createDevice, GpuProfiler, isSoftwareAdapter, readBuffer } from '@tb/gpu';
import { bootstrapCI, pairedPercentDiff, quantile, verdict } from '@tb/metrics';
import { lookAt, multiply, perspective, type V3 } from './math.ts';
import { Renderer, type FrameParams, type RendererOptions } from './renderer.ts';
import { SnapshotSource } from './source.ts';

export interface RenderBenchOptions {
  width: number;
  height: number;
  /** Body counts to build each world at. */
  counts: number[];
  worlds: WorldName[];
  variants: VariantName[];
  warmup: number;
  batches: number;
  batchFrames: number;
  profiledFrames: number;
  /** Spark pool per renderer (the smoke test shrinks it for software adapters). */
  sparkPool?: number;
}

export const DEFAULT_RENDER_BENCH: RenderBenchOptions = {
  width: 2560, height: 1440, counts: [10_000, 100_000], worlds: ['near', 'far'], variants: ['full', 'no-shadow', 'no-post', 'no-sparks', 'no-heat', 'no-ao', 'no-seam', 'fan', 'cube', 'flat-fan', 'flat-cube'],
  warmup: 30, batches: 10, batchFrames: 30, profiledFrames: 100,
};

export const QUICK_RENDER_BENCH: RenderBenchOptions = {
  width: 320, height: 180, counts: [2000], worlds: ['near', 'far'], variants: ['full', 'no-shadow', 'no-post', 'no-sparks', 'no-heat', 'no-ao', 'no-seam', 'fan', 'cube', 'flat-fan', 'flat-cube'],
  warmup: 1, batches: 2, batchFrames: 2, profiledFrames: 2,
};

export type WorldName = 'near' | 'far';
/**
 * full: the defaults (cube scene, fan shadow). no-shadow, no-post,
 * no-sparks: one pass off (in these still worlds no spark lives, so
 * no-sparks is the detector's cost; the streak draw is empty either way).
 * no-heat: the heat glow lookup off in the box shader. no-ao: no occupancy
 * volume (splat, compose) and no AO taps. no-seam: AO without the seam
 * cavity. fan, cube: that box path in both passes. flat-*: boxes shaded with
 * flat albedo, so flat-fan vs flat-cube is the paths' cost without the
 * fragment shading, and fan vs cube minus that is the shading's share.
 */
export type VariantName = 'full' | 'no-shadow' | 'no-post' | 'no-sparks' | 'no-heat' | 'no-ao' | 'no-seam' | 'fan' | 'cube' | 'flat-fan' | 'flat-cube';

function variantOptions(v: VariantName): RendererOptions {
  if (v === 'fan' || v === 'flat-fan') return { boxPath: 'fan', flatBoxes: v === 'flat-fan' };
  if (v === 'cube' || v === 'flat-cube') return { boxPath: 'cube', flatBoxes: v === 'flat-cube' };
  if (v === 'no-seam') return { aoDiag: v };
  return {};
}

interface World { descs: BodyDesc[]; eye: V3; target: V3; center: V3; radius: number }

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cube(pos: V3, rot: [number, number, number, number] = [0, 0, 0, 1], tag = 0): BodyDesc {
  return { shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag };
}

/**
 * near: a rubble heap of randomly rotated unit cubes (a hemisphere at about
 * 60% packing) filling the view from close by: big cubes, heavy overdraw.
 * far: a city of 10 x 10 x 10 towers seen from where a cube is about 6 px
 * at 1440p: tiny triangles, the micro-triangle risk.
 */
export function buildWorld(name: WorldName, n: number, seed = 1): World {
  const r = rng(seed);
  const descs: BodyDesc[] = [];
  if (name === 'near') {
    const radius = Math.cbrt((3 * (n / 0.6)) / (2 * Math.PI));
    while (descs.length < n) {
      const p: V3 = [(r() * 2 - 1) * radius, r() * radius, (r() * 2 - 1) * radius];
      if (Math.hypot(...p) > radius) continue;
      const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5];
      const l = Math.hypot(...q);
      descs.push(cube([p[0], p[1] + 0.5, p[2]], q.map((x) => x / l) as [number, number, number, number], descs.length % 7));
    }
    return { descs, eye: [radius * 1.25, radius * 0.9, radius * 1.4], target: [0, radius * 0.2, 0], center: [0, radius * 0.4, 0], radius: radius * 1.2 };
  }
  const towers = Math.max(1, Math.round(n / 1000));
  const side = Math.ceil(Math.sqrt(towers));
  const pitch = 20;
  for (let t = 0; t < towers && descs.length < n; t++) {
    const tx = (t % side - (side - 1) / 2) * pitch, tz = (Math.floor(t / side) - (side - 1) / 2) * pitch;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) if (descs.length < n) descs.push(cube([tx + x - 4.5, y + 0.5, tz + z - 4.5], undefined, t));
  }
  const extent = side * pitch;
  // A cube is about 6 px at 1440p and fov 0.9 from 250 m.
  const d = 250;
  return { descs, eye: [d * 0.62, d * 0.45, d * 0.64], target: [0, 5, 0], center: [0, 5, 0], radius: extent * 0.75 };
}

export interface RenderCase {
  world: WorldName;
  bodies: number;
  variant: VariantName;
  /** Wall ms per frame, median over batches, and its 95% bootstrap CI. */
  frameMs: number;
  frameCI: [number, number];
  /** GPU ms per frame from timestamps (first pass begin to last pass end): p50 and p95. */
  gpuP50: number | null;
  gpuP95: number | null;
  /** Median of the per-pass sum: over-counts where passes overlap (tile-based GPUs). */
  gpuSumP50: number | null;
  /** Median GPU ms per pass. */
  passes: Record<string, number>;
  /** Boxes in the main and shadow draws after culling. */
  drawn: { boxes: number; shadowBoxes: number };
  /** Wall ms per frame of each batch, in run order (interleaved with the other variants). */
  batches: number[];
}

export interface RenderBenchResult {
  adapter: string;
  software: boolean;
  timestamps: boolean;
  width: number;
  height: number;
  cases: RenderCase[];
}

export async function runRenderBench(opts: Partial<RenderBenchOptions> = {}): Promise<RenderBenchResult> {
  const o = { ...DEFAULT_RENDER_BENCH, ...opts };
  const { device, adapter, timestamps } = await createDevice({ timestamps: true });
  const info = adapter.info;
  const name = `${info.vendor} ${info.architecture} ${info.description}`.trim();
  const software = isSoftwareAdapter(info) || (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter === true;
  const cases: RenderCase[] = [];
  for (const worldName of o.worlds) for (const n of o.counts) {
    const w = buildWorld(worldName, n);
    const snap = emptySnapshot(w.descs.length);
    w.descs.forEach((b, i) => { snap.pos.set(b.pos, 3 * i); snap.rot.set(b.rot, 4 * i); });
    const src = new SnapshotSource(device);
    src.reset(w.descs);
    src.update(snap, w.descs);
    const f: FrameParams = {
      viewProj: multiply(perspective(0.9, o.width / o.height, 0.5, 2000), lookAt(w.eye, w.target)),
      eye: w.eye, focus: w.target, groundY: 0, time: 1, alpha: 1,
    };
    const rends = o.variants.map((variant) => {
      const rend = new Renderer(device, { size: [o.width, o.height] }, { ...variantOptions(variant), sparkPool: o.sparkPool });
      rend.setSource(src);
      rend.setShadowBounds(w.center, w.radius);
      rend.toggles = { shadow: variant !== 'no-shadow', post: variant !== 'no-post', sparks: variant !== 'no-sparks', trail: true, heat: variant !== 'no-heat', ao: variant !== 'no-ao' };
      return rend;
    });
    for (const rend of rends) for (let i = 0; i < o.warmup; i++) await rend.render(f);
    await device.queue.onSubmittedWorkDone();
    const batches: number[][] = rends.map(() => []);
    for (let b = 0; b < o.batches; b++) {
      for (const [k, rend] of rends.entries()) {
        const t0 = performance.now();
        for (let i = 0; i < o.batchFrames; i++) await rend.render(f);
        await device.queue.onSubmittedWorkDone();
        batches[k]!.push((performance.now() - t0) / o.batchFrames);
      }
    }
    for (const [k, rend] of rends.entries()) {
      const totals: number[] = [], sums: number[] = [];
      const perPass: Record<string, number[]> = {};
      if (timestamps) {
        rend.profiler = new GpuProfiler(device);
        for (let i = 0; i < o.profiledFrames; i++) {
          await rend.render(f);
          const { passes: t, span } = await rend.profiler.collectFrame();
          if (span !== null) totals.push(span);
          sums.push(Object.values(t).reduce((a, x) => a + x, 0));
          for (const [name, v] of Object.entries(t)) (perPass[name] ??= []).push(v);
        }
        rend.profiler.destroy();
        rend.profiler = null;
      }
      const args = new Uint32Array(await readBuffer(device, rend.cullBuffers!.args));
      const xs = batches[k]!;
      const ci = bootstrapCI(xs, (v) => quantile(v, 0.5));
      cases.push({
        world: worldName, bodies: n, variant: o.variants[k]!,
        frameMs: quantile(xs, 0.5), frameCI: [ci.lo, ci.hi],
        gpuP50: totals.length ? quantile(totals, 0.5) : null, gpuP95: totals.length ? quantile(totals, 0.95) : null,
        gpuSumP50: sums.length ? quantile(sums, 0.5) : null,
        passes: Object.fromEntries(Object.entries(perPass).map(([name, v]) => [name, quantile(v, 0.5)])),
        drawn: { boxes: args[1]!, shadowBoxes: args[9]! },
        batches: xs,
      });
      rend.destroy();
    }
  }
  device.destroy();
  return { adapter: name, software, timestamps, width: o.width, height: o.height, cases };
}

const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '' : x.toFixed(3));

export function renderBenchMarkdown(r: RenderBenchResult, header: string): string {
  const passNames = ['cull', 'shadow', 'scene', 'bloom', 'composite'];
  const lines = [
    header, '',
    `Adapter: ${r.adapter}${r.software ? ' (SOFTWARE: not a performance result)' : ''} · ${r.width}x${r.height} · timing: ${r.timestamps ? 'GPU timestamps + wall' : 'wall only'}`, '',
    'GPU frame: first pass begin to last pass end. Pass columns and their sum are for direction only: on tile-based GPUs passes overlap and the sum over-counts.', '',
    `| World | Bodies | Variant | Frame ms (wall, median) | 95% CI | GPU frame p50 | GPU frame p95 | Pass sum p50 | ${passNames.join(' | ')} | Boxes drawn | Shadow boxes |`,
    `|---|---|---|---|---|---|---|---|${passNames.map(() => '---').join('|')}|---|---|`,
    ...r.cases.map((c) => `| ${c.world} | ${c.bodies.toLocaleString('en-US')} | ${c.variant} | ${ms(c.frameMs)} | ${ms(c.frameCI[0])}-${ms(c.frameCI[1])} | ${ms(c.gpuP50)} | ${ms(c.gpuP95)} | ${ms(c.gpuSumP50)} | ${passNames.map((p) => ms(c.passes[p])).join(' | ')} | ${c.drawn.boxes.toLocaleString('en-US')} | ${c.drawn.shadowBoxes.toLocaleString('en-US')} |`),
    '',
    'Marginal cost: change in frame time when the thing is switched off (paired over interleaved batches; median and 95% CI; "n.s." when the interval includes 0):', '',
    '| World | Bodies | Without shadow | Without post (bloom + AgX) | Without sparks | Without heat glow | Without AO | Without seam cavity | Fan in both passes | Cube in both passes | Flat shading: cube vs fan |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const groups = new Map<string, RenderCase[]>();
  for (const c of r.cases) groups.set(`${c.world}:${c.bodies}`, [...(groups.get(`${c.world}:${c.bodies}`) ?? []), c]);
  for (const cs of groups.values()) {
    const by = (v: VariantName) => cs.find((c) => c.variant === v);
    const diff = (b?: RenderCase, base = by('full')) => {
      if (!base || !b || base.batches.length < 2) return '';
      const d = pairedPercentDiff(base.batches, b.batches);
      const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`;
      return `${pct(d.estimate)} [${pct(d.lo)}, ${pct(d.hi)}]${verdict(d) === 'no-difference' ? ' n.s.' : ''}`;
    };
    lines.push(`| ${cs[0]!.world} | ${cs[0]!.bodies.toLocaleString('en-US')} | ${diff(by('no-shadow'))} | ${diff(by('no-post'))} | ${diff(by('no-sparks'))} | ${diff(by('no-heat'))} | ${diff(by('no-ao'))} | ${diff(by('no-seam'))} | ${diff(by('fan'))} | ${diff(by('cube'))} | ${diff(by('flat-cube'), by('flat-fan'))} |`);
  }
  return lines.join('\n');
}
