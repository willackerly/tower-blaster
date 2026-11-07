// A novice Siege Table player for headless checks (PT5, agent playtest 1): it plays a duel the way the playtest's
// novice bot played the page, so the turn view and the rules can be judged without a browser. Each turn it looks
// from the turn view (duel-view.ts duelView), clicks near the middle of what the screen shows (the screen's middle on
// a wide screen, the middle below the HUD on an upright phone: view.ts PLAY_CENTRE_PORTRAIT) with a seeded jitter,
// and fires the first item left in its rack at full power from the default (high) launcher, as the page would aim
// it (aim.ts pick and shotFor). A click whose aim is out of reach, or refused, moves on to the next point of a
// spiral out from the middle, as the agent playtest's bot did. Pure apart from the engine it is given.
import type { PhysicsEngine } from '@tb/engine-api';
import type { Snapshot } from '@tb/engine-api';
import { compileLevel, Driver, Duel, type DuelDef, type DuelResult, duelLevel, type Part, type Player, type Shot, type ShotTally } from '@tb/keystone';
import { rayThrough } from '@tb/render/camera';
import { launchHeight, pick, shotFor, SUBSTEPS } from './aim.ts';
import { duelView, launcherAz } from './duel-view.ts';
import { PLAY_CENTRE_PORTRAIT } from './view.ts';

/** The novice's jitter about the middle, normalised device coordinates (the agent playtest's noviceAim spread). */
export const NOVICE_SPREAD = 0.18;
/** The middle of a wide screen a click aims at: a hair under centre, as the agent playtest's noviceAim had it. */
export const PLAY_CENTRE_WIDE: readonly [number, number] = [0, -0.05];

/** A small seeded generator (mulberry32): the same seed gives the same clicks. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The middle a click on a screen of this aspect aims at (PLAY_CENTRE_WIDE, or PLAY_CENTRE_PORTRAIT upright). */
export const playCentre = (aspect: number): readonly [number, number] => (aspect < 1 ? PLAY_CENTRE_PORTRAIT : PLAY_CENTRE_WIDE);

/** Points to try, in order: the jittered click, then a spiral of rings out from the middle. */
export function clickPoints(aspect: number, rnd: () => number, rings = 6, step = 0.06): Array<[number, number]> {
  const [cx, cy] = playCentre(aspect), out: Array<[number, number]> = [[cx + (rnd() * 2 - 1) * NOVICE_SPREAD, cy + (rnd() * 2 - 1) * NOVICE_SPREAD], [cx, cy]];
  for (let r = 1; r <= rings; r++) for (let i = 0; i < 8 * r; i++) {
    const a = (2 * Math.PI * i) / (8 * r);
    out.push([cx + Math.cos(a) * r * step, cy + Math.sin(a) * r * step]);
  }
  return out;
}

/**
 * One novice turn: the click, the body under it (-1: the ground) and whether that is the shooter's own, the shot, the
 * step it settled at, the referee's tally of it, and whether each side's king (Two Keeps) is down after it.
 */
export interface NoviceTurn { player: Player; shot: Shot; click: [number, number]; body: number; own: boolean; target: [number, number, number]; settledAt: number; tally: ShotTally | null; kingsDown: [boolean, boolean] }
/** A novice duel, and `mirror`: how far the settled table (after the presettle) is from its own half-turn image, metres. */
export interface NoviceDuel { first: Player; turns: NoviceTurn[]; result: DuelResult; sides: Duel['sides']; steps: number; mirror: number }

/**
 * Options for noviceDuel: stop after `turns` shots (a probe of one side's first shot), or after `maxSteps` engine
 * steps; `rivalOnly` passes over clicks that do not land on a rival block (PT22's probe: a first shot on the ground
 * scores 0 for either side and says nothing about the solver).
 */
export interface NoviceOptions { turns?: number; maxSteps?: number; rivalOnly?: boolean }

/**
 * The largest distance from a body to the nearest body at its half-turn image ((x, y, z) to (-x, y, -z)): 0 for a
 * table that is the same to both sides. Both tables are, as built; a solver's settle can creep it (PT22).
 */
export function mirrorError(s: Snapshot, n = s.count): number {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n && best > 0; j++) best = Math.min(best, Math.hypot(s.pos[3 * i]! + s.pos[3 * j]!, s.pos[3 * i + 1]! - s.pos[3 * j + 1]!, s.pos[3 * i + 2]! + s.pos[3 * j + 2]!));
    worst = Math.max(worst, best);
  }
  return worst;
}

/** A part's half-turn image about the vertical axis through the table's centre: (x, z) to (-x, -z), measured on its box. */
const turnedPart = (p: Part): string => ('at' in p && 'size' in p ? JSON.stringify([-p.at[0] - p.size[0], p.at[1], -p.at[2] - p.size[2], p.size]) : '');
const partKey = (p: Part): string => ('at' in p && 'size' in p ? JSON.stringify([p.at[0], p.at[1], p.at[2], p.size]) : '');

/**
 * The same table with the two sides' parts traded places in the level's part list (PT22's control): each part moves
 * to the index of its half-turn image, and each side owns the same blocks as before. The bodies are the same; only
 * the order the solver meets them in changes. Throws if a part has no image (a table that is not the same to both sides).
 */
export function swappedOrder(def: DuelDef): DuelDef {
  const parts = def.level.parts, at = new Map(parts.map((p, i) => [partKey(p), i]));
  const image = parts.map((p, i) => {
    const j = at.get(turnedPart(p));
    if (j === undefined) throw new Error(`${def.id}: part ${i} has no half-turn image`);
    return j;
  });
  const remap = (owns: { parts?: number[] } | undefined) => (owns?.parts ? { ...owns, parts: owns.parts.map((i) => image[i]!) } : owns);
  // Part i goes to index image[i]: the slot its image held. An index permutation, as image is an involution.
  const next: Part[] = parts.map((_, k) => parts[image[k]!]!);
  return {
    ...def, id: def.id, level: { ...def.level, parts: next },
    sides: def.sides.map((s) => ({ ...s, owns: remap(s.owns as { parts?: number[] }) as typeof s.owns, ...(s.king ? { king: remap(s.king as { parts?: number[] }) as typeof s.king } : {}) })) as DuelDef['sides'],
  };
}

/**
 * One duel of two novices on `engine` (fresh: it is reset here), `first` to fire first, clicks from `seed`, on a screen
 * of `aspect`. Stops when the duel is decided, nothing can be fired, or after `maxSteps` engine steps.
 */
export async function noviceDuel(engine: PhysicsEngine, def: DuelDef, first: Player, seed: number, aspect = 1.6, opts: NoviceOptions | number = {}): Promise<NoviceDuel> {
  const { turns: most = Infinity, maxSteps = 40_000, rivalOnly = false } = typeof opts === 'number' ? { maxSteps: opts } : opts;
  const c = compileLevel(duelLevel(def, first)), d = new Driver(engine, c, { refereed: true });
  await d.reset();
  const mirror = mirrorError(d.snapshot, c.meta.n);
  const duel = new Duel(def, c, first, d.session.home), rnd = seeded(seed), turns: NoviceTurn[] = [];
  const substeps = engine.info.integrator?.substeps ?? SUBSTEPS, y = launchHeight(c, 'high');
  while (!duel.result.over && engine.stepIndex < maxSteps && turns.length < most) {
    const p = duel.turn, ammo = duel.left[p][0];
    if (ammo === undefined) break;
    const o = duelView(c, def, p, aspect), az = launcherAz(o.yaw, def);
    let chosen: Omit<NoviceTurn, 'settledAt' | 'tally' | 'kingsDown'> | null = null;
    for (const [x, yy] of clickPoints(aspect, rnd)) {
      const hit = pick(rayThrough(o, aspect, x, yy), d.snapshot, c);
      if (!hit || (rivalOnly && !duel.owned[(1 - p) as Player].includes(hit.body))) continue;
      const a = shotFor(c, ammo, az, 100, hit.point, substeps, y);
      if (a?.reachable && !duel.refuse(a.shot)) { chosen = { player: p, shot: a.shot, click: [x, yy], body: hit.body, own: duel.owned[p].includes(hit.body), target: [...hit.point] as [number, number, number] }; break; }
    }
    if (!chosen) break;
    d.fire(chosen.shot);
    duel.fired(chosen.shot);
    do await d.step(); while (d.session.phase === 'running' && engine.stepIndex < maxSteps);
    duel.settled(d.snapshot);
    turns.push({ ...chosen, settledAt: engine.stepIndex, tally: duel.lastShot, kingsDown: [duel.fallen(0), duel.fallen(1)] });
  }
  await d.drain();
  return { first, turns, result: duel.result, sides: duel.sides, steps: engine.stepIndex, mirror };
}

/** One novice duel as a line of a balance table: who fired first, who won (null: a draw or undecided), why, its turns and clicks on own blocks. */
/** `spread`: the final score's margin, |Gold's points - Blue's| (Heraldry; 0 in Two Keeps). */
export interface DuelOutcome { first: Player; winner: Player | null; over: boolean; why: string; turns: number; own: number; steps: number; spread: number }

export const duelOutcome = (r: NoviceDuel): DuelOutcome => ({
  first: r.first, winner: r.result.over ? r.result.winner : null, over: r.result.over, why: r.result.over ? r.result.why : 'undecided',
  turns: r.turns.length, own: r.turns.filter((t) => t.own).length, steps: r.steps, spread: Math.abs(r.sides[0].points - r.sides[1].points),
});

/**
 * A balance row from novice duels: wins by side (Gold 0, Blue 1) and by seat (first, second), draws (and undecided),
 * turns per duel, the fewest turns, own-block clicks, and each seat's and side's win rate over the decided duels.
 * PT5's verify asks for 40 to 60% (agent playtest round 2).
 */
export function tallyDuels(rs: readonly DuelOutcome[]) {
  const t = { duels: rs.length, gold: 0, blue: 0, draw: 0, first: 0, second: 0, turns: 0, fewest: Infinity, own: 0 };
  for (const r of rs) {
    if (r.over && r.winner !== null) { t[r.winner ? 'blue' : 'gold']++; t[r.winner === r.first ? 'first' : 'second']++; } else t.draw++;
    t.turns += r.turns; t.fewest = Math.min(t.fewest, r.turns); t.own += r.own;
  }
  const decided = t.gold + t.blue;
  return {
    ...t, turnsPerDuel: rs.length ? t.turns / rs.length : 0, goldRate: decided ? t.gold / decided : NaN, firstRate: decided ? t.first / decided : NaN,
    drawRate: rs.length ? t.draw / rs.length : NaN, medianTurns: median(rs.map((r) => r.turns)), medianSpread: median(rs.map((r) => r.spread ?? 0)),
  };
}

/** The median of `xs` (the mean of the middle two for an even count); NaN for none. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : NaN;
}

/** A balance row as one line of text (the CLIs print it). */
export function tallyLine(id: string, engine: string, aspect: number, t: ReturnType<typeof tallyDuels>): string {
  const pc = (x: number) => (Number.isNaN(x) ? 'n/a' : `${Math.round(100 * x)}%`);
  return `${id} ${engine} aspect ${aspect}, ${t.duels} duels: Gold ${t.gold}, Blue ${t.blue}, draws ${t.draw}; first ${t.first}, second ${t.second} (Gold ${pc(t.goldRate)}, first ${pc(t.firstRate)} of decided); ${t.turnsPerDuel.toFixed(1)} turns a duel (median ${t.medianTurns}, fewest ${t.fewest}); draws ${pc(t.drawRate)}; median score margin ${t.medianSpread}; clicks on own blocks ${t.own}`;
}
