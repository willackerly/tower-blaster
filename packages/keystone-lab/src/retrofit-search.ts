// Aftershock's retrofit search and gate (M7b, docs/game/aftershock.md "Retrofit"), on the reference engine.
//
// A retrofit is a site of protected towers (and the rest of the town: sturdy halls, role 'city') with the level's own
// quake (quake.fixed) and a build budget. The player braces the towers in C9's build phase, then the quake comes.
// The bot braces the way a player does: every brace is a program of build-tool steps (BuildSession.ghost from a face
// hit, snap on, then place), so the tool's overlap check, budget and bin decide what can be built. Two families:
//
// - buttress: a pier beside the tower on each side along the quake's axis, k cubes high (a pier of 3 is one stamp),
//   so only the top of the tower is left to rock, and a short block rocks far less than a tall one (X6's slenderness);
// - tie: a plank (or a beam, or a slab) laid from the tower's top onto a sturdy neighbour of the same height along the
//   axis, so the tower cannot rock without lifting the hall.
//
// A bracing counts only if it is robust: the objective (every protected tower standing at the settle) met on at least
// ROBUST of NUDGES nudged builds (quake-search.ts nudgeLevel, every moving body, placed ones too). The gate a retrofit
// ships on: the bare site meets the objective on at most BARE_MAX of the builds, and at least two families have a
// robust bracing within the build budget; and every protected tower falls on all but BARE_MAX bare builds (so each
// brace is needed, none is decoration). Each family's bracing is then made cheaper, one brace at a time (a lower
// pier, a cheaper tie, or none), keeping it robust; the cheapest is the level's three-star line.
import { BuildSession, compileLevel, type Hit, type Hold, type LevelDef, parseTower, type QuakeShot, quakeRulesOf, type QuakeSite, towerFootprint, towerHeight } from '@tb/keystone';
import type { EngineSpec } from './engines.ts';
import { playQuakeTasks, type QuakeTask } from './quake-search.ts';
import type { BuildStep } from './rube.ts';

export const NUDGES = 8, ROBUST = 7, BARE_MAX = 1;

export type TieItem = 'plank' | 'beam' | 'slab';
/** One brace on protected tower `tower` (its index in the site's towers). */
export type Brace =
  | { tower: number; kind: 'buttress'; k: number }
  | { tower: number; kind: 'tie'; dir: -1 | 1; item: TieItem };

export const braceCost = (b: Brace): number => (b.kind === 'buttress' ? 2 * b.k : b.item === 'beam' ? 3 : 2);
export const braceName = (b: Brace): string => (b.kind === 'buttress' ? `buttress ${b.k} high on tower ${b.tower}` : `${b.item} tie ${b.dir < 0 ? '-' : '+'} from tower ${b.tower}`);
export type Family = 'buttress' | 'tie';
/** A bracing's family: tie if any brace ties, else buttress (a tie family may buttress towers with no neighbour to tie to). */
export const familyOf = (bs: readonly Brace[]): Family => (bs.some((b) => b.kind === 'tie') ? 'tie' : 'buttress');

/** The quake's axis on the ground: 0 (x) or 90 (z) degrees; a retrofit's axis is one of the two. */
function axisOf(def: LevelDef): 0 | 90 {
  const a = quakeRulesOf(def).fixed?.axis;
  if (a !== 0 && a !== 90) throw new Error(`${def.id}: a retrofit's quake runs along x or z (axis 0 or 90), not ${String(a)}`);
  return a;
}

/** The level's own quake (quake.fixed). */
export function fixedQuake(def: LevelDef): QuakeShot {
  const f = quakeRulesOf(def).fixed;
  if (!f) throw new Error(`${def.id}: not a retrofit (no fixed quake)`);
  return { ammo: 'quake', ...f };
}

/** Each site tower's body range in the compiled level (towers compile in site order, one body per storey). */
function towerBodies(site: QuakeSite): { first: number; top: number }[] {
  let next = 0;
  return site.towers.map((t) => { const n = towerHeight(parseTower(t.tower)), r = { first: next, top: next + n - 1 }; next += n; return r; });
}

const groundHit = (s: BuildSession, x: number, z: number): Hit => ({ body: -1, point: [x * s.h, 0, z * s.h], normal: [0, 1, 0], t: 0 });
function topHit(s: BuildSession, b: number, dx = 0, dz = 0): Hit {
  const body = s.compiled().scene.bodies[b]!, half = body.shape.kind === 'box' ? body.shape.half : [0, 0, 0] as const;
  return { body: b, point: [body.pos[0] + dx * half[0]!, body.pos[1] + half[1]!, body.pos[2] + dz * half[2]!], normal: [0, 1, 0], t: 0 };
}
type Put = (s: BuildSession, hit: Hit, hold: Hold) => boolean;
const put: Put = (s, hit, hold) => s.place(s.ghost(hit, hold));
const lastBody = (s: BuildSession) => s.compiled().meta.n - 1;

/** Applies one brace to the session; false when the tool refuses any step (overlap, ground, budget, not offered). */
function applyBrace(s: BuildSession, site: QuakeSite, bodies: ReturnType<typeof towerBodies>, axis: 0 | 90, b: Brace, put: Put): boolean {
  const t = site.towers[b.tower]!, spec = parseTower(t.tower), [fx, fz] = towerFootprint(spec, t.yawed), p = s.pitch;
  if (b.kind === 'buttress') {
    // The cells either side of the tower's middle along the axis, on the ground.
    const mid = axis === 0 ? [[t.at[0] - 1, t.at[1] + Math.floor(fz / 2)], [t.at[0] + fx, t.at[1] + Math.floor(fz / 2)]] : [[t.at[0] + Math.floor(fx / 2), t.at[1] - 1], [t.at[0] + Math.floor(fx / 2), t.at[1] + fz]];
    for (const [cx, cz] of mid) {
      let left = b.k;
      if (left >= 3) { if (!put(s, groundHit(s, (cx! + 0.5) * p, (cz! + 0.5) * p), { item: 'pier3', yaw: 0, tip: 0 })) return false; left -= 3; }
      else { if (!put(s, groundHit(s, (cx! + 0.5) * p, (cz! + 0.5) * p), { item: 'cube', yaw: 0, tip: 0 })) return false; left -= 1; }
      for (; left > 0; left--) if (!put(s, topHit(s, lastBody(s)), { item: 'cube', yaw: 0, tip: 0 })) return false;
    }
    return true;
  }
  // A tie: from the tower's top, the hit near its edge toward the neighbour, so the piece's centre snaps half a cell over.
  const top = bodies[b.tower]!.top, d = 0.9 * b.dir;
  return put(s, axis === 0 ? topHit(s, top, d, 0) : topHit(s, top, 0, d), { item: b.item, yaw: axis === 0 ? 0 : 90, tip: 0 });
}

/** The level braced with `braces` through the build tool, and what it cost; null when the tool refuses one. */
export function bracedLevel(def: LevelDef, site: QuakeSite, braces: readonly Brace[]): { def: LevelDef; spent: number } | null {
  const s = new BuildSession(def), bodies = towerBodies(site), axis = axisOf(def);
  for (const b of braces) if (!applyBrace(s, site, bodies, axis, b, put)) return null;
  return { def: s.def(), spent: s.spent() };
}

/**
 * The bracing as build-tool steps (a hit and what is held), in the order the build tool places them: what a player's
 * clicks give (the agent playtest replays them on the game page, playtest agent/modes.ts); null when the tool refuses one.
 */
export function braceSteps(def: LevelDef, site: QuakeSite, braces: readonly Brace[]): BuildStep[] | null {
  const s = new BuildSession(def), bodies = towerBodies(site), axis = axisOf(def), steps: BuildStep[] = [];
  const record: Put = (s, hit, hold) => {
    if (!put(s, hit, hold)) return false;
    steps.push({ place: hold.item as Extract<BuildStep, { place: unknown }>['place'], hit, ...(hold.yaw ? { yaw: hold.yaw } : {}), ...(hold.tip ? { tip: hold.tip } : {}) });
    return true;
  };
  for (const b of braces) if (!applyBrace(s, site, bodies, axis, b, record)) return null;
  return steps;
}

/**
 * The level braced as `braces` would brace it were the quake turned a quarter (so buttresses stand across the quake's
 * axis, the obvious wrong build), with the level's own quake; null when the tool refuses a step.
 */
export function crossBraced(def: LevelDef, site: QuakeSite, braces: readonly Brace[]): { def: LevelDef; spent: number } | null {
  const turned: LevelDef = { ...def, quake: { ...def.quake, fixed: { ...def.quake!.fixed!, axis: axisOf(def) === 0 ? 90 : 0 } } };
  const b = bracedLevel(turned, site, braces);
  return b ? { def: { ...b.def, quake: def.quake }, spent: b.spent } : null;
}

/** How many of n nudged builds met the objective, and on how many each protected tower (in heritage order) stood. */
export interface Verdict { met: number; n: number; stood: number[] }
export const robust = (v: Verdict) => v.met >= ROBUST;

/** Plays each level on NUDGES nudged builds with its own quake, pooled; how many builds met the objective, per level. */
export async function verdicts(levels: readonly LevelDef[], jobs: number, spec: EngineSpec = { kind: 'ref' }): Promise<Verdict[]> {
  const nudges = Array.from({ length: NUDGES }, (_, k) => k + 1);
  const tasks: QuakeTask[] = levels.flatMap((l) => nudges.map((nudge) => ({ level: l, quakes: [fixedQuake(l)], nudge })));
  const ends = await playQuakeTasks(levels[0]!, tasks, jobs, spec);
  return levels.map((_, i) => {
    const mine = ends.slice(i * NUDGES, (i + 1) * NUDGES).map((e) => e[0]!);
    return { met: mine.filter((e) => e.met).length, n: NUDGES, stood: mine[0]!.standing.map((_, t) => mine.filter((e) => e.standing[t]).length) };
  });
}

/** The braces each family starts from: every protected tower buttressed (k 3), or tied where it has a hall to tie to (planks) and buttressed where not. */
export function familyStarts(def: LevelDef, site: QuakeSite): Record<Family, Brace[]> {
  const axis = axisOf(def), prot = site.towers.flatMap((t, i) => (t.role === 'protected' ? [i] : []));
  const neighbour = (i: number): -1 | 1 | 0 => {
    const t = site.towers[i]!, spec = parseTower(t.tower), [fx, fz] = towerFootprint(spec, t.yawed), n = towerHeight(spec);
    // A city tower of the same height whose footprint is one cell away along the axis, over the tower's middle row.
    for (const dir of [1, -1] as const) {
      const hit = site.towers.some((o, j) => {
        if (j === i || o.role !== 'city') return false;
        const os = parseTower(o.tower), [ox, oz] = towerFootprint(os, o.yawed);
        if (towerHeight(os) !== n) return false;
        if (axis === 0) { const mz = t.at[1] + Math.floor(fz / 2), gapX = dir > 0 ? t.at[0] + fx + 1 : t.at[0] - 2; return mz >= o.at[1] && mz < o.at[1] + oz && (dir > 0 ? o.at[0] === gapX : o.at[0] + ox - 1 === gapX); }
        const mx = t.at[0] + Math.floor(fx / 2), gapZ = dir > 0 ? t.at[1] + fz + 1 : t.at[1] - 2;
        return mx >= o.at[0] && mx < o.at[0] + ox && (dir > 0 ? o.at[1] === gapZ : o.at[1] + oz - 1 === gapZ);
      });
      if (hit) return dir;
    }
    return 0;
  };
  return {
    buttress: prot.map((i) => ({ tower: i, kind: 'buttress', k: 3 })),
    tie: prot.map((i): Brace => { const d = neighbour(i); return d ? { tower: i, kind: 'tie', dir: d, item: 'plank' } : { tower: i, kind: 'buttress', k: 3 }; }),
  };
}

/** What a brace may be made cheaper to: a lower pier, a cheaper tie, or nothing. */
function cheaper(b: Brace): (Brace | null)[] {
  const out: (Brace | null)[] = [null];
  if (b.kind === 'buttress') for (let k = b.k - 1; k >= 1; k--) out.push({ ...b, k });
  else if (b.item === 'beam') out.push({ ...b, item: 'plank' }, { ...b, item: 'slab' });
  return out;
}

export interface FamilyResult { family: Family; start: Brace[]; startVerdict: Verdict | null; best: Brace[]; bestCost: number; bestVerdict: Verdict | null; tried: number }
export interface RetrofitResult { id: string; hash: string; bodies: number; quake: QuakeShot; budget: number | undefined; bare: Verdict; families: FamilyResult[]; wrong: { name: string; verdict: Verdict | null }[]; gate: { pass: boolean; detail: string }; wallS: number }

/**
 * The search and gate for one retrofit site: the bare site, each family's start and its cheapest robust bracing
 * (greedy over the braces, cheapest change first), and the obvious wrong build (every tower buttressed across the
 * quake's axis), on NUDGES builds each.
 */
export async function searchRetrofit(def: LevelDef, site: QuakeSite, o: { jobs: number; spec?: EngineSpec; log?: (l: string) => void }): Promise<RetrofitResult> {
  const t0 = performance.now(), c = compileLevel(def), budget = def.build?.budget, log = o.log ?? (() => {});
  const play = async (ls: (LevelDef | null)[]) => {
    const real = ls.filter((l): l is LevelDef => l !== null), vs = real.length ? await verdicts(real, o.jobs, o.spec) : [];
    let k = 0;
    return ls.map((l) => (l ? vs[k++]! : null));
  };
  const [bare] = (await play([def])) as [Verdict];
  log(`${def.id}: bare met ${bare.met}/${bare.n}`);
  const starts = familyStarts(def, site), families: FamilyResult[] = [];
  for (const family of ['buttress', 'tie'] as const) {
    const start = starts[family];
    if (family === 'tie' && familyOf(start) !== 'tie') continue;
    const sb = bracedLevel(def, site, start), [sv] = await play([sb?.def ?? null]);
    log(`${def.id} ${family}: start cost ${sb?.spent ?? 'refused'}, met ${sv ? `${sv.met}/${sv.n}` : '-'}`);
    let best = start, bestVerdict = sv ?? null, tried = 1;
    if (sv && robust(sv)) {
      // One brace at a time, its cheapest change that keeps the bracing robust (all of a brace's options in one pool).
      for (let i = 0; i < best.length; i++) {
        const opts = cheaper(best[i]!).map((alt) => (alt ? best.map((b, j) => (j === i ? alt : b)) : best.filter((_, j) => j !== i)));
        const built = opts.map((bs) => bracedLevel(def, site, bs)), vs = await play(built.map((b) => b?.def ?? null));
        tried += opts.length;
        const k = vs.findIndex((v) => v !== null && robust(v));
        if (k >= 0) {
          const removed = opts[k]!.length < best.length;
          log(`${def.id} ${family}: ${braceName(best[i]!)} -> ${removed ? 'none' : braceName(opts[k]![i]!)} (cost ${built[k]!.spent}, met ${vs[k]!.met}/${vs[k]!.n})`);
          best = opts[k]!; bestVerdict = vs[k]!;
          if (removed) i--;
        }
      }
    }
    const bb = bracedLevel(def, site, best);
    families.push({ family, start, startVerdict: sv ?? null, best, bestCost: bb?.spent ?? Infinity, bestVerdict, tried });
  }
  // The wrong build: every protected tower buttressed across the quake.
  const cross = crossBraced(def, site, starts.buttress), [cv] = await play([cross?.def ?? null]);
  const wrong = [{ name: 'buttressed across the quake', verdict: cv ?? null }];
  const ok = families.filter((f) => f.bestVerdict && robust(f.bestVerdict) && f.bestCost <= (budget ?? Infinity));
  // Every protected tower must need its brace: none stands on more than BARE_MAX bare builds.
  const idle = bare.stood.flatMap((n, t) => (n > BARE_MAX ? [`protected tower ${t} stood ${n}/${bare.n} bare`] : []));
  const pass = bare.met <= BARE_MAX && idle.length === 0 && ok.length >= 2;
  const detail = `bare met ${bare.met}/${bare.n} (at most ${BARE_MAX}), every protected tower falls bare${idle.length ? ` FAILED: ${idle.join(', ')}` : ` (stood ${bare.stood.join(', ')} of ${bare.n})`}; robust families within ${budget ?? 'no'} budget: ${ok.map((f) => `${f.family} ${f.bestCost}`).join(', ') || 'none'} (need 2)`;
  return { id: def.id, hash: c.hash, bodies: c.meta.n, quake: fixedQuake(def), budget, bare, families, wrong, gate: { pass, detail }, wallS: (performance.now() - t0) / 1000 };
}
