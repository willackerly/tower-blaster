// Roadmap G4 probe (docs/game/spectacle-mode.md, section 9): how a 10k-block
// level's shot ends and paces on a real GPU, so settle v2's allowance and the
// valve are set on measurements, not guesses. Real GPU only (TB_CHANNEL=chrome,
// Metal on the M5 Max): on SwiftShader a 10k step takes seconds.
//
// Each case loads a 10k automatic level under rules=keystone (outcome scoring,
// so settle v2 by default), fires one shot and records, for every live step,
// its wall time and nMoving (structure bodies faster than QUIET_SPEED or
// spinning faster than QUIET_SPIN: what v2 counts), until the shot settles or
// reaches v2's cap (1,800 steps). The offscreen cases run at fast-forward
// (pacing changes when steps run, never which, so the trace is the same); the
// rendered case runs at normal speed and also records frame times. With
// TB_PROBE_OUT=<dir> each case writes <dir>/<case>.json and appends its
// summary line to <dir>/summary.txt; the line is also written to stdout.
// The Keystone grenade barely moves a 10k scene (collapse 0 at 74b57c2), so
// the heavy cases fire @tb/weapons' cluster (6 bomblets, one grenade of energy
// since 2026-11-02, 0.8 before) from a rack of just that; the rendered cluster cases compare the
// valve's budget at 14 ms (the default since E7), 16.7 ms and off; one more
// rendered case saves a screenshot every 2 s, for reviewing the camera.
// The frames cases are the pipelining audit's A/B (docs/pipelining.md): the
// same rendered cluster shots with keystone.frames=half and auto, against the
// default (every frame), on a 120 Hz display (TB_HEADED=1: headless Chrome
// runs rAF at 60 Hz, which is never decimated). TB_PROBE_CASES=<regex> runs
// only the cases whose name matches (e.g. 'cluster-40-rendered').
// The fx cases (PT2, docs/render/damage-effects.md) time the frames of B1's and B3's pre-aimed openers
// (solutions.ace's first shot) under keystone.fx=damage and classic, FX_RUNS runs each, interleaved so a
// thermal drift hits both styles alike; afterAll writes one 'fx cost' line per level and style with the
// frame p50/p95 pooled over the runs and the sparks spawned (TB_PROBE_CASES='^fx-').
// On macOS it refuses to start in Low Power Mode (power.ts; E7 round 2 lost a
// run to it), unless TB_PROBE_ALLOW_LOW_POWER=1, and each summary line records
// the power state. A summary's costMs is the step's own GPU time (what the
// valve reads); stepMs is the loop's wall time per step, about 1 ms whenever
// the valve holds steps back, so compare costMs across cases.
// Not a performance result unless run on the physical GPU (CLAUDE.md).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limitsHit } from '@tb/engine-api';
import { aimAt, CHORUS_LINES, compileLevel, launcherPos, type LaunchItem, levelById, type LevelDef, readShots, scenarioLevel, settleAllowance, type Shot } from '@tb/keystone';
import { browser, useViewer } from './e2e-harness.ts';
import { openRules, ready } from './keystone-page.ts';
import { powerState } from './power.ts';

useViewer();

const MINUTES = 60_000;
const OUT = process.env.TB_PROBE_OUT;
/** TB_PROBE_SMALL=1: the same cases on tiny scenes, to check the probe itself on SwiftShader. */
const SMALL = process.env.TB_PROBE_SMALL === '1';
const RUN = !!process.env.TB_CHANNEL || SMALL;

/** A scenario (as an automatic level), or a named level (`level`: B3's 10k stone city). */
type Scene = { scenario: string; params: Record<string, number>; search: string; level?: string };
const CITY: Scene = SMALL ? { scenario: 'S4', params: { N: 120 }, search: 'scenario=S4&param.N=120' } : { scenario: 'S4', params: { N: 10_000 }, search: 'scenario=S4&param.N=10000' };
const BLOCKS: Scene = SMALL
  ? { scenario: 'S14', params: { towers: 4, W: 2, D: 2, H: 6 }, search: 'scenario=S14&param.towers=4&param.W=2&param.D=2&param.H=6' }
  : { scenario: 'S14', params: { towers: 25, W: 4, D: 4, H: 25 }, search: 'scenario=S14&param.towers=25&param.W=4&param.D=4&param.H=25' };
/** B3 Ten Thousand (small: the small city). */
const B3_CITY: Scene = SMALL ? CITY : { scenario: 'S4', params: {}, search: 'level=B3', level: 'B3' };

/** A shot of `ammo` at full power from azimuth 0 at the nearest structure body between yLo and yHi h up (any height when none is). */
function shotAt(def: LevelDef, ammo: LaunchItem, yLo: number, yHi: number): Shot {
  const c = compileLevel(def), h = c.frame.unit, y = 4 * def.launcher.y, from = launcherPos(c.frame, 0, y);
  let best = -1, dist = Infinity;
  for (let i = 0; i < c.meta.n; i++) {
    const by = c.meta.home[3 * i + 1]! / h;
    if (by < yLo || by > yHi) continue;
    const d = Math.hypot(c.meta.home[3 * i]! - from[0], c.meta.home[3 * i + 2]! - from[2]);
    if (d < dist) { dist = d; best = i; }
  }
  if (best < 0) return shotAt(def, ammo, 0, Infinity);
  const target: [number, number, number] = [c.meta.home[3 * best]!, c.meta.home[3 * best + 1]!, c.meta.home[3 * best + 2]!];
  return aimAt(c.frame, ammo, { az: 0, y, power: 100 }, target, { dt: c.scene.dt }).shot;
}

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };

/** budgetMs: keystone.budget (absent: the default); a w- case other than w-grenade has a rack of just its weapon. */
/** opener: fire the level's own pre-aimed opener (solutions.ace's first shot) with its own rack; fx: keystone.fx. */
/** line: fire this recorded shot (writeShots text) instead of aiming one. */
interface Case { name: string; scene: Scene; ammo: 'cannonball' | 'w-grenade' | 'w-cluster' | 'w-grenadem' | 'w-grenadexl' | 'w-bomb'; iterations: 40 | 20; rendered: boolean; budgetMs?: number; frames?: 'half' | 'auto'; screenshots?: boolean; opener?: boolean; fx?: 'damage' | 'classic'; line?: string }
const FX_RUNS = 5;
/** PT2's cost: B1 and B3 openers rendered, damage vs classic, runs interleaved (B1 small: the same level, 1k blocks, plain). */
const FX_CASES: Case[] = ['B1', 'B3'].flatMap((id) => Array.from({ length: FX_RUNS }, (_, r) => (['damage', 'classic'] as const).map((fx): Case => (
  { name: `fx-${id.toLowerCase()}-${fx}-${r + 1}`, scene: { scenario: '', params: {}, search: `level=${id}`, level: id }, ammo: 'w-bomb', iterations: 40, rendered: true, opener: true, fx })))).flat();
const ALL: Case[] = [
  { name: 'city-cannonball-40', scene: CITY, ammo: 'cannonball', iterations: 40, rendered: false },
  { name: 'blocks-grenade-40', scene: BLOCKS, ammo: 'w-grenade', iterations: 40, rendered: false },
  { name: 'city-cannonball-20', scene: CITY, ammo: 'cannonball', iterations: 20, rendered: false },
  { name: 'blocks-grenade-20', scene: BLOCKS, ammo: 'w-grenade', iterations: 20, rendered: false },
  { name: 'blocks-grenade-40-rendered', scene: BLOCKS, ammo: 'w-grenade', iterations: 40, rendered: true },
  { name: 'blocks-cluster-40', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: false },
  { name: 'blocks-cluster-40-rendered', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: true },
  { name: 'blocks-cluster-40-rendered-b16.7', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: true, budgetMs: 16.7 },
  { name: 'blocks-cluster-40-rendered-b0', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: true, budgetMs: 0 },
  { name: 'city-cluster-40-rendered', scene: CITY, ammo: 'w-cluster', iterations: 40, rendered: true },
  { name: 'blocks-cluster-40-rendered-half', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: true, frames: 'half' },
  { name: 'blocks-cluster-40-rendered-auto', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: true, frames: 'auto' },
  { name: 'city-cluster-40-rendered-half', scene: CITY, ammo: 'w-cluster', iterations: 40, rendered: true, frames: 'half' },
  { name: 'city-cluster-40-rendered-auto', scene: CITY, ammo: 'w-cluster', iterations: 40, rendered: true, frames: 'auto' },
  // E7 round 2: drawing fewer frames at the old whole-step budget, where it frees the most GPU for physics.
  { name: 'blocks-cluster-40-rendered-auto-b16.7', scene: BLOCKS, ammo: 'w-cluster', iterations: 40, rendered: true, frames: 'auto', budgetMs: 16.7 },
  { name: 'city-cluster-40-rendered-b16.7', scene: CITY, ammo: 'w-cluster', iterations: 40, rendered: true, budgetMs: 16.7 },
  { name: 'city-cluster-40-rendered-auto-b16.7', scene: CITY, ammo: 'w-cluster', iterations: 40, rendered: true, frames: 'auto', budgetMs: 16.7 },
  // For reviewing the follow camera (G4.3): a screenshot every 2 s into TB_PROBE_OUT. Its timings are not used (screenshots stall frames).
  { name: 'city-cluster-40-screenshots', scene: CITY, ammo: 'w-cluster', iterations: 40, rendered: true, screenshots: true },
  // Grenade sizes (2026-11-02): the XL (16 grenades, radius 12.6 cubes) wakes far more of a 10k city than anything before it;
  // M (one grenade, B3's own bomb) is its baseline. Step p95 offscreen, frame p99 rendered.
  { name: 'b3-grenadexl-40', scene: B3_CITY, ammo: 'w-grenadexl', iterations: 40, rendered: false },
  { name: 'b3-grenadexl-40-rendered', scene: B3_CITY, ammo: 'w-grenadexl', iterations: 40, rendered: true },
  { name: 'b3-grenadem-40-rendered', scene: B3_CITY, ammo: 'w-grenadem', iterations: 40, rendered: true },
  ...FX_CASES,
  // M9 Chorus (docs/game/chorus.md): CH1's 64 worlds of 45 blocks (2.9k bodies plus 64 balls) in one solve, its
  // obvious shot, which splits the worlds; rendered for frame times (the roadmap's "real time on the M5"), and
  // offscreen for step cost. The viewer has no Chorus panel; the game page's adds a 2D redraw 6 times a second.
  { name: 'ch1-chorus-rendered', scene: { scenario: '', params: {}, search: 'level=CH1', level: 'CH1' }, ammo: 'cannonball', iterations: 40, rendered: true, line: CHORUS_LINES.CH1!.obvious },
  { name: 'ch1-chorus', scene: { scenario: '', params: {}, search: 'level=CH1', level: 'CH1' }, ammo: 'cannonball', iterations: 40, rendered: false, line: CHORUS_LINES.CH1!.obvious },
];
// Rendered frames take up to a second on SwiftShader: the rendered case is a real GPU's only.
const ONLY = process.env.TB_PROBE_CASES ? new RegExp(process.env.TB_PROBE_CASES) : null;
// Small: B1's (1k blocks) first fx pair too, offscreen at fast-forward, to check the fx plumbing on SwiftShader
// (a rendered B1 shot there does not settle in 20 min; no frame times, and they would mean nothing).
const CASES = (SMALL ? ALL.filter((k) => k.iterations === 40 && !k.rendered).concat(ALL.filter((k) => /^fx-b1-\w+-1$/.test(k.name)).map((k) => ({ ...k, rendered: false }))) : ALL).filter((k) => !ONLY || ONLY.test(k.name));
/** The fx cases' frames and sparks, pooled per level and style for afterAll. */
const fxPool = new Map<string, { frameMs: number[]; spawned: number[]; runs: number }>();

describe.runIf(RUN)('G4 probe: a 10k level\'s shot on a real GPU', () => {
  const power = powerState();
  beforeAll(() => {
    if (power?.lowPower && process.env.TB_PROBE_ALLOW_LOW_POWER !== '1') {
      throw new Error(`Low Power Mode is on (pmset ${JSON.stringify(power.raw)}): step costs are not the machine's. Turn it off, or set TB_PROBE_ALLOW_LOW_POWER=1 to measure it anyway.`);
    }
  });
  afterAll(() => {
    for (const [key, v] of fxPool) {
      const line = `fx cost ${JSON.stringify({ case: key, runs: v.runs, frames: v.frameMs.length, frameMs: { p50: q(v.frameMs, 0.5), p95: q(v.frameMs, 0.95), p99: q(v.frameMs, 0.99) }, sparksPerRun: v.spawned, power })}\n`;
      process.stdout.write(line);
      if (OUT) { mkdirSync(OUT, { recursive: true }); appendFileSync(join(OUT, 'summary.txt'), line); }
    }
  });
  for (const k of CASES) {
    it(k.name, async (ctx) => {
      if (!browser) return ctx.skip();
      // The page's level, with the URL's rack (the compiled frame carries the cluster's shell for aiming).
      const base = k.scene.level ? levelById(k.scene.level)! : scenarioLevel(k.scene.scenario, k.scene.params, 1);
      const own = !k.opener && k.ammo.startsWith('w-') && k.ammo !== 'w-grenade';
      const def: LevelDef = own ? { ...base, rack: [k.ammo] } : base;
      const opener = k.opener ? base.solutions?.ace?.[0] ?? base.solutions?.par?.[0] : undefined;
      if (k.opener && !opener) throw new Error(`${base.id} has no recorded opener`);
      const shot = k.line ? readShots(k.line)[0]! : opener ?? shotAt(def, k.ammo, 3, 6);
      const search = `/?${k.scene.search}&rules=keystone${k.iterations !== 40 ? `&keystone.iterations=${k.iterations}` : ''}${own ? `&keystone.rack=${k.ammo}` : ''}${k.budgetMs !== undefined ? `&keystone.budget=${k.budgetMs}` : ''}${k.frames ? `&keystone.frames=${k.frames}` : ''}${k.fx ? `&keystone.fx=${k.fx}` : ''}${SMALL ? '&keystone.presettle=30' : ''}${k.rendered ? '' : '&offscreen=1'}`;
      const o = await openRules(search, k.rendered && !SMALL ? { width: 1440, height: 900 } : undefined, 10 * MINUTES);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page, 10 * MINUTES);
      await page.evaluate((fast) => { window.__viewer.game!.fast = fast; }, !k.rendered);
      expect(await page.evaluate((s) => window.__viewer.game!.fire(s), shot)).toBe(true);
      // Until the shot settles, the pace every 250 ms: the valve's time scale, the sim speed reached, the HUD tag.
      const pace: Array<{ t: number; timeScale: number; speed: number; tag: string; tailSkip: boolean; costMs: number }> = [];
      const t0 = Date.now();
      while (!(await page.evaluate(() => { const g = window.__viewer.game!; return g.strokes === 1 && g.phase !== 'running'; }))) {
        if (Date.now() - t0 > 20 * MINUTES) throw new Error('the shot did not settle in 20 min');
        pace.push({ t: Date.now() - t0, ...(await page.evaluate(() => window.__viewer.game!.pace)) });
        if (k.screenshots && OUT && pace.length % 8 === 1) {
          mkdirSync(OUT, { recursive: true });
          await page.screenshot({ path: join(OUT, `${k.name}-${String(Math.round((Date.now() - t0) / 1000)).padStart(3, '0')}s.png`) });
        }
        await page.waitForTimeout(250);
      }
      const wallMs = Date.now() - t0;
      const t = await page.evaluate(() => { const g = window.__viewer.game!; return { ...g.timing, collapse: g.collapse, bodies: g.bodies, draws: g.draws }; });
      const health = await page.evaluate(() => window.__viewer.health);
      // Sparks spawned since the level loaded (the renderer resets its effects on load): the style's own trace.
      const effects = k.fx ? await page.evaluate(() => window.__viewer.game!.effects()) : null;
      const n = compileLevel(def).meta.n, allowance = settleAllowance(n);
      // The first step from which nMoving stays at or under x for good: when a v2 with that allowance could have ended.
      const quietFrom = (x: number) => { let i = t.moving.length; while (i > 0 && t.moving[i - 1]! <= x) i--; return i; };
      const every60 = t.moving.filter((_, i) => i % 60 === 0);
      const summary = {
        case: k.name, search, steps: t.stepMs.length, wallMs, loadMs: Math.round(t.loadMs), collapse: t.collapse, allowance, draws: t.draws,
        stepMs: { median: q(t.stepMs, 0.5), p95: q(t.stepMs, 0.95), max: Math.max(...t.stepMs) },
        costMs: { median: q(t.costMs.filter(Number.isFinite), 0.5), p95: q(t.costMs.filter(Number.isFinite), 0.95) },
        power,
        frameMs: k.rendered ? { n: t.frameMs.length, median: q(t.frameMs, 0.5), p95: q(t.frameMs, 0.95), p99: q(t.frameMs, 0.99), max: Math.max(...t.frameMs) } : null,
        pace: { speedMin: Math.min(...pace.map((p) => p.speed)), speedMedian: q(pace.map((p) => p.speed), 0.5), tagged: pace.filter((p) => p.tag).length, samples: pace.length, tailSkipAt: pace.find((p) => p.tailSkip)?.t ?? null },
        moving: { peak: Math.max(...t.moving), last: t.moving.at(-1), every60, quietFromAllowance: quietFrom(allowance), quietFrom1pct: quietFrom(n / 100), quietFrom0: quietFrom(0) },
        limits: health ? limitsHit(health) : null,
        effects,
      };
      if (k.fx) {
        const key = k.name.replace(/-\d+$/, ''), v = fxPool.get(key) ?? { frameMs: [], spawned: [], runs: 0 };
        v.frameMs.push(...t.frameMs); v.spawned.push(effects!.spawned); v.runs++;
        fxPool.set(key, v);
      }
      const line = `G4 probe ${JSON.stringify(summary)}\n`;
      process.stdout.write(line);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        appendFileSync(join(OUT, 'summary.txt'), line);
        writeFileSync(join(OUT, `${k.name}.json`), JSON.stringify({ summary, stepMs: t.stepMs, costMs: t.costMs, moving: t.moving, frameMs: t.frameMs, pace }));
      }
      expect(errors).toEqual([]);
      await page.close();
    }, 40 * MINUTES);
  }
});
