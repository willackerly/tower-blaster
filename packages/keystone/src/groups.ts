// Tagged reductions (docs/game/modes-roadmap.md, capability C6): named groups
// of structure bodies, chosen by authored part, role, material and region, and
// what happened to each as counts. Side goals (goals.ts, the Lot Sheet) ask
// "did only the north tower fall?" and the hot-seat duel (duel.ts) asks "how
// much of each player's keep is down?"; both read these. Like rules.ts, a
// reduction is a pure function of a snapshot: integer counts and integer
// millijoules, so any order (and a later GPU reduction) gives the same answer.
//
// A group is not part of a level: it is selected against a compiled level by
// whoever asks (a lot sheet, a duel), so adding one never changes a level's
// hash and never drops its cast stars.
import type { Snapshot } from '@tb/engine-api';
import { type CompiledLevel, ROLE_ID } from './level.ts';
import { materialId, type MaterialName, type Role } from './materials.ts';
import { DISPLACED, outsideLot, peOf_mJ } from './rules.ts';

/**
 * Which structure bodies a group holds: every condition given must hold (and), each list matches any
 * of its entries (or). `parts` are indices into LevelDef.parts; `box` is a region the body's home
 * centre lies in, [x, y, z] corners with x and z in cells (the lot's units) and y in h. An empty
 * selector holds every structure body.
 */
export interface GroupSel {
  parts?: number[];
  roles?: Role[];
  materials?: MaterialName[];
  box?: { min: [number, number, number]; max: [number, number, number] };
}

/** What a group's bodies did, as of one snapshot. */
export interface GroupReduction {
  /** Bodies in the group. */
  n: number;
  /**
   * Down: centre more than DISPLACED h below its home height, or outside the lot. A body that only
   * slides stays up (it counts as displaced); a bottom-course body is down only once it leaves the lot.
   */
  down: number;
  /** More than DISPLACED h from their home (the pose play started from). */
  displaced: number;
  /** Centre outside the lot grown by 0.5 h (rules.ts Reductions.outOfLot). */
  outOfLot: number;
  /** Potential energy now and at home, integer mJ. */
  pe_mJ: number;
  pe0_mJ: number;
}

/** Throws unless sel is a well-formed selector for level c, naming `where` and the field at fault. */
export function checkGroup(c: CompiledLevel, sel: GroupSel, where = 'group'): void {
  const known = new Set(['parts', 'roles', 'materials', 'box']);
  for (const k of Object.keys(sel)) if (!known.has(k)) throw new Error(`${where}: unknown field ${k}`);
  for (const p of sel.parts ?? []) if (!(Number.isInteger(p) && p >= 0 && p < c.def.parts.length)) throw new Error(`${where}.parts: ${p} is not a part of ${c.def.id} (0 to ${c.def.parts.length - 1})`);
  for (const r of sel.roles ?? []) if (!(r in ROLE_ID)) throw new Error(`${where}.roles: unknown role ${String(r)}`);
  for (const m of sel.materials ?? []) if (materialId(m) < 0) throw new Error(`${where}.materials: unknown material ${String(m)}`);
  if (sel.box) for (let k = 0; k < 3; k++) {
    const lo = sel.box.min[k], hi = sel.box.max[k];
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo! <= hi!)) throw new Error(`${where}.box: axis ${'xyz'[k]} needs finite min <= max, got ${lo} and ${hi}`);
  }
}

/** The structure bodies sel holds in level c, ascending. Throws on a malformed selector (checkGroup). */
export function selectGroup(c: CompiledLevel, sel: GroupSel, where?: string): Int32Array {
  checkGroup(c, sel, where);
  const m = c.meta, p = c.frame.pitch * c.frame.unit, h = c.frame.unit;
  const parts = sel.parts && new Set(sel.parts), roles = sel.roles && new Set(sel.roles.map((r) => ROLE_ID[r]));
  const mats = sel.materials && new Set(sel.materials.map(materialId));
  const out: number[] = [];
  for (let i = 0; i < m.n; i++) {
    if (parts && !parts.has(m.part[i]!)) continue;
    if (roles && !roles.has(m.role[i]!)) continue;
    if (mats && !mats.has(m.material[i]!)) continue;
    if (sel.box) {
      const x = m.home[3 * i]! / p, y = m.home[3 * i + 1]! / h, z = m.home[3 * i + 2]! / p, { min, max } = sel.box;
      if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) continue;
    }
    out.push(i);
  }
  return Int32Array.from(out);
}

/** The reduction of the bodies `idx` in snapshot s, against `home` (3 per structure body; default the authored poses). */
export function reduceGroup(s: Snapshot, c: CompiledLevel, idx: Int32Array, home: ArrayLike<number> = c.meta.home): GroupReduction {
  const m = c.meta, drop = DISPLACED * c.frame.unit, d2 = drop * drop, grow = 0.5 * c.frame.unit;
  const r: GroupReduction = { n: idx.length, down: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, pe0_mJ: 0 };
  for (const i of idx) {
    const x = s.pos[3 * i]!, y = s.pos[3 * i + 1]!, z = s.pos[3 * i + 2]!;
    if (home[3 * i + 1]! - y > drop || outsideLot(c, x, z)) r.down++;
    const dx = x - home[3 * i]!, dy = y - home[3 * i + 1]!, dz = z - home[3 * i + 2]!;
    if (dx * dx + dy * dy + dz * dz > d2) r.displaced++;
    if (outsideLot(c, x, z, grow)) r.outOfLot++;
    r.pe_mJ += peOf_mJ(m.mass[i]!, y);
    r.pe0_mJ += peOf_mJ(m.mass[i]!, home[3 * i + 1]!);
  }
  return r;
}

/** Selects and reduces every named group at once: the shape a lot sheet and a duel read. */
export function reduceGroups(s: Snapshot, c: CompiledLevel, groups: Readonly<Record<string, Int32Array>>, home?: ArrayLike<number>): Record<string, GroupReduction> {
  return Object.fromEntries(Object.entries(groups).map(([k, idx]) => [k, reduceGroup(s, c, idx, home)]));
}

/** Selects every named group of `sels` in level c (selectGroup), naming the group in any error. */
export function selectGroups(c: CompiledLevel, sels: Readonly<Record<string, GroupSel>>): Record<string, Int32Array> {
  return Object.fromEntries(Object.entries(sels).map(([k, sel]) => [k, selectGroup(c, sel, `groups.${k}`)]));
}
