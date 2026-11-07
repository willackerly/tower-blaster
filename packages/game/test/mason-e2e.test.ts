// Mason's Trial on the game page (M8, docs/game/masons-trial.md), Rapier in
// headless Chromium: MT4 opens building (no rack, nothing fires); the 3-star
// author build placed through the build tool's rays and keys gives exactly the
// level the build tool gives in Node; Play loads it and runs the test straight
// away (world 0 drawn on the loaded driver, the judge on an engine of its own):
// the trial goes running -> judging -> done, and the card shows how many of the
// 64 worlds it stood in and what it spent. Retry keeps the build and waits for
// Test (the HUD's button, key F); a second Test runs the same judge. That the
// judge's counts are right is keystone-lab's mason-ref and mason-trial tests;
// here the judge runs on Rapier (the page's engine), so only the flow is checked.
import { describe, expect, it } from 'vitest';
import { BuildSession, compileLevel, findLevel, type Hit, type LevelDef, MASON_WORLDS } from '@tb/keystone';
import type { Page } from 'playwright';
import { gamePage } from './page.ts';
import { BUILD_HELP, MASON_HELP } from '../src/ui.ts';

const game = gamePage();
const PHONES = [
  ['upright', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }],
  ['sideways', { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }],
] as const;
type Box = { x: number; y: number; w: number; h: number };
const inside = (b: Box, vw: number, vh: number) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= vw + 0.5 && b.y + b.h <= vh + 0.5;
const apart = (a: Box, b: Box) => a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;
/** An element's box (null when not shown), and whether it is on top at its centre. */
const shown = (page: Page, sel: string) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return null;
  const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { box: { x: r.left, y: r.top, w: r.width, h: r.height }, top: !!hit && (hit === e || e.contains(hit)), vw: innerWidth, vh: innerHeight };
}, sel);
const MINUTES = 60_000;
type V3 = [number, number, number];

/** A hit on the top face of body `b` at (x, z) h (keystone-lab rube.ts's `top`). */
function top(s: BuildSession, b: number, x: number, z: number): Hit {
  const body = s.compiled().scene.bodies[b]!, half = body.shape.kind === 'box' ? body.shape.half[1] : body.shape.radius;
  return { body: b, point: [x * s.h, body.pos[1] + half, z * s.h], normal: [0, 1, 0], t: 0 };
}

/**
 * MT4's 3-star author build (keystone-lab mason-solutions.ts): a plank pointed half a cell in from the table's edge and
 * slid two half-cells out (]), so it reaches past the edge, then three cubes on its back end.
 */
const T3: { item: string; on: number; x: number; slide: number }[] = [
  { item: 'plank', on: 0, x: -0.5, slide: 2 }, { item: 'cube', on: 1, x: -1.5, slide: 0 }, { item: 'cube', on: 1, x: -0.5, slide: 0 }, { item: 'cube', on: 2, x: -1.5, slide: 0 },
];

/** The build in Node, through the build tool, and the world points the page's rays aim at (straight down onto each top face). */
function t3Build(def: LevelDef): { def: LevelDef; spent: number; points: V3[] } {
  const s = new BuildSession(def), points: V3[] = [];
  for (const st of T3) {
    const hit = top(s, st.on, st.x, 0);
    points.push(hit.point as V3);
    expect(s.place(s.ghost(hit, { item: st.item as never, yaw: 0, tip: 0, slide: st.slide })), st.item).toBe(true);
  }
  return { def: s.def(), spent: s.spent(), points };
}

/** Pick the item (its number key in the build panel), slide it out (] per half-cell), and click where a ray straight down onto `p` lands. */
async function placeAt(page: Page, key: string, slide: number, p: V3) {
  expect(await page.evaluate((k) => window.__game.edit.key(k), key)).toBe(true);
  for (let i = 0; i < slide; i++) expect(await page.evaluate(() => window.__game.edit.key(']'))).toBe(true);
  const o: V3 = [p[0], p[1] + 20, p[2]], d: V3 = [0, -1, 0];
  for (const kind of ['move', 'down', 'up'] as const) await page.evaluate(([k, a, b]) => window.__game.edit.ray(k, a, b), [kind, o, d] as const);
}

const trialDone = (page: Page) => page.waitForFunction(() => window.__game.trial?.state === 'done' || window.__game.trial?.state === 'error', undefined, { timeout: 8 * MINUTES, polling: 250 });

describe("Mason's Trial on the game page", () => {
  it('MT4: build the 3-star counterweight, Play tests it in 64 worlds, the card says how it stood; Retry keeps it, Test runs again', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=MT4&engine=rapier&offscreen=1&progress=off&door=0', undefined, { viewport: { width: 1024, height: 640 } });
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const authored = findLevel('MT4')!, want = t3Build(authored), wantC = compileLevel(want.def);
    // The hint line says what the pointer and keys do while building, and nothing about firing.
    const hint = () => page.evaluate(() => (document.querySelector('#help') as HTMLElement).innerText.trim());
    expect(await hint()).toBe(BUILD_HELP.replace(/<[^>]+>/g, ''));
    // Building: no rack, so nothing fires; no trial yet.
    expect(await page.evaluate(() => ({ trial: window.__game.trial, building: document.body.classList.contains('kg-building') }))).toEqual({ trial: null, building: true });
    expect(await page.evaluate(() => window.__game.fire({ ammo: 'cannonball', az: 0, y: 4, yaw: 0, pitch: 0, power: 50 } as never))).toBe(false);

    // The build through the panel's tool: the number keys follow the build tool's item list (catalog order).
    const items = new BuildSession(authored).items.map((i) => i.name as string), keyOf = (item: string) => String(items.indexOf(item) + 1);
    for (let i = 0; i < T3.length; i++) await placeAt(page, keyOf(T3[i]!.item), T3[i]!.slide, want.points[i]!);
    const def = await page.evaluate(() => window.__game.edit.def()) as LevelDef;
    expect(def.parts.slice(authored.parts.length)).toEqual(want.def.parts.slice(authored.parts.length));
    expect(compileLevel(def).hash).toBe(wantC.hash);
    expect(await page.evaluate(() => window.__game.edit.status())).toMatch(new RegExp(`${10 - want.spent} of 10 left`));

    // Play: the level as built, and its test starts at once (world 0 on the page, the judge beside it).
    await page.locator('.kg-build button[data-a=play]').click();
    await page.waitForFunction(() => window.__game.trial !== null, undefined, { timeout: 20_000, polling: 100 }).catch(async () => {
      console.log('DEBUG', await page.evaluate(() => ({ banner: document.querySelector('.kg-banner')?.textContent, ready: window.__game.ready, status: window.__game.status, result: window.__game.result, on: window.__game.edit.on, level: window.__game.level, hud: document.querySelector('.kg-hud')?.textContent })), errors);
    });
    expect(await page.evaluate(() => ({ played: window.__game.edit.played, level: window.__game.level, of: window.__game.trial!.of }))).toEqual({ played: wantC.hash, level: 'MT4', of: MASON_WORLDS });
    // While the test runs: no Build button (B cannot pull the level out from under it), and the Mason hint line.
    expect(await page.locator('.kg-build').isVisible()).toBe(false);
    expect(await page.evaluate(() => window.__game.edit.enter())).toBe(false);
    expect(await hint()).toBe(MASON_HELP.replace(/<[^>]+>/g, ''));
    const seen = new Set<string>();
    await page.exposeFunction('__masonState', (s: string) => { seen.add(s); });
    await page.evaluate(() => { const tick = () => { const s = window.__game.trial?.state; if (s) void (window as unknown as { __masonState(s: string): void }).__masonState(s); if (s !== 'done' && s !== 'error') requestAnimationFrame(tick); }; tick(); });
    await page.evaluate(() => { window.__game.fast = true; });
    await trialDone(page);
    const first = await page.evaluate(() => ({ trial: window.__game.trial, worlds: window.__game.result?.worlds ?? null, card: document.querySelector('.kg-result')?.textContent ?? '' }));
    expect(first.trial!.error).toBe('');
    expect(first.trial!.state).toBe('done');
    expect(seen.has('judging') || seen.has('running')).toBe(true);
    const passes = first.trial!.passes!;
    console.log(`MT4 T3 on Rapier: ${passes}/${MASON_WORLDS}, world 0 ${first.trial!.hero ? 'stood' : 'fell'}; states ${[...seen].join(' > ')}; card: ${first.card.replace(/\s+/g, ' ').trim()}`);
    expect(passes).toBeGreaterThanOrEqual(0);
    expect(passes).toBeLessThanOrEqual(MASON_WORLDS);
    expect(first.card).toContain(`stood in ${passes} of ${MASON_WORLDS} worlds`);
    expect(first.card).toContain(`spent ${want.spent} of 10`);
    expect(first.worlds).not.toBeNull();

    // Retry keeps the build and waits for Test; the HUD's button runs the same judge again.
    await page.evaluate(() => window.__game.retry());
    await page.waitForFunction(() => window.__game.result === null && window.__game.trial === null && !window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.bodies)).toBe(wantC.meta.n);
    const test = page.locator('.kg-hud button[data-act=opener]');
    await test.waitFor({ state: 'visible', timeout: MINUTES });
    expect(await test.textContent()).toContain('Test the build');
    await test.click();
    await page.waitForFunction(() => window.__game.trial !== null, undefined, { timeout: MINUTES, polling: 100 });
    await trialDone(page);
    expect(await page.evaluate(() => window.__game.trial)).toMatchObject({ state: 'done', passes });
    expect(errors).toEqual([]);
    await page.close();
  }, 20 * MINUTES);

  for (const [name, phone] of PHONES) it(`on a phone ${name}: Slide is a tap in the docked Build panel; Test and the card sit inside the screen, clear of the strip and Menu`, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=MT4&engine=rapier&offscreen=1&progress=off&door=0', 2 * MINUTES, phone);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on && document.querySelector('.kg-hud .st') !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
    // The plank held: the panel offers Slide out, and a tap on it slides the plank (the panel scrolls it into view if need be).
    const items = new BuildSession(findLevel('MT4')!).items.map((i) => i.name as string);
    await page.locator(`.kg-build button[data-a=item][data-item=plank]`).tap();
    expect(items).toContain('plank');
    await page.locator('.kg-build button[data-a=slide][data-d="1"]').tap();
    await page.waitForFunction(() => /slid \+1/.test(window.__game.edit.status()), undefined, { timeout: 10_000, polling: 50 });
    const out = await shown(page, '.kg-build button[data-a=slide][data-d="1"]');
    expect(out && inside(out.box, out.vw, out.vh), 'Slide out inside the screen').toBe(true);

    // Play with nothing built: the test runs at once, and the card (the weight falls) sits inside the screen.
    await page.locator('.kg-build button[data-a=play]').tap();
    await page.evaluate(() => { window.__game.fast = true; });
    await trialDone(page);
    expect(await page.evaluate(() => window.__game.trial)).toMatchObject({ state: 'done', hero: false });
    // The card comes up after the score's tally.
    await page.waitForSelector('.kg-result.show', { timeout: MINUTES });
    const card = await shown(page, '.kg-result');
    expect(card, 'the card shows').not.toBeNull();
    expect(inside(card!.box, card!.vw, card!.vh), 'the card inside the screen').toBe(true);

    // Retry: the Test button, inside the screen, on top, clear of the status strip (or rail) and Menu.
    await page.evaluate(() => window.__game.retry());
    await page.waitForFunction(() => window.__game.result === null && !window.__game.edit.on && document.querySelector('.kg-hud button[data-act=opener]') !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const [test, st, menu, build] = [await shown(page, '.kg-hud button[data-act=opener]'), await shown(page, '.kg-hud .st'), await shown(page, '.kg-menu'), await shown(page, '.kg-build')];
    console.log(`MT4 ${name}: Test ${JSON.stringify(test?.box)}, strip/rail ${JSON.stringify(st?.box)}, menu ${JSON.stringify(menu?.box)}, Build ${JSON.stringify(build?.box)}`);
    expect(test && inside(test.box, test.vw, test.vh), 'Test inside the screen').toBe(true);
    expect(test!.top, 'Test on top').toBe(true);
    for (const [what, other] of [['strip or rail', st], ['Menu', menu], ['Build button', build]] as const) if (other) expect(apart(test!.box, other.box), `Test clear of the ${what}`).toBe(true);
    await page.locator('.kg-hud button[data-act=opener]').tap();
    await page.waitForFunction(() => window.__game.trial !== null, undefined, { timeout: MINUTES, polling: 100 });
    expect(errors).toEqual([]);
    await page.close();
  }, 4 * MINUTES);
});
