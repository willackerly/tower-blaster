// The domino brush on a real engine (C9, docs/game/placement.md): a run laid
// by BuildSession.stroke along a straight lead and a curve, at the default
// domino and pitch (probe X1's domino at the game's 0.5 m h), stands still
// before the push and falls end to end after it, on the AVBD reference at
// Keystone's settings. X1 measured the GPU engine at full size; this pins the
// brush's own output (spacing, headings, standing height) to a run that works.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, Vec3 } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, BuildSession, compileLevel, type CompiledLevel, findLevel, type LevelDef, type P2, smoothStroke, WORKSHOP_ANGLES, WORKSHOP_RADIUS } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

const level: LevelDef = {
  id: 'BRUSH', name: 'brush', version: 1, world: 0, lot: { min: [-12, -12], max: [12, 12] }, crownLine: 1, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble'], launcher: { radius: 14, y: 1, dropY: 8 }, parts: [], build: { budget: 100 },
};
const PUSH = 30;

/** A pointer path: 3 h straight up +z, then a quarter turn of radius 6 h to the right, sampled as a mouse would. */
function pointer(): P2[] {
  const out: P2[] = [];
  for (let z = 0; z <= 3; z += 0.05) out.push([0, z]);
  for (let a = 0; a <= Math.PI / 2; a += 0.01) out.push([6 - 6 * Math.cos(a), 3 + 6 * Math.sin(a)]);
  return out;
}
const tiltDeg = (rot: Float64Array, i: number) => (Math.acos(Math.min(1, 1 - 2 * (rot[4 * i]! ** 2 + rot[4 * i + 2]! ** 2))) * 180) / Math.PI;

/** X1's pusher behind body b, moving along its thin axis (z) at about 1 m/s, 0.8 m up: a 0.1 m stone-ish ball. */
function pusher(c: CompiledLevel, b: number, sign = 1): BodyDesc {
  const first = c.scene.bodies[b]!, q = first.rot, dir: Vec3 = [sign * 2 * (q[0] * q[2] + q[3] * q[1]), 0, sign * (1 - 2 * (q[0] ** 2 + q[1] ** 2))];
  const back = 0.075 + 0.1 + 0.02;
  return { shape: { kind: 'sphere', radius: 0.1 }, pos: [first.pos[0] - back * dir[0], 0.8, first.pos[2] - back * dir[2]], rot: [0, 0, 0, 1], linVel: [dir[0], 0, dir[2]], angVel: [0, 0, 0], density: 2000, friction: 0.5, restitution: 0, tag: -1 };
}

/** Steps a level on the reference engine with a push at step PUSH; the step each body tipped past 15 degrees (-1: never), and the most tilt before the push. */
async function topple(c: CompiledLevel, push: BodyDesc, steps: number): Promise<{ fallenAt: number[]; before: number }> {
  const n = c.meta.n, e = new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
  await e.init({ ...c.scene, inputs: [{ step: PUSH, kind: 'spawn', body: push }] });
  for (let i = 0; i < PUSH; i++) await e.step();
  const still = await e.snapshot();
  let before = 0;
  for (let i = 0; i < n; i++) before = Math.max(before, tiltDeg(still.rot, i));
  const fallenAt = new Array<number>(n).fill(-1);
  for (let step = PUSH; step < PUSH + steps && fallenAt.includes(-1); step++) {
    await e.step();
    if (step % 5) continue;
    const snap = await e.snapshot();
    for (let i = 0; i < n; i++) if (fallenAt[i]! < 0 && tiltDeg(snap.rot, i) > 15) fallenAt[i] = step;
  }
  e.dispose();
  return { fallenAt, before };
}

describe('domino brush on the reference engine', () => {
  it('a laid run stands, then falls end to end from one push', async () => {
    const s = new BuildSession(level);
    const run = s.stroke(smoothStroke(pointer()));
    expect(run.clash.some(Boolean)).toBe(false);
    expect(s.lay(run)).toBe(true);
    const c = compileLevel(s.def()), n = c.meta.n;
    expect(n).toBeGreaterThan(10);
    const { fallenAt, before } = await topple(c, pusher(c, 0), 420);
    expect(before).toBeLessThan(0.5);
    expect(fallenAt.filter((x) => x < 0)).toEqual([]);
    // In order along the run (the wave travels; a domino never falls well before the one behind it).
    for (let i = 1; i < n; i++) expect(fallenAt[i]!).toBeGreaterThanOrEqual(fallenAt[i - 1]! - 5);
  }, 120_000);

  it('T-W1 Domino Workshop is solvable with the brush: two quarter-circle strokes, one push of the first crown, all three crowns fall', async () => {
    const def = findLevel('T-W1')!, s = new BuildSession(def);
    expect(s.budget).toBe(30);
    // Unbuilt, the same push fells the first crown only: the run is what carries the wave on.
    const bare = compileLevel(def), alone = await topple(bare, pusher(bare, bare.meta.crowns[0]!), 300);
    expect(Array.from(bare.meta.crowns, (b) => alone.fallenAt[b]! >= 0)).toEqual([true, false, false]);
    // The pointer along the circle from each crown to the next (180 to 90 degrees, then 90 to 0), as a mouse samples it.
    let laid = 0;
    for (let k = 0; k + 1 < WORKSHOP_ANGLES.length; k++) {
      const a0 = (WORKSHOP_ANGLES[k]! * Math.PI) / 180, a1 = (WORKSHOP_ANGLES[k + 1]! * Math.PI) / 180, path: P2[] = [];
      for (let t = 0; t <= 1.0001; t += 0.01) { const a = a0 + (a1 - a0) * t; path.push([WORKSHOP_RADIUS * Math.cos(a), WORKSHOP_RADIUS * Math.sin(a)]); }
      const run = s.stroke(smoothStroke(path));
      // The ends sit on the crowns and are left out; the rest go down.
      expect(run.clash.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      expect(run.ok).toBe(true);
      expect(s.lay(run)).toBe(true);
      laid += run.cost;
    }
    expect(laid).toBeGreaterThanOrEqual(12);
    expect(s.left()).toBe(30 - laid);
    const c = compileLevel(s.def());
    expect(c.meta.crowns).toHaveLength(3);
    // The crown at 180 degrees, pushed towards the one at 90 (+z).
    const { fallenAt, before } = await topple(c, pusher(c, c.meta.crowns[0]!), 600);
    expect(before).toBeLessThan(0.5);
    expect(Array.from(c.meta.crowns, (b) => fallenAt[b]! >= 0)).toEqual([true, true, true]);
    expect(fallenAt.filter((x) => x < 0)).toEqual([]);
  }, 120_000);
});
