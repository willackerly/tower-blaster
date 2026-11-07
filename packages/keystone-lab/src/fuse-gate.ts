// Fuse & Fold's domino fuses (M5b, docs/game/fuse-and-fold.md, "Domino fuses"): builds a fuse level's
// fuses as a player would lay them, and judges the level by M5's order-matters gate (fuse-search.ts
// orderGate), where a "line" is now a build: one fuse per lane, each a domino run from the lane's head to
// its socket. A straight fuse is the shortest; a longer one carries bumps (an S of arcs that leaves the
// lane and comes back to it), so a lane's delay is its straight length plus the bumps' extra dominoes.
//
// The naive build is every lane straight: equal fuses fire every row at once (M5's "all at once"). The
// structured builds are sweeps, as on F1 to F5: the lanes ranked along the rows' axis, each `step`
// dominoes longer than the one before, in either direction.
import { castPlay, compileLevel, Driver, DOMINO_HALF, DOMINO_PITCH, type FuseLane, fuseCandidate, fuseLanes, FUSE_SITES, laneGeometry, type LevelDef, nudgedLevel, type P2, playShots, type PlungerShot, type RunPart, runCentres, sampleOf } from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';
import { type FoldEnd, type LineStats, lineStats, orderGate, type GateResult } from './fuse-search.ts';

/** A bump's arc radii (h), tried in order. The reference carries a wave round r 2 to 3 h at up to 90 degrees (fuse-gate.test.ts). */
export const BUMP_RADII = [2.5, 2, 3] as const;
const ARC_STEP_DEG = 5;
const round3 = (x: number) => Math.round(x * 1e3) / 1e3 + 0;

/**
 * A turtle path from `from` heading `dir` (unit, x z): straight `lead` h, then each bump (left turn t, right 2t, left
 * t, on `side` 1 or -1), then straight on to `to` (on the same line). Arcs as 5 degree chords; coordinates to 1e-3.
 */
export function bumpPath(from: P2, dir: P2, to: P2, bumps: Array<{ r: number; deg: number }>, side: 1 | -1, lead = DOMINO_PITCH): P2[] {
  let [x, z] = from, [hx, hz] = dir;
  const out: P2[] = [[x, z]];
  const go = (d: number) => { x += hx * d; z += hz * d; out.push([round3(x), round3(z)]); };
  go(lead);
  for (const b of bumps) for (const turn of [b.deg, -2 * b.deg, b.deg]) {
    const n = Math.max(2, Math.ceil(Math.abs(turn) / ARC_STEP_DEG)), a = ((side * turn * Math.PI) / 180) / n, c = Math.cos(a), s = Math.sin(a);
    for (let k = 0; k < n; k++) { go(b.r * Math.abs(a)); const nx = hx * c - hz * s, nz = hx * s + hz * c; hx = nx; hz = nz; }
  }
  out.push([round3(to[0]), round3(to[1])]);
  return out;
}

/** Where a lane's fuse ends: 0.6 h before its socket (half a pitch), so the brush's last domino stands 0.6 to 1.8 h from it. */
export const fuseEnd = (l: FuseLane): P2 => { const g = laneGeometry(l); return [g.socket[0] - g.dir[0] * 0.6, g.socket[1] - g.dir[1] * 0.6]; };

/** The dominoes a lane's straight fuse takes (its `straight`): runCentres from head to fuseEnd. */
export const dominoes = (path: readonly P2[]) => runCentres(path, DOMINO_PITCH).length;

/**
 * A fuse for `lane` that is `extra` dominoes longer than straight (0: straight), bumping to `side`; null when no
 * one to three bumps of a radius in BUMP_RADII, up to 90 degrees, give exactly that count within the lane's length.
 */
export function laneFuse(lane: FuseLane, extra: number, side: 1 | -1 = 1): P2[] | null {
  const g = laneGeometry(lane), end = fuseEnd(lane), base = dominoes([g.head, end]);
  if (extra === 0) return [g.head, end];
  const span = Math.hypot(end[0] - g.head[0], end[1] - g.head[1]) - 2 * DOMINO_PITCH;
  for (const count of [1, 2, 3]) for (const r of BUMP_RADII) for (let deg = 20; deg <= 90; deg += 1) {
    // Each bump covers 4 r sin t along the lane; they must fit between the lead-in and two pitches before the end.
    if (count * 4 * r * Math.sin((deg * Math.PI) / 180) > span) break;
    const p = bumpPath(g.head, g.dir, end, Array.from({ length: count }, () => ({ r, deg })), side);
    if (dominoes(p) - base === extra) return p;
  }
  return null;
}

/** A fuse as the brush would lay it: a placed domino run along `path`. */
export const fuseRun = (path: P2[]): RunPart => ({ kind: 'run', path, pitch: DOMINO_PITCH, half: [...DOMINO_HALF], material: 'plaster', placed: true });

/** A named build: one path per lane (null: that lane left unlaid). */
export interface FuseBuild { name: string; fuses: Array<P2[] | null> }

/** The level as built. */
export const built = (level: LevelDef, b: FuseBuild): LevelDef => ({ ...level, parts: [...level.parts, ...b.fuses.flatMap((p) => (p ? [fuseRun(p)] : []))] });

/** The plunger shot of a fuse level: every charge at once (the fuses are the delays). */
export const firing = (level: LevelDef): PlungerShot => ({ ammo: 'plunger', fuse: level.charges!.map((_, i): [number, number] => [i, 0]) });

/**
 * The naive build (every lane straight) and the sweeps: lanes ranked in `order` (lane indices, first to fire first),
 * each `step` dominoes longer than the one before, for step 1 to maxStep, in that order and reversed.
 */
export function sweepBuilds(site: string, order: readonly number[], maxStep = 6): FuseBuild[] {
  const lanes = FUSE_SITES[site]!.fuse.lanes, n = lanes.length;
  // Away from the board's middle: side 1 turns first toward (-dz, dx), the lane's left of its heading in x z.
  const mid = [lanes.reduce((a, l) => a + l.lead[0], 0) / n, lanes.reduce((a, l) => a + l.lead[1], 0) / n];
  const sideOf = (k: number): 1 | -1 => {
    const g = laneGeometry(lanes[k]!), lat = (-g.dir[1]) * (lanes[k]!.lead[0] - mid[0]!) + g.dir[0] * (lanes[k]!.lead[1] - mid[1]!);
    return lat < 0 ? -1 : 1;
  };
  const out: FuseBuild[] = [{ name: 'straight', fuses: lanes.map((l) => laneFuse(l, 0)) }];
  for (const [label, ord] of [['forward', order], ['reversed', [...order].reverse()]] as const) {
    // Every lane bumps to one side, the side away from the middle of the lane that fires last (the longest fuse), so no
    // two bumps face each other: a bump reaches 2r + 0.5 h off its line, under the 7 h between
    // lanes on FD-2 and FD-3 (FD-1's two lanes, 3 h apart, bump outward: only one bumps in a sweep).
    const side = sideOf(ord.at(-1)!);
    for (let step = 1; step <= maxStep; step++) {
      const fuses = lanes.map((l, k) => laneFuse(l, ord.indexOf(k) * step, side));
      if (fuses.some((f) => f === null)) continue;
      out.push({ name: `${label} +${step}`, fuses });
    }
  }
  return out;
}

/** One build's end on one nudged build of the level (fresh engine; the reference by default). */
export async function playBuild(level: LevelDef, b: FuseBuild, nudge: number, spec: EngineSpec = { kind: 'ref' }): Promise<FoldEnd> {
  const def = built(level, b), c = nudgedLevel(compileLevel(def), nudge), e = makeEngine(spec);
  try {
    if (spec.kind !== 'ref') {
      const p = await castPlay(e, c, [firing(def)]), s = p.samples.at(-1);
      return { fold: s?.fold ?? 0, collapse: s?.collapse ?? 0, met: s?.met ?? false, heritage: s?.heritage ?? 0, steps: p.steps, limits: p.limits.length };
    }
    const d = new Driver(e, c);
    await d.reset();
    const r = await playShots(d, [firing(def)], 0), s = sampleOf(r.session, r.steps);
    return { fold: s.fold ?? 0, collapse: s.collapse, met: s.met, heritage: s.heritage, steps: r.steps, limits: 0 };
  } finally { e.dispose(); }
}

export interface FuseGateResult { level: string; screen: LineStats[]; confirm: LineStats[]; gate: GateResult; builds: FuseBuild[] }

/** M5's gate over builds: screen every build on `screen` nudges, confirm the naive build and the best `keep` on `confirm` nudges. */
export async function fuseGate(site: string, order: readonly number[], o: { screen?: number[]; confirm?: number[]; keep?: number; spec?: EngineSpec; log?: (s: string) => void } = {}): Promise<FuseGateResult> {
  const level = fuseCandidate(site), builds = sweepBuilds(site, order), lines = builds.map((b) => ({ name: b.name, shot: firing(level) }));
  const play = async (bs: FuseBuild[], nudges: number[]) => {
    const ends: FoldEnd[][] = [];
    for (const n of nudges) { const row: FoldEnd[] = []; for (const b of bs) { row.push(await playBuild(level, b, n, o.spec)); o.log?.(`  ${site} n${n} ${b.name}: fold ${row.at(-1)!.fold.toFixed(3)} met ${row.at(-1)!.met}`); } ends.push(row); }
    return ends;
  };
  const screen = lineStats(lines, await play(builds, o.screen ?? [1]));
  const ranked = screen.map((s, i) => ({ s, i })).slice(1).sort((a, b) => b.s.met - a.s.met || b.s.fold - a.s.fold);
  const keep = [builds[0]!, ...ranked.slice(0, o.keep ?? 3).map((x) => builds[x.i]!)];
  const confirm = lineStats(keep.map((b) => ({ name: b.name, shot: firing(level) })), await play(keep, o.confirm ?? [1, 2, 3, 4, 5, 6, 7, 8]));
  return { level: site, screen, confirm, gate: orderGate(confirm), builds: keep };
}

// ---- Builds as the star cast lays them (M5c, cast.ts buildModel) ----
//
// A cast line on a fuse level is a build: how many dominoes beyond straight each lane's fuse takes (its "extras"),
// keyed `fuse.<e0>.<e1>...` so a cast's JSON records the build each play ran on. Each lane bumps away from the board's
// middle (a middle lane, on an odd board, toward the side of the lane with the most extras), so neighbours' bumps
// never face each other: FD-1's two lanes, 3 h apart, may both bump. A build is laid only when every lane's count is
// reachable (laneFuse), it fits the level's budget, and no two fuses come within FUSE_CLEAR of each other.

/** Least distance between two lanes' domino centres (h): the domino is 1 h wide, so 1.5 leaves half a domino between. */
export const FUSE_CLEAR = 1.5;

const siteCache = new WeakMap<LevelDef, string | null>();
/** The fuse site a level's lanes were built from (FUSE_SITES id), matched by every lane's head to 1e-3 h; null on other levels. */
export function fuseSiteOf(level: LevelDef): string | null {
  if (siteCache.has(level)) return siteCache.get(level)!;
  const lanes = fuseLanes(compileLevel(level));
  const hit = Object.entries(FUSE_SITES).find(([, s]) => s.fuse.lanes.length === lanes.length && s.fuse.lanes.every((l, k) => {
    const g = laneGeometry(l), h = lanes[k]!.head;
    return Math.abs(g.head[0] - h[0]) < 1e-3 && Math.abs(g.head[1] - h[1]) < 1e-3;
  }))?.[0] ?? null;
  siteCache.set(level, hit);
  return hit;
}

/** Which side lane k's bumps turn to on `site` (laneFuse's side): away from the board's middle; a lane on the middle line follows `tie`. */
export function outwardSide(site: string, k: number, tie: 1 | -1 = 1): 1 | -1 {
  const lanes = FUSE_SITES[site]!.fuse.lanes, n = lanes.length;
  const mid = [lanes.reduce((a, l) => a + l.lead[0], 0) / n, lanes.reduce((a, l) => a + l.lead[1], 0) / n];
  const g = laneGeometry(lanes[k]!), lat = (-g.dir[1]) * (lanes[k]!.lead[0] - mid[0]!) + g.dir[0] * (lanes[k]!.lead[1] - mid[1]!);
  return Math.abs(lat) < 1e-6 ? tie : lat < 0 ? -1 : 1;
}

const fuseCache = new Map<string, P2[] | null>();
/** laneFuse, remembered (its search tries a few hundred paths). */
function laneFuseCached(site: string, k: number, extra: number, side: 1 | -1): P2[] | null {
  const key = `${site}/${k}/${extra}/${side}`;
  if (!fuseCache.has(key)) fuseCache.set(key, extra < 0 ? null : laneFuse(FUSE_SITES[site]!.fuse.lanes[k]!, extra, side));
  return fuseCache.get(key)!;
}

export const buildKey = (extras: readonly number[]): string => `fuse.${extras.join('.')}`;
/** A build key's extras; throws on anything else. */
export function parseBuildKey(key: string): number[] {
  const m = /^fuse((?:\.\d+)+)$/.exec(key);
  if (!m) throw new Error(`not a fuse build key: ${key}`);
  return m[1]!.slice(1).split('.').map(Number);
}

/** Why a build cannot be laid (null: it can): a lane's count unreachable, over the budget, or two fuses too close. */
export function extrasProblem(site: string, extras: readonly number[]): string | null {
  const fs = FUSE_SITES[site]!.fuse;
  if (extras.length !== fs.lanes.length) return `${extras.length} lanes for ${fs.lanes.length}`;
  const b = extrasBuild(site, extras);
  if (!b) return 'a lane cannot take that many';
  const cost = fs.lanes.reduce((a, l, k) => a + l.straight + extras[k]!, 0);
  if (cost > fs.budget) return `${cost} dominoes over the budget of ${fs.budget}`;
  const centres = b.fuses.map((p) => runCentres(p!, DOMINO_PITCH));
  for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) for (const a of centres[i]!) for (const q of centres[j]!) {
    if (Math.hypot(a[0] - q[0], a[1] - q[1]) < FUSE_CLEAR) return `lanes ${i + 1} and ${j + 1} within ${FUSE_CLEAR} h`;
  }
  return null;
}

/** The build with `extras` dominoes beyond straight per lane, bumping outward; null when a lane cannot take its count. */
export function extrasBuild(site: string, extras: readonly number[]): FuseBuild | null {
  const most = extras.indexOf(Math.max(...extras)), tie = outwardSide(site, most);
  const fuses = extras.map((e, k) => laneFuseCached(site, k, e, outwardSide(site, k, tie)));
  return fuses.some((f) => f === null) ? null : { name: buildKey(extras), fuses };
}

/** A fuse level as built by `key` (buildKey); throws when the level is not a fuse site's or the build cannot be laid. */
export function buildLevel(level: LevelDef, key: string): LevelDef {
  const site = fuseSiteOf(level), extras = parseBuildKey(key);
  if (!site) throw new Error(`${level.id} is not a fuse level: no build ${key}`);
  const why = extrasProblem(site, extras);
  if (why) throw new Error(`${level.id}: build ${key} cannot be laid: ${why}`);
  return built(level, extrasBuild(site, extras)!);
}
