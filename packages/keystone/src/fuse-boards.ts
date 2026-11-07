// Fuse & Fold's domino fuses (M5b, docs/game/fuse-and-fold.md, "Domino fuses"): the delays are not set on a
// timeline; the player lays them. A fuse level is a fold site with a firing board beside it, one lane per row
// of columns to cut:
//
//   [stop] lead  o o o o o  >  (the player's fuse)  >  socket  ~~cord~~>  the row's columns
//
// - The lead: a domino cocked 25 degrees toward the lane, resting on a pinned stop. The plunger fires a
//   release (Rube Lab's start) that takes the stop out, and the lead falls on gravity alone.
// - The lead run: LEAD_RUN dominoes the level lays. A wave starting from a domino at rest needs about five
//   dominoes to reach its steady speed (on the reference, hops of 23, 20, 17, 15, 14 steps, then 13); after
//   them the wave enters the player's fuse at the speed it keeps, so a fuse's delay is its length over that
//   speed. A blast kick instead of the lead either threw the first dominoes across the board (an uncapped
//   kicker scaled to the frame's rods: 7 m/s) or started as slow a wave as gravity does (a capped one).
// - The player's fuse: a domino run laid with the brush (C9) from the lane's head to a socket.
// - The socket: a domino at the lane's end. Every column of the lane's row carries a detonator (@tb/weapons
//   DETONATOR) watching it (ChargeDef.watch): when the wave tips the socket, the row is cut.
//
// So a fuse's length is its row's delay: X1's front runs 0.90 to 0.96 sqrt(g h) (2.8 to 3.0 m/s for the game's
// 1 m domino), a domino every 0.6 m, about 0.2 s a domino. Lanes run along x or z, so the stop and socket stand
// unturned (exact rotations, their boxes' axes swapped) and a straight run turns by dirQuat's sqrt; the lead's
// tilt uses trig, so its fields are literals (a piece's fields, not its body, are hashed).
// The fuse's pieces and runs are props, not building (rules.ts foldProp): no spill, collapse or weapon scale.
import { castOf } from './big-levels.ts';
import { type FoldSite, foldLevel, frameBuilding } from './fuse-buildings.ts';
import type { ChargeDef, CompiledLevel, LevelDef, Part } from './level.ts';
import type { PlungerShot } from './shots.ts';
import { DOMINO_HALF, DOMINO_PITCH, type P2, runPoses } from './stroke.ts';

/** The lead's lean toward its lane, degrees. */
export const LEAD_TILT = 25;
/** The lead: a domino with its thin axis along local x (so pieceQuat's tilt, about local z, leans it along the lane once yawed). */
export const LEAD_HALF: [number, number, number] = [DOMINO_HALF[2], DOMINO_HALF[1], DOMINO_HALF[0]];
/** Height of the lead's centre (h) with its low edge on the ground at LEAD_TILT: hy cos t + hx sin t (fuse-boards.test.ts checks it). */
export const LEAD_Y = 0.9697;
/**
 * The stop: a pinned stone block whose near top edge holds the lead's face 0.6 h above the lead's centre (its centre
 * along the lane and up from the lead's, h). Its top edge, not its face, carries the lead: the leaning face slants
 * away above the contact, so a stop centred on it overlapped the lead by 0.08 h.
 */
export const STOP_HALF: [number, number, number] = [0.5, 0.2, 0.2];
export const STOP_AT: [number, number] = [0.5915, 0.2804];
/** The lead run: dominoes the level lays from the lead (the first LEAD_FIRST h from the lead's centre), so the wave is at its steady speed at the head. */
export const LEAD_RUN = 5;
export const LEAD_FIRST = 1.5;

/** The ways a lane can burn: toward -z (N), +z (S), +x (E) or -x (W). */
export type Burn = 'N' | 'S' | 'E' | 'W';
/** Each way as a unit vector (x, z), and the lead's yaw that leans it that way (pieceQuat: local +x, the lead's thin axis, turned to it). */
export const BURN: Readonly<Record<Burn, { dir: P2; yaw: number }>> = { N: { dir: [0, -1], yaw: 90 }, S: { dir: [0, 1], yaw: -90 }, E: { dir: [1, 0], yaw: 0 }, W: { dir: [-1, 0], yaw: 180 } };

/**
 * One fuse lane, straight along x or z: its lead's centre on the ground plane (h), the way it burns, how many
 * dominoes a straight fuse takes from the head to the socket, and the ground columns (frame grid [i, j]) its
 * socket's detonators cut.
 */
export interface FuseLane { lead: P2; burns: Burn; straight: number; row: Array<[number, number]> }

/** A fuse level: the fold site (its `cuts` unused: the lanes' rows are cut), its lanes, and the dominoes the player may lay. */
export interface FuseSite { site: FoldSite; lanes: FuseLane[]; budget: number }

/** Where a lane's parts stand (h): the lead run's dominoes, the head (the first domino of a fuse laid from it), the socket, and the way it burns. */
export interface LaneGeometry { run: P2[]; head: P2; socket: P2; dir: P2 }

export function laneGeometry(l: FuseLane): LaneGeometry {
  const dir = BURN[l.burns].dir, [x, z] = l.lead, at = (d: number): P2 => [x + dir[0] * d, z + dir[1] * d];
  const run = Array.from({ length: LEAD_RUN }, (_, k) => at(LEAD_FIRST + k * DOMINO_PITCH));
  return { run, head: at(LEAD_FIRST + LEAD_RUN * DOMINO_PITCH), socket: at(LEAD_FIRST + (LEAD_RUN + l.straight) * DOMINO_PITCH), dir };
}

/**
 * A lane's parts: the stop (pinned), the lead (cocked), the lead run, the socket; one body each but the run (LEAD_RUN).
 * The stop and socket are boxes with their thin axis along the lane (half extents swapped for an x lane), never turned.
 */
export function laneParts(l: FuseLane): { stop: Part; lead: Part; run: Part; socket: Part } {
  const g = laneGeometry(l), [dx, dz] = g.dir, [x, z] = l.lead, alongX = dx !== 0;
  const across = (h: [number, number, number]): [number, number, number] => (alongX ? [h[2], h[1], h[0]] : [...h]);
  return {
    stop: { kind: 'piece', at: [x + dx * STOP_AT[0], LEAD_Y + STOP_AT[1], z + dz * STOP_AT[0]], half: across(STOP_HALF), material: 'stone', pinned: true },
    lead: { kind: 'piece', at: [x, LEAD_Y, z], half: [...LEAD_HALF], yaw: BURN[l.burns].yaw, tilt: -LEAD_TILT, material: 'plaster' },
    run: { kind: 'run', path: [g.run[0]!, g.run.at(-1)!], pitch: DOMINO_PITCH, half: [...DOMINO_HALF], material: 'plaster' },
    socket: { kind: 'piece', at: [g.socket[0], DOMINO_HALF[1], g.socket[1]], half: across(DOMINO_HALF as [number, number, number]), material: 'plaster' },
  };
}

/** Bodies a lane adds: stop, lead, LEAD_RUN dominoes, socket. */
export const LANE_BODIES = LEAD_RUN + 3;

/**
 * A fuse level: the fold site's building, lot and neighbours (fuse-buildings.ts foldLevel), then each lane's
 * parts; a release on every stop and a detonator on every column of each lane's row watching that lane's
 * socket, all armed by the plunger at 0 (a fuse level's plunger names every charge with no delay: the fuses
 * are the delays); the domino brush within `budget`. Settles by v3, as F1 to F5 (fuse-levels.ts shipped).
 */
export function fuseLevel(id: string, name: string, fs: FuseSite, extra: Partial<LevelDef> = {}): LevelDef {
  const base = foldLevel(id, name, { ...fs.site, cuts: [] });
  const fr = frameBuilding(fs.site.frame), first = base.parts.length;
  // Every fold part is one body (rods and course slabs), so lane k's bodies start at first + k * LANE_BODIES.
  const parts: Part[] = [], charges: ChargeDef[] = [];
  fs.lanes.forEach((l, k) => {
    const p = laneParts(l);
    parts.push(p.stop, p.lead, p.run, p.socket);
    charges.push({ host: first + k * LANE_BODIES, weapon: 'release' });
  });
  fs.lanes.forEach((l, k) => {
    const socket = first + (k + 1) * LANE_BODIES - 1;
    for (const [i, j] of l.row) {
      const host = fr.ground[i]?.[j];
      if (host === undefined) throw new RangeError(`${id}: lane ${k} names column [${i}, ${j}], not on a ${fs.site.frame.nx} x ${fs.site.frame.nz} frame`);
      charges.push({ host, weapon: 'detonator', watch: socket });
    }
  });
  return { ...base, settle: 'v3', parts: [...base.parts, ...parts], charges, build: { budget: fs.budget, pieces: ['domino'], brush: true }, ...extra };
}

/** The fuse sites, by id (candidates judged by the fuse gate: keystone-lab fuse-gate.ts). */
export const FUSE_SITES: Readonly<Record<string, { name: string; fuse: FuseSite }>> = {
  // F1's slender tower, its board to the south: a lane per row. Straight, they burn together and the tower drops a
  // storey; the east row's fuse must burn 0.6 s (3 to 4 dominoes) longer for it to fall west into the yard.
  'FD-1': {
    name: 'Slow Match',
    fuse: {
      site: { frame: { nx: 2, nz: 2, span: 3, storeys: 6, slab: 0.5, colH: 2, column: 'rod' }, cuts: [], margin: 1, yards: [{ side: 'W', len: 22 }],
        neighbours: [{ side: 'E', gap: 1, w: 6, d: 2, h: 6 }, { side: 'N', gap: 1, w: 4, d: 2, h: 4, along: 0 }], min: 0.6, spillMax: 0.05 },
      lanes: [
        { lead: [-1.53, 29.6], burns: 'N', straight: 12, row: [[0, 0], [0, 1]] },
        { lead: [1.53, 29.6], burns: 'N', straight: 12, row: [[1, 0], [1, 1]] },
      ],
      budget: 26,
    },
  },
  // F2's tower, the yard north, its board to the east: three lanes, 7 h apart (a fuse's bumps reach 5.5 h off its line), for
  // the north, middle and south rows; 20 dominoes straight, so a lane has room for bumps worth 10 more.
  // Only a north-first sweep folds it: the middle row about 1 s after the north, the south 1 s after that.
  'FD-2': {
    name: 'Three Lines',
    fuse: {
      site: { frame: { nx: 3, nz: 3, span: 2, storeys: 6, slab: 0.5, colH: 2, column: 'rod' }, cuts: [], margin: 1, yards: [{ side: 'N', len: 22 }],
        neighbours: [{ side: 'W', gap: 1, w: 6, d: 2, h: 6 }, { side: 'S', gap: 1, w: 6, d: 2, h: 5 }], min: 0.6, spillMax: 0.05 },
      lanes: [0, 1, 2].map((j): FuseLane => ({ lead: [38.5, (j - 1) * 7], burns: 'W', straight: 20, row: [[0, j], [1, j], [2, j]] })),
      budget: 80,
    },
  },
  // F4's wide block and short yard, its board to the south: four lanes, 7 h apart, 22 dominoes straight, one per row west to east. A west
  // sweep of 0.4 to 0.8 s a row folds it (2 to 4 dominoes more each lane); shorter stands, longer throws it past the wall.
  'FD-3': {
    name: 'Short Fuse',
    fuse: {
      site: { frame: { nx: 4, nz: 3, span: 2, storeys: 5, slab: 0.5, colH: 2, column: 'rod' }, cuts: [], margin: 1, yards: [{ side: 'W', len: 14 }],
        neighbours: [{ side: 'W', gap: 1, w: 8, d: 2, h: 3 }, { side: 'E', gap: 1, w: 6, d: 2, h: 6 }], min: 0.6, spillMax: 0.05 },
      lanes: [0, 1, 2, 3].map((i): FuseLane => ({ lead: [(i - 1.5) * 7, 40.9], burns: 'N', straight: 22, row: [[i, 0], [i, 1], [i, 2]] })),
      budget: 110,
    },
  },
};

/** Whether a level is a domino-fuse level: the player builds, and some charge watches a socket. */
export const isFuseLevel = (def: LevelDef): boolean => !!def.build && (def.charges ?? []).some((ch) => ch.watch !== undefined);

/**
 * A fuse level's plunger shot: every plunger charge at delay 0 (the fuses are the delays), in charge order. The game's Go
 * button (as on Rube Lab) fires it; there is no timeline to set. Null on any other level.
 */
export function fuseGo(def: LevelDef): PlungerShot | null {
  if (!isFuseLevel(def)) return null;
  return { ammo: 'plunger', fuse: (def.charges ?? []).flatMap((ch, i): [number, number][] => ((ch.arm ?? 'plunger') === 'plunger' ? [[i, 0]] : [])) };
}

/**
 * A lane as the game finds it in a compiled fuse level (h, on the ground plane): its release charge, its socket body,
 * where a fuse starts (head) and should end (end: 0.6 h short of the socket), the way it burns, the columns it cuts,
 * and its straight fuse's dominoes.
 */
export interface LaneInfo { release: number; socket: number; head: P2; end: P2; socketAt: P2; dir: P2; hosts: number[]; straight: number }

/**
 * The lanes of a compiled fuse level, in release order, read from fuseLevel's layout: a release on a stop whose lane's
 * socket (LANE_BODIES - 1 bodies on) some detonator watches. Empty on any other level.
 */
export function fuseLanes(c: CompiledLevel): LaneInfo[] {
  const defs = c.def.charges ?? [], h = c.frame.unit, home = c.meta.home, out: LaneInfo[] = [];
  const at = (b: number): P2 => [home[3 * b]! / h, home[3 * b + 2]! / h];
  defs.forEach((ch, i) => {
    if (ch.weapon !== 'release') return;
    const socket = ch.host + LANE_BODIES - 1, hosts = defs.flatMap((d) => (d.watch === socket ? [d.host] : []));
    if (!hosts.length || socket >= c.meta.n) return;
    const stop = at(ch.host), sock = at(socket), dx = sock[0] - stop[0], dz = sock[1] - stop[1];
    const dir: P2 = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
    const lead: P2 = [stop[0] - dir[0] * STOP_AT[0], stop[1] - dir[1] * STOP_AT[0]], d0 = LEAD_FIRST + LEAD_RUN * DOMINO_PITCH;
    const head: P2 = [r3(lead[0] + dir[0] * d0), r3(lead[1] + dir[1] * d0)];
    const end: P2 = [r3(sock[0] - dir[0] * 0.6), r3(sock[1] - dir[1] * 0.6)];
    const straight = Math.round((Math.abs(sock[0] - lead[0]) + Math.abs(sock[1] - lead[1]) - d0) / DOMINO_PITCH);
    out.push({ release: i, socket, head, end, socketAt: sock, dir, hosts, straight });
  });
  return out;
}
const r3 = (x: number) => Math.round(x * 1e3) / 1e3 + 0;

/**
 * A fuse's burn on the reference (keystone-lab fuse-delay.test measures it): steps from the plunger until the wave
 * strikes the head domino, and a hop from one domino to the next on a straight. A bend shortens a hop: the
 * dominoes' inner edges stand closer than their centres, so a hop turning by angle a costs (1 - FUSE_BEND a / pitch) of a straight one (fitted to FD-1 sweeps: within 2%).
 */
export const FUSE_LEAD_STEPS = 96;
export const FUSE_HOP_STEPS = 12.9;
export const FUSE_BEND = 0.3;

/**
 * Engine steps from the plunger until a fuse laid along `path` (from its lane's head) fires its socket: the lead, then a
 * hop into each domino and one onto the socket. For the game's delay tags (an estimate; not part of any score or hash).
 */
export function fuseSteps(path: readonly P2[], bend = FUSE_BEND): number {
  const poses = path.length > 1 ? runPoses(path, DOMINO_PITCH) : [];
  let s = FUSE_LEAD_STEPS + FUSE_HOP_STEPS;
  for (let i = 0; i < poses.length; i++) {
    const a = poses[i]!.dir, b = poses[i + 1]?.dir ?? a;
    const turn = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]) || 1))));
    s += FUSE_HOP_STEPS * Math.max(0.5, 1 - (bend * turn) / DOMINO_PITCH);
  }
  return s;
}

/** How near (h) a stroke's first or last point must come to a lane's head or end to snap to it. */
export const FUSE_SNAP = 2.5;

/**
 * A brush stroke (smoothStroke's path) snapped to the lanes: a start within FUSE_SNAP of a lane's head starts exactly
 * there, one straight pitch along the lane first (the wave enters square); an end within FUSE_SNAP of a lane's end
 * finishes there, its last pitch straight along the lane (the last domino falls on the socket). Points within a pitch
 * and a half of a snapped end are dropped so the path does not double back. A stroke near neither is returned as is.
 */
export function snapFuse(lanes: readonly LaneInfo[], path: readonly P2[]): P2[] {
  if (path.length === 0 || lanes.length === 0) return [...path];
  const near = (p: P2, key: 'head' | 'end') => {
    let best: LaneInfo | null = null, bd = FUSE_SNAP;
    for (const l of lanes) { const d = Math.hypot(p[0] - l[key][0], p[1] - l[key][1]); if (d <= bd) { bd = d; best = l; } }
    return best;
  };
  const far = (q: P2, p: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 1.5 * DOMINO_PITCH;
  let pts: P2[] = [...path];
  const a = near(path[0]!, 'head'), b = path.length > 1 ? near(path.at(-1)!, 'end') : null;
  if (a) pts = [a.head, [r3(a.head[0] + a.dir[0] * DOMINO_PITCH), r3(a.head[1] + a.dir[1] * DOMINO_PITCH)], ...pts.filter((p) => far(a.head, p))];
  if (b) {
    const tail: P2 = [r3(b.end[0] - b.dir[0] * DOMINO_PITCH), r3(b.end[1] - b.dir[1] * DOMINO_PITCH)];
    pts = [...pts.filter((p, i) => (a && i < 2) || far(b.end, p)), tail, b.end];
  }
  return pts;
}

export const fuseCandidate = (id: string): LevelDef => {
  const s = FUSE_SITES[id];
  if (!s) throw new Error(`no fuse site ${id}: ${Object.keys(FUSE_SITES).join(', ')}`);
  return fuseLevel(id, s.name, s.fuse);
};

/** Shipped under a level id, its cast stars from stars.json. */
export const fuseShipped = (id: string, site: string): LevelDef => ({ ...fuseCandidate(site), id, ...castOf(id) });

/**
 * The domino-fuse levels that passed the order gate on the reference (keystone-lab fuse-gate.ts; docs/game/fuse-and-fold.md,
 * "Domino fuses"), in door order after F1 to F5: the same verb with the delays laid as dominoes.
 */
export const FUSE_DOMINO_LEVELS: readonly LevelDef[] = [
  fuseShipped('F6', 'FD-1'), // F1's tower: the east fuse 4 or more dominoes longer folds it west; straight drops a storey, east-first throws it at the houses
  fuseShipped('F7', 'FD-2'), // F2's tower: north lane shortest, each lane 3 or 4 dominoes longer to the south; two or fewer, or south-first, fail
  fuseShipped('F8', 'FD-3'), // F4's wide block: a west sweep of 2 or 3 dominoes a lane folds it into the short yard; 1 stands, east-first spills
];
