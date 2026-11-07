// The renderer's data path: CPU-side packing and references here, GPU
// culling and drawing in headless Chromium (SwiftShader without a GPU).
// Correctness only: timings from here are never performance results.
// The renderer's drawing cases (describe 'drawing'), split from render.test.ts so neither file passes CI's 300 s per file.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Body } from '@tb/schema';
import { ADAPT_REF, REAL_POLISH_OFF, normalize, transmittance } from '../src/index.ts';
import { type V3 } from '../src/index.ts';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
  it('ID pixels at stable probes equal a CPU raycast', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Seed 11 caught spheres drawn inside out (back faces kept by the cull mode).
    for (const seed of [11, 12, 13]) {
      const r = await call('idProbes', seed);
      expect(r.error).toBeNull();
      expect(r.probes).toBeGreaterThan(500);
      expect(r.hitProbes).toBeGreaterThan(50);
      expect(r.mismatches, r.examples.join('; ')).toBe(0);
    }
  });

  // A packed tower showed dark vertical dashes: at edge pixels the MSAA
  // shading point lies outside the triangle, and a face guessed from the
  // extrapolated local position named the neighbouring face (that guess
  // makes 1735 of these pixels unstable).
  it('tower faces shade as their own face at every sub-pixel edge', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('towerFaces');
    expect(r.error).toBeNull();
    expect(r.checked).toBeGreaterThan(2000);
    expect(r.unstable, r.examples.join('; ')).toBe(0);
    // A few pixels on a shared edge see the neighbour's inner face: the two
    // meet exactly there, and snapped vertices decide either way. Measured
    // 5 of 2897; neither depth32float nor dilating boxes by up to 1 px
    // removes them, and in the shaded image they are one sample of four on
    // an already darkened seam.
    expect(r.wrong, r.examples.join('; ')).toBeLessThan(r.checked * 0.005);
  });

  it('colour and bevel WGSL match their TypeScript twins', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('lookTwins', 41);
    expect(r.error).toBeNull();
    expect(r.agxErr).toBeLessThan(1 / 1024); // a quarter of an 8-bit step
    expect(r.labErr).toBeLessThan(1e-5);
    expect(r.bevErr).toBeLessThan(1e-4);
  });

  it('bloom without Karis weighting conserves energy and falls off monotonically', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('bloomEnergy', false);
    expect(r.error).toBeNull();
    expect(r.finite).toBe(true);
    expect(r.levels).toBe(5);
    expect(r.meanRatio).toBeGreaterThan(0.95);
    expect(r.meanRatio).toBeLessThan(1.05);
    expect(r.rises).toBe(0);
    // Karis weighting tames the single-pixel firefly: much less energy, still finite.
    const k = await call('bloomEnergy', true);
    expect(k.finite).toBe(true);
    expect(k.meanRatio).toBeLessThan(0.5);
  });

  it('FX scale hides, shrinks and regrows bodies exactly; clearFx restores', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const seed of [51, 52]) {
      const r = await call('fxScale', seed);
      expect(r.error).toBeNull();
      expect(r.probes).toBeGreaterThan(500);
      expect(r.hits).toBeGreaterThan(50);
      expect(r.mismatches, r.examples.join('; ')).toBe(0);
      expect(r.hiddenSeen).toBe(0);
      expect(r.restoreDiff).toBe(0);
    }
  });

  it('FX paint makes a ball the tint\'s colour, in the candy and the real look', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('fxPaint');
    expect(r.error).toBeNull();
    const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    for (const look of ['candy', 'real'] as const) {
      const { plain, painted } = r.looks[look]!;
      // Plain is the look's ball (peach or grey); painted reads blue (the candy ball glows far
      // into HDR, so its tone map leaves it pastel).
      expect(plain[2]!, look).toBeLessThan(plain[0]! + 5);
      expect(painted[2]!, look).toBeGreaterThan(painted[0]! + 50);
      expect(painted[2]!, look).toBeGreaterThan(painted[1]! + 50);
    }
    // A tint multiplies the look's ball: the candy ball's glow ignores it, the real look's grey darkens it; paint does neither.
    const { tinted: ct, painted: cp } = r.looks.candy!, { tinted: rt, painted: rp } = r.looks.real!;
    expect(cp[2]! - cp[0]!).toBeGreaterThan(ct[2]! - ct[0]! + 50);
    expect(luma(rp)).toBeGreaterThan(luma(rt) + 30);
  });

  it('FX tint, glow, flash and overlay show in the final image', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('fxColour');
    expect(r.error).toBeNull();
    const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(r.red[0]! / r.red[1]!).toBeGreaterThan(1.5 * (r.plain[0]! / r.plain[1]!)); // tint shifts towards red
    expect(luma(r.glow)).toBeGreaterThan(luma(r.plain) + 20); // glow brightens
    expect(luma(r.flashMid)).toBeGreaterThan(luma(r.plain) + 5); // halfway through the flash
    expect(luma(r.flashMid)).toBeLessThan(luma(r.glow));
    expect(Math.abs(luma(r.flashDone) - luma(r.plain))).toBeLessThan(1); // flash over: as if none
    expect(r.backBehindBox).toBe(true);
    expect(r.frontDelta).toBeGreaterThan(30); // the front sphere is drawn
    expect(r.backDelta).toBeLessThan(3); // the one behind the box is hidden by depth
  });

  it('the hexagon fan draws and casts the same boxes as the 36-vertex cube', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const seed of [61, 62]) {
      const r = await call('fanVsCube', seed, 50);
      expect(r.error).toBeNull();
      expect(r.covered).toBeGreaterThan(r.pixels * 0.3);
      expect(r.differ).toBeLessThan(r.pixels * 0.001); // measured 13 and 6 of 800k
      expect(r.coverDiff).toBe(0);
      expect(r.over1cm).toBeLessThan(r.texels * 0.001); // nearer-surface disagreements; measured 0 and 1 of 747k, 674k
      expect(r.over1mm).toBeLessThan(r.texels * 0.01); // interpolation; measured 1946 and 2393, max 7 mm
    }
  });

  it('the floor covers exactly the visible plane (no stray floor over bodies, no gaps)', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Looking down at the grazing slab's floor (where macOS SwiftShader drew the old 1,200 m quad's triangle over the slab),
    // a low camera with the horizon in view, a camera close to the floor, and one below it looking up.
    const cases: [V3, V3, number][] = [[[0.3, 7, 0.4], [0, 2, 0], -5], [[0, 1.5, 8], [0, 1, 0], 0], [[2, 0.05, 3], [0, 0, 0], 0], [[0, -2, 0], [3, 4, 1], 0]];
    for (const [eye, target, groundY] of cases) {
      const r = await call('floorCoverage', eye, target, groundY);
      expect(r.error).toBeNull();
      expect(r.checked).toBeGreaterThan(10000);
      expect(r.wrong, `eye ${eye}`).toBe(0);
    }
  });

  it('renders at tiny output sizes without error (bloom keeps at least one level)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('tinyFrames', [[1, 1], [3, 5], [7, 7], [8, 8], [9, 4]]);
    for (const f of r) {
      expect(f.error, `size ${f.size}`).toBeNull();
      expect(f.meanLuma, `size ${f.size}`).toBeGreaterThan(5); // sky and floor still drawn and composited
    }
  });

  it('atmosphere LUT passes match their CPU twins, pass by pass', async (ctx) => {
    if (!gpu) return ctx.skip();
    const el = (deg: number): V3 => normalize([Math.cos((deg * Math.PI) / 180) * 0.6, Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180) * -0.8]);
    const sun35 = el(35);
    for (const [sun, eye] of [[sun35, 0.03], [el(4), 0.002], [el(-2), 0.1]] as [V3, number][]) {
      const r = await call('atmosphereTwins', sun, eye);
      expect(r.error).toBeNull();
      expect(r.finite).toBe(true);
      // Measured on SwiftShader, worst of the three: 4.8e-4 (half-float rounding), 4e-4, 2.3e-2 (2 m up, just below
      // the horizon, where transmittance changes fastest and the sampler's fixed-point weights show), 3.2e-3 absolute, 1.7e-4.
      expect(r.worst.transmittance).toBeLessThan(1e-3);
      expect(r.worst.multi).toBeLessThan(2e-3);
      expect(r.worst.sky).toBeLessThan(4e-2);
      expect(r.worst.skyAlpha).toBeLessThan(5e-3);
      expect(r.worst.ambient).toBeLessThan(2e-3);
      expect(r.worst.exposure).toBeLessThan(1e-4);
      if (sun === sun35) {
        // ADAPT_REF is this ratio (measured at 30 m), so the default sun keeps the exposure as set.
        expect(Math.abs(r.illuminance / r.sunIlluminanceLuma / ADAPT_REF - 1)).toBeLessThan(5e-3);
        expect(r.exposure).toBeCloseTo(1.3, 2);
      }
    }
  });

  it('material bake (stones, grounds, macro) matches its CPU twin, tiles, keeps unit normals, and box-filters its mips', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('materialBake');
    expect(r.error).toBeNull();
    expect(r.layers.map((l) => l.layer)).toEqual(['limestone', 'sandstone', 'granite', 'concrete', 'pine', 'gravel', 'dirt', 'macro']);
    // Measured on SwiftShader: twin within 0.5 of an 8-bit step (rounding), mips within 0.5 step,
    // the wrap jump within 1.1x the jump between neighbours inside.
    for (const l of r.layers) {
      expect(l.twin, l.layer).toBeLessThanOrEqual(1);
      expect(l.unit, l.layer).toBeLessThan(0.02);
      expect(l.mip, l.layer).toBeLessThanOrEqual(1);
      expect(l.tile.wrap, l.layer).toBeLessThan(1.5 * l.tile.inside + 1);
      // The ground keeps the configured albedo on average (within 5%), and the macro layer is 0.5 (x 2) on average.
      const [lo, hi] = ['gravel', 'dirt', 'macro'].includes(l.layer) ? [0.95, 1.05] : [0.8, 1.15];
      for (const m of l.mean) { expect(m, l.layer).toBeGreaterThan(lo); expect(m, l.layer).toBeLessThan(hi); }
    }
  });

  it('pixel readback is RGBA whatever the output format (Apple prefers BGRA)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const rgba = await call('sceneHash', {}, 'rgba8unorm'), bgra = await call('sceneHash', {}, 'bgra8unorm');
    expect(rgba.error).toBeNull();
    expect(bgra.error).toBeNull();
    expect(bgra.hash).toBe(rgba.hash);
    // The shadow check thresholds on luma, so a swapped readback moves its numbers (measured lit 142 vs 126 on the grazing slab).
    const a = await call('shadowCheck', 'grazing', { format: 'rgba8unorm' }), b = await call('shadowCheck', 'grazing', { format: 'bgra8unorm' });
    expect(b.lit).toBe(a.lit);
  });

  // Golden images: the looks that exist must not change by a single bit while
  // new looks are added to the same shaders (docs/realism.md). Hashes are
  // pinned per platform, since rasterizers differ (Linux and macOS SwiftShader
  // do); an unpinned platform logs its hashes and skips. UPDATE_GOLDEN=1
  // rewrites this platform's entry, for a change meant to alter these looks:
  // say why in the commit. real-polish-off is the real look with realism
  // step 7's options off (REAL_POLISH_OFF), pinned before step 7 landed: the
  // polish adds options and changes nothing else.
  it('candy, hazy and the real look without its polish are bit-identical to their pinned golden images', async (ctx) => {
    if (!gpu) return ctx.skip();
    const looks = ['candy', 'hazy', { name: 'real-polish-off', real: REAL_POLISH_OFF }];
    const r = await call('lookHashes', looks);
    expect(r.error).toBeNull();
    expect((await call('lookHashes', looks)).hashes).toEqual(r.hashes); // deterministic, or the gate means nothing
    const key = `${process.platform} ${gpu.adapter.vendor} ${gpu.adapter.architecture} ${gpu.adapter.description}`.replace(/\s+/g, ' ').trim();
    const file = fileURLToPath(new URL('./golden/looks.json', import.meta.url));
    const pinned = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, number>>;
    if (process.env.UPDATE_GOLDEN === '1') {
      pinned[key] = r.hashes;
      writeFileSync(file, JSON.stringify(pinned, null, 2) + '\n');
      return;
    }
    const want = pinned[key];
    if (!want) {
      console.warn(`no golden images pinned for "${key}"; UPDATE_GOLDEN=1 pins: ${JSON.stringify(r.hashes)}`);
      return ctx.skip();
    }
    expect(r.hashes).toEqual(want);
  });

  it('shadows fall where the analytic sun rays say, without acne or light leaks', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const kind of ['float', 'contact', 'grazing'] as const) {
      const r = await call('shadowCheck', kind);
      expect(r.error).toBeNull();
      expect(r.used).toBeGreaterThan(3000);
      expect(r.wrong).toBe(0); // away from shadow edges and silhouettes, every pixel is lit or shadowed as the rays say
      expect(r.maxStep).toBeLessThanOrEqual(3); // no acne: measured 1.9, 2, 1 (12 on the grazing face without bias)
      if (kind === 'grazing') { expect(r.NoL).toBeCloseTo(0.17, 6); continue; }
      expect(r.iou).toBeGreaterThan(0.95); // measured 0.994 (float), 0.990 (contact)
      expect(r.centroidErr).toBeLessThan(0.02); // metres; measured 5.6 mm, 3.1 mm
      expect(r.leak).toBe(0); // no light under a resting cube (a 30 cm bias leaks 6 cm)
    }
    // The close-up sees a small part of the arena, so its map is the finest.
    expect((await call('shadowCheck', 'contact')).window).toBe(4);
  });

  it('culling never changes an ID pixel', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('cullInvariance', 21, 4000);
    expect(r.error).toBeNull();
    expect(r.diff).toBe(0);
    expect(r.distinctOnScreen).toBeGreaterThan(100);
    expect(r.drawnBoxes + r.drawnSpheres).toBeLessThan(3000); // most of the cloud is behind or beside the camera
  });

  it('interpolates between the last two steps', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('interpolation', 31);
    expect(r.error).toBeNull();
    // alpha 0 / 1 reproduce prev / current, allowing a few edge pixels for quaternion renormalization.
    expect(r.diff0).toBeLessThan(r.pixels * 0.001);
    expect(r.diff1).toBe(0);
    expect(Math.abs(r.c1 - r.c0)).toBeGreaterThan(5);
    expect(Math.abs(r.c5 - (r.c0 + r.c1) / 2)).toBeLessThan(1);
  });

  it('SnapshotSource uploads only new, active and re-tiered slots, and still draws dormant cells', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('tierUploads', 5);
    expect(r.error).toBeNull();
    expect(r.steps.map((s) => s.equal)).toEqual([true, true, true, true]);
    // All 200; the woken 5, 77, 150; 5 and 150 (active) and 77 (frozen); 5 and 150 and the new slot 200, not 77 (still rubble).
    expect(r.steps.map((s) => s.uploaded / Body.size)).toEqual([200, 3, 3, 3]);
    expect(r.dormantDrawn).toEqual([true, true, true]);
  });

  it("draws a GPU engine's buffers in place: same image, uniforms-only uploads", async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('gpuSource', 41);
    expect(r.error).toBeNull();
    expect(r.diff).toBe(0);
    expect(r.prevEqual).toBe(true); // beforeStep() copied the state into prev
    // Uniforms only (frame, cull, spark and light params, spark control reset): measured 1602 B (the debris params and counters added 24, the
    // hall's 2 vec4 in the frame 48 with padding; realism step 7 48: the frame's ballSteel and the composite's tone map and grain,
    // measured 1698; the frame's iceShadow 16 and Bullet Time's fxGain 16 more, 1730, its grade in a spare post word). Any per-body upload is 41 x Body.size more.
    expect(r.bytesPerFrame).toBeLessThanOrEqual(1732);
    expect(1732).toBeLessThan(41 * Body.size);
  });
});
