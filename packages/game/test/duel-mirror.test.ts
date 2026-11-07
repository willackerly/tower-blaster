// PT22 (agent playtest round 2): both Siege Tables are the same to either side under a half turn about the vertical
// axis, so a click at one screen point from each side's turn view must aim the same shot turned half way round: the
// same yaw, pitch and power, the launcher 180 deg round the ring. If the bot's views were not images of each other,
// the novice bot would aim differently for Gold and Blue, and its win rates would measure the views, not the tables.
import { describe, expect, it } from 'vitest';
import { compileLevel, D1, D2, type DuelDef, duelLevel, type LaunchShot, type Player } from '@tb/keystone';
import type { Snapshot } from '@tb/engine-api';
import { rayThrough } from '@tb/render/camera';
import { launchHeight, pick, shotFor, SUBSTEPS } from '../src/aim.ts';
import { duelView, launcherAz } from '../src/duel-view.ts';
import { clickPoints, seeded } from '../src/duel-bot.ts';

/** The half turn of an azimuth in the shot's 0.5 deg units. */
const turned = (az: number) => (az + 360) % 720;

/** The table as compiled, before any physics: the views and the aim alone, not a solver's settle (which creeps a few mm). */
function startOf(c: ReturnType<typeof compileLevel>): Snapshot {
  const b = c.scene.bodies, n = b.length, s: Snapshot = { count: n, pos: new Float64Array(3 * n), rot: new Float64Array(4 * n), linVel: new Float64Array(3 * n), angVel: new Float64Array(3 * n), awake: new Uint8Array(n) };
  b.forEach((x, i) => { s.pos.set(x.pos, 3 * i); s.rot.set(x.rot, 4 * i); });
  return s;
}

function shotsFrom(def: DuelDef, p: Player, aspect: number, points: Array<[number, number]>) {
  const c = compileLevel(duelLevel(def, 0)), snap = startOf(c);
  const o = duelView(c, def, p, aspect), az = launcherAz(o.yaw, def), y = launchHeight(c, 'high'), ammo = def.sides[p].rack[0]!;
  const out = points.map(([x, yy]) => {
    const hit = pick(rayThrough(o, aspect, x, yy), snap, c);
    return hit ? { body: hit.body, point: hit.point, shot: shotFor(c, ammo, az, 100, hit.point, SUBSTEPS, y)?.shot as LaunchShot | undefined } : null;
  });
  return { out, c };
}

describe('Siege Table turn views are half-turn images of each other', () => {
  for (const [id, def] of [['D1', D1], ['D2', D2]] as const) for (const aspect of [1.6, 390 / 844]) {
    it(`${id} at aspect ${aspect.toFixed(2)}: the same click aims the same shot turned half way round`, () => {
      const points = clickPoints(aspect, seeded(7), 3);
      const [g, b] = [shotsFrom(def, 0, aspect, points), shotsFrom(def, 1, aspect, points)];
      let compared = 0;
      for (const [k, gh] of g.out.entries()) {
        const bh = b.out[k];
        expect(!!bh, `point ${k}: one side hits, the other does not`).toBe(!!gh);
        if (!gh || !bh) continue;
        // The hit points are images: (x, y, z) -> (-x, y, -z), to well under a millimetre.
        expect(Math.abs(gh.point[0] + bh.point[0]) + Math.abs(gh.point[1] - bh.point[1]) + Math.abs(gh.point[2] + bh.point[2]), `point ${k}`).toBeLessThan(1e-6);
        if (!gh.shot || !bh.shot) { expect(!!bh.shot).toBe(!!gh.shot); continue; }
        expect(bh.shot.az, `point ${k}`).toBe(turned(gh.shot.az));
        expect([bh.shot.y, bh.shot.yaw, bh.shot.pitch, bh.shot.power], `point ${k}`).toEqual([gh.shot.y, gh.shot.yaw, gh.shot.pitch, gh.shot.power]);
        compared++;
      }
      expect(compared).toBeGreaterThan(10);
    });
  }
});
