// Invariants of the tiered world, checked after steps in tests:
// (a) every lattice is stored consistently and legal under the support model;
// (b) each body is in exactly one tier, and the host agrees (dormant: off or
//     a static proxy; active: dynamic; not spawned: off);
// (c) the body count is conserved;
// (d) no dynamic body overlaps a dormant cell beyond `penTol` (in edges);
// (e) every exposed dormant cell touching a dynamic body's bounding sphere
//     is a static proxy in the host (else the body would pass through it).
import { MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type Quat, type Vec3 } from '@tb/engine-api';
import { boundingRadius, shapeDepth } from '@tb/geom';
import { checkStorage, checkSupport } from './check.ts';
import { CUBE_ROTATIONS } from './symmetry.ts';
import { cellsInBox, exposed, TIER_ACTIVE, TIER_LATTICE, TIER_UNSPAWNED, type TieredEngine } from './tiered.ts';

/** penTol is in edges; Rapier itself reaches about 0.03 for a moment when a cube lands hard. */
export async function checkTiers(e: TieredEngine, penTol = 0.05): Promise<string[]> {
  const out: string[] = [];
  const host = e.host;
  for (const lat of e.lattices) out.push(...checkStorage(lat), ...checkSupport(lat, e.p.support));
  let dormant = 0;
  for (let id = 0; id < e.tier.length; id++) {
    const t = e.tier[id]!, mode = host.modeOf(id);
    if (t === TIER_LATTICE) {
      dormant++;
      const lat = e.lattices[e.latticeOf[id]!];
      if (!lat || lat.idAt(...lat.coords(e.cellOf[id]!)) !== id) out.push(`body ${id}: dormant but not in its cell`);
      if (mode === MODE_DYNAMIC) out.push(`body ${id}: dormant but dynamic in the host`);
      if (host.caps.latticeNative && mode !== MODE_STATIC) out.push(`body ${id}: dormant but not a native lattice cell in the host`);
    } else if (t === TIER_ACTIVE) {
      if (mode !== MODE_DYNAMIC) out.push(`body ${id}: active but host mode ${mode}`);
      if (e.latticeOf[id] !== -1) out.push(`body ${id}: active but still mapped to a cell`);
    } else if (t === TIER_UNSPAWNED) {
      if (id < e.spawned) out.push(`body ${id}: spawned but unspawned tier`);
      if (mode !== MODE_OFF) out.push(`body ${id}: not spawned but host mode ${mode}`);
    }
  }
  const stored = e.lattices.reduce((n, l) => n + l.count, 0);
  if (stored !== dormant) out.push(`lattices hold ${stored} cells but ${dormant} bodies are dormant`);
  let active = 0;
  for (let id = 0; id < e.spawned; id++) if (e.tier[id] === TIER_ACTIVE) active++;
  if (dormant + active !== e.spawned) out.push(`count: ${dormant} dormant + ${active} active != ${e.spawned} spawned`);
  const cur = await host.current();
  for (let n = 0; n < cur.ids.length; n++) {
    const id = cur.ids[n]!, b = e.bodies[id]!;
    const pos: Vec3 = [cur.pos[3 * n]!, cur.pos[3 * n + 1]!, cur.pos[3 * n + 2]!];
    const rot: Quat = [cur.rot[4 * n]!, cur.rot[4 * n + 1]!, cur.rot[4 * n + 2]!, cur.rot[4 * n + 3]!];
    const r = boundingRadius(b.shape);
    for (const lat of e.lattices) {
      const h = lat.frame.edge / 2;
      for (const [i, j, k] of cellsInBox(lat, [pos[0] - r, pos[1] - r, pos[2] - r], [pos[0] + r, pos[1] + r, pos[2] + r], (i, j, k) => lat.has(i, j, k))) {
        const depth = shapeDepth(b.shape, pos, rot, { kind: 'box', half: [h, h, h] }, lat.center(i, j, k), CUBE_ROTATIONS[lat.rotAt(i, j, k)]!);
        if (depth > penTol * lat.frame.edge) out.push(`body ${id} overlaps dormant cell ${i},${j},${k} by ${depth.toFixed(4)}`);
        if (depth > -1e-9 && exposed(lat, i, j, k) && host.modeOf(lat.idAt(i, j, k)) !== MODE_STATIC) {
          // Touching or overlapping: the cell must be solid for the host.
          out.push(`body ${id} touches dormant cell ${i},${j},${k} that is not a static proxy`);
        }
      }
    }
  }
  return out;
}
