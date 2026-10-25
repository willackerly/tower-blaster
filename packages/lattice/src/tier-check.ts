// Invariants of the tiered world, checked after steps in tests:
// (a) every lattice is stored consistently and legal under the support model;
// (b) each body is in exactly one tier, and the host agrees (dormant: off or
//     a static proxy; active: dynamic; not spawned: off);
// (c) the body count is conserved;
// (d) no dynamic body overlaps a dormant cell beyond `penTol` (in edges)
//     plus one step of its own travel toward the cell (a body that meets a
//     dormant wall is pushed out on the next step, as by any static body);
// (e) every exposed dormant cell touching a dynamic body's bounding sphere
//     is a static proxy in the host (else the body would pass through it);
// (f) rubble is static in the host at its frozen pose, and rests on the
//     ground or on supporters that are all still at rest (lattice or rubble):
//     nothing at rest floats.
import { MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type Quat, type Vec3 } from '@tb/engine-api';
import { boundingRadius, shapeDepth, signedGroundDepth } from '@tb/geom';
import { checkStorage, checkSupport } from './check.ts';
import { CUBE_ROTATIONS } from './symmetry.ts';
import { cellsInBox, exposed, TIER_ACTIVE, TIER_LATTICE, TIER_RUBBLE, TIER_UNSPAWNED, type TieredEngine } from './tiered.ts';

/**
 * penTol is in edges. Rapier itself reaches about 0.03 for a moment when a
 * cube lands hard, and up to 0.067 for a few steps when a pile presses a cube
 * into dormant cells that hold (they used to wake at any push over capacity;
 * the slide rules keep them dormant). A body passing through a cell goes far
 * deeper.
 */
export async function checkTiers(e: TieredEngine, penTol = 0.08): Promise<string[]> {
  const out: string[] = [];
  const host = e.host;
  for (const lat of e.lattices) out.push(...checkStorage(lat), ...checkSupport(lat, e.p.support));
  let dormant = 0, rubble = 0;
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
    } else if (t === TIER_RUBBLE) {
      rubble++;
      if (mode !== MODE_STATIC) out.push(`body ${id}: rubble but host mode ${mode}`);
      if (e.latticeOf[id] !== -1) out.push(`body ${id}: rubble but mapped to a cell`);
      const sup = e.supporters.get(id);
      if (!sup) { out.push(`body ${id}: rubble without a supporter record`); continue; }
      for (const s of sup) if (e.tier[s] !== TIER_LATTICE && e.tier[s] !== TIER_RUBBLE) out.push(`body ${id}: rubble resting on body ${s}, which is no longer at rest`);
      const { pos, rot } = e.rubblePose(id), g = e.scene?.ground;
      const grounded = g != null && signedGroundDepth(e.bodies[id]!.shape, pos, rot, g.y) > -e.p.touchTol;
      if (!grounded && !sup.length) out.push(`body ${id}: rubble floating (no ground, no supporters)`);
    } else if (t === TIER_UNSPAWNED) {
      if (id < e.spawned) out.push(`body ${id}: spawned but unspawned tier`);
      if (mode !== MODE_OFF) out.push(`body ${id}: not spawned but host mode ${mode}`);
    }
  }
  const stored = e.lattices.reduce((n, l) => n + l.count, 0);
  if (stored !== dormant) out.push(`lattices hold ${stored} cells but ${dormant} bodies are dormant`);
  let active = 0;
  for (let id = 0; id < e.spawned; id++) if (e.tier[id] === TIER_ACTIVE) active++;
  if (dormant + active + rubble !== e.spawned) out.push(`count: ${dormant} dormant + ${active} active + ${rubble} rubble != ${e.spawned} spawned`);
  if (e.supporters.size !== rubble) out.push(`${e.supporters.size} supporter records for ${rubble} rubble bodies`);
  const cur = await host.current();
  for (let n = 0; n < cur.ids.length; n++) {
    const id = cur.ids[n]!, b = e.bodies[id]!;
    const pos: Vec3 = [cur.pos[3 * n]!, cur.pos[3 * n + 1]!, cur.pos[3 * n + 2]!];
    const rot: Quat = [cur.rot[4 * n]!, cur.rot[4 * n + 1]!, cur.rot[4 * n + 2]!, cur.rot[4 * n + 3]!];
    const r = boundingRadius(b.shape), v: Vec3 = [cur.linVel[3 * n]!, cur.linVel[3 * n + 1]!, cur.linVel[3 * n + 2]!];
    for (const lat of e.lattices) {
      const h = lat.frame.edge / 2;
      for (const [i, j, k] of cellsInBox(lat, [pos[0] - r, pos[1] - r, pos[2] - r], [pos[0] + r, pos[1] + r, pos[2] + r], (i, j, k) => lat.has(i, j, k))) {
        const c = lat.center(i, j, k), depth = shapeDepth(b.shape, pos, rot, { kind: 'box', half: [h, h, h] }, c, CUBE_ROTATIONS[lat.rotAt(i, j, k)]!);
        const to = [c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]], dist = Math.hypot(...to) || 1;
        const travel = Math.max(0, (v[0] * to[0]! + v[1] * to[1]! + v[2] * to[2]!) / dist) * e.scene!.dt;
        if (depth > penTol * lat.frame.edge + travel) out.push(`body ${id} overlaps dormant cell ${i},${j},${k} by ${depth.toFixed(4)}`);
        if (depth > -1e-9 && exposed(lat, i, j, k) && host.modeOf(lat.idAt(i, j, k)) !== MODE_STATIC) {
          // Touching or overlapping: the cell must be solid for the host.
          out.push(`body ${id} touches dormant cell ${i},${j},${k} that is not a static proxy`);
        }
      }
    }
  }
  return out;
}
