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
import { LOOKS, realLook } from './look.ts';
import { hallInside, hallScaled, OLYMPIA } from './hall.ts';
import { CTL, MAX_INJECT } from './sparks.ts';
import { SEG } from './cull.ts';
import { buildWorld, rng, type WorldName } from './bench-world.ts';

export { buildWorld, type World, type WorldName } from './bench-world.ts';

/** ice and real-ice: every body this close to the view's focus is ice (m): a wall of it in the middle of the view. */
const ICE_RADIUS = 4;

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
  /** Extra warmup frames for real-dust and real-plain-dust, so their particle counts and ages are steady (default 240: 4 s of particle time). */
  dustWarmup?: number;
}

export const DEFAULT_RENDER_BENCH: RenderBenchOptions = {
  width: 2560, height: 1440, counts: [10_000, 100_000], worlds: ['near', 'far'], variants: ['full', 'no-shadow', 'no-post', 'no-sparks', 'no-heat', 'no-ao', 'no-seam', 'fan', 'cube', 'flat-fan', 'flat-cube', 'real', 'real-no-stone', 'real-stone-off', 'real-step1', 'real-no-lod', 'real-no-floor-sky', 'real-flat-ground', 'real-no-pcss', 'real-4096', 'real-dust', 'real-hall', 'real-hall-out', 'real-bare-hills', 'real-plain-dust', 'real-rocks', 'blasts', 'real-blasts', 'ice-one', 'ice', 'real-ice'],
  warmup: 30, batches: 10, batchFrames: 30, profiledFrames: 100,
};

export const QUICK_RENDER_BENCH: RenderBenchOptions = {
  width: 320, height: 180, counts: [2000], worlds: ['near', 'far'], variants: ['full', 'no-shadow', 'no-post', 'no-sparks', 'no-heat', 'no-ao', 'no-seam', 'fan', 'cube', 'flat-fan', 'flat-cube', 'real', 'real-no-stone', 'real-stone-off', 'real-step1', 'real-no-lod', 'real-no-floor-sky', 'real-flat-ground', 'real-no-pcss', 'real-4096', 'real-dust', 'real-hall', 'real-hall-out', 'real-bare-hills', 'real-plain-dust', 'real-rocks', 'blasts', 'real-blasts', 'ice-one', 'ice', 'real-ice'],
  warmup: 1, batches: 2, batchFrames: 2, profiledFrames: 2,
};

/**
 * full: the defaults (cube scene, fan shadow). no-shadow, no-post,
 * no-sparks: one pass off (in these still worlds no spark lives, so
 * no-sparks is the detector's cost; the streak draw is empty either way).
 * no-heat: the heat glow lookup off in the box shader. no-ao: no occupancy
 * volume (splat, compose) and no AO taps. no-seam: AO without the seam
 * cavity. fan, cube: that box path in both passes. flat-*: boxes shaded with
 * flat albedo, so flat-fan vs flat-cube is the paths' cost without the
 * fragment shading, and fan vs cube minus that is the shading's share.
 * real: the real look (docs/realism.md) in place of candy: its sky LUTs run
 * in the cull pass, and it has no sparks, trail, heat or point lights.
 * real-no-stone: real with stone texture 0 (no texture samples), so real
 * against it is the stone materials' cost. real-stone-off: the stone code
 * compiled out, so real-no-stone against it is what the code costs while
 * unused (registers, hoisted samples). real-step1: blocks shaded as realism
 * step 1 did, so real-stone-off against it is step 3's other shading.
 * real-no-lod: every box drawn with the stone code (no boxFar list), so
 * real against it is what the material level of detail saves.
 * real-no-floor-sky: the floor without its sky view cones (floorSky).
 * real-flat-ground: the ground material and horizon hills compiled out
 * (realism step 4), so real against it is their cost. real-no-pcss: sun
 * shadows from the 3x3 taps, the soft shadow code compiled out (step 5).
 * real-4096: real with a 4096 shadow map instead of 2048. real-dust: real
 * in a steady debris shower (step 6): 64 impacts a frame around the view's
 * focus (more than the dust and chip budgets take) and 1/60 s of particle
 * time a frame, warmed up until the counts and ages are steady (puffs of
 * every age and size on screen); real against it is the worst steady cost
 * of impact dust and chips. (Every other variant renders a still world with
 * dt 0: no particle lives.)
 * Since the level of detail, stone texture 0 sends every box to boxFar, so
 * real-no-stone and real-stone-off draw the same shader. real-hall: real
 * inside the exhibition hall (hall.ts, Kapla step K3.2), scaled up until the
 * world's eye is inside it (hallSizeFor), so real-hall against real is the
 * hall's cost; real-hall-out: the hall seen from outside (its exterior, the
 * default), scaled down until the eye is just outside it (hallSizeOutside).
 * real-bare-hills: the horizon hills as before 2026-11-02 (one ridge 1.5
 * degrees high, the floor's albedo), so real against it is what the scrub
 * cover, the second ridge and the taller default cost. real-plain-dust:
 * real-dust with the dust shape knobs off (dustErode, dustThin, dustSkirt 0,
 * as before 2026-11-02), so real-dust against it is what the eroded edges,
 * the thinning and the skirt cost in the same steady shower. real-rocks:
 * real with small rocks on the ground (rocks 0.6, the default 12 cm), so
 * real-rocks against real is what they cost (off by default: none run).
 * blasts / real-blasts: full / real with four blasts held at their hottest
 * (blasts.ts, 0.15 s old, radius 8 around the focus: fireballs, shells and
 * their lights), so blasts against full is a bomb's worst steady cost.
 * ice-one: full with one body (the one nearest the focus) ice, so ice-one
 * against full is the fixed cost of the split scene pass (ice-pass.ts: the
 * MSAA samples and depth stored and loaded again, `under` resolved). ice and
 * real-ice: full and real with every body within ICE_RADIUS of the focus ice
 * (a wall of it filling the middle of the view), so ice against ice-one is
 * the ice shading's own cost per pixel of ice.
 */
export type VariantName = 'full' | 'no-shadow' | 'no-post' | 'no-sparks' | 'no-heat' | 'no-ao' | 'no-seam' | 'fan' | 'cube' | 'flat-fan' | 'flat-cube' | 'real' | 'real-no-stone' | 'real-stone-off' | 'real-step1' | 'real-no-lod' | 'real-no-floor-sky' | 'real-flat-ground' | 'real-no-pcss' | 'real-4096' | 'real-dust' | 'real-hall' | 'real-hall-out' | 'real-bare-hills' | 'real-plain-dust' | 'real-rocks' | 'blasts' | 'real-blasts' | 'ice-one' | 'ice' | 'real-ice';

function variantOptions(v: VariantName): RendererOptions {
  if (v === 'fan' || v === 'flat-fan') return { boxPath: 'fan', flatBoxes: v === 'flat-fan' };
  if (v === 'cube' || v === 'flat-cube') return { boxPath: 'cube', flatBoxes: v === 'flat-cube' };
  if (v === 'no-seam') return { aoDiag: v };
  if (v === 'real-stone-off') return { realDiag: 'stone-off' };
  if (v === 'real-step1') return { realDiag: 'step1' };
  if (v === 'real-no-lod') return { stoneLod: false };
  if (v === 'real-no-floor-sky') return { realDiag: 'no-floor-sky' };
  if (v === 'real-flat-ground') return { realDiag: 'ground-off' };
  if (v === 'real-no-pcss') return { realDiag: 'pcss-off' };
  if (v === 'real-4096') return { shadowSize: 4096 };
  return {};
}

/** The largest hall size (Olympia times a multiple of 0.25, down to 0.25) with the eye 10% closer in than it still outside. */
export function hallSizeOutside(eye: V3): number {
  let s = hallSizeFor(eye);
  while (s > 0.25 && hallInside(hallScaled(OLYMPIA, s), [eye[0] * 0.9, eye[1] * 0.9, eye[2] * 0.9])) s -= 0.25;
  return s;
}

/** The smallest hall size (Olympia times a multiple of 0.25, from 1) with the eye 10% further out than it is still inside. */
export function hallSizeFor(eye: V3): number {
  let s = 1;
  while (!hallInside(hallScaled(OLYMPIA, s), [eye[0] * 1.1, eye[1] * 1.1, eye[2] * 1.1])) s += 0.25;
  return s;
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
  /** boxes: drawn with the stone code (or all, outside the real look); farBoxes: without it (boxFar). */
  drawn: { boxes: number; farBoxes: number; shadowBoxes: number; iceBoxes: number };
  /** Particles alive after the last frame (sparks, or real-look dust and chips). */
  particles: number;
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
  // One renderer per variant for every world: the first frame compiles its
  // pipelines and bakes its textures, which on a software adapter is most of
  // the run. Each world still gets its own warmup.
  const rends = o.variants.map((variant) => {
    const rend = new Renderer(device, { size: [o.width, o.height] }, { ...variantOptions(variant), sparkPool: o.sparkPool });
    if (variant === 'real' || variant === 'real-no-lod' || variant === 'real-no-floor-sky' || variant === 'real-flat-ground' || variant === 'real-no-pcss' || variant === 'real-4096' || variant === 'real-dust' || variant === 'real-blasts' || variant === 'real-ice') rend.look = LOOKS.real!;
    if (variant === 'real-no-stone' || variant === 'real-stone-off' || variant === 'real-step1') rend.look = realLook({ stoneDetail: 0 });
    if (variant === 'real-bare-hills') rend.look = realLook({ hills: 1.5, hillCover: 0, hillRidges: 1 });
    if (variant === 'real-plain-dust') rend.look = realLook({ dustErode: 0, dustThin: 0, dustSkirt: 0 });
    if (variant === 'real-rocks') rend.look = realLook({ rocks: 0.6 });
    rend.toggles = { shadow: variant !== 'no-shadow', post: variant !== 'no-post', sparks: variant !== 'no-sparks', trail: true, heat: variant !== 'no-heat', ao: variant !== 'no-ao', blasts: true };
    return rend;
  });
  for (const worldName of o.worlds) for (const n of o.counts) {
    const w = buildWorld(worldName, n);
    o.variants.forEach((v, k) => {
      if (v === 'real-hall') rends[k]!.look = realLook({ env: 'hall', hallSize: hallSizeFor(w.eye) });
      if (v === 'real-hall-out') rends[k]!.look = realLook({ env: 'hall', hallSize: hallSizeOutside(w.eye) });
    });
    const snap = emptySnapshot(w.descs.length);
    w.descs.forEach((b, i) => { snap.pos.set(b.pos, 3 * i); snap.rot.set(b.rot, 4 * i); });
    const src = new SnapshotSource(device);
    src.reset(w.descs);
    src.update(snap, w.descs);
    const f: FrameParams = {
      viewProj: multiply(perspective(0.9, o.width / o.height, 0.5, 2000), lookAt(w.eye, w.target)),
      eye: w.eye, focus: w.target, groundY: 0, time: 1, alpha: 1,
    };
    // Ice (ice-one, ice, real-ice): the body nearest the focus, or every one within ICE_RADIUS of it.
    const near = w.descs.map((b, i) => [Math.hypot(b.pos[0] - w.target[0], b.pos[1] - w.target[1], b.pos[2] - w.target[2]), i] as const).sort((a, b) => a[0] - b[0]);
    const iced = (v: VariantName) => (v === 'ice-one' ? near.slice(0, 1) : v === 'ice' || v === 'real-ice' ? near.filter(([d]) => d <= ICE_RADIUS) : []).map(([, i]) => i);
    for (const [k, rend] of rends.entries()) {
      rend.setSource(src);
      rend.setShadowBounds(w.center, w.radius);
      rend.clearSurfaces();
      for (const i of iced(o.variants[k]!)) rend.setSurface(i, { kind: 'ice', seed: i });
      rend.blasts.clear();
      // Held at 0.15 s old: the frame time never moves.
      if (o.variants[k] === 'blasts' || o.variants[k] === 'real-blasts') for (const [dx, dz] of [[0, 0], [5, 2], [-4, 3], [2, -5]]) rend.blast([w.target[0] + dx!, 2, w.target[2] + dz!], 8, f.time! - 0.15);
    }
    const shower = rng(7), fDust: FrameParams = { ...f, dt: 1 / 60 };
    const shows = (k: number) => o.variants[k] === 'real-dust' || o.variants[k] === 'real-plain-dust';
    const render = (k: number) => {
      if (!shows(k)) return rends[k]!.render(f);
      for (let i = 0; i < MAX_INJECT; i++) rends[k]!.burst([w.target[0] + 6 * (shower() - 0.5), 0.2 + 3 * shower(), w.target[2] + 6 * (shower() - 0.5)], [shower() - 0.5, 1, shower() - 0.5], 12);
      return rends[k]!.render(fDust);
    };
    // The showers warm up longer (4 s of particle time), so their puffs and chips reach their steady count and ages.
    for (const k of rends.keys()) for (let i = 0; i < o.warmup + (shows(k) ? o.dustWarmup ?? 240 : 0); i++) await render(k);
    await device.queue.onSubmittedWorkDone();
    const batches: number[][] = rends.map(() => []);
    for (let b = 0; b < o.batches; b++) {
      for (const k of rends.keys()) {
        const t0 = performance.now();
        for (let i = 0; i < o.batchFrames; i++) await render(k);
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
          await render(k);
          const { passes: t, span } = await rend.profiler.collectFrame();
          if (span !== null) totals.push(span);
          sums.push(Object.values(t).reduce((a, x) => a + x, 0));
          for (const [name, v] of Object.entries(t)) (perPass[name] ??= []).push(v);
        }
        rend.profiler.destroy();
        rend.profiler = null;
      }
      const args = new Uint32Array(await readBuffer(device, rend.cullBuffers!.args));
      const particles = new Uint32Array(await readBuffer(device, rend.sparks.ctl))[CTL.alive]!;
      const xs = batches[k]!;
      const ci = bootstrapCI(xs, (v) => quantile(v, 0.5));
      cases.push({
        world: worldName, bodies: n, variant: o.variants[k]!,
        frameMs: quantile(xs, 0.5), frameCI: [ci.lo, ci.hi],
        gpuP50: totals.length ? quantile(totals, 0.5) : null, gpuP95: totals.length ? quantile(totals, 0.95) : null,
        gpuSumP50: sums.length ? quantile(sums, 0.5) : null,
        passes: Object.fromEntries(Object.entries(perPass).map(([name, v]) => [name, quantile(v, 0.5)])),
        drawn: { boxes: args[1]!, farBoxes: args[17]!, shadowBoxes: args[9]!, iceBoxes: args[4 * SEG.boxIce + 1]! }, particles,
        batches: xs,
      });
    }
  }
  for (const rend of rends) rend.destroy();
  device.destroy();
  return { adapter: name, software, timestamps, width: o.width, height: o.height, cases };
}

const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '' : x.toFixed(3));

export function renderBenchMarkdown(r: RenderBenchResult, header: string): string {
  const passNames = ['cull', 'shadow', 'scene', 'ice', 'bloom', 'composite'];
  const lines = [
    header, '',
    `Adapter: ${r.adapter}${r.software ? ' (SOFTWARE: not a performance result)' : ''} · ${r.width}x${r.height} · timing: ${r.timestamps ? 'GPU timestamps + wall' : 'wall only'}`, '',
    'GPU frame: first pass begin to last pass end. Pass columns and their sum are for direction only: on tile-based GPUs passes overlap and the sum over-counts.', '',
    `| World | Bodies | Variant | Frame ms (wall, median) | 95% CI | GPU frame p50 | GPU frame p95 | Pass sum p50 | ${passNames.join(' | ')} | Boxes drawn | Far boxes (no stone code) | Ice boxes | Shadow boxes | Particles alive |`,
    `|---|---|---|---|---|---|---|---|${passNames.map(() => '---').join('|')}|---|---|---|---|---|`,
    ...r.cases.map((c) => `| ${c.world} | ${c.bodies.toLocaleString('en-US')} | ${c.variant} | ${ms(c.frameMs)} | ${ms(c.frameCI[0])}-${ms(c.frameCI[1])} | ${ms(c.gpuP50)} | ${ms(c.gpuP95)} | ${ms(c.gpuSumP50)} | ${passNames.map((p) => ms(c.passes[p])).join(' | ')} | ${c.drawn.boxes.toLocaleString('en-US')} | ${c.drawn.farBoxes.toLocaleString('en-US')} | ${c.drawn.iceBoxes.toLocaleString('en-US')} | ${c.drawn.shadowBoxes.toLocaleString('en-US')} | ${c.particles.toLocaleString('en-US')} |`),
    '',
    'Marginal cost: change in frame time when the thing is switched off (paired over interleaved batches; median and 95% CI; "n.s." when the interval includes 0):', '',
    '| World | Bodies | Without shadow | Without post (bloom + AgX) | Without sparks | Without heat glow | Without AO | Without seam cavity | Fan in both passes | Cube in both passes | Flat shading: cube vs fan | Real look instead of candy | Stone textures (real vs real without) | Unused stone code (texture 0 vs compiled out) | Step 3 shading without stone (vs step 1 blocks) | Stone level of detail (real vs every box with stone code) | Floor sky view cones | Ground material and hills | Soft shadows (real vs 3x3 taps) | 4096 shadow map (vs 2048) | Impact dust and chips, steady shower (vs none alive) | Hall (real inside it vs real) | Hall from outside (vs real) | Hills: scrub, two ridges, 2.2 deg (real vs bare 1.5 deg) | Dust shape: erode, thin, skirt (real-dust vs knobs off) | Small rocks 0.6 (vs none) | Ice pass, one ice block (split pass fixed cost) | Ice shading, a wall of it (vs one block) | Ice in the real look (vs real) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const groups = new Map<string, RenderCase[]>();
  for (const c of r.cases) groups.set(`${c.world}:${c.bodies}`, [...(groups.get(`${c.world}:${c.bodies}`) ?? []), c]);
  for (const cs of groups.values()) {
    const by = (v: VariantName) => cs.find((c) => c.variant === v);
    // A missing variant (a --variants subset) leaves its column blank, its base included.
    const diff = (b: RenderCase | undefined, base: RenderCase | undefined) => {
      if (!base || !b || base.batches.length < 2) return '';
      const d = pairedPercentDiff(base.batches, b.batches);
      const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`;
      return `${pct(d.estimate)} [${pct(d.lo)}, ${pct(d.hi)}]${verdict(d) === 'no-difference' ? ' n.s.' : ''}`;
    };
    lines.push(`| ${cs[0]!.world} | ${cs[0]!.bodies.toLocaleString('en-US')} | ${diff(by('no-shadow'), by('full'))} | ${diff(by('no-post'), by('full'))} | ${diff(by('no-sparks'), by('full'))} | ${diff(by('no-heat'), by('full'))} | ${diff(by('no-ao'), by('full'))} | ${diff(by('no-seam'), by('full'))} | ${diff(by('fan'), by('full'))} | ${diff(by('cube'), by('full'))} | ${diff(by('flat-cube'), by('flat-fan'))} | ${diff(by('real'), by('full'))} | ${diff(by('real'), by('real-no-stone'))} | ${diff(by('real-no-stone'), by('real-stone-off'))} | ${diff(by('real-stone-off'), by('real-step1'))} | ${diff(by('real'), by('real-no-lod'))} | ${diff(by('real'), by('real-no-floor-sky'))} | ${diff(by('real'), by('real-flat-ground'))} | ${diff(by('real'), by('real-no-pcss'))} | ${diff(by('real-4096'), by('real'))} | ${diff(by('real-dust'), by('real'))} | ${diff(by('real-hall'), by('real'))} | ${diff(by('real-hall-out'), by('real'))} | ${diff(by('real'), by('real-bare-hills'))} | ${diff(by('real-dust'), by('real-plain-dust'))} | ${diff(by('real-rocks'), by('real'))} | ${diff(by('ice-one'), by('full'))} | ${diff(by('ice'), by('ice-one'))} | ${diff(by('real-ice'), by('real'))} |`);
  }
  return lines.join('\n');
}
