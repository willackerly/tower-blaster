// Rube Lab's bot (M10, docs/game/rube-lab.md): plays a contraption level as built
// through the real Driver and Session (pre-settle, the plunger's release charge,
// the bell read from the watched crowns) on the reference engine, and searches
// builds the way a player makes them: BuildSession ghosts from face hits (snap
// on), so every candidate is a placement the build tool allows (no overlap, in
// budget, offered). A search is a list of build programs; each clears or not.
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, BuildSession, compileLevel, type Hit, type Hold, type LevelDef, type P2, RUBE_GO, type RubeResult, rubePlay, type Shot, smoothStroke, type CatalogName } from '@tb/keystone';
import type { PhysicsEngine } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';

/** The plunger that starts every Rube Lab level (keystone rube-play.ts RUBE_GO). */
export const GO: Shot = RUBE_GO;

export interface RubePlay extends RubeResult { spent: number }

/** Plays `def` (already built) with one plunger on `make()` (default the reference at Keystone's settings). */
export async function playRube(def: LevelDef, make: () => PhysicsEngine = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP }), spent = 0): Promise<RubePlay> {
  const e = make();
  try { return { ...(await rubePlay(e, compileLevel(def))), spent }; } finally { e.dispose(); }
}

/** One step of a build program: place an item at a face hit, or lay a domino stroke. */
export type BuildStep =
  | { place: CatalogName; hit: Hit; yaw?: number; tip?: 0 | 1 | 2 }
  | { stroke: P2[] };

/** A ground hit at (x, z) h. */
export const ground = (s: BuildSession, x: number, z: number): Hit => ({ body: -1, point: [x * s.h, 0, z * s.h], normal: [0, 1, 0], t: 0 });
/** A hit on the top face of body `b` at (x, z) h. */
export function top(s: BuildSession, b: number, x: number, z: number): Hit {
  const body = s.compiled().scene.bodies[b]!, half = body.shape.kind === 'box' ? body.shape.half[1] : body.shape.radius;
  return { body: b, point: [x * s.h, body.pos[1] + half, z * s.h], normal: [0, 1, 0], t: 0 };
}

/** Applies a program to a fresh BuildSession of `def`; null when any step is refused (overlap, budget, ...). */
export function build(def: LevelDef, steps: readonly BuildStep[] | ((s: BuildSession) => BuildStep[])): { def: LevelDef; spent: number } | null {
  const s = new BuildSession(def), list = typeof steps === 'function' ? steps(s) : steps;
  for (const st of list) {
    if ('stroke' in st) { const g = s.stroke(smoothStroke(st.stroke)); if (!s.lay(g)) return null; continue; }
    const hold: Hold = { item: st.place, yaw: st.yaw ?? 0, tip: st.tip ?? 0 };
    if (!s.place(s.ghost(st.hit, hold))) return null;
  }
  return { def: s.def(), spent: s.spent() };
}

export interface Candidate { label: string; family: string; steps: BuildStep[] | ((s: BuildSession) => BuildStep[]) }
export interface Found { label: string; family: string; spent: number; rungAt: number }

/** Plays every candidate that builds; returns those that clear (and how many were refused or failed). */
export async function search(def: LevelDef, cands: readonly Candidate[]): Promise<{ clears: Found[]; refused: number; failed: Found[] }> {
  const clears: Found[] = [], failed: Found[] = [];
  let refused = 0;
  for (const c of cands) {
    const b = build(def, c.steps);
    if (!b) { refused++; continue; }
    const p = await playRube(b.def, undefined, b.spent);
    (p.cleared ? clears : failed).push({ label: c.label, family: c.family, spent: b.spent, rungAt: p.rungAt });
  }
  return { clears, refused, failed };
}
