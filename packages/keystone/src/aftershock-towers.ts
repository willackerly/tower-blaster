// Aftershock's towers (M7, docs/game/aftershock.md): the parametric towers its levels are made of and its design
// search measures (keystone-lab quake-search.ts). A tower is named by a short id, so a level, a threshold curve and
// a CLI argument all say the same thing:
//
//   col<n>        a column of n unit cubes                          (aspect 1/n, small)
//   slab<n>x<w>   n slabs of w x 1 x w cells, one per storey         (aspect w/n, large: same slenderness, bigger block)
//   wall<n>x<w>   n rods of 1 x 1 x w, long along z (or x, yawed)    (thin across, wide along: the axis lever)
//
// with optional suffixes: -<material> (stone, iron, rubber, ice; default plaster) and -anchor (the bottom storey
// pinned: bolted to bedrock, C8). The top body is the tower's crown (condemned) or heritage (protected).
import type { Vec3 } from '@tb/engine-api';
import type { BlockPart, BoxPart, Part } from './level.ts';
import type { MaterialName, Role } from './materials.ts';

export type TowerKind = 'col' | 'slab' | 'wall';
export interface TowerSpec { kind: TowerKind; n: number; w: number; material: MaterialName; anchor: boolean }

const KINDS: readonly TowerKind[] = ['col', 'slab', 'wall'];
const MATS: readonly MaterialName[] = ['plaster', 'stone', 'iron', 'rubber', 'ice'];

/** A tower id (col6, slab9x3, wall8x2-stone, col5-anchor) as a spec; throws naming what is wrong. */
export function parseTower(id: string): TowerSpec {
  const [head, ...suffix] = id.split('-');
  const m = /^(col|slab|wall)(\d+)(?:x(\d+))?$/.exec(head ?? '');
  if (!m) throw new Error(`tower ${JSON.stringify(id)}: want col<n>, slab<n>x<w> or wall<n>x<w>, then -<material> or -anchor`);
  const kind = m[1] as TowerKind, n = Number(m[2]), w = m[3] === undefined ? 1 : Number(m[3]);
  if (kind === 'col' && m[3] !== undefined) throw new Error(`tower ${id}: a column is one cube across (col<n>)`);
  if (kind !== 'col' && m[3] === undefined) throw new Error(`tower ${id}: give its width, ${kind}<n>x<w>`);
  if (!(n >= 2 && n <= 24 && w >= 1 && w <= 6)) throw new Error(`tower ${id}: 2 to 24 storeys, 1 to 6 cells wide`);
  let material: MaterialName = 'plaster', anchor = false;
  for (const s of suffix) {
    if (s === 'anchor') anchor = true;
    else if ((MATS as readonly string[]).includes(s)) material = s as MaterialName;
    else throw new Error(`tower ${id}: unknown suffix -${s} (want -anchor or one of ${MATS.join(', ')})`);
  }
  if (!KINDS.includes(kind)) throw new Error(`tower ${id}: unknown kind`);
  return { kind, n, w, material, anchor };
}

/** A spec's id (parseTower's inverse). */
export function towerId(t: TowerSpec): string {
  return `${t.kind}${t.n}${t.kind === 'col' ? '' : `x${t.w}`}${t.material === 'plaster' ? '' : `-${t.material}`}${t.anchor ? '-anchor' : ''}`;
}

/** Footprint in cells along x and z (a wall long along z unless yawed). */
export function towerFootprint(t: TowerSpec, yawed = false): [number, number] {
  if (t.kind === 'col') return [1, 1];
  if (t.kind === 'slab') return [t.w, t.w];
  return yawed ? [t.w, 1] : [1, t.w];
}

/** Height in h (one per storey). */
export const towerHeight = (t: TowerSpec): number => t.n;

/**
 * The parts of tower `t` with its footprint's min corner at cell (x, z): its top body takes `role`, the rest are
 * plain; `yawed` lays a wall along x instead of z. Cubes for a column (a BlockPart, so it compiles as Keystone's
 * lattice does, gaps and all), one box per storey for slabs and walls.
 */
export function towerParts(t: TowerSpec, at: [number, number], role: Role, yawed = false): Part[] {
  const [fx, fz] = towerFootprint(t, yawed), out: Part[] = [];
  const pin = (k: number) => (t.anchor && k === 0 ? { pinned: true as const } : {});
  if (t.kind === 'col') {
    for (let k = 0; k < t.n; k++) {
      const p: BlockPart = { kind: 'block', at: [at[0], k, at[1]], size: [1, 1, 1], material: t.material, ...(k === t.n - 1 ? { role } : {}), ...pin(k) };
      out.push(p);
    }
    return out;
  }
  // A box part's `at` is (centre x, bottom y, centre z), x and z in cells (compileLevel applies the lattice pitch),
  // and its half-extents are in h: a w-cell box centred on its cells, w h across (the cells less their gaps).
  const half: Vec3 = [fx / 2, 0.5, fz / 2];
  for (let k = 0; k < t.n; k++) {
    const p: BoxPart = { kind: t.kind === 'slab' ? 'slab' : 'rod', at: [at[0] + fx / 2, k, at[1] + fz / 2], half, material: t.material, ...(k === t.n - 1 ? { role } : {}), ...pin(k) };
    out.push(p);
  }
  return out;
}
