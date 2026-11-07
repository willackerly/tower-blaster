// Fuse & Fold's timeline (M5, docs/game/fuse-and-fold.md): the player's plan for a fold level's charges.
// Every plunger charge is on it (a fold level's plunger fires them all), each with a delay on the 0.1 s
// grid from 0 to 2 s; the Sweep tool fills the delays as a demolition engineer would (a direction, and a
// spacing between rows along it), and the player tunes from there. Pure state: fuse-panel.ts draws it,
// and the markers on the charges' hosts are an overlay coloured by delay; the lot is chalked on the ground and
// the panel's compass needle turns with the camera, so the compass buttons read in the scene.
import type { CompiledLevel, PlungerShot } from '@tb/keystone';
import { rgbe } from './scene.ts';

/** Engine steps per snap (0.1 s at 60 Hz) and the most snaps a delay can be (2 s). */
export const SNAP_STEPS = 6;
export const MAX_SNAPS = 20;

/** Compass points a sweep can fall towards: the row furthest that way goes first. Unit (x, z); north is -z. */
export const SWEEP_DIRS: ReadonlyArray<{ name: string; d: [number, number] }> = [
  { name: 'N', d: [0, -1] }, { name: 'NE', d: [Math.SQRT1_2, -Math.SQRT1_2] }, { name: 'E', d: [1, 0] }, { name: 'SE', d: [Math.SQRT1_2, Math.SQRT1_2] },
  { name: 'S', d: [0, 1] }, { name: 'SW', d: [-Math.SQRT1_2, Math.SQRT1_2] }, { name: 'W', d: [-1, 0] }, { name: 'NW', d: [-Math.SQRT1_2, -Math.SQRT1_2] },
];

export interface TimelineCharge {
  /** Index in LevelDef.charges (what the plunger shot names). */
  charge: number;
  host: number;
  /** "A1": column letter west to east, row number north to south, then the storey above the ground ("A1 s2"). */
  label: string;
  /** Where the marker sits: the host's centre at home, m. */
  at: [number, number, number];
}

/** Distinct values of xs grouped within tol of the previous one, in order: the index of each x's group. */
function groups(xs: readonly number[], tol: number): number[] {
  const sorted = [...new Set(xs)].sort((a, b) => a - b), key = new Map<number, number>();
  let g = -1, last = -Infinity;
  for (const x of sorted) { if (x - last > tol) g++; key.set(x, g); last = x; }
  return xs.map((x) => key.get(x)!);
}

/** The level's plunger charges with their labels and marker points, in charge order. */
export function timelineCharges(c: CompiledLevel): TimelineCharge[] {
  const defs = c.def.charges ?? [], m = c.meta, tol = 0.25 * c.frame.unit * c.frame.pitch;
  const live = defs.flatMap((ch, i) => ((ch.arm ?? 'plunger') === 'plunger' ? [{ charge: i, host: ch.host }] : []));
  const at = live.map(({ host }) => [m.home[3 * host]!, m.home[3 * host + 1]!, m.home[3 * host + 2]!] as [number, number, number]);
  const col = groups(at.map((p) => p[0]), tol), row = groups(at.map((p) => p[2]), tol), lvl = groups(at.map((p) => p[1]), c.frame.unit);
  return live.map((x, k) => ({ ...x, at: at[k]!, label: `${String.fromCharCode(65 + (col[k]! % 26))}${row[k]! + 1}${lvl[k]! > 0 ? ` s${lvl[k]! + 1}` : ''}` }));
}

/** The rows of a sweep: each charge's rank along direction d (rank 0 furthest that way), hosts within a quarter cell sharing a rank. */
export function sweepRanks(charges: readonly TimelineCharge[], d: readonly [number, number], cell: number): number[] {
  return groups(charges.map((t) => -(d[0] * t.at[0] + d[1] * t.at[2])), 0.25 * cell);
}

/**
 * The level's relays (charges armed at start, C5's sympathetic charge: they go off when their host is jolted):
 * host, storey (1 = ground) and marker point, in charge order. Not on the timeline: the plunger cannot set them.
 */
export function relayCharges(c: CompiledLevel): { charge: number; host: number; storey: number; at: [number, number, number] }[] {
  const defs = c.def.charges ?? [], m = c.meta;
  const live = defs.flatMap((ch, i) => (ch.arm === 'start' ? [{ charge: i, host: ch.host }] : []));
  if (!live.length) return [];
  // The storey: 1 + the floors under the host (bodies under it, over its centre, wider than it both ways).
  const storey = (h: number) => {
    let k = 1;
    for (let b = 0; b < m.n; b++) {
      if (b === h || m.home[3 * b + 1]! >= m.home[3 * h + 1]!) continue;
      if (m.half[3 * b]! <= 2 * m.half[3 * h]! || m.half[3 * b + 2]! <= 2 * m.half[3 * h + 2]!) continue;
      if (Math.abs(m.home[3 * b]! - m.home[3 * h]!) <= m.half[3 * b]! && Math.abs(m.home[3 * b + 2]! - m.home[3 * h + 2]!) <= m.half[3 * b + 2]!) k++;
    }
    return k;
  };
  return live.map(({ charge, host }) => ({ charge, host, storey: storey(host), at: [m.home[3 * host]!, m.home[3 * host + 1]!, m.home[3 * host + 2]!] }));
}

/** A relay's marker colour: cool blue, so it never reads as a delay. */
export const RELAY_COLOUR = rgbe(90, 190, 255, 0.55);
export const RELAY_CSS = 'rgb(90, 190, 255)';

/**
 * The timeline the Fuse & Fold panel shows for a level: one when its rack has a plunger and the plunger arms a
 * charge, none on a Rube Lab contraption (its plunger is the Go button's release, not a timed demolition).
 */
export function panelTimeline(c: CompiledLevel): Timeline | null {
  if (!c.def.rack.includes('plunger') || c.def.rube) return null;
  const t = new Timeline(c);
  return t.empty ? null : t;
}

export class Timeline {
  readonly charges: TimelineCharge[];
  /** Relays (arm 'start'), shown but not set: they go off when jolted. */
  readonly relays: ReturnType<typeof relayCharges>;
  /** Each charge's delay in snaps (0 to MAX_SNAPS), index-aligned with charges. */
  readonly snaps: number[];
  /** The charge row the player is editing (its marker drawn larger), or -1. */
  selected = -1;
  constructor(readonly level: CompiledLevel) {
    this.charges = timelineCharges(level);
    this.relays = relayCharges(level);
    this.snaps = this.charges.map(() => 0);
  }

  get empty(): boolean { return this.charges.length === 0; }

  set(k: number, snaps: number): void {
    if (k < 0 || k >= this.snaps.length) return;
    this.snaps[k] = Math.max(0, Math.min(MAX_SNAPS, Math.round(snaps)));
  }

  /** Every delay to 0: all at once. */
  clear(): void { this.snaps.fill(0); }

  /** Fill the delays as a sweep: `spacing` snaps between consecutive rows along direction `dir` (SWEEP_DIRS name), capped at MAX_SNAPS. */
  sweep(dir: string, spacing: number): void {
    const d = SWEEP_DIRS.find((x) => x.name === dir);
    if (!d) throw new Error(`sweep: no direction ${dir}`);
    const ranks = sweepRanks(this.charges, d.d, this.level.frame.unit * this.level.frame.pitch);
    ranks.forEach((r, k) => this.set(k, r * spacing));
  }

  /** The plunger shot: every charge at its delay, ordered by delay then charge (the order same-step charges go in). */
  shot(): PlungerShot {
    const fuse = this.charges.map((t, k): [number, number] => [t.charge, this.snaps[k]! * SNAP_STEPS]);
    fuse.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return { ammo: 'plunger', fuse };
  }

  /** Loads a plunger shot's delays (snapped to the grid); charges it does not name go to 0. */
  load(shot: PlungerShot): void {
    this.clear();
    for (const [ch, steps] of shot.fuse) {
      const k = this.charges.findIndex((t) => t.charge === ch);
      if (k >= 0) this.set(k, steps / SNAP_STEPS);
    }
  }

  /** The latest delay, in seconds. */
  get span(): number { return Math.max(0, ...this.snaps) / 10; }
}

/** A delay's marker colour: yellow at 0 s through orange to red at 2 s, glowing. */
export function delayColour(snaps: number): number {
  const t = Math.max(0, Math.min(1, snaps / MAX_SNAPS));
  return rgbe(255, Math.round(214 - 170 * t), Math.round(80 - 40 * t), 0.55);
}

/** CSS colour of the same delay, for the panel's dots. */
export function delayCss(snaps: number): string {
  const t = Math.max(0, Math.min(1, snaps / MAX_SNAPS));
  return `rgb(255, ${Math.round(214 - 170 * t)}, ${Math.round(80 - 40 * t)})`;
}

export const MARKER_RADIUS = 0.11;

/**
 * Overlay spheres: one marker per charge, low on its host's outer face (away from the charges' centre; a
 * charge at the centre shows on its south face), coloured by delay; the selected charge's is larger. Then one
 * per relay, in RELAY_COLOUR.
 */
export function timelineOverlay(t: Timeline): { xyzr: Float32Array<ArrayBuffer>; colours: Uint32Array<ArrayBuffer> } {
  const n = t.charges.length, all = n + t.relays.length, xyzr = new Float32Array(4 * all), colours = new Uint32Array(all), m = t.level.meta;
  const cx = t.charges.reduce((a, ch) => a + ch.at[0], 0) / Math.max(1, n), cz = t.charges.reduce((a, ch) => a + ch.at[2], 0) / Math.max(1, n);
  const r = MARKER_RADIUS * (t.level.frame.unit / 0.5);
  const put = (k: number, host: number, at: readonly number[], radius: number, colour: number) => {
    const hx = m.half[3 * host]!, hy = m.half[3 * host + 1]!, hz = m.half[3 * host + 2]!;
    let dx = at[0]! - cx, dz = at[2]! - cz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
    // To the box's face along (dx, dz): the nearer of its x and z faces, then a little proud of it.
    const reach = Math.min(Math.abs(dx) > 1e-6 ? hx / Math.abs(dx) : Infinity, Math.abs(dz) > 1e-6 ? hz / Math.abs(dz) : Infinity) + 0.5 * radius;
    xyzr.set([at[0]! + dx * reach, at[1]! - 0.5 * hy, at[2]! + dz * reach, radius], 4 * k);
    colours[k] = colour;
  };
  t.charges.forEach((ch, k) => put(k, ch.host, ch.at, r * (k === t.selected ? 1.6 : 1), delayColour(t.snaps[k]!)));
  // Relays after the timeline's charges, in their own colour.
  t.relays.forEach((ch, k) => put(n + k, ch.host, ch.at, r, RELAY_COLOUR));
  return { xyzr, colours };
}

/** Lot chalk: beads about this many cube edges apart, this big (in cube edges), this bright. */
export const LOT_SPACING = 1;
export const LOT_RADIUS = 0.12;
export const LOT_COLOUR = rgbe(240, 236, 220, 0.3);

/**
 * Overlay spheres that chalk the lot's edge on the ground (a fold level is judged on what stays inside it, so
 * the player needs to see the yard): a bead at every corner and the rest about LOT_SPACING cube edges apart.
 */
export function lotBeads(c: CompiledLevel): { xyzr: Float32Array<ArrayBuffer>; colours: Uint32Array<ArrayBuffer> } {
  const u = c.frame.unit, r = LOT_RADIUS * u, [x0, z0] = c.lot.min, [x1, z1] = c.lot.max;
  const corners: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], pts: number[] = [];
  corners.forEach(([ax, az], k) => {
    const [bx, bz] = corners[(k + 1) % 4]!, n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / (LOT_SPACING * u)));
    for (let i = 0; i < n; i++) pts.push(ax + ((bx - ax) * i) / n, r, az + ((bz - az) * i) / n, r);
  });
  const xyzr = Float32Array.from(pts);
  return { xyzr, colours: new Uint32Array(pts.length / 4).fill(LOT_COLOUR) };
}

/**
 * Where north (-z) points on screen at the view's centre, for an orbit camera at `yaw` and `pitch` (render
 * camera.ts eyeOf: the eye sits at target + d (cos pitch sin yaw, sin pitch, cos pitch cos yaw)): radians
 * clockwise from screen-up, for a CSS rotate of an up-pointing needle. Looking down at a slant shortens the
 * ground's depth by sin(pitch), so the needle leans toward the side the ground's north really shows.
 */
export function northOnScreen(yaw: number, pitch = Math.PI / 2): number {
  return Math.atan2(Math.sin(yaw), Math.cos(yaw) * Math.sin(pitch));
}
