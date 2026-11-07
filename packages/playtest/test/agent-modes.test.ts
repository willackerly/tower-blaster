// Round 2's moves for the new modes (modes.ts): a Rube Lab level's recorded build, as the keys and pointer
// rays the harness sends the page, builds exactly the level the lab's build program gives when it goes through
// the page's own edit controller (game edit.ts, DOM-free); Fuse & Fold's sweep points at each site's yard.
import { describe, expect, it } from 'vitest';
import { FUSE_LEVELS, RETROFIT_LEVELS, RUBE_LEVELS } from '@tb/keystone';
import { EditController } from '../../game/src/edit.ts';
import { build } from '../../keystone-lab/src/rube.ts';
import { RETROFIT_SOLUTIONS, retrofitBuild, retrofitSteps } from '../../keystone-lab/src/retrofit-solutions.ts';
import { RUBE_SOLUTIONS } from '../../keystone-lab/src/rube-solutions.ts';
import { buildActions, buildLine, fuseSweep, retrofitLine, rubeLine, yawPresses } from '../src/agent/modes.ts';

describe('Rube Lab builds as page actions', () => {
  it('turns the short way round in 15 deg presses', () => {
    expect(yawPresses(0, -45)).toEqual({ key: 'q', n: 3 });
    expect(yawPresses(0, 90)).toEqual({ key: 'e', n: 6 });
    expect(yawPresses(315, 300)).toEqual({ key: 'q', n: 1 });
    expect(yawPresses(0, 0)).toEqual({ key: 'e', n: 0 });
  });

  it.each(RUBE_LEVELS.map((l) => [l.id, l] as const))('%s: every recorded build, sent as keys and rays through the edit controller, builds what the lab builds', (_, def) => {
    for (const b of RUBE_SOLUTIONS[def.id]!) {
      const want = build(def, b.steps);
      expect(want, b.label).not.toBeNull();
      const ed = new EditController(def);
      for (const a of buildActions(def, b.steps)) {
        if ('key' in a) expect(ed.key(a.key, { shift: a.shift }), `${b.label}: key ${a.key}`).toBe(true);
        else if (a.ray === 'move') ed.move(a.at);
        else if (a.ray === 'down') ed.down(a.at);
        else expect(ed.up(a.at), `${b.label}: ${ed.message}`).toBe(true);
      }
      expect(JSON.stringify(ed.play()), b.label).toBe(JSON.stringify(want!.def));
    }
    expect(rubeLine(def)?.label).toBe(RUBE_SOLUTIONS[def.id]![0]!.label);
  });
});

describe('Aftershock retrofits\' bracings as page actions', () => {
  it.each(RETROFIT_LEVELS.map((l) => [l.id, l] as const))('%s: every recorded bracing, sent as keys and rays through the edit controller, builds what the retrofit search builds', (_, def) => {
    for (const b of RETROFIT_SOLUTIONS[def.id]!) {
      const want = retrofitBuild(def, b), ed = new EditController(def);
      for (const a of buildActions(def, retrofitSteps(def, b))) {
        if ('key' in a) expect(ed.key(a.key, { shift: a.shift }), `${b.label}: key ${a.key}`).toBe(true);
        else if (a.ray === 'move') ed.move(a.at);
        else if (a.ray === 'down') ed.down(a.at);
        else expect(ed.up(a.at), `${b.label}: ${ed.message}`).toBe(true);
      }
      expect(JSON.stringify(ed.play()), b.label).toBe(JSON.stringify(want.def));
    }
    expect(retrofitLine(def)?.label).toBe(RETROFIT_SOLUTIONS[def.id]![0]!.label);
    expect(buildLine(def)?.label).toBe(RETROFIT_SOLUTIONS[def.id]![0]!.label);
  });
});

describe('Fuse & Fold sweep', () => {
  it('sweeps toward each shipped site’s first yard', () => {
    expect(FUSE_LEVELS.map((l) => [l.id, fuseSweep(l)])).toEqual([['F1', 'W'], ['F2', 'N'], ['F3', 'W'], ['F4', 'W'], ['F5', 'W']]);
  });
});
