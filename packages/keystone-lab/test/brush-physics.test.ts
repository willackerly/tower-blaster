// The domino brush on a real engine (C9, docs/game/placement.md): a run laid
// by BuildSession.stroke along a straight lead and a curve, at the default
// domino and pitch (probe X1's domino at the game's 0.5 m h), stands still
// before the push and falls end to end after it, on the AVBD reference at
// Keystone's settings. X1 measured the GPU engine at full size; this pins the
// brush's own output (spacing, headings, standing height) to a run that works.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, Vec3 } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, BuildSession, compileLevel, type LevelDef, type P2, smoothStroke } from '@tb/keystone';
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

describe('domino brush on the reference engine', () => {
  it('a laid run stands, then falls end to end from one push', async () => {
    const s = new BuildSession(level);
    const run = s.stroke(smoothStroke(pointer()));
    expect(run.clash.some(Boolean)).toBe(false);
    expect(s.lay(run)).toBe(true);
    const c = compileLevel(s.def()), n = c.meta.n;
    expect(n).toBeGreaterThan(10);
    // X1's pusher: a 0.1 m stone-ish ball at about 1 m/s, 0.8 m up, just behind the first domino.
    const first = c.scene.bodies[0]!, q = first.rot, dir: Vec3 = [2 * (q[0] * q[2] + q[3] * q[1]), 0, 1 - 2 * (q[0] ** 2 + q[1] ** 2)];
    const back = 0.075 + 0.1 + 0.02;
    const ball: BodyDesc = { shape: { kind: 'sphere', radius: 0.1 }, pos: [first.pos[0] - back * dir[0], 0.8, first.pos[2] - back * dir[2]], rot: [0, 0, 0, 1], linVel: [dir[0], 0, dir[2]], angVel: [0, 0, 0], density: 2000, friction: 0.5, restitution: 0, tag: -1 };
    const e = new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
    await e.init({ ...c.scene, inputs: [{ step: PUSH, kind: 'spawn', body: ball }] });
    for (let i = 0; i < PUSH; i++) await e.step();
    const still = await e.snapshot();
    for (let i = 0; i < n; i++) expect(tiltDeg(still.rot, i)).toBeLessThan(0.5);
    const fallenAt = new Array<number>(n).fill(-1);
    for (let step = PUSH; step < PUSH + 420 && fallenAt.includes(-1); step++) {
      await e.step();
      if (step % 5) continue;
      const snap = await e.snapshot();
      for (let i = 0; i < n; i++) if (fallenAt[i]! < 0 && tiltDeg(snap.rot, i) > 15) fallenAt[i] = step;
    }
    expect(fallenAt.filter((x) => x < 0)).toEqual([]);
    // In order along the run (the wave travels; a domino never falls well before the one behind it).
    for (let i = 1; i < n; i++) expect(fallenAt[i]!).toBeGreaterThanOrEqual(fallenAt[i - 1]! - 5);
    e.dispose();
  }, 120_000);
});
