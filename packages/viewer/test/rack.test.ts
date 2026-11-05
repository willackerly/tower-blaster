// The rack in the viewer (keystone.rack, a file's rules.rack; roadmap G3): under Keystone's
// rules the viewer plays a level, or a scenario as one, with the rack the URL gives instead
// of its own, checked as the game page checks it (@tb/game rackOf), kept through the URL and
// a scene file, and dropped when another scene is picked; on the page the rack's weapons fire
// (a grenade, then a firework that splits into 12 stars), and a replay lands where the live
// session did. Rapier, so the page test is quick.
import { describe, expect, it } from 'vitest';
import { BIG_LEVELS, scenarioLevel, type Shot, writeShots } from '@tb/keystone';
import { levelChoice, levelOf, pageLevels, parseSceneFile, parseViewerConfig, proposeScene, sceneFile, toSearch } from '../src/index.ts';
import { browser, useViewer } from './e2e-harness.ts';
import { aimAtNearest, openRules, ready } from './keystone-page.ts';

useViewer();

const MINUTES = 60_000;
const S3 = '?scenario=S3&param.W=10&param.H=5&rules=keystone&engine=rapier';

describe('keystone.rack in the viewer', () => {
  it('on a built-in level\'s page, the opening level plays the link\'s rack and the rest of its series their own (as the game page)', () => {
    // Until 2026-11-05 the page rebuilt the series from the built-in defs, so ?level=B3&keystone.rack=w-grenadexl played
    // B3's own rack and refused the XL shot (the M5 pacing probe's B3 cases).
    const c = parseViewerConfig('?level=B3&rules=keystone&keystone.rack=w-grenadexl&keystone.iterations=20');
    const p = pageLevels(c)!;
    expect(p.levels.map((l) => l.id)).toEqual(BIG_LEVELS.map((l) => l.id));
    expect(p.levels[p.start]!.id).toBe('B3');
    expect(p.levels[p.start]).toEqual(levelOf(c));
    expect(p.levels[p.start]!.rack).toEqual(['w-grenadexl']);
    for (const [i, l] of p.levels.entries()) if (i !== p.start) expect(l.rack, l.id).toEqual(BIG_LEVELS[i]!.rack);
    // The rule overrides reach every level of the series.
    expect(p.levels.map((l) => l.physics?.iterations)).toEqual(BIG_LEVELS.map(() => 20));
    expect(pageLevels({ ...c, rack: null })!.levels[p.start]!.rack).toEqual(BIG_LEVELS[p.start]!.rack);
    // A scenario as a level is the only one.
    const s = parseViewerConfig(`${S3}&keystone.rack=w-grenade`);
    expect(pageLevels(s)).toEqual({ levels: [levelOf(s)], start: 0 });
  });
  it('replaces the level\'s rack under the rules, round-trips through the URL and a file, and drops on another scene', () => {
    const c = parseViewerConfig(`${S3}&keystone.rack=w-firework,w-grenade,p-bowlingball`);
    expect(c.rack).toEqual(['w-firework', 'w-grenade', 'p-bowlingball']);
    expect(levelOf(c)!.rack).toEqual(c.rack);
    expect(levelOf({ ...c, rack: null })!.rack).toEqual(scenarioLevel('S3', { W: 10, H: 5 }, 1).rack);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(new URLSearchParams(toSearch(c)).get('keystone.rack')).toBe('w-firework,w-grenade,p-bowlingball');
    const file = sceneFile(c, 'rack', null);
    expect(file.rules).toMatchObject({ mode: 'keystone', rack: c.rack });
    // (A file writes the scenario's default params out too, so the configs differ there.)
    const back = parseSceneFile(JSON.stringify(file)).config;
    expect(back.rack).toEqual(c.rack);
    expect(levelOf(back)!.rack).toEqual(c.rack);
    expect(sceneFile(parseViewerConfig(S3), 'x', null).rules).not.toHaveProperty('rack');
    expect(parseViewerConfig(S3).rack).toBeNull();
    // A line is checked against the rack it is played with.
    const g: Shot = { ammo: 'p-bowlingball', az: 0, y: 8, yaw: 900, pitch: 300, power: 50 };
    expect(parseViewerConfig(`${S3}&keystone.rack=p-bowlingball&keystone.shots=${writeShots([g])}`).shots).toEqual([g]);
    expect(() => parseViewerConfig(`${S3}&keystone.shots=${writeShots([g])}`)).toThrow(/fires 1 p-bowlingball but S3's rack holds 0/);
    // The same scene keeps its rack; another keeps nothing of it (a level, or the sandbox).
    const rules = { rules: 'keystone' as const, feel: c.feel };
    const same = proposeScene(c, 'S3', { W: 10, H: 5 }, 1, 1, 1, undefined, undefined, rules);
    expect(same.ok && same.config.rack).toEqual(c.rack);
    for (const r of [proposeScene(c, levelChoice('L1'), {}, 1, 1, 1, undefined, undefined, rules), proposeScene(c, 'S3', { W: 12, H: 5 }, 1, 1, 1, undefined, undefined, rules), proposeScene(c, 'S3', { W: 10, H: 5 }, 1, 1, 1, undefined, undefined, { rules: 'sandbox', feel: c.feel })]) {
      expect(r.ok && r.config.rack).toBeNull();
    }
  });

  it('refuses a rack outside the rules, an empty or long one, a name that is no item, a weapon the level lacks', () => {
    expect(() => parseViewerConfig('?level=L1&keystone.rack=marble')).toThrow(/keystone.rack applies to rules=keystone/);
    expect(() => parseViewerConfig(`${S3}&keystone.rack=`)).toThrow(/keystone.rack must list 1 to 8 items \(and up to 24 pulls\)/);
    expect(() => parseViewerConfig(`${S3}&keystone.rack=${Array(9).fill('marble').join(',')}`)).toThrow(/1 to 8 items/);
    expect(() => parseViewerConfig(`${S3}&keystone.rack=bomb`)).toThrow(/keystone.rack: bomb is not one of/);
    expect(() => parseViewerConfig(`${S3}&keystone.rack=w-nuke`)).toThrow(/has no weapons.nuke/);
    const file = sceneFile(parseViewerConfig(S3), 'x', null) as unknown as { rules: Record<string, unknown> };
    expect(() => parseSceneFile(JSON.stringify({ ...file, rules: { ...file.rules, rack: 'marble' } }))).toThrow(/rules.rack must be an array/);
  });

  it('on the page: a grenade then a firework from the URL rack, 13 blasts, and a replay that matches (Rapier)', async (ctx) => {
    if (!browser) return ctx.skip();
    const { shot } = aimAtNearest(scenarioLevel('S3', { W: 10, H: 5 }, 1), 180, 1, 3);
    const line: Shot[] = [{ ...shot, ammo: 'w-grenade' } as Shot, { ammo: 'w-firework', az: 0, y: 8, yaw: 900, pitch: 450, power: 0 }];
    const o = await openRules(`/${S3}&keystone.rack=w-grenade,w-firework&keystone.shots=${writeShots(line)}&offscreen=1`, undefined, 5 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await ready(page);
    // The line plays on load; with the rack empty the level ends.
    await page.waitForFunction(() => window.__viewer.game!.result !== null, undefined, { timeout: 5 * MINUTES, polling: 250 });
    const g = await page.evaluate(() => { const v = window.__viewer.game!; return { fired: v.counts.fired, blast: v.counts.blast, strokes: v.strokes }; });
    expect(g).toEqual({ fired: 2, blast: 1 + 12, strokes: 2 });
    const live = await page.evaluate(() => window.__viewer.game!.state());
    expect(await page.evaluate((s) => window.__viewer.game!.replay(s), line)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});
