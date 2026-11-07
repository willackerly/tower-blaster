// The aim's clarity (PT14, docs/game/aim-clarity.md): where a shot will first touch (arcContact, the impact
// marker's place), every point of the structure a player can point at from the opening view is reachable at full
// power, and every level's pre-aimed opener comes down on the structure.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot, type Vec3 } from '@tb/engine-api';
import { compileLevel, type CompiledLevel, GRAVITY, L1, type LaunchItem, SERIES, type Shot, shotToSpawn } from '@tb/keystone';
import { rotate } from '@tb/geom';
import { rayThrough, viewProj } from '@tb/render/camera';
import { arcContact, azFromYaw, launchHeight, launchY, pick, previewBeads, rayBox, REACH, shotFor, SUBSTEPS } from '../src/aim.ts';
import { defaultInsets, viewOf } from '../src/view.ts';
import { nextSelection } from '../src/hud.ts';
import { markOf } from '../src/scene.ts';

function atHome(c: CompiledLevel): Snapshot {
  const s = emptySnapshot(c.meta.n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot.set(c.scene.bodies[i]!.rot, 4 * i);
  return s;
}
const isLaunch = (a: string): a is LaunchItem => a !== 'drop' && a !== 'pull' && a !== 'cue';
const ALL = SERIES.flat();

/**
 * Whether `p` lies past 95% of the furthest a full-power shot of `ammo` carries at p's height from the launcher at
 * (az, at): the drag-free range at the best angle, R = (v / g) sqrt(v^2 + 2 g (y0 - y)). The far side of the
 * biggest trial lots (T-S3, T-X3) is that far from the ring, and there "Out of reach" is the truth.
 */
function beyond(c: CompiledLevel, ammo: LaunchItem, az: number, at: number, p: Vec3): boolean {
  const ev = shotToSpawn(c.frame, { ammo, az, y: launchY(c, ammo, at), yaw: 0, pitch: 0, power: 100 }, 0);
  const v = Math.hypot(...ev.body.linVel), y0 = ev.body.pos[1], k = v * v + 2 * GRAVITY * (y0 - p[1]);
  const range = k > 0 ? (v / GRAVITY) * Math.sqrt(k) : 0;
  return Math.hypot(p[0] - ev.body.pos[0], p[2] - ev.body.pos[2]) > 0.95 * range;
}

describe('arcContact', () => {
  const c = compileLevel(L1), s = atHome(c);
  it('a shot aimed at a face first touches that face, the marker on its surface facing the shot', () => {
    const o = viewOf(c, 1.6), az = azFromYaw(o.yaw);
    const hit = pick(rayThrough(o, 1.6, 0, 0), s, c)!;
    expect(hit.body).toBeGreaterThanOrEqual(0);
    const a = shotFor(c, 'cannonball', az, 100, hit.point, SUBSTEPS, launchHeight(c, 'high'))!;
    expect(a.reachable).toBe(true);
    const k = arcContact(c, s, a.shot)!;
    expect(k.body).toBe(hit.body);
    // On the box's surface (within a millimetre), near the aimed point, its normal against the flight.
    const half = (c.scene.bodies[k.body]!.shape as { half: Vec3 }).half, pos = c.meta.home.subarray(3 * k.body, 3 * k.body + 3);
    const inside = rayBox({ origin: [k.point[0] + k.normal[0] * 1e-3, k.point[1] + k.normal[1] * 1e-3, k.point[2] + k.normal[2] * 1e-3], dir: [-k.normal[0], -k.normal[1], -k.normal[2]] }, [pos[0]!, pos[1]!, pos[2]!], c.scene.bodies[k.body]!.rot, half);
    expect(inside!.t).toBeLessThan(2e-3);
    expect(Math.hypot(k.point[0] - hit.point[0], k.point[1] - hit.point[1], k.point[2] - hit.point[2])).toBeLessThan(REACH + 2 * k.radius);
    // The preview's beads stop where it touches, not past it.
    const beads = previewBeads(c, a.shot, hit.point, SUBSTEPS, 40, 2, k), last = beads.subarray(beads.length - 3);
    expect(Math.hypot(last[0]! - k.point[0], last[1]! - k.point[1], last[2]! - k.point[2])).toBeLessThan(1);
  });

  it('a shot over everything comes down on the ground, its marker flat', () => {
    const shot: Shot = { ammo: 'cannonball', az: 0, y: 8, yaw: 900, pitch: 0, power: 30 };
    const k = arcContact(c, s, shot)!;
    expect(k).toMatchObject({ body: -1, normal: [0, 1, 0] });
    expect(k.point[1]).toBeCloseTo(0, 9);
  });

  it('a drop touches the top of the body under it', () => {
    const top = c.meta.home[1]! + (c.scene.bodies[0]!.shape as { half: Vec3 }).half[1];
    const ph = c.frame.pitch * c.frame.unit;
    const shot: Shot = { ammo: 'drop', x: Math.round((4 * c.meta.home[0]!) / ph), z: Math.round((4 * c.meta.home[2]!) / ph) };
    const k = arcContact(c, s, shot)!;
    expect(k.body).toBeGreaterThanOrEqual(0);
    expect(k.normal[1]).toBeCloseTo(1, 9);
    expect(k.point[1]).toBeGreaterThanOrEqual(top - 1e-9);
  });
});

describe('every level, from its opening view', () => {
  for (const def of ALL) {
    it(`${def.id}: every structure point under a 9x9 grid of the free area, and every objective's middle, within the ball's range is reachable at full power, wide and upright`, () => {
      const c = compileLevel(def), s = atHome(c);
      const ammo = nextSelection(c.def.rack, c.def.rack, null);
      if (!ammo || !isLaunch(ammo)) return;
      for (const aspect of [1.6, 390 / 844]) {
        const o = viewOf(c, aspect), az = azFromYaw(o.yaw), ins = defaultInsets(aspect), at = launchHeight(c, 'high');
        const sq = aspect >= 1 ? 1 / aspect : 1, bad: string[] = [];
        let near = 0, far = 0;
        // The 9x9 grid, then the middle of every objective body on screen (at most 32, evenly spread): a sparse lot
        // like T-W1's three dominoes falls between the grid's rays.
        const rays: [number, number][] = [];
        for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) rays.push([(-1 + 2 * ins.left + (2 - 2 * ins.left - 2 * ins.right) * (i + 0.5) / 9) * sq, -1 + 2 * ins.bottom + (2 - 2 * ins.bottom - 2 * ins.top) * (j + 0.5) / 9]);
        const goals = Array.from({ length: c.meta.n }, (_, b) => b).filter((b) => markOf(c, b) !== 0), m = viewProj(o, aspect);
        for (let g = 0; g < Math.min(32, goals.length); g++) {
          const b = goals[Math.floor((g * goals.length) / Math.min(32, goals.length))]!, h = c.meta.home;
          const w = [0, 1, 2, 3].map((r) => m[r]! * h[3 * b]! + m[4 + r]! * h[3 * b + 1]! + m[8 + r]! * h[3 * b + 2]! + m[12 + r]!);
          const x = w[0]! / w[3]!, y = w[1]! / w[3]!;
          if (w[3]! > 0 && x > -1 + 2 * ins.left && x < 1 - 2 * ins.right && y > -1 + 2 * ins.bottom && y < 1 - 2 * ins.top) rays.push([x, y]);
        }
        for (const [x, y] of rays) {
          const hit = pick(rayThrough(o, aspect, x, y), s, c);
          if (!hit || hit.body < 0) continue;
          if (beyond(c, ammo, az, at, hit.point)) { far++; continue; }
          const a = shotFor(c, ammo, az, 100, hit.point, SUBSTEPS, at);
          if (!a?.reachable) bad.push(`${x.toFixed(2)},${y.toFixed(2)}: ${a?.error.toFixed(2)} m`);
          near++;
        }
        expect(bad, `aspect ${aspect.toFixed(2)}`).toEqual([]);
        expect(near, 'points tested').toBeGreaterThan(0);
      }
    });
  }
});

describe('the pre-aimed openers', () => {
  const withOpener = ALL.filter((d) => d.solutions?.ace?.[0] ?? d.solutions?.par?.[0]);
  it('are many', () => expect(withOpener.length).toBeGreaterThan(5));
  for (const def of withOpener) {
    it(`${def.id}: its opener's arc comes down on the structure`, () => {
      const c = compileLevel(def), shot = (def.solutions!.ace?.[0] ?? def.solutions!.par![0])!;
      if (shot.ammo === 'pull' || shot.ammo === 'cue') return;
      const k = arcContact(c, atHome(c), shot);
      expect(k?.body ?? -2).toBeGreaterThanOrEqual(0);
      // The marker lies flat on one of the body's faces: its normal is a face axis in the body's frame.
      const q = c.scene.bodies[k!.body]!.rot, n = rotate([-q[0], -q[1], -q[2], q[3]], k!.normal);
      expect(n.map((v) => Math.abs(v)).sort((a, b) => a - b).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    });
  }
});
