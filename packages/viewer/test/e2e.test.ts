// The viewer in headless Chromium: it boots, renders a non-blank scene,
// steps physics, and a fired ball becomes a new body. SwiftShader in CI.
import { describe, expect, it } from 'vitest';
import { requireWebGPU } from '@tb/testkit';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { browser, open, useViewer } from './e2e-harness.ts';

/** Minimal RGBA PNG encoder for debug screenshots of offscreen frames. */
function encodePng(w: number, h: number, px: { data: number[]; bytesPerRow: number }): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * px.bytesPerRow + 4 * x, o = y * (w * 4 + 1) + 1 + 4 * x;
    raw[o] = px.data[i]!; raw[o + 1] = px.data[i + 1]!; raw[o + 2] = px.data[i + 2]!; raw[o + 3] = 255;
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

useViewer();

describe('viewer', () => {
  // The GPU case also picks 20 solver iterations, which its buttons show.
  it.for([['avbd-gpu:iterations=20', 'GPU AVBD'], ['rapier', 'Rapier (CPU)'], ['tiered', 'Tiered (CPU)']] as const)('renders a tower, steps physics and fires a ball on %s', async ([engine, button], ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open(`/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=${engine}`);
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 10 && window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__viewer.bodies)).toBe(54);

    const stats = await page.evaluate((keep) => window.__viewer.capture(keep), !!process.env.VIEWER_SCREENSHOT);
    expect(stats).not.toBeNull();
    // Bodies cover part of the frame, with lit and shadowed faces in several colours: not blank.
    expect(stats!.bodyFraction).toBeGreaterThan(0.05);
    expect(stats!.distinctColors).toBeGreaterThan(50);
    if (process.env.VIEWER_SCREENSHOT) writeFileSync(process.env.VIEWER_SCREENSHOT, encodePng(stats!.width, stats!.height, stats!.pixels!));

    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.bodies === 55, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__viewer.inputs.length)).toBe(1);
    expect(await page.locator('#hud').innerText()).toMatch(/bodies[\s\S]*ms\/step/);
    expect(await page.locator('#hud').innerText()).toContain(engine);
    const on = await page.locator('#presets button.on').allInnerTexts();
    expect(on).toContain(button);
    expect(on.includes('20 iterations')).toBe(engine.startsWith('avbd-gpu'));

    // R reloads the scene between frames. The GPU engine's init() spans frames, and a
    // frame that stepped the engine mid-init stopped the viewer ('init() first').
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error, bodies: window.__viewer.bodies, inputs: window.__viewer.inputs.length })))
      .toEqual({ s: 'running', e: undefined, bodies: 54, inputs: 0 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('draws a dormant tower on the tiered engine, keeps it asleep, and a fired ball wakes it', async (ctx) => {
    if (!browser) return ctx.skip();
    // No gap: the cubes sit on a grid, so the tiers take the whole tower dormant.
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&offscreen=1&engine=tiered');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 10 && window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ bodies: window.__viewer.bodies, awake: window.__viewer.awake }))).toEqual({ bodies: 54, awake: 0 });
    const stats = await page.evaluate(() => window.__viewer.capture(false));
    expect(stats!.bodyFraction).toBeGreaterThan(0.05);
    expect(stats!.distinctColors).toBeGreaterThan(50);
    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.bodies === 55 && window.__viewer.awake > 1, undefined, { timeout: 30_000 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('the panel rebuilds the scene in place, a bigger projectile rebuilds the GPU engine, and the URL reproduces both', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=avbd-gpu');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
    const hasMarker = () => page.evaluate(() => (window as unknown as { marker?: number }).marker === 1);

    // The panel starts closed on a screen this narrow.
    expect(await page.locator('#controls').getAttribute('open')).toBeNull();
    await page.locator('#controls summary').click();
    // Scene: switch to S14, size it, and the panel shows the count before rebuilding.
    const scene = page.locator('#scene-form');
    await scene.locator('select[name=scenario]').selectOption('S14');
    for (const [k, v] of [['towers', '2'], ['W', '2'], ['D', '3'], ['H', '4']] as const) await scene.locator(`input[name="param.${k}"]`).fill(v);
    expect(await scene.locator('.out').innerText()).toBe('48 bodies');
    // Keys typed into the panel are not viewer commands (R would reset).
    await scene.locator('input[name=seed]').press('r');
    await scene.locator('input[name="param.towers"]').fill('0');
    expect(await scene.locator('button').isDisabled()).toBe(true);
    await scene.locator('input[name="param.towers"]').fill('2');
    await scene.locator('button').click();
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error, bodies: window.__viewer.bodies }))).toEqual({ s: 'running', e: undefined, bodies: 48 });
    expect(await hasMarker()).toBe(true); // no page load
    expect(new URL(page.url()).searchParams.get('scenario')).toBe('S14');
    expect(new URL(page.url()).searchParams.get('param.towers')).toBe('2');

    // Projectile: a 3 m cube is larger than any body the GPU engine was sized for, so it rebuilds.
    const proj = page.locator('#proj-form');
    await proj.locator('select[name=shape]').selectOption('cube');
    await page.waitForFunction(() => window.__viewer.resets === 3, undefined, { timeout: 60_000 }); // a 1.4 m cube: radius 1.21 > 0.87
    await proj.locator('input[name=size]').fill('3');
    await proj.locator('input[name=size]').dispatchEvent('change');
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 4 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await page.locator('#hud').innerText()).toMatch(/Rebuilt the scene/);
    // Slower and heavier fits the engine as it is: applied live, no rebuild.
    await proj.locator('input[name=speed]').fill('15');
    await proj.locator('input[name=mass]').fill('200');
    await proj.locator('input[name=mass]').dispatchEvent('change');
    expect(await proj.locator('.out').innerText()).toMatch(/^200 kg, 3\.00e\+3 kg·m\/s/);
    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.bodies === 49, undefined, { timeout: 30_000 });
    const fired = await page.evaluate(() => window.__viewer.inputs[0]!.body);
    expect(fired.shape).toEqual({ kind: 'box', half: [1.5, 1.5, 1.5] });
    expect(Math.hypot(...fired.linVel)).toBeCloseTo(15, 9);
    expect(fired.density * 27).toBeCloseTo(200, 9);
    expect(await page.evaluate(() => window.__viewer.resets)).toBe(4);
    const url = new URL(page.url());
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith('proj')))).toEqual({ proj: 'cube', 'proj.size': '3', 'proj.mass': '200', 'proj.speed': '15' });
    expect(errors).toEqual([]);
    await page.close();

    // The URL alone reproduces the setup: same scene, and the engine is sized for the cube from the start.
    const again = await open(url.pathname + url.search);
    expect(await again.page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }))).toEqual({ s: 'running', e: undefined });
    await again.page.waitForFunction(() => window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    await again.page.evaluate(() => window.__viewer.fire(0, 0));
    await again.page.waitForFunction(() => window.__viewer.bodies === 49, undefined, { timeout: 30_000 });
    expect(await again.page.locator('#proj-form select[name=shape]').inputValue()).toBe('cube');
    expect(await again.page.locator('#scene-form input[name="param.D"]').inputValue()).toBe('3');
    expect(again.errors).toEqual([]);
    await again.page.close();
  });

  it('the panel switches to the real look live and its knobs go into the URL', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=rapier');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 5, undefined, { timeout: 60_000 });
    // The top row's centre pixel: sky (S1 is one short tower, framed below it).
    const sky = () => page.evaluate(async () => {
      const f = (await window.__viewer.capture(true))!;
      return [0, 1, 2].map((c) => f.pixels!.data[4 * Math.floor(f.width / 2) + c]!);
    });
    const candy = await sky();
    await page.locator('#controls summary').click();
    const look = page.locator('#look-form');
    expect(await look.locator('.real').isHidden()).toBe(true);
    await look.locator('select[name=look]').selectOption('real');
    expect(await look.locator('.real').isVisible()).toBe(true);
    await look.locator('input[name=sunElevation]').fill('40');
    await look.locator('input[name=visibility]').fill('15');
    await page.waitForFunction(() => window.__viewer.frames > 15, undefined, { timeout: 60_000 });
    const real = await sky();
    expect(real[2]!).toBeGreaterThan(real[0]!); // a blue sky
    expect(real).not.toEqual(candy);
    const url = new URL(page.url());
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k === 'look' || k.startsWith('real.')))).toEqual({ look: 'real', 'real.sunElevation': '40', 'real.visibility': '15' });
    expect(await page.evaluate(() => window.__viewer.resets)).toBe(1); // live: no rebuild
    expect(errors).toEqual([]);
    await page.close();
    const again = await open(url.pathname + url.search);
    expect(await again.page.locator('#look-form input[name=sunElevation]').inputValue()).toBe('40');
    expect(await again.page.locator('#look-form select[name=look]').inputValue()).toBe('real');
    expect(again.errors).toEqual([]);
    await again.page.close();
  });

  it('the panel\'s cube size brings its substeps, rebuilds at that scale, and the URL keeps it', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=rapier');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    const firedSpeed = async (bodies: number) => {
      await page.evaluate(() => window.__viewer.fire(0, 0));
      await page.waitForFunction((n) => window.__viewer.bodies === n, bodies, { timeout: 30_000 });
      return page.evaluate(() => Math.hypot(...window.__viewer.inputs.at(-1)!.body.linVel));
    };
    const unit = await firedSpeed(55);
    await page.locator('#controls summary').click();
    const scene = page.locator('#scene-form');
    // Bounce is the AVBD engines' restitution switch: off and disabled on Rapier.
    expect({ checked: await scene.locator('input[name=bounce]').isChecked(), disabled: await scene.locator('input[name=bounce]').isDisabled() }).toEqual({ checked: false, disabled: true });
    // The browser's own form check must pass the default and a size off any step grid, or submit does nothing.
    const valid = () => scene.locator('input[name=scale]').evaluate((el) => (el as HTMLInputElement).validity.valid);
    expect(await valid()).toBe(true);
    await scene.locator('input[name=scale]').fill('0.25');
    expect(await valid()).toBe(true);
    expect(await scene.locator('input[name=substeps]').inputValue()).toBe('2');
    expect(await scene.locator('.out').innerText()).toBe('54 bodies, 4 g in cube units, 2x as fast, 2x physics cost');
    await scene.locator('button').click();
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__viewer.status)).toBe('running');
    expect(await firedSpeed(55)).toBeCloseTo(2 * unit, 9);
    const url = new URL(page.url());
    expect(url.searchParams.get('scale')).toBe('0.25');
    expect(url.searchParams.get('substeps')).toBeNull(); // 2 is 0.25's own
    expect(errors).toEqual([]);
    await page.close();
  });

  it('the panel\'s camera framing moves the camera now, goes into the URL, and R keeps it', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=rapier');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    const pose = () => page.evaluate(() => window.__viewer.camera());
    expect((await pose()).pitch).toBeCloseTo((12 * Math.PI) / 180, 3);
    const far = (await pose()).distance;
    await page.locator('#controls summary').click();
    const view = page.locator('#view-form');
    await view.locator('input[name=pitch]').fill('30');
    await view.locator('input[name=fit]').fill('2');
    expect((await pose()).pitch).toBeCloseTo((30 * Math.PI) / 180, 3);
    expect((await pose()).distance).toBeGreaterThan(1.5 * far);
    await view.locator('input[name=fov]').fill('500');
    expect(await view.locator('.out').innerText()).toMatch(/field of view \(deg\) must be from 10 to 120/);
    const url = new URL(page.url());
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith('view.')))).toEqual({ 'view.pitch': '30', 'view.fit': '2' });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // keys typed into the panel are not commands
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.resets === 2, undefined, { timeout: 60_000 });
    expect((await pose()).pitch).toBeCloseTo((30 * Math.PI) / 180, 3);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('downloads the setup as named JSON, and loading a file rebuilds that setup in place, camera and all', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=rapier&look=real&real.sunElevation=12');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
    const hasMarker = () => page.evaluate(() => (window as unknown as { marker?: number }).marker === 1);
    const camera = () => page.evaluate(() => window.__viewer.camera());
    await page.locator('#controls summary').click();
    const form = page.locator('#file-form');

    // Download: the name goes into the file and its file name; the camera is where it is now.
    await form.locator('input[name=name]').fill('My tower: v1');
    const [download] = await Promise.all([page.waitForEvent('download'), form.locator('button[type=submit]').click()]);
    expect(download.suggestedFilename()).toBe('my-tower-v1.json');
    const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expect(saved).toMatchObject({
      format: 'tower-blaster/viewer-scene', version: 1, name: 'My tower: v1',
      scene: { scenario: 'S1', params: { F: 3, H: 6, gap: 0.02 }, seed: 1, sleep: null },
      engine: { name: 'rapier', options: {} },
      look: { preset: 'real', real: { sunElevation: 12, visibility: 40 } },
    });
    expect(saved.camera).toEqual(await camera());
    expect(await form.locator('.out').innerText()).toBe('Saved my-tower-v1.json');

    // Load an edited copy: another scene, engine and camera, rebuilt without a page load.
    const wall = { ...saved, name: 'Wall', scene: { scenario: 'S3', params: { W: 6, H: 4, running: false }, seed: 1, sleep: null }, engine: { name: 'tiered', options: {} }, camera: { target: [0, 2, 0], yaw: 1, pitch: 0.3, distance: 30 } };
    const pick = (name: string, doc: unknown) => form.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await pick('wall.json', wall);
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error, bodies: window.__viewer.bodies }))).toEqual({ s: 'running', e: undefined, bodies: 24 });
    expect(await camera()).toEqual(wall.camera);
    expect(await hasMarker()).toBe(true);
    expect(await page.locator('#hud').innerText()).toContain('Loaded Wall');
    expect(await form.locator('input[name=name]').inputValue()).toBe('Wall');
    expect(await page.locator('#scene-form input[name="param.W"]').inputValue()).toBe('6');
    const url = new URL(page.url()).searchParams;
    expect([url.get('scenario'), url.get('engine'), url.get('cam'), url.get('real.sunElevation'), url.get('real.visibility')]).toEqual(['S3', 'tiered', '0,2,0,1,0.3,30', '12', null]);
    expect(await page.locator('#presets button.on').allInnerTexts()).toContain('Tiered (CPU)');
    // R restarts at the loaded camera.
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.resets === 3, undefined, { timeout: 60_000 });
    expect(await camera()).toEqual(wall.camera);

    // A file the viewer can't read says why and changes nothing.
    await pick('future.json', { ...wall, version: 2 });
    await expect.poll(() => form.locator('.out').innerText()).toMatch(/^future\.json: scene file version 2 is newer/);
    expect(await form.locator('.out').getAttribute('class')).toContain('warn');
    expect(await page.evaluate(() => window.__viewer.resets)).toBe(3);

    // Another loop needs a page load; the page then starts as the file says.
    await pick('frame.json', { ...wall, loop: { mode: 'frame', pipeline: true, maxSteps: 2 } });
    await page.waitForURL(/loop=frame/, { timeout: 30_000 });
    await page.waitForFunction(() => window.__viewer?.status === 'running' && window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    expect(await hasMarker()).toBe(false);
    expect(await camera()).toEqual(wall.camera);
    expect(await page.locator('#hud').innerText()).toContain('loop frame');
    expect(new URL(page.url()).searchParams.get('offscreen')).toBe('1'); // the page's own setting is kept
    expect(errors).toEqual([]);
    await page.close();
  });

  // loop=free with an engine that steps synchronously and slower than real time (the f64
  // reference at 30 iterations, ~100-150 ms a step here and still over 16.7 ms on a host
  // five times faster): steps are always due, so without a task boundary between them the
  // physics loop would never yield and the page would hang.
  it('keeps rendering while a CPU engine slower than real time steps back to back', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=avbd-ref:iterations=30');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.stepIndex > 6 && window.__viewer.msPerStep > 0, undefined, { timeout: 60_000, polling: 250 });
    const a = await page.evaluate(() => ({ steps: window.__viewer.stepIndex, frames: window.__viewer.frames, ms: window.__viewer.msPerStep }));
    // Slower than real time, so the physics loop never waits for a frame...
    expect(a.ms).toBeGreaterThan(1000 / 60);
    // ...and frames still run between its steps. (Their rate is SwiftShader's and the host's
    // load's, so this waits for progress rather than timing it; a loop that never yields hangs here.)
    await page.waitForFunction((x) => window.__viewer.frames >= x.frames + 3 && window.__viewer.stepIndex >= x.steps + 8, a, { timeout: 60_000, polling: 250 });
    expect(await page.locator('#hud').innerText()).toContain('loop free');
    expect(errors).toEqual([]);
    await page.close();
  });

  // loop=free renders every frame without waiting for physics. An offscreen target gets no
  // presentation backpressure, so the loop bounds its own GPU work: unbounded, SwiftShader's
  // queue was 50 s behind after 12 s, starving physics and turning a capture into a 50 s wait.
  it('keeps at most a couple of frames queued on the GPU, so physics and readbacks keep up', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=avbd-gpu');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    // Pipelined (the default): an engine behind real time submits each step while the one before
    // still runs. SwiftShader is far behind on this scene; a fast GPU need not be.
    const run = await page.evaluate(() => ({ overlapped: window.__viewer.overlapped, ms: window.__viewer.msPerStep, snap: window.__viewer.snapMs, steps: window.__viewer.stepIndex }));
    console.log(`pipelined: ${run.steps} steps, ${run.overlapped} overlapped, ${run.ms.toFixed(1)} ms/step, ${run.snap.toFixed(1)} ms snapshot + upload`);
    if (run.ms > 1.5 * (1000 / 60)) {
      expect(run.overlapped).toBeGreaterThan(0);
      // Each read waits behind its step (and the one before), but is timed from when its step was done.
      expect(run.snap).toBeLessThan(run.ms);
    }
    const before = await page.evaluate(() => window.__viewer.stepIndex);
    const t0 = Date.now();
    expect(await page.evaluate(() => window.__viewer.capture(false))).not.toBeNull();
    // Without the cap the queue was ~30 s behind by now; with it a capture waits a frame or two (more on a loaded host).
    expect(Date.now() - t0).toBeLessThan(15_000);
    await page.waitForFunction((k) => window.__viewer.stepIndex > k + 3, before, { timeout: 10_000, polling: 250 });
    // R resets on the physics loop while frames keep drawing; afterwards the new scene is on screen and stepping.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // keys typed into the panel are not commands
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.resets === 2 && window.__viewer.stepIndex > 3, undefined, { timeout: 60_000, polling: 250 });
    expect((await page.evaluate(() => window.__viewer.capture(false)))!.bodyFraction).toBeGreaterThan(0.05);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('pipeline=0 runs the free loop serially: steps, resets, never overlaps a step, and the HUD says so', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=avbd-gpu&pipeline=0');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 10 && window.__viewer.stepIndex > 5, undefined, { timeout: 60_000, polling: 250 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // keys typed into the panel are not commands
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.resets === 2 && window.__viewer.stepIndex > 3, undefined, { timeout: 60_000, polling: 250 });
    // Serial, a step is never queued behind the one before. That only tells pipelining apart when
    // the engine is behind real time, as it always is on SwiftShader here.
    const run = await page.evaluate(() => ({ overlapped: window.__viewer.overlapped, ms: window.__viewer.msPerStep }));
    console.log(`pipeline=0: ${run.overlapped} overlapped, ${run.ms.toFixed(1)} ms/step`);
    if (run.ms > 1.5 * (1000 / 60)) expect(run.overlapped).toBe(0);
    expect(await page.locator('#hud').innerText()).toContain('loop free · pipeline off');
    expect(errors).toEqual([]);
    await page.close();
  });

  // The GPU engine, so the frame loop's finish() timing runs too.
  it('loop=frame still steps, renders, fires and resets', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=avbd-gpu&loop=frame');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 10 && window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.bodies === 55, undefined, { timeout: 30_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // keys typed into the panel are not commands
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.resets === 2 && window.__viewer.stepIndex > 3, undefined, { timeout: 60_000, polling: 250 });
    expect(await page.evaluate(() => window.__viewer.bodies)).toBe(54);
    expect((await page.evaluate(() => window.__viewer.capture(false)))!.bodyFraction).toBeGreaterThan(0.05);
    expect(await page.locator('#hud').innerText()).toContain('loop frame');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows a readable error for a bad URL instead of a blank page', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page } = await open('/?scenario=S99&offscreen=1');
    expect(await page.evaluate(() => window.__viewer.status)).toBe('error');
    expect(await page.locator('#error').innerText()).toMatch(/unknown scenario S99/);
    await page.close();
  });
});
