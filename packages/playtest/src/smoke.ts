// pnpm playtest:smoke: check the deployed playtest from outside, as a tester would
// (roadmap G8): the form without a pass, the password getting a pass, and the pass
// opening build.json, which must name the expected commit, and the game page with
// its isolation headers. Then, in headless Chromium, the game itself: the front
// door, Play, the level loading behind it, and the pre-aimed first shot firing,
// with no page errors. CI runs it after every deploy; it works from any machine,
// no Cloudflare login needed.
//
//   PLAYTEST_PASSWORD=...  pnpm playtest:smoke [commit]   (default commit: HEAD)
//   PLAYTEST_URL=https://...  (default https://tower-blaster-playtest.pages.dev)
//   PLAYTEST_SMOKE_BROWSER=0  (HTTP checks only)   PLAYTEST_SMOKE_SHOT=file.png  (a screenshot after the shot)
//
// It signs in as SMOKE_EMAIL, so that address shows up in the KV namespace;
// pnpm playtest:testers leaves it out.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECT } from './deploy.ts';
import { COOKIE, cookieOf, GATE_PATH } from './gate.ts';

export const SMOKE_EMAIL = 'ci-smoke@tower-blaster.invalid';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A pass from the gate for SMOKE_EMAIL, or what went wrong getting one. */
export async function enter(base: string, password: string, fetchFn: Fetch = fetch): Promise<{ pass: string } | { problem: string }> {
  const body = new URLSearchParams({ email: SMOKE_EMAIL, password, next: '/build.json' });
  const entry = await fetchFn(`${base}${GATE_PATH}`, { method: 'POST', body, redirect: 'manual' });
  if (entry.status !== 303) return { problem: `POST ${GATE_PATH}: ${entry.status}, expected 303 (wrong password, or the gate is misconfigured)` };
  const setCookie = entry.headers.getSetCookie?.().join(', ') || entry.headers.get('set-cookie');
  const pass = cookieOf(setCookie, COOKIE);
  return pass ? { pass } : { problem: `POST ${GATE_PATH}: 303 but no ${COOKIE} cookie` };
}

/** What is wrong with the playtest at `base` (empty when it passes): gate, pass, build.json's commit, then the game page and its headers. */
export async function smoke(base: string, password: string, commit: string, fetchFn: Fetch = fetch): Promise<string[]> {
  const form = await fetchFn(`${base}/`, { redirect: 'manual' });
  if (form.status !== 401) return [`GET / without a pass: ${form.status}, expected 401 (the gate form)`];

  const entered = await enter(base, password, fetchFn);
  if ('problem' in entered) return [entered.problem];
  const pass = entered.pass;

  const build = await fetchFn(`${base}/build.json`, { headers: { cookie: `${COOKIE}=${pass}` }, redirect: 'manual' });
  if (build.status !== 200) return [`GET /build.json with the pass: ${build.status}, expected 200`];
  const info = (await build.json()) as { commit?: string };
  if (info.commit !== commit) return [`build.json names ${info.commit}, expected ${commit}`];

  const page = await fetchFn(`${base}/`, { headers: { cookie: `${COOKIE}=${pass}` }, redirect: 'manual' });
  if (page.status !== 200 || !(await page.text()).includes('id="door"')) return [`GET / with the pass: ${page.status}, expected 200 and the game page`];
  // Without cross-origin isolation the page loses SharedArrayBuffer (the audio worklet's ring).
  const coop = page.headers.get('cross-origin-opener-policy'), coep = page.headers.get('cross-origin-embedder-policy');
  if (coop !== 'same-origin' || coep !== 'require-corp') return [`GET / with the pass: isolation headers COOP ${coop}, COEP ${coep}; expected same-origin, require-corp (the build's _headers)`];
  return [];
}


/**
 * The game in headless Chromium behind the gate: the front door, Play, the level loads, the pre-aimed
 * first shot fires, no page errors. On Rapier, offscreen and without saving progress, so it takes the same
 * time on any runner (WebGPU on SwiftShader would take minutes) and leaves nothing behind; the GPU path is
 * the ci suite's job. Returns what went wrong, or [] when it passes.
 */
export async function smokeBrowser(base: string, pass: string, opts: { screenshot?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const timeout = opts.timeoutMs ?? 240_000;
  // The renderer still needs a WebGPU adapter (SwiftShader on a runner without a GPU).
  const { launchChromium, WEBGPU_ARGS } = await import('@tb/testkit');
  const { browser, close } = await launchChromium({ headless: true, args: process.platform === 'linux' ? WEBGPU_ARGS : ['--enable-unsafe-webgpu'] });
  const errors: string[] = [];
  let step = 'open the page';
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: COOKIE, value: pass, url: base }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/?engine=rapier&offscreen=1&progress=off`, { timeout });
    step = 'the front door';
    await page.waitForFunction(() => window.__door?.open === true && crossOriginIsolated, undefined, { timeout });
    if ((await page.locator('.kg-door .card').count()) < 3) return ['the front door: fewer than 3 level cards'];
    step = 'Play: the level loading';
    await page.locator('.kg-door .play').click();
    await page.waitForFunction(() => window.__game.ready, undefined, { timeout, polling: 250 });
    step = 'the pre-aimed first shot';
    await page.locator('.kg-hud button.opener').click();
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 60_000, polling: 100 });
    if (opts.screenshot) await page.screenshot({ path: opts.screenshot });
    return errors.length ? [`page errors: ${errors.join(' | ')}`] : [];
  } catch (e) {
    return [`in the browser, ${step}: ${e instanceof Error ? e.message.split('\n')[0] : e}${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}`];
  } finally {
    await close();
  }
}

async function main() {
  const password = process.env.PLAYTEST_PASSWORD;
  if (!password) throw new Error('set PLAYTEST_PASSWORD (the playtest password) for this run');
  const base = (process.env.PLAYTEST_URL ?? `https://${process.env.PLAYTEST_PROJECT ?? DEFAULT_PROJECT}.pages.dev`).replace(/\/$/, '');
  const commit = process.argv[2] ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // The production alias can lag the deploy by a few seconds, so a stale build.json is retried for a while.
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 12; attempt++) {
    problems = await smoke(base, password, commit);
    if (problems.length === 0) break;
    if (!problems[0]?.startsWith('build.json names')) break;
    console.log(`attempt ${attempt}: ${problems[0]}; retrying in 10 s`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (problems.length) throw new Error(`playtest smoke failed at ${base}: ${problems.join('; ')}`);
  console.log(`playtest smoke: gate 401, pass 303, build.json ${commit.slice(0, 7)}, game page isolated`);
  if (process.env.PLAYTEST_SMOKE_BROWSER !== '0') {
    const entered = await enter(base, password);
    if ('problem' in entered) throw new Error(`playtest smoke failed at ${base}: ${entered.problem}`);
    const seen = await smokeBrowser(base, entered.pass, { screenshot: process.env.PLAYTEST_SMOKE_SHOT || undefined });
    if (seen.length) throw new Error(`playtest smoke failed at ${base}: ${seen.join('; ')}`);
    console.log('playtest smoke: in the browser, the front door, Play, the level loaded, the first shot fired');
  }
  console.log(`playtest smoke passed at ${base}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
