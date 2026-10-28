// One parser for both pages (docs/design/viewer-superset.md, step F): every
// game page URL, with rules=keystone added, opens the same game in the viewer:
// level, engine, pace juice, look and its knobs, line and offscreen as the game
// page reads them (@tb/game parseGameParams), and a value the game page
// refuses the viewer refuses too.
import { describe, expect, it } from 'vitest';
import { parseGameParams } from '@tb/game';
import { L1, L4, type Shot, writeShots } from '@tb/keystone';
import { parseRealOptions } from '@tb/render';
import { keystoneEngine, levelChoice, parseViewerConfig, proposeScene, toSearch } from '../src/index.ts';

const GAME_URLS = [
  '',
  '?level=L2',
  '?level=l4&engine=rapier',
  '?engine=gpu',
  '?engine=avbd-gpu&level=L5',
  '?level=L3&keystone.hitstop=1&keystone.slowmo=1',
  '?keystone.slowmo=0',
  '?look=candy',
  '?look=real&real.sunElevation=6&real.visibility=12&real.env=hall',
  `?level=L1&keystone.shots=${writeShots(L1.solutions!.par as Shot[])}`,
  `?level=L4&engine=rapier&keystone.shots=${writeShots(L4.solutions!.par as Shot[])}&offscreen=1`,
];

/** The viewer's URL for a game URL: the same keys, under the rules (the viewer needs a level named). */
const viewerUrl = (game: string) => {
  const q = new URLSearchParams(game);
  if (!q.has('level')) q.set('level', 'L1');
  q.set('rules', 'keystone');
  return `?${q}`;
};

describe('a game URL in the viewer', () => {
  it('reads every game key as the game page does', () => {
    for (const u of GAME_URLS) {
      const g = parseGameParams(new URLSearchParams(u)), v = parseViewerConfig(viewerUrl(u));
      expect({ level: v.level, engine: keystoneEngine(v.engine), feel: v.feel, look: v.look, real: v.real, shots: v.shots, offscreen: v.offscreen }, u).toEqual({
        level: g.level.id, engine: g.engine, feel: g.feel, look: g.look, real: parseRealOptions(new URLSearchParams(u)), shots: g.shots, offscreen: g.offscreen,
      });
      // And what the viewer writes back reads the same in both pages.
      const back = toSearch(v);
      expect(parseGameParams(new URLSearchParams(back)), u).toEqual(g);
    }
  });

  it('refuses what the game page refuses', () => {
    for (const u of ['?level=L99', '?engine=physx', '?keystone.hitstop=yes', '?look=neon', '?keystone.shots=', '?level=L1&keystone.shots=drop.0.0', '?keystone.shots=marble.0']) {
      expect(() => parseGameParams(new URLSearchParams(u)), u).toThrow();
      expect(() => parseViewerConfig(viewerUrl(u)), u).toThrow();
    }
  });

  it('gives a level the panel switches to the rules the game\'s look when the sandbox had its default, and keeps a look chosen', () => {
    const to = (u: string, rules: 'sandbox' | 'keystone') => {
      const c = parseViewerConfig(u), p = proposeScene(c, levelChoice('L1'), {}, 1, 1, 1, undefined, undefined, { rules, feel: c.feel });
      return p.ok ? p.config.look : p.error;
    };
    expect(to('?level=L1', 'keystone')).toBe('hazy');
    expect(to('?level=L1&look=real', 'keystone')).toBe('real');
    expect(to('?level=L1&rules=keystone', 'sandbox')).toBe('candy');
    expect(to('?level=L1&rules=keystone&look=candy', 'sandbox')).toBe('candy');
    expect(to('?level=L1&rules=keystone&look=real', 'sandbox')).toBe('real');
  });
});
