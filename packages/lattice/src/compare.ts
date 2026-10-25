// Differential comparison of the tiered engine against an all-dynamic
// reference on the same scene: which cubes moved, how far the debris went,
// and where the momentum went. Used by tests and by `pnpm tiers:compare`.
import { bodiesAt, massOf, type PhysicsEngine, type SceneDesc, type Snapshot, TAG_BALL } from '@tb/engine-api';

export interface Trace {
  /** Horizontal momentum sum m v_x per sampled step (all bodies). */
  momentumX: number[];
  /** Ball x velocity per sampled step (NaN before it spawns). */
  ballVx: number[];
  final: Snapshot;
  stepMs: number[];
}

export async function trace(e: PhysicsEngine, scene: SceneDesc, steps: number): Promise<Trace> {
  await e.init(scene);
  const bodies = bodiesAt(scene, Infinity);
  const ball = bodies.findIndex((b) => b.tag === TAG_BALL);
  const momentumX: number[] = [], ballVx: number[] = [], stepMs: number[] = [];
  for (let s = 0; s < steps; s++) {
    const t0 = performance.now();
    await e.step();
    stepMs.push(performance.now() - t0);
    const snap = await e.snapshot();
    let px = 0;
    for (let i = 0; i < snap.count; i++) px += massOf(bodies[i]!) * snap.linVel[3 * i]!;
    momentumX.push(px);
    ballVx.push(ball >= 0 && ball < snap.count ? snap.linVel[3 * ball]! : NaN);
  }
  const final = await e.snapshot();
  e.dispose();
  return { momentumX, ballVx, final, stepMs };
}

export interface Comparison {
  /** Cubes displaced by more than `moved` edges in each run. */
  movedRef: number;
  movedTest: number;
  /** |A ∩ B| / |A ∪ B| of the moved sets. */
  jaccard: number;
  /** Cubes that moved in the reference but stayed (within `moved`) in the test, and the reverse. */
  missed: number;
  extra: number;
  /** Mean final distance from the scene's centre of mass of moved cubes, ref and test. */
  spreadRef: number;
  spreadTest: number;
}

export function compare(scene: SceneDesc, ref: Snapshot, test: Snapshot, moved = 0.5): Comparison {
  const n = scene.bodies.length;
  const disp = (s: Snapshot, i: number) => Math.hypot(s.pos[3 * i]! - scene.bodies[i]!.pos[0], s.pos[3 * i + 1]! - scene.bodies[i]!.pos[1], s.pos[3 * i + 2]! - scene.bodies[i]!.pos[2]);
  let cx = 0, cz = 0;
  for (const b of scene.bodies) { cx += b.pos[0] / n; cz += b.pos[2] / n; }
  let a = 0, b = 0, both = 0, missed = 0, extra = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    if (scene.bodies[i]!.tag === TAG_BALL) continue;
    const ma = disp(ref, i) > moved, mb = disp(test, i) > moved;
    if (ma) { a++; sa += Math.hypot(ref.pos[3 * i]! - cx, ref.pos[3 * i + 2]! - cz); }
    if (mb) { b++; sb += Math.hypot(test.pos[3 * i]! - cx, test.pos[3 * i + 2]! - cz); }
    if (ma && mb) both++;
    if (ma && !mb) missed++;
    if (mb && !ma) extra++;
  }
  return { movedRef: a, movedTest: b, jaccard: a + b - both ? both / (a + b - both) : 1, missed, extra, spreadRef: a ? sa / a : 0, spreadTest: b ? sb / b : 0 };
}
