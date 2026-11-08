// pnpm playtest:agent: the agent playtest round (roadmap G9b,
// docs/game/agent-playtest-1.md). Plays every scenario of plan.ts in headless
// Chromium against the game page on a local Vite server (main as checked out),
// at desktop and phone viewports, and writes for each run its captures (PNG),
// a contact sheet of them, and what it measured (report.json): load, each
// shot's sim time to settle, collapse, the result card, undo and retry times,
// HUD and card text, page errors.
//
//   pnpm playtest:agent [--only <regex>] [--viewport desktop|phone|phone-landscape] [--out dir] [--workers n] [--engine rapier|gpu: every scenario on it] [--look hazy|real|candy: every scenario in it]
//
// Headless Chromium here cannot present WebGPU to a canvas (no shared-image
// backing for the swap chain on SwiftShader: the device is lost on the first
// frame), so the page renders offscreen at the viewport's own size
// (?offscreen=WxH) and each capture is drawn into a 2D canvas laid over the
// game's canvas, under the HUD, before the screenshot. Physics runs on each
// scenario's engine (plan.ts: the GPU solver for the chamber levels, Undercut
// and the duels; Rapier for the 1,000 to 10,000 block levels, which take the
// GPU solver minutes a shot on SwiftShader), at real pace; every
// time measured is in sim steps (60 a second), which no machine changes. Wall
// times are SwiftShader's and never a performance result (CLAUDE.md).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer } from 'vite';
import { levelById, RUBE_GO, type Shot } from '@tb/keystone';
import { WEBGPU_ARGS } from '@tb/testkit';
import { buildLine, type EditAction, fuseSweep } from './modes.ts';
import { agentPlan, frameName, lineOf, noviceAim, type Scenario, sheetGrid, spiral, VIEWPORTS, type ViewportName, withLook } from './plan.ts';

const MIN = 60_000;
const STEP_HZ = 60;
/** Sim steps after the first shot at which the sequence is captured (a third of a second, one second, two and a half). */
export const SEQUENCE_STEPS = [20, 60, 150];
/**
 * Sim steps after a bell rings (Rube Lab, Wavefront's Lay; PT26) at which the first shot is also captured: the flash
 * at its brightest, the ring waves out, and the bell as it comes to rest (a bell level ends 1.5 s, 90 steps, after it).
 */
export const RING_STEPS = [6, 30, 70];

interface ShotRecord { k: number; shot: Shot | null; how: string; firedAt: number; settledAt: number | null; simS: number | null; collapse: number; strokes: number; phase: string }
export interface RunRecord {
  scenario: string; title: string; mode: string; viewport: ViewportName; url: string; engine: string;
  status: 'ok' | 'error' | 'timeout'; problem?: string;
  loadWallMs: number; loadMs?: number; bodies?: number;
  shots: ShotRecord[];
  result?: { total: number; stars: number; stamp: string; text: string } | null;
  hud?: string; help?: string;
  undo?: { ok: boolean; mode: string; ms: number } | null; retryWallMs?: number;
  freeze?: { frozeAt: number; frozen: boolean; firedWhileFrozen: boolean; resumed: boolean } | null;
  /** Round 2: a build phase (Rube Lab, Mason's Trial): what was built (the recorded build's label, or nothing) and the panel's line after it. */
  build?: { built: string; status: string } | null;
  /** PT3's verify on a touch viewport: the docked HUD's share of the screen (upright: strip + tray heights over the height; sideways: the rail's right edge over the width) at the aim view and after shot 1, and whether its boxes stayed put. */
  hudShare?: { before: number; after: number | null; same: boolean | null; dock: boolean } | null;
  duel?: unknown; goals?: unknown; counts?: Record<string, number>; pace?: unknown;
  frames: string[]; sheet?: string; errors: string[]; wallMs: number;
}

function args(argv: string[]) {
  const o: { only: RegExp | null; viewport: ViewportName | null; out: string; workers: number; engine: string | null; look: string | null } = { only: null, viewport: null, out: 'agent-playtest-out', workers: 2, engine: null, look: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--only') { o.only = new RegExp(v!); i++; } else if (a === '--viewport') { o.viewport = v as ViewportName; i++; } else if (a === '--out') { o.out = v!; i++; } else if (a === '--workers') { o.workers = Number(v); i++; } else if (a === '--engine') { o.engine = v!; i++; } else if (a === '--look') { o.look = v!; i++; } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Draw the game's next frame into a 2D canvas over its own (offscreen) one, so a screenshot shows the scene under the HUD. */
async function mirror(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const st = await window.__game.capture(true);
    if (!st?.pixels) return false;
    const src = document.getElementById('c')!, r = src.getBoundingClientRect();
    let c = document.getElementById('agent-mirror') as HTMLCanvasElement | null;
    if (!c) {
      c = document.createElement('canvas');
      c.id = 'agent-mirror';
      src.after(c);
    }
    c.width = st.width; c.height = st.height;
    Object.assign(c.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none', zIndex: getComputedStyle(src).zIndex });
    const ctx = c.getContext('2d')!, img = ctx.createImageData(st.width, st.height), row = st.width * 4, px = st.pixels;
    for (let y = 0; y < st.height; y++) img.data.set(px.data.slice(y * px.bytesPerRow, y * px.bytesPerRow + row), y * row);
    ctx.putImageData(img, 0, 0);
    return true;
  });
}

/** The docked HUD's boxes and its share of the screen, as game/test/phone-hud-e2e.test.ts measures it (PT3). */
const hudBoxes = (page: Page) => page.evaluate(() => {
  // No named helper inside: tsx's esbuild wraps named functions in __name, which the page does not define.
  const [st, tray] = ['.kg-hud .st', '.kg-hud .tray'].map((sel) => { const e = document.querySelector(sel) as HTMLElement | null; if (!e || e.offsetParent === null) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const vw = innerWidth, vh = innerHeight;
  const share = !st || !tray ? NaN : vw > vh ? Math.max(st.x + st.w, tray.x + tray.w) / vw : (st.h + tray.h) / vh;
  return { st, tray, share, dock: !!document.querySelector('.kg-hud.kg-dock') };
});

const textOf = (page: Page, sel: string) => page.locator(sel).first().innerText({ timeout: 2000 }).catch(() => '');
const gameState = (page: Page) => page.evaluate(() => { const g = window.__game; return { ready: g.ready, phase: g.phase, strokes: g.strokes, step: g.stepIndex, collapse: g.collapse, result: g.result, status: g.status, error: g.error, frozen: g.frozen }; });

/**
 * Wait (timer polling: rAF starves while SwiftShader is busy) until the last shot has settled and the page can
 * fire, or the round is over. `ready` alone is not enough: with rapid fire (on by default) it is also true while a
 * shot runs, so the phase must have left 'running'.
 */
const settled = (page: Page, strokes: number, timeout: number) => page.waitForFunction((n) => window.__game.status !== 'running' || window.__game.result !== null || (window.__game.ready && window.__game.phase !== 'running' && window.__game.strokes >= n), strokes, { timeout, polling: 250 });

async function runOne(browser: Browser, origin: string, sc: Scenario, vp: ViewportName, out: string, engine: string): Promise<RunRecord> {
  const v = VIEWPORTS[vp], t0 = Date.now();
  const w = v.width * v.scale, h = v.height * v.scale;
  const sep = sc.search.includes('?') ? '&' : '?';
  // fxclock=1: the effects run on the simulation's clock between captures, so a frame shows the sparks, flashes and
  // blasts a player would see (without it they age only at captures and pile up; damage-effects.md, look review).
  const url = `${sc.search}${sep}engine=${engine}&offscreen=${w}x${h}&fxclock=1&progress=off&keystone.sound=synth${sc.script.kind === 'door' ? '' : '&door=0'}`;
  const rec: RunRecord = { scenario: sc.id, title: sc.title, mode: sc.mode, viewport: vp, url, engine, status: 'ok', loadWallMs: 0, shots: [], frames: [], errors: [], wallMs: 0 };
  const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, isMobile: v.touch, hasTouch: v.touch });
  const page = await context.newPage();
  page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') rec.errors.push(`${m.type()}: ${m.text()}`); });
  let n = 0;
  /**
   * Capture a frame. Physics holds (GameHandle.hold) from before the picture until after the screenshot, so the
   * scene and the HUD show the same step (PT12: on Rapier the sim ran on while SwiftShader rendered). `what` may
   * be a function of the step held at, for the frame's name.
   */
  const shoot = async (what: string | ((step: number) => string), settleMs = 0) => {
    if (settleMs) await page.waitForTimeout(settleMs);
    const step = await page.evaluate(() => { window.__game.hold = true; return window.__game.stepIndex; });
    try {
      await mirror(page);
      const file = frameName(sc.id, vp, n++, typeof what === 'string' ? what : what(step));
      await page.screenshot({ path: join(out, file) });
      rec.frames.push(file);
    } finally {
      await page.evaluate(() => { window.__game.hold = false; });
    }
  };
  const tap = async (sel: string) => { const l = page.locator(sel).first(); if (v.touch) await l.tap(); else await l.click(); };
  try {
    await page.goto(new URL(url, origin).toString());
    await page.waitForFunction(() => window.__game !== undefined && window.__game.status !== 'loading', undefined, { timeout: 15 * MIN, polling: 250 });
    if (sc.script.kind !== 'door') await page.waitForFunction(() => window.__game.status !== 'running' || window.__game.ready || window.__game.edit.on, undefined, { timeout: 15 * MIN, polling: 250 });
    rec.loadWallMs = Date.now() - t0;
    const st0 = await gameState(page);
    if (st0.status === 'error') throw new Error(`page error: ${st0.error}`);
    Object.assign(rec, await page.evaluate(() => ({ loadMs: window.__game.timing.loadMs, bodies: window.__game.bodies })));
    rec.help = await textOf(page, '#help');
    // Real pace (no fast-forward): effects timed in wall time (sparks, dust, the result card's entrance) then show as a player sees them.

    /** Fire shot k as the policy says; returns how, or null when nothing could be fired. */
    const fireNovice = async (k: number): Promise<{ shot: Shot | null; how: string } | null> => {
      if (k === 0 && (await page.locator('.kg-hud button.opener').count())) { await tap('.kg-hud button.opener'); return { shot: null, how: 'opener (HUD button)' }; }
      const pts = [noviceAim(k, 1), ...spiral()];
      for (const [x, y] of pts) {
        const a = await page.evaluate(([px, py]) => { const r = window.__game.aim(px!, py!); return r ? { shot: r.shot, ok: r.reachable } : null; }, [x, y]);
        if (a?.ok && (await page.evaluate((s) => window.__game.fire(s), a.shot))) return { shot: a.shot, how: `click at ${x.toFixed(2)},${y.toFixed(2)}` };
      }
      return null;
    };

    /**
     * Round 2's modes: fire as the level offers. Aftershock: Start with the dial as it loads. A plunger (Fuse & Fold,
     * Rube Lab): with `sweep`, the timeline swept toward the yard at the spacing shown; then the panel's Plunger, or
     * the plunger shot itself where no panel shows. Null when the level is none of these.
     */
    const fireMode = async (def: NonNullable<ReturnType<typeof levelById>>, policy: string): Promise<{ shot: Shot | null; how: string } | null> => {
      if (def.quake) return (await page.evaluate(() => window.__game.startQuake())) ? { shot: null, how: `Start (dial ${JSON.stringify(await page.evaluate(() => window.__game.dial()))})` } : null;
      if (def.rack[0] !== 'plunger') return null;
      const panel = '.kg-fuse.show';
      let how = '';
      if (policy === 'sweep') {
        const dir = fuseSweep(def);
        await tap(`${panel} button[data-dir="${dir}"]`);
        how = `sweep ${dir} at ${await textOf(page, `${panel} .sp b`)}, `;
        await shoot(`timeline swept ${dir}`, 300);
      }
      if (await page.locator(`${panel} button.plunger`).count()) { await tap(`${panel} button.plunger`); return { shot: null, how: `${how}Plunger (panel)` }; }
      if (await page.locator('.kg-hud button.opener').count()) { await tap('.kg-hud button.opener'); return { shot: null, how: `${how}Go (HUD button)` }; }
      return (await page.evaluate((x) => window.__game.fire(x), RUBE_GO)) ? { shot: RUBE_GO, how: `${how}plunger (no panel showed)` } : null;
    };

    /** A build phase open on load (Rube Lab, a retrofit, Mason's Trial): build the recorded build (`line`) or nothing, capture it, then Play. */
    const buildPhase = async (def: NonNullable<ReturnType<typeof levelById>>, policy: string, play: boolean) => {
      if (!(await page.evaluate(() => window.__game.edit.on))) return;
      const line = policy === 'line' ? buildLine(def) : null;
      if (line) {
        for (const a of line.actions as EditAction[]) {
          await page.evaluate((x) => { const e = window.__game.edit; if ('key' in x) e.key(x.key, x.shift); else e.ray(x.ray, x.at.origin, x.at.dir); }, a);
        }
        await shoot('built', 300);
      }
      rec.build = { built: line?.label ?? 'nothing', status: await page.evaluate(() => window.__game.edit.status()) };
      if (!play) return;
      // Play the build and stop before Go (Rube Lab's Run releases the ball at once): the harness fires the level's own verb next, as a player's first shot.
      await page.evaluate(() => window.__game.edit.play(false));
      await page.waitForFunction(() => !window.__game.edit.on && (window.__game.ready || window.__game.status !== 'running'), undefined, { timeout: 5 * MIN, polling: 250 });
      await shoot('after Play', 300);
    };

    /** The level in play rings a bell (Rube Lab, Wavefront's Lay): its first shot's sequence also captures the ring (RING_STEPS). */
    let bellLevel = false;
    const playShot = async (k: number, fire: () => Promise<{ shot: Shot | null; how: string } | null>, sequence: boolean) => {
      const before = await gameState(page);
      const how = await fire();
      if (!how) { rec.shots.push({ k, shot: null, how: 'nothing reachable to fire', firedAt: before.step, settledAt: null, simS: null, collapse: before.collapse, strokes: before.strokes, phase: before.phase }); return false; }
      await page.waitForFunction((s) => window.__game.strokes > s || window.__game.result !== null, before.strokes, { timeout: MIN, polling: 100 });
      const firedAt = (await gameState(page)).step;
      if (sequence) {
        // The sequence's frames, and on a bell level the ring's too once it rings, in step order.
        const due: Array<{ at: number; name: (step: number) => string }> = SEQUENCE_STEPS.map((ds) => ({ at: firedAt + ds, name: (step) => `shot ${k + 1} +${step - firedAt} steps` }));
        let rung = !bellLevel;
        while (due.length || !rung) {
          due.sort((a, b) => a.at - b.at);
          const next = due[0]?.at ?? Number.MAX_SAFE_INTEGER;
          const st = await (await page.waitForFunction(([t, watch]) => {
            const g = window.__game, bell = g.counts.bellStep ?? null;
            return g.stepIndex >= t || g.phase !== 'running' || (watch && bell !== null) ? { phase: g.phase, bell } : false;
          }, [next, !rung] as const, { timeout: 10 * MIN, polling: 'raf' })).jsonValue() as { phase: string; bell: number | null };
          if (!rung && st.bell !== null) {
            const rang = st.bell;
            rung = true;
            due.push(...RING_STEPS.map((ds) => ({ at: rang + ds, name: (step: number) => `bell rang +${step - rang} steps` })));
            continue;
          }
          if (st.phase !== 'running') break;
          await shoot(due.shift()!.name);
        }
      }
      await settled(page, before.strokes + 1, 15 * MIN);
      const after = await gameState(page);
      rec.shots.push({ k, shot: how.shot, how: how.how, firedAt, settledAt: after.step, simS: (after.step - firedAt) / STEP_HZ, collapse: after.collapse, strokes: after.strokes, phase: after.phase });
      return true;
    };

    const finish = async () => {
      let st = await gameState(page);
      if (!st.result && (await page.evaluate(() => window.__game.bank()))) {
        await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 5 * MIN, polling: 250 });
        st = await gameState(page);
      }
      if (st.result) {
        await page.waitForSelector('.kg-result.show', { timeout: 30_000 }).catch(() => {});
        await shoot('result', 1500);
        rec.result = { total: st.result.total, stars: st.result.stars, stamp: st.result.stamp, text: await textOf(page, '.kg-result') };
      } else rec.result = null;
    };

    const s = sc.script;
    if (s.kind === 'door') {
      await shoot('door', 800);
      rec.hud = await textOf(page, '.kg-door');
      if (await page.locator('.kg-door [data-act="how"]').count()) { await tap('.kg-door [data-act="how"]'); await shoot('how to play', 400); await tap('.kg-door [data-act="how"]'); }
      if (await page.locator('.kg-door [data-act="advanced"]').count()) { await tap('.kg-door [data-act="advanced"]'); await shoot('advanced settings', 400); await tap('.kg-door [data-act="advanced"]'); }
      if (await page.locator('.kg-door [data-act="trials"]').count()) { await tap('.kg-door [data-act="trials"]'); await shoot('trials open', 400); }
    } else if (s.kind === 'view') {
      await page.evaluate(() => window.__game.aim(0, -0.05));
      await shoot('aim view');
      rec.hud = await textOf(page, '#hud');
      if (sc.level) await buildPhase(levelById(sc.level)!, 'novice', false);
    } else if (s.kind === 'play') {
      const def = levelById(sc.level!)!;
      // A level whose recorded line is a build (Rube Lab, a retrofit) builds it, then plays its own verb.
      const line = s.policy === 'line' && !buildLine(def) ? lineOf(def) : null;
      if (!line) await page.evaluate(() => window.__game.aim(0, -0.05));
      await shoot('aim view');
      rec.hud = await textOf(page, '#hud');
      await buildPhase(def, s.policy, true);
      bellLevel = def.objective.kind === 'bell';
      const moded = !!def.quake || def.rack[0] === 'plunger';
      const hud0 = v.touch ? await hudBoxes(page) : null;
      for (let k = 0; k < s.shots; k++) {
        const fire = line ? async () => ((await page.evaluate((x) => window.__game.fire(x), line[k]!)) ? { shot: line[k]!, how: 'recorded line' } : null) : moded ? () => fireMode(def, s.policy) : () => fireNovice(k);
        if (!(await playShot(k, fire, k === 0))) break;
        if (k === 0 && hud0) {
          const hud1 = (await gameState(page)).result ? null : await hudBoxes(page);
          rec.hudShare = { before: hud0.share, after: hud1?.share ?? null, same: hud1 ? JSON.stringify([hud0.st, hud0.tray]) === JSON.stringify([hud1.st, hud1.tray]) : null, dock: hud0.dock };
        }
        await shoot(`shot ${k + 1} settled`);
        if ((await gameState(page)).result) break;
      }
      rec.hud = await textOf(page, '#hud');
      rec.goals = await page.evaluate(() => window.__game.goals);
      await finish();
      if (s.undo) {
        const t = Date.now();
        const ok = await page.evaluate(() => window.__game.undo());
        await settled(page, 0, 5 * MIN);
        const u = await page.evaluate(() => window.__game.undone);
        rec.undo = { ok, mode: u?.mode ?? '', ms: u?.ms ?? Date.now() - t };
        await shoot('after undo', 500);
      }
      if (s.retry) {
        const t = Date.now();
        await page.evaluate(() => window.__game.retry());
        await settled(page, 0, 5 * MIN);
        rec.retryWallMs = Date.now() - t;
        await shoot('after retry', 500);
      }
    } else if (s.kind === 'freeze') {
      await page.evaluate(() => window.__game.aim(0, -0.05));
      await shoot('aim view');
      const before = await gameState(page);
      const first = await fireNovice(0);
      if (!first) throw new Error('nothing to fire');
      await page.waitForFunction((s0) => window.__game.strokes > s0, before.strokes, { timeout: MIN, polling: 100 });
      const firedAt = (await gameState(page)).step;
      await page.waitForFunction((t) => window.__game.stepIndex >= t || window.__game.phase !== 'running', firedAt + 30, { timeout: 10 * MIN, polling: 50 });
      const frozen = await page.evaluate(() => window.__game.freeze(true));
      const frozeAt = (await gameState(page)).step;
      await shoot('frozen mid-shot', 300);
      rec.hud = await textOf(page, '#hud');
      const second = await fireNovice(1);
      await shoot('fired into the frozen world', 300);
      const resumed = !(await gameState(page)).frozen;
      rec.freeze = { frozeAt: frozeAt - firedAt, frozen, firedWhileFrozen: !!second, resumed };
      if (!resumed) await page.evaluate(() => window.__game.freeze(false));
      await settled(page, before.strokes + 1, 15 * MIN);
      const after = await gameState(page);
      rec.shots.push({ k: 0, shot: first.shot, how: first.how, firedAt, settledAt: after.step, simS: (after.step - firedAt) / STEP_HZ, collapse: after.collapse, strokes: after.strokes, phase: after.phase });
      await shoot('settled');
      await finish();
    } else if (s.kind === 'duel') {
      await shoot('table');
      for (let k = 0; k < s.turns; k++) {
        await page.waitForFunction(() => window.__game.status !== 'running' || window.__game.result !== null || (window.__game.ready && window.__game.phase !== 'running' && !window.__game.view.turning), undefined, { timeout: 5 * MIN, polling: 250 });
        if ((await gameState(page)).result) break;
        // The hand-over card (PT5): the next player taps it before they can aim; a tap never fires.
        if (await page.evaluate(() => window.__game.handoff)) {
          await shoot(`turn ${k + 1} hand-over`);
          await tap('.duel-handoff');
          await page.waitForFunction(() => !window.__game.handoff, undefined, { timeout: MIN, polling: 100 });
        }
        await page.evaluate(() => window.__game.aim(0, -0.05));
        await shoot(`turn ${k + 1} aim`);
        if (!(await playShot(k, () => fireNovice(k + 1), k === 0))) break;
        await shoot(`turn ${k + 1} settled`);
      }
      rec.duel = await page.evaluate(() => window.__game.duel);
      rec.hud = await textOf(page, '#hud');
      await finish();
    }
    rec.counts = await page.evaluate(() => window.__game.counts);
    rec.pace = await page.evaluate(() => window.__game.pace);
  } catch (e) {
    rec.status = /Timeout/.test(String(e)) ? 'timeout' : 'error';
    rec.problem = e instanceof Error ? e.message.split('\n')[0] : String(e);
    try { await shoot('at the problem'); } catch { /* the page may be gone */ }
  } finally {
    rec.wallMs = Date.now() - t0;
    await context.close();
  }
  return rec;
}

/** A contact sheet of a run's frames with their names under them, drawn by the browser itself (no image library). */
async function contactSheet(browser: Browser, out: string, rec: RunRecord): Promise<string | undefined> {
  if (!rec.frames.length) return undefined;
  const v = VIEWPORTS[rec.viewport], g = sheetGrid(rec.frames.length, v.width, v.height);
  const cells = rec.frames.map((f) => `<figure><img src="data:image/png;base64,${readFileSync(join(out, f)).toString('base64')}"><figcaption>${f.replace(/\.png$/, '')}</figcaption></figure>`).join('');
  const page = await browser.newPage({ viewport: { width: g.cols * (g.cellW + 8) + 8, height: 200 } });
  await page.setContent(`<style>body{margin:0;padding:4px;background:#111;color:#ddd;font:12px system-ui;display:grid;grid-template-columns:repeat(${g.cols},${g.cellW}px);gap:8px}figure{margin:0}img{width:${g.cellW}px;height:${g.cellH}px;display:block}figcaption{padding:2px 0}</style><h3 style="grid-column:1/-1;margin:4px 0">${rec.title} · ${rec.viewport}</h3>${cells}`);
  const file = `sheet-${rec.scenario}-${rec.viewport}.png`;
  await page.screenshot({ path: join(out, file), fullPage: true });
  await page.close();
  return file;
}

async function main() {
  const o = args(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const jobs = agentPlan().map((sc) => (o.look ? { ...sc, search: withLook(sc.search, o.look) } : sc)).flatMap((sc) => sc.viewports.filter((vp) => !o.viewport || vp === o.viewport).map((vp) => ({ sc, vp }))).filter((j) => !o.only || o.only.test(`${j.sc.id}-${j.vp}`));
  const server = await createServer({ configFile: fileURLToPath(new URL('../../../game/vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!.replace('127.0.0.1', 'localhost');
  const reportFile = join(o.out, 'report.json');
  const records: RunRecord[] = [];
  let next = 0;
  const worker = async () => {
    const browser = await chromium.launch({ args: platform() === 'linux' ? WEBGPU_ARGS : ['--enable-unsafe-webgpu'] });
    try {
      while (next < jobs.length) {
        const { sc, vp } = jobs[next++]!;
        const rec = await runOne(browser, origin, sc, vp, o.out, o.engine ?? sc.engine ?? 'rapier');
        rec.sheet = await contactSheet(browser, o.out, rec).catch(() => undefined);
        records.push(rec);
        writeFileSync(reportFile, JSON.stringify(records, null, 1));
        const shots = rec.shots.map((s) => `${s.simS?.toFixed(1) ?? '-'}s`).join(' ');
        console.log(`${rec.status.padEnd(7)} ${`${sc.id} ${vp}`.padEnd(32)} load ${(rec.loadWallMs / 1000).toFixed(1)}s, shots [${shots}], ${rec.result ? `${rec.result.stars}* ${rec.result.total}` : 'no result'}, ${rec.frames.length} frames, ${rec.errors.length} errors, ${(rec.wallMs / 1000).toFixed(0)}s${rec.problem ? ` (${rec.problem})` : ''}`);
      }
    } finally { await browser.close(); }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.workers) }, worker));
  await server.close();
  console.log(`${records.filter((r) => r.status === 'ok').length} of ${records.length} runs ok; report ${reportFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
