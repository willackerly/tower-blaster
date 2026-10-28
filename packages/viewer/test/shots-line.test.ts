// A line of shots in the viewer (keystone.shots, a file's rules.shots): parsed,
// checked against the level's rack, written, saved, and kept by the panel only
// on the level it was made on (docs/design/viewer-superset.md, step D).
import { describe, expect, it } from 'vitest';
import { L1, L3, type Shot, writeShots } from '@tb/keystone';
import { CUSTOM_LEVEL, levelChoice, parseSceneFile, parseViewerConfig, proposeScene, sceneFile, toSearch, withCustomLevel } from '../src/index.ts';

const par = L1.solutions!.par as Shot[];
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const line = [miss, ...par];
const url = `?level=L1&rules=keystone&engine=rapier&keystone.shots=${writeShots(line)}`;

describe('a line of shots in the viewer', () => {
  it('parses keystone.shots under the rules and round-trips it through the URL and a file', () => {
    const c = parseViewerConfig(url);
    expect(c.shots).toEqual(line);
    expect(parseViewerConfig('?level=L1&rules=keystone').shots).toBeNull();
    expect(toSearch(c)).toBe(`?level=L1&engine=rapier&rules=keystone&keystone.shots=${writeShots(line)}`);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    const file = sceneFile(c, 'repro', null);
    expect(file.rules).toEqual({ mode: 'keystone', hitstop: false, slowmo: false, shots: line });
    expect(parseSceneFile(JSON.stringify(file)).config).toEqual(c);
    // No line: no key in the file.
    expect(sceneFile(parseViewerConfig('?level=L1&rules=keystone'), 'x', null).rules).toEqual({ mode: 'keystone', hitstop: false, slowmo: false });
  });

  it('refuses a line outside the rules, an empty one, a bad shot, or one the rack cannot fire', () => {
    expect(() => parseViewerConfig(`?level=L1&keystone.shots=${writeShots(par)}`)).toThrow(/keystone.shots applies to rules=keystone/);
    expect(() => parseViewerConfig('?level=L1&rules=keystone&keystone.shots=')).toThrow(/keystone.shots is empty/);
    expect(() => parseViewerConfig('?level=L1&rules=keystone&keystone.shots=marble.0.4')).toThrow(/shot 1 .*marble takes 5 fields/);
    // L1's rack: two cannonballs, two marbles.
    expect(() => parseViewerConfig(`?level=L1&rules=keystone&keystone.shots=${writeShots([miss, miss, miss])}`)).toThrow(/fires 3 marble but L1's rack holds 2/);
    expect(() => parseViewerConfig(`?level=L1&rules=keystone&keystone.shots=drop.0.0`)).toThrow(/fires 1 drop but L1's rack holds 0/);
  });

  it('refuses file shots that are not shots, naming where', () => {
    const file = sceneFile(parseViewerConfig(url), 'repro', null) as unknown as { rules: { shots: unknown } };
    const load = (shots: unknown) => parseSceneFile(JSON.stringify({ ...file, rules: { ...file.rules, shots } }));
    expect(() => load([])).toThrow(/rules.shots must be a non-empty array/);
    expect(() => load([{ ammo: 'bomb' }])).toThrow(/rules.shots\[0\].ammo must be one of/);
    expect(() => load([{ ...miss, power: 101 }])).toThrow(/rules.shots: shot 1 .*power/);
    expect(() => load([par[0], { ...miss, spin: 3 }])).toThrow(/rules.shots\[1\]: unknown key spin/);
  });

  it('is kept by the panel on the same level and dropped on another level or the sandbox', () => {
    const c = parseViewerConfig(url);
    const rules = { rules: 'keystone' as const, feel: c.feel };
    const again = proposeScene(c, levelChoice('L1'), {}, 1, 1, 1, undefined, undefined, rules);
    expect(again.ok && again.config.shots).toEqual(line);
    const other = proposeScene(c, levelChoice('L3'), {}, 1, 1, 1, undefined, undefined, rules);
    expect(other.ok && other.config.shots).toBeNull();
    const sandbox = proposeScene(c, levelChoice('L1'), {}, 1, 1, 1, undefined, undefined, { rules: 'sandbox', feel: c.feel });
    expect(sandbox.ok && sandbox.config).toMatchObject({ rules: 'sandbox', shots: null });
    // A level of your own keeps its line when it is picked again, not when a built-in one with its id is.
    const mine = { ...withCustomLevel(parseViewerConfig('?level=L3&rules=keystone'), { ...L3, id: 'mine', rack: ['marble', 'marble'] }), shots: [miss] };
    const same = proposeScene(mine, CUSTOM_LEVEL, {}, 1, 1, 1, undefined, undefined, rules);
    expect(same.ok && same.config.shots).toEqual([miss]);
  });
});
