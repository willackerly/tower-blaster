// The par and dev panel under Keystone's rules, in headless Chromium on Rapier:
// Play line plays the par line to runSession's result, a link's line plays on
// load, Replay check says whether a fresh engine agrees (and says so when it
// does not), and Keep as line puts the attempt in the link
// (docs/design/viewer-superset.md, step D).
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { RapierEngine } from '@tb/adapter-rapier';
import type { BodyDesc } from '@tb/engine-api';
import { driverOptions, fmtLeverage } from '@tb/game';
import { compileLevel, DEFAULT_GOLD, L1, L2, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';
import { browser, useViewer } from './e2e-harness.ts';
import { openRules, ready } from './keystone-page.ts';

useViewer();

const MINUTES = 60_000;
const BIG = { width: 1280, height: 1000 };
const c = compileLevel(L1);
const par = L1.solutions!.par as Shot[];
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };

async function headless(shots: Shot[]) {
  const r = await runSession(new RapierEngine(), c, shots, driverOptions('rapier'));
  return { step: r.steps, phase: r.session.phase, strokes: shots.length, heritageBroken: 0, hash: snapshotHash(r.snapshot) };
}
const out = (page: Page) => page.locator('#dev .out');
const done = (page: Page) => page.waitForFunction(() => window.__viewer.game!.result !== null, undefined, { timeout: 5 * MINUTES, polling: 250 });
const idle = (page: Page) => page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#dev button[name=play]')!.disabled, undefined, { timeout: 5 * MINUTES, polling: 250 });

describe('the par and dev panel', () => {
  it('plays the par line to runSession\'s result, checks the replay, and keeps the attempt as the link\'s line', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await openRules('/?level=L1&rules=keystone&engine=rapier&offscreen=1', BIG);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const panel = page.locator('#dev');
    expect(await panel.locator('.f').first().innerText()).toBe(`L1 · par ${L1.par} · gold ${fmtLeverage(L1.lGold ?? DEFAULT_GOLD)}`);
    expect(await panel.locator('.line').innerText()).toBe(`par line, 1 shot: ${writeShots(par)}`);
    expect(await panel.locator('button[name=check]').isDisabled()).toBe(true);

    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await panel.locator('button[name=play]').click();
    await done(page);
    await idle(page);
    const h = await headless(par);
    expect(await page.evaluate(() => window.__viewer.game!.state())).toEqual(h);
    expect(await out(page).innerText()).toMatch(/^played 1 shot: .*★/);
    expect(await panel.locator('table.shots tr').count()).toBe(2);
    expect(await panel.locator('.score').innerText()).toMatch(/★/);

    await panel.locator('button[name=check]').click();
    await idle(page);
    expect(await out(page).innerText()).toBe(`replay matches: step ${h.step}, cleared, hash ${h.hash}`);
    expect(await out(page).getAttribute('class')).toBe('out');

    await panel.locator('button[name=keep]').click();
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('keystone.shots'))).toBe(writeShots(par));
    expect(await panel.locator('.line').innerText()).toMatch(/^line from the link, 1 shot/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('plays a link\'s line on load, and a level change drops it', async (ctx) => {
    if (!browser) return ctx.skip();
    const line = [miss, ...par];
    const o = await openRules(`/?level=L1&rules=keystone&engine=rapier&offscreen=1&keystone.shots=${writeShots(line)}`, BIG);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await done(page);
    await idle(page);
    expect(await page.evaluate(() => window.__viewer.game!.state())).toEqual(await headless(line));
    expect(await page.locator('#dev table.shots tr').count()).toBe(3);
    expect(await out(page).innerText()).toMatch(/^played 2 shots/);

    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__viewer.game!.level === 'L2', undefined, { timeout: MINUTES });
    await ready(page);
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('keystone.shots'))).toBeNull();
    expect(await page.locator('#dev .line').innerText()).toBe(`par line, ${L2.solutions!.par!.length} shot${L2.solutions!.par!.length === 1 ? '' : 's'}: ${writeShots(L2.solutions!.par!)}`);
    expect(await page.locator('#dev .muted').innerText()).toBe('no shots fired yet');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('says when a fresh engine does not reach the live state', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await openRules('/?level=L1&rules=keystone&engine=rapier&offscreen=1', BIG);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await page.locator('#dev button[name=play]').click();
    await done(page);
    await idle(page);
    // An input hook set after the attempt is seen by the replay only: the two must differ, and the panel says so.
    const block: BodyDesc = { ...c.scene.bodies[0]!, pos: [3, 6, 3], linVel: [0, 0, 0], angVel: [0, 0, 0] };
    await page.evaluate((body) => {
      window.__viewer.inputHook = () => { let calls = 0; return (_s, step) => (++calls === 10 ? [{ step: step + 1, kind: 'spawn', body }] : []); };
    }, block);
    await page.locator('#dev button[name=check]').click();
    await idle(page);
    expect(await out(page).innerText()).toMatch(/^replay differs: live step \d+, cleared, hash \w+; replay step \d+, \w+, hash \w+$/);
    expect(await out(page).getAttribute('class')).toBe('out warn');
    expect(errors).toEqual([]);
    await page.close();
  });
});
