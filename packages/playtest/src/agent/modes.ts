// The agent playtest's moves for the build-and-fire modes (round 2, docs/game/agent-playtest-2.md): how the
// harness plays Fuse & Fold's sweep, and how it builds a Rube Lab level's or a retrofit's recorded solution on the game page
// through the same keys and pointer rays a player's mouse gives (GameHandle.edit.key and edit.ray), so a
// build that clears in the lab is built the way a person would build it. Pure: run.ts replays the actions,
// test/agent-modes.test.ts replays them through the page's own EditController in node.
import type { Vec3 } from '@tb/engine-api';
import { BuildSession, FOLD_SITES, type Hold, type LevelDef, smoothStroke } from '@tb/keystone';
import { RETROFIT_SOLUTIONS, retrofitSteps } from '../../../keystone-lab/src/retrofit-solutions.ts';
import { RUBE_SOLUTIONS } from '../../../keystone-lab/src/rube-solutions.ts';
import type { BuildStep } from '../../../keystone-lab/src/rube.ts';

/** A pointer ray straight down onto a point (every recorded build's hits are on up-facing faces or the ground). */
export interface DownRay { origin: Vec3; dir: Vec3 }
export type EditAction =
  | { key: string; shift?: boolean }
  | { ray: 'move' | 'down' | 'up'; at: DownRay };

/** How far above a hit the pointer's ray starts (h are 1 m here; the tallest Rube Lab part stands under 10 m). */
export const RAY_HEIGHT = 40;
const down = (p: readonly number[]): DownRay => ({ origin: [p[0]!, p[1]! + RAY_HEIGHT, p[2]!], dir: [0, -1, 0] });

/** Turns (in Shift-Q / Shift-E presses of 15 deg) from one yaw to another, the short way round. */
export function yawPresses(from: number, to: number): { key: 'q' | 'e'; n: number } {
  const d = (((to - from) % 360) + 360) % 360;
  return d <= 180 ? { key: 'e', n: Math.round(d / 15) } : { key: 'q', n: Math.round((360 - d) / 15) };
}

/**
 * The page actions that build `steps` on `def` as a player would: an item's number key, Shift-Q/E to turn it,
 * T to tip it, then the pointer moved to the hit and released (a click); a stroke is B (the domino brush), a press,
 * the drag through its points (on the ground under them), and the release. Throws when a step names an item the
 * level's bin does not offer as a number key (1 to 9).
 */
export function buildActions(def: LevelDef, steps: readonly BuildStep[] | ((s: BuildSession) => BuildStep[])): EditAction[] {
  const s = new BuildSession(def), list = typeof steps === 'function' ? steps(s) : steps, h = s.h;
  const out: EditAction[] = [];
  const first = s.items[0]?.name;
  let hold: Hold = { item: (first ?? 'cube') as Hold['item'], yaw: 0, tip: 0 }, brush = false;
  for (const st of list) {
    if ('stroke' in st) {
      if (!brush) { out.push({ key: 'b' }); brush = true; }
      const pts = st.stroke.map(([x, z]): Vec3 => [x * h, 0, z * h]);
      out.push({ ray: 'down', at: down(pts[0]!) });
      for (const p of pts) out.push({ ray: 'move', at: down(p) });
      out.push({ ray: 'up', at: down(pts[pts.length - 1]!) });
      // The lab lays the same stroke (smoothed), so the session below stays in step with the page.
      if (!s.lay(s.stroke(smoothStroke(st.stroke)))) throw new Error(`${def.id}: the stroke was refused`);
      continue;
    }
    const idx = s.items.findIndex((i) => i.name === st.place);
    if (idx < 0 || idx > 8) throw new Error(`${def.id}: ${st.place} is not a number key in this bin`);
    if (brush || hold.item !== st.place) { out.push({ key: String(idx + 1) }); brush = false; hold = { ...hold, item: st.place }; }
    const t = yawPresses(hold.yaw, st.yaw ?? 0);
    for (let i = 0; i < t.n; i++) out.push({ key: t.key, shift: true });
    for (let i = 0; i < (((st.tip ?? 0) - hold.tip + 3) % 3); i++) out.push({ key: 't' });
    hold = { ...hold, yaw: st.yaw ?? 0, tip: st.tip ?? 0 };
    out.push({ ray: 'move', at: down(st.hit.point) }, { ray: 'up', at: down(st.hit.point) });
    if (!s.place(s.ghost(st.hit, { item: st.place, yaw: st.yaw ?? 0, tip: st.tip ?? 0 }))) throw new Error(`${def.id}: a step was refused`);
  }
  return out;
}

/** A Rube Lab level's recorded build (its first: the cheapest, the parts par) as page actions; null when it has none. */
export function rubeLine(def: LevelDef): { label: string; actions: EditAction[] } | null {
  const b = RUBE_SOLUTIONS[def.id]?.[0];
  return b ? { label: b.label, actions: buildActions(def, b.steps) } : null;
}

/** An Aftershock retrofit's recorded bracing (its first: the three-star one) as page actions; null when it has none. */
export function retrofitLine(def: LevelDef): { label: string; actions: EditAction[] } | null {
  const b = RETROFIT_SOLUTIONS[def.id]?.[0];
  return b ? { label: b.label, actions: buildActions(def, retrofitSteps(def, b)) } : null;
}

/** A level's recorded build as page actions (a Rube Lab build, else a retrofit's bracing); null when it has none. */
export const buildLine = (def: LevelDef) => rubeLine(def) ?? retrofitLine(def);

/** Fuse & Fold's sweep for a level: toward its site's first yard (the side the building may fall into). */
export function fuseSweep(def: LevelDef): string {
  const site = Object.values(FOLD_SITES).find((s) => s.name === def.name);
  if (!site) throw new Error(`${def.id}: no fold site named ${def.name}`);
  const yard = site.site.yards?.[0];
  if (!yard) throw new Error(`${def.id}: its site has no yard`);
  return yard.side;
}
