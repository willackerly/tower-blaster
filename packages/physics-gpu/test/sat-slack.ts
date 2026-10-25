// How close the reference's SAT axis choice came to flipping (see pairHistory in page.ts).
import { cross, dot, EDGE_ABS, EDGE_REL, FACE_ABS, FACE_REL, length, type Obb, obb, scale, sub } from '@tb/geom';
import type { Quat, Vec3 } from '@tb/engine-api';

/**
 * The f32 narrowphase and the f64 reference can pick different SAT axes only
 * where the reference's choice was this close to flipping (m). Rounding moves
 * the separations by ~1e-7 m (an f32 replay of the first pair that flipped,
 * 2026-10-25, moved them 5.7e-8 and 9.3e-8); this is 20x that, and 2% of
 * FACE_ABS.
 */
export const AXIS_TIE = 2e-6;

/**
 * How near the reference's SAT choice for boxes A and B came to flipping, and
 * to what. It replays boxBoxManifold (geom/manifold.ts) with the hint tried
 * first: the face hysteresis, the edge argmax, then edge against face. Each
 * comparison has a gap, separation minus the bar it had to clear.
 * - slack: the smallest |gap| among the comparisons whose inversion alone
 *   changes the final axis (m);
 * - alternatives: every other axis the replay can end at when each
 *   comparison it meets within tol of its bar may go either way, including
 *   several at once and comparisons a flip leads to (a search over those
 *   branches).
 */
export function axisSlack(ha: Vec3, A: { pos: Vec3; rot: Quat }, hb: Vec3, B: { pos: Vec3; rot: Quat }, hint: number, tol = AXIS_TIE): { axis: number; slack: number; alternatives: number[] } {
  const a = obb(A.pos, A.rot, ha), b = obb(B.pos, B.rot, hb), d = sub(b.c, a.c);
  const pr = (o: Obb, n: Vec3) => o.half[0] * Math.abs(dot(o.axes[0], n)) + o.half[1] * Math.abs(dot(o.axes[1], n)) + o.half[2] * Math.abs(dot(o.axes[2], n));
  const sep = (n: Vec3) => Math.abs(dot(d, n)) - pr(a, n) - pr(b, n);
  const first = hint < 6 ? hint : 0;
  const faces = Array.from({ length: 6 }, (_, t) => {
    const id = t === 0 ? first : t - 1 + (t - 1 >= first ? 1 : 0);
    return { id, s: sep((id < 3 ? a : b).axes[id % 3]!) };
  });
  const edges: Array<{ id: number; s: number }> = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const c = cross(a.axes[i]!, b.axes[j]!), len = length(c);
    if (len >= 1e-6) edges.push({ id: 6 + 3 * i + j, s: sep(scale(c, 1 / len)) });
  }
  // Comparisons run in the same order whatever their outcomes. decide(k, g)
  // gives the outcome of comparison k with gap g.
  const replay = (decide: (k: number, g: number) => boolean) => {
    let k = 0;
    const wins = (s: number, bar: number) => decide(k++, s - bar);
    let face = faces[0]!;
    for (const f of faces.slice(1)) if (wins(f.s, face.s + FACE_ABS + FACE_REL * Math.abs(face.s))) face = f;
    let edge: { id: number; s: number } | null = null;
    for (const e of edges) if (edge === null || wins(e.s, edge.s)) edge = e;
    const useEdge = edge !== null && wins(edge.s, face.s + EDGE_ABS + EDGE_REL * Math.abs(face.s));
    return useEdge ? edge!.id : face.id;
  };
  const gaps: number[] = [];
  const axis = replay((_, g) => (gaps.push(g), g > 0));
  let slack = Infinity;
  gaps.forEach((g, k) => {
    if (replay((j, h) => (j === k) !== (h > 0)) !== axis) slack = Math.min(slack, Math.abs(g));
  });
  // Depth-first over the near comparisons met on each path: `forced` fixes the
  // outcomes of the first ones, the rest take their natural outcome, and each
  // natural outcome past the prefix is then inverted in turn.
  const alternatives = new Set<number>();
  let paths = 0;
  const explore = (forced: boolean[]) => {
    if (++paths > 4096) throw new Error('axisSlack: more than 4096 near-tie paths');
    const natural: boolean[] = [];
    const end = replay((_, g) => {
      if (Math.abs(g) >= tol) return g > 0;
      const n = natural.length;
      natural.push(n < forced.length ? forced[n]! : g > 0);
      return natural[n]!;
    });
    if (end !== axis) alternatives.add(end);
    for (let n = forced.length; n < natural.length; n++) explore([...natural.slice(0, n), !natural[n]]);
  };
  explore([]);
  return { axis, slack, alternatives: [...alternatives].sort((x, y) => x - y) };
}
