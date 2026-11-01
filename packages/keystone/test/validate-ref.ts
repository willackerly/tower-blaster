// validateLevel as it was before the scale work (G2.4), kept verbatim as the
// reference the new one is checked against (level-scale.test.ts): the sweep on
// x for near pairs and the all-pairs support pass, O(n^2) in the worst case.
// Only the imports and the export name differ, and the per-item rack checks
// (tunnelling and the rest) are left out: they moved to rackIssues with the
// rack items (G3.1) and never touched the near-pair search.
import { type CompiledLevel, type Issue, MAX_RACK } from '@tb/keystone';

type BodyMeta = CompiledLevel['meta'];
const MAX_BODIES = 2500;

const aabb = (m: BodyMeta, i: number) => {
  const c = [m.home[3 * i]!, m.home[3 * i + 1]!, m.home[3 * i + 2]!], e = [m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!];
  return { lo: c.map((x, k) => x - e[k]!), hi: c.map((x, k) => x + e[k]!) };
};

/** Pairs whose AABBs, grown by `margin` on every side, overlap. Sweep on x. */
function nearPairs(m: BodyMeta, margin: number): Array<[number, number]> {
  const boxes = Array.from({ length: m.n }, (_, i) => aabb(m, i));
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.lo[0]! - boxes[b]!.lo[0]!);
  const out: Array<[number, number]> = [];
  for (let s = 0; s < order.length; s++) {
    const i = order[s]!, A = boxes[i]!;
    for (let t = s + 1; t < order.length; t++) {
      const j = order[t]!, B = boxes[j]!;
      if (B.lo[0]! > A.hi[0]! + 2 * margin) break;
      if ([0, 1, 2].every((k) => A.lo[k]! - margin < B.hi[k]! + margin && B.lo[k]! - margin < A.hi[k]! + margin)) out.push(i < j ? [i, j] : [j, i]);
    }
  }
  return out;
}

/**
 * Static checks that keep levels solvable and the solver honest. The physical
 * check (the level sits still on a real engine) lives in the sim package.
 */
export function validateLevelRef(c: CompiledLevel): Issue[] {
  const { def, meta: m } = c, h = c.frame.unit, issues: Issue[] = [];
  if (m.n === 0) issues.push({ code: 'empty', message: 'level has no bodies' });
  if (m.n > MAX_BODIES) issues.push({ code: 'count', message: `${m.n} bodies > ${MAX_BODIES} (Rapier prototype budget)` });
  if (def.rack.length === 0 || def.rack.length > MAX_RACK || def.par < 1 || def.par > def.rack.length) issues.push({ code: 'rack', message: `rack of ${def.rack.length} with par ${def.par}: need 1 <= par <= rack <= ${MAX_RACK}` });

  const eps = 1e-4 * h;
  const box = (i: number) => aabb(m, i);
  for (const [i, j] of nearPairs(m, 0.1 * h)) {
    const A = box(i), B = box(j);
    const depth = Math.min(...[0, 1, 2].map((k) => Math.min(A.hi[k]!, B.hi[k]!) - Math.max(A.lo[k]!, B.lo[k]!)));
    if (depth > eps) issues.push({ code: 'overlap', message: `bodies ${i} and ${j} overlap by ${(depth / h).toFixed(3)} h`, bodies: [i, j] });
    const ratio = Math.max(m.mass[i]! / m.mass[j]!, m.mass[j]! / m.mass[i]!);
    if (ratio > 10) issues.push({ code: 'mass-ratio', message: `bodies ${i} and ${j} touch with mass ratio ${ratio.toFixed(1)} > 10`, bodies: [i, j] });
  }

  // Loose support: a body off the ground must rest on bodies whose tops meet
  // its bottom, with its centre over the bounding box of those contacts.
  const boxes = Array.from({ length: m.n }, (_, i) => box(i));
  // above[j] = bodies resting directly on j; below[j] = what j rests on.
  const above: number[][] = Array.from({ length: m.n }, () => []);
  const below: number[][] = Array.from({ length: m.n }, () => []);
  for (const [i, j] of nearPairs(m, 0.01 * h)) {
    const A = boxes[i]!, B = boxes[j]!;
    const ox = Math.min(A.hi[0]!, B.hi[0]!) - Math.max(A.lo[0]!, B.lo[0]!), oz = Math.min(A.hi[2]!, B.hi[2]!) - Math.max(A.lo[2]!, B.lo[2]!);
    if (ox <= eps || oz <= eps) continue;
    if (Math.abs(A.hi[1]! - B.lo[1]!) <= eps) { above[i]!.push(j); below[j]!.push(i); }
    else if (Math.abs(B.hi[1]! - A.lo[1]!) <= eps) { above[j]!.push(i); below[i]!.push(j); }
  }
  // The body plus everything that rests only on it (transitively). Shared
  // loads such as a lintel on two columns are left out: splitting them needs
  // statics, and the at-rest run on a real engine catches those cases.
  const carried = (i: number): Set<number> => {
    const set = new Set([i]);
    for (let grew = true; grew;) {
      grew = false;
      for (const k of [...set]) for (const j of above[k]!) if (!set.has(j) && below[j]!.every((b) => set.has(b))) { set.add(j); grew = true; }
    }
    return set;
  };
  for (let i = 0; i < m.n; i++) {
    const A = boxes[i]!;
    if (A.lo[1]! < eps) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let j = 0; j < m.n; j++) {
      const B = boxes[j]!;
      if (j === i || Math.abs(B.hi[1]! - A.lo[1]!) > eps) continue;
      const ox0 = Math.max(A.lo[0]!, B.lo[0]!), ox1 = Math.min(A.hi[0]!, B.hi[0]!), oz0 = Math.max(A.lo[2]!, B.lo[2]!), oz1 = Math.min(A.hi[2]!, B.hi[2]!);
      if (ox1 - ox0 <= eps || oz1 - oz0 <= eps) continue;
      x0 = Math.min(x0, ox0); x1 = Math.max(x1, ox1); z0 = Math.min(z0, oz0); z1 = Math.max(z1, oz1);
    }
    // Centre of mass of the body and everything resting on it, so a lever
    // whose own centre overhangs its supports passes if its load balances it.
    const load = carried(i);
    let mx = 0, mz = 0, mm = 0;
    for (const j of load) { mx += m.mass[j]! * m.home[3 * j]!; mz += m.mass[j]! * m.home[3 * j + 2]!; mm += m.mass[j]!; }
    const cx = mx / mm, cz = mz / mm;
    if (!(cx > x0 + eps && cx < x1 - eps && cz > z0 + eps && cz < z1 - eps)) issues.push({ code: 'unsupported', message: `body ${i} at y=${(A.lo[1]! / h).toFixed(2)} h: the centre of mass of it and its load is not over its supports`, bodies: [i] });
  }

  for (const i of m.crowns) {
    const x = m.home[3 * i]!, y = m.home[3 * i + 1]!, z = m.home[3 * i + 2]!;
    if (y < def.crownLine * h || x < c.lot.min[0] || x > c.lot.max[0] || z < c.lot.min[1] || z > c.lot.max[1]) issues.push({ code: 'crown-start', message: `crown ${i} starts already down`, bodies: [i] });
  }
  return issues;
}

