// The trials' racks reach their structures (trial-levels.ts): every launch item
// in a trial's rack can be aimed onto some face a competent player picks (16
// lines, as the drafts' test), and at least 60% of all their launch shots can.
// The drafts' bar is 80%; a trial is unrated and its structure was built for
// another purpose, and the tall ones (S1, S2: 15 and 20 m) keep faces above
// what a shot from 1 m up can reach (the cannonball, 12 m/s, worst). Racks
// lead with marbles, grenades (flown as marbles) or the big levels' bombs and
// rams. Raising the launch point raises these; the floor only holds them.
import { describe, expect, it } from 'vitest';
import { aimAt, compileLevel, type LaunchShot, TRIAL_LEVELS } from '@tb/keystone';
import { competentIntents, intentShot, REACH, surfaceTarget } from '../src/index.ts';

describe('trial racks', () => {
  it.each(TRIAL_LEVELS.map((d) => d.id))('%s: every launch item reaches some target, and 60% of competent launch shots reach theirs', (id) => {
    const c = compileLevel(TRIAL_LEVELS.find((d) => d.id === id)!);
    let launched = 0, reached = 0;
    const hit = new Map<string, number>();
    for (const line of competentIntents(c, 16, 1)) for (const it of line) {
      if (it.item === 'drop' || it.item === 'pull') continue;
      const shot = intentShot(c, it, 1) as LaunchShot;
      launched++;
      const ok = aimAt(c.frame, shot.ammo, { az: shot.az, y: shot.y, power: shot.power }, surfaceTarget(c, it).point).error <= REACH * c.frame.unit;
      if (ok) reached++;
      hit.set(it.item, (hit.get(it.item) ?? 0) + (ok ? 1 : 0));
    }
    expect(launched).toBeGreaterThan(0);
    for (const [item, n] of hit) expect(n, item).toBeGreaterThan(0);
    expect(reached / launched).toBeGreaterThanOrEqual(0.6);
  });
});
