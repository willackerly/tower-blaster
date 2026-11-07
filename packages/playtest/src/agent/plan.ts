// The agent playtest's plan (roadmap G9b, docs/game/agent-playtest-1.md): which
// pages it opens, at which viewports, and how it plays each one. Pure data and
// small pure functions, so the coverage (every level, every mode, both form
// factors) is a unit test and not a hope; run.ts drives the browser from it.
import { AFTERSHOCK_LEVELS, BIG_LEVELS, DUELS, FUSE_LEVELS, LEVELS, type LevelDef, MASON_LEVELS, RUBE_LEVELS, type Shot, TRIAL_LEVELS, UNDERCUT_LEVELS } from '@tb/keystone';
import { RUBE_SOLUTIONS } from '../../../keystone-lab/src/rube-solutions.ts';

/** The form factors played: a laptop, a phone held upright (touch), and the same phone turned. */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, scale: 1, touch: false },
  phone: { width: 390, height: 844, scale: 2, touch: true },
  'phone-landscape': { width: 844, height: 390, scale: 2, touch: true },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/**
 * How a scenario plays its level:
 * - `line`: the level's recorded line (solutions.par on the chamber levels, solutions.ace on B1 and B2): a competent player.
 * - `novice`: what a first visit does: the pre-aimed opener when the HUD offers one, then clicks near the middle of
 *   the screen with the first item left in the rack, a small seeded jitter each time (noviceAim), up to `shots` shots;
 *   an outcome level still open after them is banked. In the new modes (round 2) a first visit takes what the
 *   level offers as it opens: Fuse & Fold's Plunger with the delays as they load, Aftershock's Start with the
 *   dial as it loads, Rube Lab's Play with nothing built and then its Plunger.
 * - `line` in the new modes: Aftershock's recorded quake (solutions.ace); Rube Lab's recorded build (keystone-lab
 *   rube-solutions.ts, the first: the parts par), built through the page's build keys and pointer (modes.ts).
 * - `sweep` (Fuse & Fold): the timeline's Sweep button toward the site's yard at the spacing it shows (0.6 s), then
 *   the Plunger: the verb the mode is about, found by a player who tries the panel's one obvious button.
 */
export type Policy = 'line' | 'novice' | 'sweep';

export type Script =
  /** The front door: as it opens, with Advanced settings open, and with the Trials list open. */
  | { kind: 'door' }
  /** Play the level; capture the aim view, a short sequence of the first shot, each settle and the result card. */
  | { kind: 'play'; policy: Policy; shots: number; undo?: boolean; retry?: boolean }
  /** Only the aim view (a look, or a trial on a phone): cheap coverage of what the level looks like. */
  | { kind: 'view' }
  /** Bullet Time: fire, freeze mid-shot, capture the frozen world, fire into it, resume. */
  | { kind: 'freeze' }
  /** A Siege Table duel: `turns` turns, novice aims, the turn view between them. */
  | { kind: 'duel'; turns: number };

export interface Scenario {
  /** File-safe id: the captures are <id>-<viewport>-<nn>-<what>.png. */
  id: string;
  /** What a reader of the report calls it. */
  title: string;
  /** The mode the scenario stands for (the brief's list): level, door, bullet-time, siege-table, look, trial, ice, touch; round 2 adds fuse, aftershock, rube, mason. */
  mode: string;
  /** The game page's search string, without the harness's own keys (engine, offscreen, progress, door). */
  search: string;
  viewports: ViewportName[];
  script: Script;
  /** The level the scenario plays (null: the door, a duel). */
  level: string | null;
  /**
   * The physics engine (absent: Rapier, which keeps a 1,000 to 10,000 block level to minutes on SwiftShader). The GPU
   * solver, the players' engine, for the chamber levels, Undercut and the duels: on Rapier a resting structure sleeps,
   * so a shot from a launcher over 4 h outside the lot settles 20 steps in, with the ball still in the air (rules.ts
   * ammoLive; outcome levels keep their launchers within 4 h, par levels do not), and a pull's sleeping neighbours
   * never fall. The GPU engine does not sleep by default, so neither happens there.
   */
  engine?: 'gpu' | 'rapier';
}

const BOTH: ViewportName[] = ['desktop', 'phone'];
const hasLine = (l: LevelDef) => !!(l.solutions?.par ?? l.solutions?.ace);

/** The new mode series round 2 adds (each small: tens of bodies, so the players' GPU solver throughout), by mode name. */
export const NEW_MODES = [['fuse', FUSE_LEVELS], ['aftershock', AFTERSHOCK_LEVELS], ['rube', RUBE_LEVELS]] as const;
/**
 * Not on the game page yet, so not played: Mason's Trial (MT1-MT4: its test phase, door series and `?level=` land in
 * a second PR, docs/game/masons-trial.md follow-ups) and Chorus (#269, a draft). Named here so the report says so.
 */
export const NOT_ON_PAGE = { mason: MASON_LEVELS.map((l) => l.id), chorus: ['#269'] } as const;

/** The agent's plan: every rated level at both form factors, every trial, both duels, Bullet Time, the door, the looks. */
export function agentPlan(): Scenario[] {
  const out: Scenario[] = [];
  out.push({ id: 'door', title: 'Front door', mode: 'door', search: '?door=1', viewports: [...BOTH, 'phone-landscape'], script: { kind: 'door' }, level: null });
  // The rated levels: a first-visit play at both form factors, and the recorded line where there is one (desktop).
  for (const l of [...BIG_LEVELS, ...LEVELS, ...UNDERCUT_LEVELS]) {
    const engine = BIG_LEVELS.includes(l) ? {} : { engine: 'gpu' as const };
    out.push({ ...engine, id: `${l.id}-novice`, title: `${l.id} ${l.name}, first visit`, mode: 'level', search: `?level=${l.id}`, viewports: BOTH, script: { kind: 'play', policy: 'novice', shots: Math.min(l.rack.length, 4), undo: l.id === 'L3', retry: l.id === 'L3' }, level: l.id });
    if (hasLine(l)) out.push({ ...engine, id: `${l.id}-line`, title: `${l.id} ${l.name}, recorded line`, mode: 'level', search: `?level=${l.id}`, viewports: ['desktop'], script: { kind: 'play', policy: 'line', shots: (l.solutions!.par ?? l.solutions!.ace)!.length }, level: l.id });
  }
  // Every trial: a first-visit play on the desktop, the aim view on the phone. Ice trials again in the real look.
  for (const l of TRIAL_LEVELS) {
    const ice = l.id.startsWith('T-I');
    out.push({ id: `${l.id}-novice`, title: `${l.id} ${l.name}, first visit`, mode: ice ? 'ice' : 'trial', search: `?level=${l.id}`, viewports: ['desktop'], script: { kind: 'play', policy: 'novice', shots: Math.min(l.rack.length, 3) }, level: l.id });
    out.push({ id: `${l.id}-view`, title: `${l.id} ${l.name}, aim view`, mode: ice ? 'ice' : 'trial', search: `?level=${l.id}`, viewports: ['phone'], script: { kind: 'view' }, level: l.id });
    if (ice) out.push({ id: `${l.id}-real`, title: `${l.id} ${l.name}, real look`, mode: 'ice', search: `?level=${l.id}&look=real`, viewports: ['desktop'], script: { kind: 'play', policy: 'novice', shots: 2 }, level: l.id });
  }
  // Bullet Time on a big level and a chamber level.
  out.push({ id: 'B1-bullet-time', title: 'Bullet Time on B1 (3 freezes)', mode: 'bullet-time', search: '?level=B1&keystone.freeze=3', viewports: BOTH, script: { kind: 'freeze' }, level: 'B1' });
  out.push({ engine: 'gpu', id: 'L5-bullet-time', title: 'Bullet Time on L5 (2 freezes)', mode: 'bullet-time', search: '?level=L5&keystone.freeze=2', viewports: ['desktop'], script: { kind: 'freeze' }, level: 'L5' });
  // Siege Table: every table, up to eight turns (a novice duel ends in about four on the GPU: round 2).
  for (const d of DUELS) out.push({ engine: 'gpu', id: `duel-${d.id}`, title: `Siege Table ${d.id} ${d.name}`, mode: 'siege-table', search: `?duel=${d.id}`, viewports: BOTH, script: { kind: 'duel', turns: 8 }, level: null });
  // The looks on two levels (the default is hazy; candy and real are options).
  for (const look of ['real', 'candy']) for (const id of ['L3', 'B2']) out.push({ ...(id === 'L3' ? { engine: 'gpu' as const } : {}), id: `${id}-${look}`, title: `${id} in the ${look} look`, mode: 'look', search: `?level=${id}&look=${look}`, viewports: ['desktop'], script: { kind: 'view' }, level: id });
  // B1 turned sideways on a phone.
  out.push({ id: 'B1-landscape', title: 'B1 on a phone held sideways', mode: 'touch', search: '?level=B1', viewports: ['phone-landscape'], script: { kind: 'play', policy: 'novice', shots: 2 }, level: 'B1' });
  // Round 2: the new mode series. A first visit at both form factors and sideways, the mode's verb or recorded line
  // on the desktop (NOT_ON_PAGE lists the modes the page cannot open yet).
  for (const [mode, levels] of NEW_MODES) {
    for (const l of levels) {
      const at = { engine: 'gpu' as const, mode, search: `?level=${l.id}`, level: l.id };
      out.push({ ...at, id: `${l.id}-novice`, title: `${l.id} ${l.name}, first visit`, viewports: [...BOTH, 'phone-landscape'], script: { kind: 'play', policy: 'novice', shots: 1 } });
      if (mode === 'fuse') out.push({ ...at, id: `${l.id}-sweep`, title: `${l.id} ${l.name}, swept toward the yard`, viewports: ['desktop'], script: { kind: 'play', policy: 'sweep', shots: 1 } });
      if (l.solutions?.ace || RUBE_SOLUTIONS[l.id]) out.push({ ...at, id: `${l.id}-line`, title: `${l.id} ${l.name}, recorded ${mode === 'rube' ? 'build' : 'line'}`, viewports: ['desktop'], script: { kind: 'play', policy: 'line', shots: 1 } });
    }
  }
  return out;
}

/** The recorded line a `line` scenario plays: the par line, else the showcase (ace); a Rube Lab level's is its build, then the Plunger (modes.ts). */
export function lineOf(l: LevelDef): Shot[] {
  const s = l.solutions?.par ?? l.solutions?.ace;
  if (!s) throw new Error(`${l.id} has no recorded line`);
  return s as Shot[];
}

/** A small seeded PRNG (mulberry32): the novice's jitter is the same every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where a novice clicks for shot k (NDC, x right, y up): the middle of the screen, where the camera opens on the
 * structure, a little below it (structures stand on the ground), then jittered by up to `spread` from shot to shot.
 */
export function noviceAim(k: number, seed: number, spread = 0.18): [number, number] {
  const r = rng(seed * 977 + k);
  if (k === 0) return [0, -0.05];
  return [(r() * 2 - 1) * spread, -0.05 + (r() * 2 - 1) * spread];
}

/** Candidate points, centre outwards, for a click that must land on a block (a pull): a spiral of rings over the middle of the screen. */
export function spiral(rings = 6, step = 0.06): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, -0.05]];
  for (let r = 1; r <= rings; r++) {
    const n = 8 * r;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push([Math.cos(a) * r * step, -0.05 + Math.sin(a) * r * step]);
    }
  }
  return out;
}

/** The capture's file name: <scenario>-<viewport>-<nn>-<what>.png, nn its order within the run. */
export function frameName(scenario: string, viewport: ViewportName, n: number, what: string): string {
  return `${scenario}-${viewport}-${String(n).padStart(2, '0')}-${what.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.png`;
}

/**
 * The contact sheet's grid for n frames of a w x h viewport: columns so the sheet is at most `maxWidth` wide and
 * each frame drawn at `scale` of its size. Returns cols, rows and the cell size.
 */
export function sheetGrid(n: number, w: number, h: number, maxWidth = 2000): { cols: number; rows: number; cellW: number; cellH: number } {
  const portrait = h > w;
  const cellW = portrait ? 300 : 640, cellH = Math.round((cellW * h) / w);
  const cols = Math.max(1, Math.min(n, Math.floor(maxWidth / cellW)));
  return { cols, rows: Math.ceil(n / cols), cellW, cellH };
}

/**
 * A scenario's search with its look set to `look` (run.ts --look): replaces a look= it names, or adds one.
 * For a side-by-side look review (docs/render/look-colours.md §4): the same scenarios, lines and shots in each look.
 */
export function withLook(search: string, look: string): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  q.set('look', look);
  return `?${q.toString()}`;
}
