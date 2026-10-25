// Differential comparison of the tiered engine against an all-dynamic
// reference on the same scene: which cubes moved, how far the debris went,
// and where the momentum went. Used by tests and by `pnpm tiers:compare`.
import { bodiesAt, massOf, type PhysicsEngine, type Quat, type SceneDesc, type Snapshot, TAG_BALL, type Vec3 } from '@tb/engine-api';
import { quatAngle, quatMul, rotate, spherePairs, sub } from '@tb/geom';

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

export interface BondComparison {
  /** Face-adjacent box pairs in the scene. */
  bonds: number;
  /** Bonds broken in each run (see `broken`), and the cubes with at least one. */
  brokenBondsRef: number;
  brokenBondsTest: number;
  brokenRef: number;
  brokenTest: number;
  /** |A ∩ B| / |A ∪ B| of the broken-cube sets. */
  jaccard: number;
}

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const pose = (s: Snapshot, i: number) => ({ p: [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!] as Vec3, q: [s.rot[4 * i]!, s.rot[4 * i + 1]!, s.rot[4 * i + 2]!, s.rot[4 * i + 3]!] as Quat });

/**
 * Face-adjacent box pairs of the scene whose relative pose changed: the
 * offset of b seen from a's frame moved by more than `shift` edges, or their
 * relative rotation by more than `angle`. Unlike displacement from the start
 * this ignores rigid motion and smooth bending of a whole tower, so a tower
 * that sways (Rapier stacks are soft: an 8 x 8 x 25 tower struck by the S5
 * ball sways ~0.5 m at the top for seconds) breaks no bonds, while a cube
 * knocked out of it breaks all of its own.
 */
export function brokenBonds(scene: SceneDesc, s: Snapshot, shift = 0.25, angle = (15 * Math.PI) / 180): { pairs: number; broken: Array<[number, number]> } {
  const boxes = scene.bodies.map((b, i) => ({ b, i })).filter(({ b }) => b.shape.kind === 'box');
  const centers = new Float64Array(3 * boxes.length), radii = new Float64Array(boxes.length);
  boxes.forEach(({ b }, k) => {
    centers.set(b.pos, 3 * k);
    radii[k] = b.shape.kind === 'box' ? Math.min(...b.shape.half) : 0;
  });
  const pairs = spherePairs(centers, radii, 0.02);
  const broken: Array<[number, number]> = [];
  for (const [x, y] of pairs) {
    const a = boxes[x]!.i, b = boxes[y]!.i, A = boxes[x]!.b, B = boxes[y]!.b, edge = 2 * radii[x]!;
    const off0 = rotate(conj(A.rot), sub(B.pos, A.pos)), pa = pose(s, a), pb = pose(s, b);
    const off = rotate(conj(pa.q), sub(pb.p, pa.p));
    const rel0 = quatMul(conj(A.rot), B.rot), rel = quatMul(conj(pa.q), pb.q);
    if (Math.hypot(...sub(off, off0)) > shift * edge || quatAngle(quatMul(conj(rel0), rel)) > angle) broken.push([a, b]);
  }
  return { pairs: pairs.length, broken };
}

export function compareBonds(scene: SceneDesc, ref: Snapshot, test: Snapshot): BondComparison {
  const r = brokenBonds(scene, ref), t = brokenBonds(scene, test);
  const cubes = (br: Array<[number, number]>) => new Set(br.flat());
  const A = cubes(r.broken), B = cubes(t.broken);
  let both = 0;
  for (const i of A) if (B.has(i)) both++;
  const union = A.size + B.size - both;
  return { bonds: r.pairs, brokenBondsRef: r.broken.length, brokenBondsTest: t.broken.length, brokenRef: A.size, brokenTest: B.size, jaccard: union ? both / union : 1 };
}
