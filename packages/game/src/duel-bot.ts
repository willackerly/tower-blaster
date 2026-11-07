// A novice Siege Table player for headless checks (PT5, agent playtest 1): it plays a duel the way the playtest's
// novice bot played the page, so the turn view and the rules can be judged without a browser. Each turn it looks
// from the turn view (duel-view.ts duelView), clicks near the middle of what the screen shows (the screen's middle on
// a wide screen, the middle below the HUD on an upright phone: view.ts PLAY_CENTRE_PORTRAIT) with a seeded jitter,
// and fires the first item left in its rack at full power from the default (high) launcher, as the page would aim
// it (aim.ts pick and shotFor). A click whose aim is out of reach, or refused, moves on to the next point of a
// spiral out from the middle, as the agent playtest's bot did. Pure apart from the engine it is given.
import type { PhysicsEngine } from '@tb/engine-api';
import { compileLevel, Driver, Duel, type DuelDef, type DuelResult, duelLevel, type Player, type Shot } from '@tb/keystone';
import { rayThrough } from '@tb/render/camera';
import { azFromYaw, launchHeight, pick, shotFor, SUBSTEPS } from './aim.ts';
import { duelView } from './duel-view.ts';
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

/** One novice turn: the click, the body under it (-1: the ground) and whether that is the shooter's own, the shot, and the step it settled at. */
export interface NoviceTurn { player: Player; shot: Shot; click: [number, number]; body: number; own: boolean; target: [number, number, number]; settledAt: number }
export interface NoviceDuel { first: Player; turns: NoviceTurn[]; result: DuelResult; sides: Duel['sides']; steps: number }

/**
 * One duel of two novices on `engine` (fresh: it is reset here), `first` to fire first, clicks from `seed`, on a screen
 * of `aspect`. Stops when the duel is decided, nothing can be fired, or after `maxSteps` engine steps.
 */
export async function noviceDuel(engine: PhysicsEngine, def: DuelDef, first: Player, seed: number, aspect = 1.6, maxSteps = 40_000): Promise<NoviceDuel> {
  const c = compileLevel(duelLevel(def, first)), d = new Driver(engine, c, { refereed: true });
  await d.reset();
  const duel = new Duel(def, c, first, d.session.home), rnd = seeded(seed), turns: NoviceTurn[] = [];
  const substeps = engine.info.integrator?.substeps ?? SUBSTEPS, y = launchHeight(c, 'high');
  while (!duel.result.over && engine.stepIndex < maxSteps) {
    const p = duel.turn, ammo = duel.left[p][0];
    if (ammo === undefined) break;
    const o = duelView(c, def, p, aspect), az = azFromYaw(o.yaw);
    let chosen: Omit<NoviceTurn, 'settledAt'> | null = null;
    for (const [x, yy] of clickPoints(aspect, rnd)) {
      const hit = pick(rayThrough(o, aspect, x, yy), d.snapshot, c);
      if (!hit) continue;
      const a = shotFor(c, ammo, az, 100, hit.point, substeps, y);
      if (a?.reachable && !duel.refuse(a.shot)) { chosen = { player: p, shot: a.shot, click: [x, yy], body: hit.body, own: duel.owned[p].includes(hit.body), target: [...hit.point] as [number, number, number] }; break; }
    }
    if (!chosen) break;
    d.fire(chosen.shot);
    duel.fired(chosen.shot);
    do await d.step(); while (d.session.phase === 'running' && engine.stepIndex < maxSteps);
    duel.settled(d.snapshot);
    turns.push({ ...chosen, settledAt: engine.stepIndex });
  }
  await d.drain();
  return { first, turns, result: duel.result, sides: duel.sides, steps: engine.stepIndex };
}

/** One novice duel as a line of a balance table: who fired first, who won (null: a draw or undecided), why, its turns and clicks on own blocks. */
export interface DuelOutcome { first: Player; winner: Player | null; over: boolean; why: string; turns: number; own: number; steps: number }

export const duelOutcome = (r: NoviceDuel): DuelOutcome => ({
  first: r.first, winner: r.result.over ? r.result.winner : null, over: r.result.over, why: r.result.over ? r.result.why : 'undecided',
  turns: r.turns.length, own: r.turns.filter((t) => t.own).length, steps: r.steps,
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
  return { ...t, turnsPerDuel: rs.length ? t.turns / rs.length : 0, goldRate: decided ? t.gold / decided : NaN, firstRate: decided ? t.first / decided : NaN };
}

/** A balance row as one line of text (the CLIs print it). */
export function tallyLine(id: string, engine: string, aspect: number, t: ReturnType<typeof tallyDuels>): string {
  const pc = (x: number) => (Number.isNaN(x) ? 'n/a' : `${Math.round(100 * x)}%`);
  return `${id} ${engine} aspect ${aspect}, ${t.duels} duels: Gold ${t.gold}, Blue ${t.blue}, draws ${t.draw}; first ${t.first}, second ${t.second} (Gold ${pc(t.goldRate)}, first ${pc(t.firstRate)} of decided); ${t.turnsPerDuel.toFixed(1)} turns a duel (fewest ${t.fewest}); clicks on own blocks ${t.own}`;
}
