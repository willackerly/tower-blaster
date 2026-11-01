// A scenario as a level part (docs/game/spectacle-mode.md, G2.3): any of the
// benchmark scenes (@tb/scenarios: the S3 wall, the S4 city, S14 buildings,
// the S15 Kapla tower) built from its params and seed, its bodies placed at
// the level's scale, and roles given by selectors. Scenarios already have
// parameters, seeds, viewer controls and saved scenes; a scenario part reuses
// all of them, beside authored blocks and slabs.
import type { BodyDesc, Vec3 } from '@tb/engine-api';
import { buildScenario, type Params, SCENARIOS } from '@tb/scenarios';
import type { LevelDef } from './level.ts';
import type { MaterialName, Role } from './materials.ts';
import type { RackItem } from './rack.ts';

/**
 * Which bodies of a scenario part get a role. Every condition given must hold (an empty rule picks
 * every body); rules apply in order, a later one overriding an earlier one. Coordinates are the
 * scenario's own (unit cubes, before `at` and the level's scale).
 */
export interface RoleRule {
  role: Role;
  /** The body's centre inside this box (inclusive), scenario units. */
  box?: { min: Vec3; max: Vec3 };
  /** Course: floor of the body's bottom height in scenario units; a number or an inclusive range. */
  course?: number | [number, number];
  /** Only the highest body of each column (bodies whose centres share x and z to 1e-6). */
  top?: boolean;
  /** The scenario's own body tag: the tower index in S4 and S14, the storey in S15. */
  tag?: number | number[];
}

/**
 * A scenario's bodies as part of a level. Positions are the scenario's times the level's unit h,
 * horizontal ones also times the pitch (1 + gap): cube lattices get the level's gap between cells, as
 * block parts do. `gap` overrides it for this part (0 keeps the scenario's exact layout, as interlocking
 * Kapla planks need). Every body takes the part's material; the scenario's own inputs (S15's topple ball)
 * are dropped: a level's shots are its only input.
 */
export interface ScenarioPart {
  kind: 'scenario';
  /** A scenario id, S1 to S15. */
  id: string;
  /** Overrides of the scenario's defaults (ScenarioDef.defaults). */
  params?: Params;
  /** Default 1, as the viewer's. */
  seed?: number;
  /** Offset in cells (x, z) and h (y) added to every body; default [0, 0, 0]. */
  at?: Vec3;
  material: MaterialName;
  /** Default role for bodies no rule picks (default plain). */
  role?: Role;
  roles?: RoleRule[];
  gap?: number;
}

export interface ScenarioBody { pos: Vec3; half: Vec3; rot: BodyDesc['rot']; role: Role }

const EPS = 1e-6;

/** Whether rule r picks body i (its scenario description b); `tops` marks the top body of each column. */
function picks(r: RoleRule, b: BodyDesc, tops: Uint8Array, i: number): boolean {
  const half = (b.shape as { half: Vec3 }).half;
  if (r.box && ![0, 1, 2].every((k) => b.pos[k]! >= r.box!.min[k]! - EPS && b.pos[k]! <= r.box!.max[k]! + EPS)) return false;
  if (r.course !== undefined) {
    const c = Math.floor(b.pos[1] - half[1] + EPS);
    const [lo, hi] = typeof r.course === 'number' ? [r.course, r.course] : r.course;
    if (c < lo || c > hi) return false;
  }
  if (r.top && !tops[i]) return false;
  if (r.tag !== undefined && !(typeof r.tag === 'number' ? [r.tag] : r.tag).includes(b.tag)) return false;
  return true;
}

/** The highest body of each column, by centre x and z rounded to 1e-6. */
function columnTops(bodies: readonly BodyDesc[]): Uint8Array {
  const best = new Map<string, number>();
  bodies.forEach((b, i) => {
    const key = `${Math.round(b.pos[0] / EPS)},${Math.round(b.pos[2] / EPS)}`, j = best.get(key);
    if (j === undefined || b.pos[1] > bodies[j]!.pos[1]) best.set(key, i);
  });
  const tops = new Uint8Array(bodies.length);
  for (const i of best.values()) tops[i] = 1;
  return tops;
}

/**
 * The part's bodies in the scenario's order, in metres: h the level's unit, `pitch` its horizontal
 * pitch (1 + gap) unless the part sets its own gap. Throws for an unknown scenario or param, or a
 * scenario body that is not a box.
 */
export function scenarioBodies(part: ScenarioPart, h: number, pitch: number): ScenarioBody[] {
  if (!SCENARIOS[part.id]) throw new Error(`unknown scenario ${part.id}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const scene = buildScenario(part.id, part.params ?? {}, part.seed ?? 1);
  const p = part.gap === undefined ? pitch : 1 + part.gap;
  const at = part.at ?? [0, 0, 0];
  const tops = part.roles?.some((r) => r.top) ? columnTops(scene.bodies) : new Uint8Array(0);
  return scene.bodies.map((b, i) => {
    if (b.shape.kind !== 'box') throw new Error(`scenario ${part.id} body ${i} is a ${b.shape.kind}: a level part takes boxes only`);
    let role: Role = part.role ?? 'plain';
    for (const r of part.roles ?? []) if (picks(r, b, tops, i)) role = r.role;
    const half = b.shape.half;
    return {
      pos: [(at[0] + b.pos[0]) * p * h, (at[1] + b.pos[1]) * h, (at[2] + b.pos[2]) * p * h],
      half: [half[0] * h, half[1] * h, half[2] * h],
      rot: b.rot,
      role,
    };
  });
}

/**
 * The part as the level hash sees it: params at the scenario's defaults and seed 1 left out, the
 * other params in key order, so writing a default out names the same level.
 */
export function scenarioKey(part: ScenarioPart): ScenarioPart {
  const defaults = SCENARIOS[part.id]?.defaults ?? {};
  const params = Object.fromEntries(Object.entries(part.params ?? {}).filter(([k, v]) => defaults[k] !== v).sort(([a], [b]) => (a < b ? -1 : 1)));
  const { params: _p, seed, ...rest } = part;
  return { ...rest, ...(Object.keys(params).length ? { params } : {}), ...(seed !== undefined && seed !== 1 ? { seed } : {}) };
}

/** What an automatic level gives a scenario (spectacle-mode.md, section 10) unless told otherwise. */
export const AUTO_LEVEL = { objective: 0.3, rack: ['cannonball', 'cannonball', 'w-grenade'], material: 'plaster' } as const;

/**
 * Any scenario as an outcome level: its bodies as one scenario part with no roles, objective "bring 30%
 * down", stars uncast, a launcher ring just outside the structure, and the rack given (default two
 * cannonballs and the built-in grenade, spectacle-mode.md section 10). The lot is the structure's footprint grown by 2 cells. S15's planks keep their exact
 * layout (gap 0); cube scenes get the level's gap.
 */
export function scenarioLevel(id: string, params: Params = {}, seed = 1, opts: { rack?: readonly RackItem[]; material?: MaterialName } = {}): LevelDef {
  const def = SCENARIOS[id];
  if (!def) throw new Error(`unknown scenario ${id}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const bodies = buildScenario(id, params, seed).bodies;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  for (const b of bodies) {
    const half = b.shape.kind === 'box' ? b.shape.half : [b.shape.radius, b.shape.radius, b.shape.radius];
    x0 = Math.min(x0, b.pos[0] - half[0]!); x1 = Math.max(x1, b.pos[0] + half[0]!);
    z0 = Math.min(z0, b.pos[2] - half[2]!); z1 = Math.max(z1, b.pos[2] + half[2]!);
    top = Math.max(top, b.pos[1] + half[1]!);
  }
  if (!bodies.length) { x0 = z0 = -1; x1 = z1 = 1; }
  const rack = [...(opts.rack ?? AUTO_LEVEL.rack)];
  const part: ScenarioPart = { kind: 'scenario', id, ...(Object.keys(params).length ? { params } : {}), seed, material: opts.material ?? AUTO_LEVEL.material, ...(id === 'S15' ? { gap: 0 } : {}) };
  return {
    id, name: def.title, version: 1, world: 0, scoring: 'outcome',
    parts: [part],
    lot: { min: [x0 - 2, z0 - 2], max: [x1 + 2, z1 + 2] },
    crownLine: 2,
    objective: { kind: 'collapse', min: AUTO_LEVEL.objective },
    par: rack.length, rack,
    launcher: { radius: Math.hypot(x1 - x0, z1 - z0) / 2 + 4, y: 2, dropY: Math.ceil(top) + 4 },
  };
}
