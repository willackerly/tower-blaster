// Mason's Trial's recorded builds (M8, docs/game/masons-trial.md): for each level,
// the author solutions that set its star points (each marked with the star it
// sets), a knife-edge build that passes in only some of its worlds (what the
// judge's verify compares islands and solo runs on: a build that passes
// everywhere or nowhere says nothing about agreement), and the obvious wrong
// builds that must fail. Programs, not part lists: each step goes through the
// real build tool (BuildSession: face hits, snap, overlap and budget) and may
// look at what the steps before it placed, so the tests check the bin as well.
//
// `measured`: the reference judge's passes in the level's 64 worlds and the
// build's cost (pnpm mason:judge). The level's stars are MASON_STAR_SHARE of the
// tier authors' points (masonStarsFrom); test/mason-levels.test.ts checks the
// levels say so, and with PHYSICS_GPU_SLOW=1 re-runs every 64-world judge (the
// reference is deterministic, so the passes must be equal).
import { BuildSession, floorTotal, type Hit, type Hold, type LevelDef, masonLines, MASON_WORLDS, MT1, MT2, MT3, MT4, MT5, type CatalogName } from '@tb/keystone';
import { ground, top } from './rube.ts';

/** One step of a build: an item at a face hit (computed from the session so far). */
export type MasonStep = (s: BuildSession) => { place: CatalogName; hit: Hit; yaw?: number; tip?: 0 | 1 | 2; slide?: number };

export interface MasonBuild {
  label: string;
  /** What does the work (a solution family). */
  family: string;
  steps: MasonStep[];
  /** Author solutions: the star they set. */
  tier?: 2 | 3;
  /** The reference judge in the level's worlds: passes and the build's cost. */
  measured?: { passes: number; spent: number };
}

/** Applies a program to a fresh BuildSession; null with the refusal when a step is refused. */
export function masonBuild(def: LevelDef, steps: readonly MasonStep[]): { def: LevelDef; spent: number } | { refused: string } {
  const s = new BuildSession(def);
  for (const f of steps) {
    const st = f(s), hold: Hold = { item: st.place, yaw: st.yaw ?? 0, tip: st.tip ?? 0, ...(st.slide ? { slide: st.slide } : {}) }, g = s.ghost(st.hit, hold);
    if (!s.place(g)) return { refused: `${st.place}: ${g.why}` };
  }
  return { def: s.def(), spent: s.spent() };
}

/**
 * `item` on the top face of body `b` where a ray straight down onto (x, z) h lands, slid `slide` half-cells out along its
 * length (Hold.slide): what a player can do. The test checks each step's hit is the face such a ray picks.
 */
/**
 * The steps a player could not make: those whose placement differs from what a ray straight down onto the step's
 * point picks (the face the pointer would be on), slid as held. A program's hit may name any point of a face, even one
 * past its edge, which no pointer reaches; an empty list means every step is a click on the level as built so far.
 */
export function masonUnreachable(def: LevelDef, steps: readonly MasonStep[]): string[] {
  const s = new BuildSession(def), out: string[] = [];
  steps.forEach((f, i) => {
    const st = f(s), p = st.hit.point, hold: Hold = { item: st.place, yaw: st.yaw ?? 0, tip: st.tip ?? 0, ...(st.slide ? { slide: st.slide } : {}) };
    const g = s.ghost(st.hit, hold), picked = s.pick({ origin: [p[0], p[1] + 20 * s.h, p[2]], dir: [0, -1, 0] });
    if (!picked || JSON.stringify(s.ghost(picked, hold).parts) !== JSON.stringify(g.parts)) out.push(`step ${i} (${st.place}): the pointer picks ${picked ? `body ${picked.body}` : 'nothing'} there`);
    s.place(g);
  });
  return out;
}

const on = (b: number, x: number, z = 0, item: CatalogName = 'cube', slide = 0): MasonStep => (s) => ({ place: item, hit: top(s, b, x, z), ...(slide ? { slide } : {}) });
const at = (x: number, z: number, item: CatalogName = 'cube', yaw = 0): MasonStep => (s) => ({ place: item, hit: ground(s, x, z), yaw });

/** MT1: slab L is body 5 (on the left ledge), slab R body 6; cubes stack on the slabs' back ends, off the ball's lane. */
const MT1_SLABS = [on(1, -0.6, 0, 'slab', 2), on(2, 4, 0, 'slab')];
/** Counterweights: n cubes on slab `b` at x, alternating z = 1 and -1, the third and fourth stacked on the first two. */
function weights(b: number, x: number, n: number, first: number): MasonStep[] {
  const out: MasonStep[] = [];
  for (let i = 0; i < n; i++) out.push(i < 2 ? on(b, x, i ? -1 : 1) : on(first + i - 2, x, i % 2 ? -1 : 1));
  return out;
}

export const MASON_SOLUTIONS: Record<string, MasonBuild[]> = {
  MT1: [
    { label: 'a pier of three in the middle of the gap under two slabs', family: 'pier', tier: 3, measured: { passes: 64, spent: 7 }, steps: [at(2, 0, 'pier3'), ...MT1_SLABS] },
    { label: 'two slabs cantilevered off the ledges, four cubes weighting each back end (corbels)', family: 'corbel', tier: 2, measured: { passes: 60, spent: 12 }, steps: [...MT1_SLABS, ...weights(5, -0.5, 4, 7), ...weights(6, 4.5, 4, 11)] },
  ],
  MT2: [
    { label: 'two piers of three and a plank roof', family: 'roof', tier: 3, measured: { passes: 64, spent: 8 }, steps: [at(-1, 0, 'pier3'), at(1, 0, 'pier3'), on(3, 1, 0, 'plank')] },
    { label: 'two piers of three and a beam roof', family: 'roof', tier: 2, measured: { passes: 63, spent: 9 }, steps: [at(-1, 0, 'pier3'), at(1, 0, 'pier3'), on(3, 1, 0, 'beam')] },
  ],
  MT3: [
    { label: 'a course of four two cells out in front of each hut', family: 'guards', tier: 3, measured: { passes: 64, spent: 8 }, steps: [at(-2, -2.5, 'course4', 90), at(-2, 1.6, 'course4', 90)] },
    { label: 'a wall of four by two in front of each hut', family: 'berm', tier: 2, measured: { passes: 64, spent: 16 }, steps: [at(0, -2.5, 'wall4x2', 90), at(0, 1.6, 'wall4x2', 90)] },
  ],
  MT4: [
    { label: 'a plank out over the edge, three cubes on its back end', family: 'counterweight', tier: 3, measured: { passes: 64, spent: 5 }, steps: [on(0, -0.5, 0, 'plank', 2), on(1, -1.5), on(1, -0.5), on(2, -1.5)] },
    { label: 'a plank out over the edge, four cubes on its back end', family: 'counterweight', tier: 2, measured: { passes: 64, spent: 6 }, steps: [on(0, -0.5, 0, 'plank', 2), on(1, -1.5), on(1, -0.5), on(2, -1.5), on(3, -0.5)] },
  ],
  MT5: [
    { label: 'a pier of three against the tower on the side the quake throws it (-x)', family: 'buttress', tier: 3, measured: { passes: 64, spent: 3 }, steps: [at(-1, 0, 'pier3')] },
    { label: 'a pier of three against the tower on each side along the quake', family: 'buttresses', tier: 2, measured: { passes: 64, spent: 6 }, steps: [at(-1, 0, 'pier3'), at(1, 0, 'pier3')] },
  ],
};

/** Builds that pass in only some worlds: the judge's verify (islands against solo runs) needs outcomes to differ. */
export const MASON_KNIFE: Record<string, MasonBuild> = {
  MT1: { label: 'corbels with four cubes on the left and three on the right', family: 'corbel', measured: { passes: 44, spent: 11 }, steps: [...MT1_SLABS, ...weights(5, -0.5, 4, 7), ...weights(6, 4.5, 3, 11)] },
  MT2: { label: 'a lean-to: one pier and a slab over the urn', family: 'lean-to', measured: { passes: 32, spent: 5 }, steps: [at(-1, 0, 'pier3'), on(3, -1, 0, 'slab')] },
  MT3: { label: 'a course of four close in front of each hut (a boulder can shove it into the hut)', family: 'guards', measured: { passes: 38, spent: 8 }, steps: [at(0, -2.5, 'course4', 90), at(0, 1.6, 'course4', 90)] },
  MT4: { label: 'a plank further out, two cubes on its back end', family: 'counterweight', measured: { passes: 46, spent: 4 }, steps: [on(0, 0, 0, 'plank'), on(1, -2), on(1, -1)] },
  MT5: { label: 'the pier half a cell off the tower (it rocks into the pier, hard)', family: 'buttress', measured: { passes: 14, spent: 3 }, steps: [at(-1.5, 0, 'pier3')] },
};

/** The obvious wrong builds: every one must fail (fewer than half its worlds pass). */
export const MASON_WRONG: Record<string, MasonBuild[]> = {
  MT1: [
    { label: 'nothing (the ball falls into the gap)', family: 'none', steps: [] },
    { label: 'two slabs with no weights (they tip into the gap)', family: 'corbel', steps: MT1_SLABS },
    { label: 'a pier with nothing on it', family: 'pier', steps: [at(2, 0, 'pier3')] },
  ],
  MT2: [
    { label: 'nothing (the collapse knocks the urn over)', family: 'none', steps: [] },
    { label: 'a slab laid on the urn (the blocks drive it down)', family: 'lid', steps: [on(0, 0, 0, 'slab')] },
  ],
  MT3: [
    { label: 'nothing (the boulders hit the huts)', family: 'none', steps: [] },
    { label: 'a cube in front of each hut (the boulders roll it into them)', family: 'guards', steps: [at(0, -1.5), at(0, 1.5)] },
  ],
  MT4: [
    { label: 'nothing (the weight falls to the floor)', family: 'none', steps: [] },
    { label: 'a bare plank out over the edge (it tips under the weight)', family: 'counterweight', steps: [on(0, -0.5, 0, 'plank', 2)] },
    { label: 'a plank with one cube on its back end', family: 'counterweight', steps: [on(0, -0.5, 0, 'plank', 2), on(1, -1.5)] },
  ],
  MT5: [
    { label: 'nothing (the quake fells the tower)', family: 'none', steps: [] },
    { label: 'the pier on the other side (+x: the tower falls away from it)', family: 'buttress', steps: [at(1, 0, 'pier3')] },
    { label: 'two cubes stacked against it (too low)', family: 'buttress', steps: [at(-1, 0), on(6, -1)] },
    { label: 'a course of four along its foot (too low)', family: 'skirt', steps: [at(-1, 0, 'course4', 90)] },
  ],
};

/** The share of an author build's points its tier's threshold takes: slack for judge noise and for the GPU against the reference. */
export const MASON_STAR_SHARE = 0.9;

/** A build's points (the two lines' total) at `passes` of K worlds and `spent` of the level's budget. */
export const masonPointsOf = (def: LevelDef, passes: number, spent: number, K = MASON_WORLDS): number => floorTotal(masonLines(passes, K, (def.build?.budget ?? 0) - spent, def.build?.budget ?? 0));

/** The level's star points from its tier authors' measured runs: MASON_STAR_SHARE of their points, floored to 10. */
export function masonStarsFrom(def: LevelDef, builds: readonly MasonBuild[]): [number, number] {
  const tier = (t: 2 | 3) => {
    const b = builds.find((x) => x.tier === t);
    if (!b?.measured) throw new Error(`${def.id}: no measured tier-${t} author build`);
    return Math.floor((MASON_STAR_SHARE * masonPointsOf(def, b.measured.passes, b.measured.spent)) / 10) * 10;
  };
  return [tier(2), tier(3)];
}

export const MASON_LEVEL_DEFS: readonly LevelDef[] = [MT1, MT2, MT3, MT4, MT5];
