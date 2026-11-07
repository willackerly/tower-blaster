// The Rube Lab gate's search (M10, docs/game/rube-lab.md): for each of the three
// gate puzzles, the builds a player can make in a zone near where the contraption
// has to do something, generated as the build tool makes them (rube.ts: ghosts
// from face hits, snap on, hits only on faces that exist), deduplicated by the
// level they build, played on the reference, and the clears grouped into
// families (what mechanism does the work). A clear counts only if it is robust:
// it clears on at least ROBUST of NUDGES builds with every placed part nudged
// up to NUDGE h across the ground (seeded), so a knife-edge build is not a solution.
import { BuildSession, compileLevel, type CatalogName, type LevelDef, type Part, RL1, RL2, RL3, RL4, RL5 } from '@tb/keystone';
import { build, type BuildStep, type Candidate, ground, playRube, top } from './rube.ts';
import { arc, line, RUBE_WRONG } from './rube-solutions.ts';

export const NUDGES = 8, ROBUST = 6, NUDGE = 0.05;

const range = (a: number, b: number, step: number): number[] => { const out: number[] = []; for (let x = a; x <= b + 1e-9; x += step) out.push(+x.toFixed(6)); return out; };

/** Single placements of `items` at ground hits over a zone (x0..x1, z0..z1, h) at each yaw. */
function groundSingles(family: (item: CatalogName, yaw: number) => string, items: CatalogName[], xs: number[], zs: number[], yaws: number[], tip: 0 | 1 | 2 = 0): Candidate[] {
  const out: Candidate[] = [];
  for (const item of items) for (const yaw of yaws) for (const x of xs) for (const z of zs) out.push({ label: `${item}${tip ? ` tip${tip}` : ''} yaw ${yaw} at ground ${x},${z}`, family: family(item, yaw), steps: (s) => [{ place: item, hit: ground(s, x, z), yaw, tip }] });
  return out;
}

/** Single placements on the top face of body `b`, at hits (x, z) inside it. */
function topSingles(family: (item: CatalogName) => string, s0: BuildSession, b: number, items: CatalogName[], xs: number[], zs: number[], yaws: number[]): Candidate[] {
  const body = s0.compiled().scene.bodies[b]!, h = s0.h, half = body.shape.kind === 'box' ? body.shape.half : [0, 0, 0];
  const inside = (x: number, z: number) => Math.abs(x * h - body.pos[0]) <= half[0]! && Math.abs(z * h - body.pos[2]) <= half[2]!;
  const out: Candidate[] = [];
  for (const item of items) for (const yaw of yaws) for (const x of xs) for (const z of zs) if (inside(x, z)) out.push({ label: `${item} yaw ${yaw} on body ${b} at ${x},${z}`, family: family(item), steps: (s) => [{ place: item, hit: top(s, b, x, z), yaw }] });
  return out;
}

/** The candidates for each gate puzzle, and its obvious wrong builds (expected to fail). */
export interface GatePuzzle { def: LevelDef; cands: Candidate[]; wrong: Candidate[] }

export function gatePuzzles(): GatePuzzle[] {
  // RL1: fills in the gap (x 0..1.5) and spans laid on either shelf's top near the gap.
  const s1 = new BuildSession(RL1);
  const rl1: GatePuzzle = {
    def: RL1,
    cands: [
      ...groundSingles(() => 'fill (a pier in the gap)', ['pier3'], range(0, 1.5, 0.25), [-0.5, 0, 0.5], [0]),
      ...[2, 3].flatMap((b) => topSingles((it) => `span (a ${it} across)`, s1, b, ['slab', 'plank', 'beam'], b === 2 ? range(-3, 0, 0.25) : range(1.5, 4.5, 0.25), [-0.5, 0, 0.5], [0, 90])),
    ],
    wrong: RUBE_WRONG.RL1!,
  };
  // RL2: turners (a wall or a fixed bumper at an angle) on the ball's line, and domino runs from the ball's line to the bell.
  const turnYaws = [-15, -30, -45, -60];
  const rl2: GatePuzzle = {
    def: RL2,
    cands: [
      ...groundSingles(() => 'turn (a fixed bumper)', ['bumper'], range(4, 14, 1), [-0.5, 0, 0.5], turnYaws),
      ...[3, 4, 5, 6, 7, 8].flatMap((x0) => [10, 11, 12].map((x1): Candidate => ({ label: `run arc from ${x0},0 to ${x1},5`, family: 'relay (a domino run)', steps: [{ stroke: arc(x0, 0, x1, 5) }] }))),
      ...groundSingles((it) => `turn (a free ${it})`, ['beam', 'wall4x2'], range(5, 13, 1), [0], turnYaws),
    ],
    wrong: RUBE_WRONG.RL2!,
  };
  // RL3: a fixed ramp up to the shelf (foot x on the ground, rising +x), dominoes and planks on end in front of the shelf, and runs into them.
  const rl3: GatePuzzle = {
    def: RL3,
    cands: [
      ...groundSingles(() => 'ramp up', ['ramp'], range(4, 9, 0.5), [0], [0]),
      ...groundSingles(() => 'topple (domino)', ['domino'], range(8, 11.5, 0.5), [0], [0, 90]),
      ...groundSingles(() => 'topple (plank on end)', ['plank'], range(6, 11.5, 0.5), [0], [0], 1),
      ...[3, 4, 5].flatMap((x0) => [9, 10, 10.5, 11].map((x1): Candidate => ({ label: `run from ${x0} to ${x1}`, family: 'topple (domino run)', steps: [{ stroke: line(x0, 0, x1, 0) }] }))),
      // A run into something tall on end in front of the shelf: a plank (5 h) or a beam (3 h), which falls onto the bell.
      ...(['plank', 'beam'] as const).flatMap((item) => range(7, 11.5, 0.5).flatMap((x) => [0.9, 1.2].map((back): Candidate => ({
        label: `run from 3 into a ${item} on end at ${x} (last domino ${back} h back)`, family: `topple (run into a ${item} on end)`,
        steps: (s) => [{ place: item, hit: ground(s, x, 0), tip: 1 }, { stroke: line(3, 0, x - back - 0.2, 0) }],
      })))),
    ],
    wrong: RUBE_WRONG.RL3!,
  };
  // RL4 (M10b): a ramp up to the shelf, then a turner on its top; or a run curving on the ground into a plank on end in front of it.
  const rl4: GatePuzzle = {
    def: RL4,
    cands: [
      ...(['bumper', 'beam'] as const).flatMap((t) => [5, 6, 7].flatMap((rx) => range(10.5, 13, 0.5).flatMap((tx) => [-30, -45, -60].map((yaw): Candidate => ({
        label: `ramp at ${rx} then a ${t} on the shelf at ${tx}, yaw ${yaw}`, family: `climb + turn (a ramp, a ${t === 'bumper' ? 'fixed bumper' : 'free beam'})`,
        steps: (s) => [{ place: 'ramp', hit: ground(s, rx, 0) }, { place: t, hit: top(s, 3, tx, 0), yaw }],
      }))))),
      ...[3, 5].flatMap((x0) => [8.5, 9, 9.5].flatMap((px) => [5.5, 6.5, 7.5].flatMap((pz) => [0, 90].map((yaw): Candidate => ({
        label: `run arc from ${x0},0 into a plank on end at ${px},${pz} (yaw ${yaw})`, family: 'relay (a run into a plank on end)',
        steps: (s) => [{ place: 'plank', hit: ground(s, px, pz), yaw, tip: 1 }, { stroke: arc(x0, 0, px - 1.2, pz) }],
      }))))),
    ],
    wrong: RUBE_WRONG.RL4!,
  };
  // RL5 (M10b): something across the 2 h wide, 1 h deep gap (a cube in it, a slab from either platform), then a turner on the far platform.
  const cross: [string, (s: BuildSession) => BuildStep[]][] = [
    ...[0.5, 0.75, 1, 1.25, 1.5].map((x): [string, (s: BuildSession) => BuildStep[]] => [`a cube in the gap at ${x}`, (s) => [{ place: 'cube', hit: ground(s, x, 0) }]]),
    ...[[2, -1], [2, -0.75], [2, -0.5], [2, -0.25], [2, -0.1], [3, 2.1], [3, 2.25], [3, 2.5], [3, 2.75], [3, 3]].map(([b, x]): [string, (s: BuildSession) => BuildStep[]] => [`a slab on platform ${b === 2 ? 'A' : 'B'} at ${x}`, (s) => [{ place: 'slab', hit: top(s, b!, x!, 0) }]]),
  ];
  const rl5: GatePuzzle = {
    def: RL5,
    cands: cross.flatMap(([cl, cs]) => (['bumper', 'beam'] as const).flatMap((t) => range(6, 12, 1).flatMap((tx) => [-45, -60, -75].map((yaw): Candidate => ({
      label: `${cl}, then a ${t} at ${tx}, yaw ${yaw}`, family: `cross + turn (${cl.startsWith('a cube') ? 'a cube' : 'a slab'}, a ${t === 'bumper' ? 'fixed bumper' : 'free beam'})`,
      steps: (s) => [...cs(s), { place: t, hit: top(s, 3, tx, 0), yaw }],
    }))))),
    wrong: RUBE_WRONG.RL5!,
  };
  return [rl1, rl2, rl3, rl4, rl5];
}

/** A candidate's placed parts nudged (seeded): each piece's or ball's centre moved by up to NUDGE h in x and z. */
export function nudged(def: LevelDef, seed: number): LevelDef {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const parts = def.parts.map((p): Part => {
    if (!('placed' in p) || !p.placed || (p.kind !== 'piece' && p.kind !== 'ball')) return p;
    return { ...p, at: [+(p.at[0] + (2 * rnd() - 1) * NUDGE).toFixed(6), p.at[1], +(p.at[2] + (2 * rnd() - 1) * NUDGE).toFixed(6)] };
  });
  return { ...def, parts };
}

export interface GateRow { label: string; family: string; spent: number; rungAt: number; robust: number; parts: Part[] }

/** Builds and plays every candidate (deduplicated by level hash); robust clears get their nudge count. */
export async function runPuzzle(p: GatePuzzle, log: (s: string) => void = () => {}): Promise<{ rows: GateRow[]; refused: number; played: number; wrong: { label: string; cleared: boolean; refused?: true }[] }> {
  const seen = new Set<string>(), rows: GateRow[] = [];
  let refused = 0, played = 0;
  for (const c of p.cands) {
    const b = build(p.def, c.steps as BuildStep[] | ((s: BuildSession) => BuildStep[]));
    if (!b) { refused++; continue; }
    const hash = compileLevel(b.def).hash;
    if (seen.has(hash)) continue;
    seen.add(hash);
    played++;
    const r = await playRube(b.def, undefined, b.spent);
    if (!r.cleared) continue;
    let robust = 0;
    for (let k = 0; k < NUDGES; k++) if ((await playRube(nudged(b.def, 1000 + k))).cleared) robust++;
    const placed = b.def.parts.slice(p.def.parts.length);
    rows.push({ label: c.label, family: c.family, spent: b.spent, rungAt: r.rungAt, robust, parts: placed });
    log(`  ${p.def.id} clear: ${c.label} [${c.family}] cost ${b.spent}, rung at ${r.rungAt}, robust ${robust}/${NUDGES}`);
  }
  const wrong: { label: string; cleared: boolean; refused?: true }[] = [];
  for (const w of p.wrong) {
    const b = build(p.def, w.steps as BuildStep[] | ((s: BuildSession) => BuildStep[]));
    // A refused wrong build proves nothing: it is reported as refused, not as a fail.
    wrong.push({ label: w.label, cleared: b ? (await playRube(b.def)).cleared : false, ...(b ? {} : { refused: true }) });
  }
  return { rows, refused, played, wrong };
}
