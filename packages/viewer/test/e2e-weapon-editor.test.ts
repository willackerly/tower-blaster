// The weapon editor in the viewer (weapon-editor.ts; C12's verify: "editor round trips a WeaponSpec",
// "budget caps reject a spec that exceeds the device tier"). Headless Chromium, Rapier (the tier
// guessed mid): open the editor on the firework, edit a field and the name, apply; the URL's
// weapon.def decodes to exactly the edited spec, and firing it blasts with the edited radius. A
// spec pasted as JSON rebuilds the form; one over the tier cannot be applied, and a link that
// carries one is refused on fire.
import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@tb/engine-api';
import { FIREWORK, GRENADE_XL, writeWeapon } from '@tb/weapons';
import { decodeWeaponParam } from '../src/projectile.ts';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

const WIDE = { width: 1280, height: 860 };
const SCENE = '/?scenario=S1&param.F=2&param.H=3&engine=rapier&offscreen=1';
const field = (path: (string | number)[]) => `#weapon-editor [data-path='${JSON.stringify(path)}']`;

describe('the weapon editor', () => {
  it('round trips a spec: form edit, apply, the link\'s weapon.def is the edited spec, and it fires as edited', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open(`${SCENE}&proj.weapon=firework`, WIDE);
    if (await page.evaluate(() => window.__viewer.status) !== 'running') return ctx.skip();
    await page.evaluate(() => { (document.getElementById('controls') as HTMLDetailsElement).open = true; });
    await page.click('button[name=weaponEdit]');
    await page.waitForSelector('#weapon-editor:not([hidden])');
    expect(new URL(page.url()).searchParams.get('weapon.edit')).toBe('1');
    // The side view: the shell, 12 stars, a split and 12 blast spheres.
    expect(await page.locator('#weapon-editor .arc .track').count()).toBe(13);
    expect(await page.locator('#weapon-editor .arc .blast').count()).toBe(12);
    // The JSON beside the form is the spec's canonical text.
    expect(await page.inputValue('#weapon-editor textarea[name=json]')).toBe(writeWeapon(FIREWORK));
    // Edit a star's blast radius (select the star in the tree first) and the name.
    await page.click('#weapon-editor button.node[data-mun=star]');
    await page.fill(field(['children', 'star', 'rules', 0, 'do', 0, 'blast', 'radius']), '2.5');
    await page.fill(field(['name']), 'comet');
    const want = { ...FIREWORK, name: 'comet', children: { star: { ...FIREWORK.children!.star!, rules: [{ ...FIREWORK.children!.star!.rules[0]!, do: [{ blast: { radius: 2.5, impulse: 18.5, core: 0.2 } }, { remove: true as const }] }] } } };
    expect(JSON.parse(await page.inputValue('#weapon-editor textarea[name=json]'))).toEqual(JSON.parse(writeWeapon(want)));
    // An edit off the range shows the validator's message at the field, and Apply waits (back on the shell).
    await page.click('#weapon-editor button.node[data-mun=""]');
    await page.fill(field(['shell', 'density']), '-1');
    expect(await page.locator(`#weapon-editor .iss[data-for='${JSON.stringify(['shell', 'density'])}']`).textContent()).toMatch(/must be from/);
    expect(await page.isDisabled('#weapon-editor button[data-act=apply]')).toBe(true);
    await page.fill(field(['shell', 'density']), '4');
    await page.click('#weapon-editor button[data-act=apply]');
    const q = new URL(page.url()).searchParams;
    expect(q.get('proj.weapon')).toBe('comet');
    expect(decodeWeaponParam(q.get('weapon.def')!)).toEqual(want);
    // Fired, each star blows with the edited radius.
    await page.evaluate(() => window.__viewer.fire(0, 0.3));
    await page.waitForFunction(() => window.__viewer.inputs.filter((e) => e.kind === 'blast').length >= 12, undefined, { timeout: 60_000 });
    const blasts = (await page.evaluate(() => window.__viewer.inputs) as InputEvent[]).filter((e) => e.kind === 'blast');
    expect(blasts.every((e) => e.kind === 'blast' && e.blast.radius === 2.5)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('JSON pasted in rebuilds the form; one over the device tier cannot be applied, and a link carrying it is refused on fire', async (ctx) => {
    if (!browser) return ctx.skip();
    // weapon.edit=1 opens the editor on load.
    const { page, errors } = await open(`${SCENE}&weapon.edit=1`, WIDE);
    if (await page.evaluate(() => window.__viewer.status) !== 'running') return ctx.skip();
    await page.waitForSelector('#weapon-editor:not([hidden])');
    const big = { ...GRENADE_XL, name: 'big' };
    await page.fill('#weapon-editor textarea[name=json]', writeWeapon(big));
    expect(await page.inputValue(field(['name']))).toBe('big');
    // 16 grenades of energy: over the mid tier's 8 (Rapier's guess).
    expect(await page.locator('#weapon-editor .bud.over[data-k=grenades]').count()).toBe(1);
    expect(await page.isDisabled('#weapon-editor button[data-act=apply]')).toBe(true);
    expect(await page.textContent('#weapon-editor .apply-out')).toMatch(/over the mid tier's caps/);
    // Bad JSON says so and leaves the form be.
    await page.fill('#weapon-editor textarea[name=json]', '{ "version": 1,');
    expect(await page.textContent('#weapon-editor .json-out')).toMatch(/not JSON/);
    expect(await page.inputValue(field(['name']))).toBe('big');
    await page.close();

    // The XL by link on Rapier: refused, nothing spawned, the HUD says which tier fires it.
    const xl = await open(`${SCENE}&proj.weapon=grenadexl`, WIDE);
    await xl.page.evaluate(() => window.__viewer.fire(0, 0.3));
    await xl.page.waitForFunction(() => /not fired/.test(document.getElementById('hud')!.textContent ?? ''), undefined, { timeout: 10_000 });
    expect(await xl.page.evaluate(() => window.__viewer.inputs.length)).toBe(0);
    expect(await xl.page.textContent('#hud')).toMatch(/weapon\.tier=high fires it anyway/);
    await xl.page.close();
    // With weapon.tier=high it fires.
    const hi = await open(`${SCENE}&proj.weapon=grenadexl&weapon.tier=high`, WIDE);
    await hi.page.evaluate(() => window.__viewer.fire(0, 0.3));
    expect(await hi.page.evaluate(() => window.__viewer.inputs.filter((e) => e.kind === 'spawn').length)).toBe(1);
    expect([...errors, ...xl.errors, ...hi.errors]).toEqual([]);
    await hi.page.close();
  });
});
