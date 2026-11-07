// The opening aim (PT29, docs/game/aim-clarity.md): where the aim rests when a level opens, before the player's hand
// touches anything. Agent playtest round 2 read the aim at the middle of the screen as the level's: L3 opened on its
// centre heritage column, B2's blast zone over the cathedral, L4's anvil on the fulcrum or (phone) on the ground, and
// on phones 15 of 34 trials opened "Out of reach". The opening view frames the objectives, not a shot, so the middle
// of the screen is no promise. The opening aim is chosen for the view as framed (so per viewport), from the launcher
// that view gives:
//   - on a structure block the player can see (a ray from the eye meets it first), that is not heritage;
//   - its flight reaches the point (no "Out of reach") and first touches that very block, so the marker is where the
//     player sees the aim (or, where no such point exists in a dense city, first touches some structure block that is
//     not heritage); a tap or click at the point aims the same shot;
//   - clear of heritage: the touched point at least HERITAGE_CLEAR h from every heritage block, for a weapon with a
//     blast its zone (the largest blast's radius, plus half an h) reaching none, and no heritage block touching the
//     struck one ahead along the flight's heading, nor within its fall that way (heritageAhead);
//   - the best of those: nearest a crown (the level's objective), else highest on the structure.
// The game shows it (dots, marker, blast zone) until the player aims; a tap or click at its point fires it. Picking
// is CPU only (aim.ts pick, shotFor, arcContact), on the bodies as they stand after the level's pre-settle.
import { type Snapshot, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { type CompiledLevel, launchDir, type RackItem, type Shot } from '@tb/keystone';
import { type Orbit, rayThrough, viewProj } from '@tb/render/camera';
import { transform } from '@tb/render/math';
import { arcContact, type Contact, pick, shotFor, SUBSTEPS } from './aim.ts';

/** Screen points tried across the structure's box on screen, each way (a GRID x GRID raster). */
export const GRID = 16;
/** How many of the best-placed points that pass the cheap rules have their flight tried (each an arcContact), best first. */
export const TRIES = 24;
/** The least distance (h) from the touched point to any heritage block. */
export const HERITAGE_CLEAR = 0.25;
/** A blast's zone reaches a heritage block when its centre is within the radius plus this (h) of the block's box. */
export const BLAST_MARGIN = 0.5;
/** A heritage block touching the struck one (its box within this many h of the struck block's middle, past the struck block's own half) is in the way. */
export const TOUCHING = 0.3;
/** ... when it lies ahead along the flight's heading: the cosine of the angle from the heading to it above this (about 72 deg). */
export const AHEAD_COS = 0.3;
/**
 * What the struck block stands on can fall that far: a heritage block within this many times the struck block's height
 * (horizontally) and within TOPPLE_COS of the heading is in the way too. (B2 on Rapier: a bomb on the crowned tower's
 * roof, fired from beyond it toward the middle, felled the tower onto the cathedral 9 m on and cracked 1 to 21 blocks.)
 */
export const TOPPLE = 1.5;
/** The cosine of the topple cone's half angle (60 deg). */
export const TOPPLE_COS = 0.5;

export interface OpeningAim {
  /** The shot the opening aim fires. */
  shot: Shot;
  /** Where its flight first touches (the impact marker), on block `contact.body`. */
  contact: Contact;
  /** The point aimed at, on the same block's face toward the eye. */
  point: Vec3;
  /** Where to tap or click to aim it: normalised device coordinates (x, y in -1..1, y up), as GameHandle.aim takes. */
  ndc: [number, number];
}

/** What the opening aim is chosen for: the view and its aspect, and the shot's item, power, launcher azimuth and height (1/4 h). */
export interface AimSetup { view: Orbit; aspect: number; item: RackItem; power: number; az: number; at: number; substeps?: number }

/** Items an opening aim is chosen for: those the player aims at a point (a pull, a cue, a plunger, a quake have none). */
export const aimsAtPoint = (item: RackItem): boolean => item !== 'pull' && item !== 'cue' && item !== 'plunger' && item !== 'quake';

/** Distance from p to body i's box at its pose in s (0 inside). */
export function boxDistance(c: CompiledLevel, s: Pick<Snapshot, 'pos' | 'rot'>, i: number, p: Vec3): number {
  const pos: Vec3 = [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!], q: [number, number, number, number] = [s.rot[4 * i]!, s.rot[4 * i + 1]!, s.rot[4 * i + 2]!, s.rot[4 * i + 3]!];
  const l = rotate([-q[0], -q[1], -q[2], q[3]], [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]]);
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const h = c.meta.half[3 * i + k]!, o = Math.max(0, Math.abs(l[k]!) - h);
    d2 += o * o;
  }
  return Math.sqrt(d2);
}

/** The nearest heritage block's distance from p (Infinity with none standing). */
function heritageDistance(c: CompiledLevel, s: Snapshot, p: Vec3): number {
  let best = Infinity;
  for (const i of c.meta.heritage) if (s.tier?.[i] !== TIER_FREE) best = Math.min(best, boxDistance(c, s, i, p));
  return best;
}

/**
 * Whether heritage stands in the way of what the shot moves: a block touching block `b` on the side the shot pushes it
 * to (a flight drives what it strikes along its heading, into the next block that way), or one within the reach of
 * what `b` stands on falling over that way (TOPPLE, TOPPLE_COS), or for a blast, falling any way, plus the blast's
 * radius. (L3 on the f64 reference: a marble 25 deg off square on a crown between two
 * heritage blocks drove it into one and cracked it; square on, it knocks the crown off clean.) A drop pushes down, onto
 * what holds the block up, which is never heritage-ahead here.
 */
export function heritageAhead(c: CompiledLevel, s: Snapshot, b: number, shot: Shot): boolean {
  if (shot.ammo === 'drop' || !('az' in shot)) return false;
  const reach = blastReach(c, shot.ammo), blast = reach > 0;
  const d = launchDir(shot.az, shot.yaw, 0), l = Math.hypot(d[0], d[2]) || 1, hx = d[0] / l, hz = d[2] / l;
  const bc: Vec3 = [s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!];
  const own = Math.max(c.meta.half[3 * b]!, c.meta.half[3 * b + 1]!, c.meta.half[3 * b + 2]!);
  for (const h of c.meta.heritage) {
    if (s.tier?.[h] === TIER_FREE) continue;
    const vx = s.pos[3 * h]! - bc[0], vz = s.pos[3 * h + 2]! - bc[2], v = Math.hypot(vx, vz);
    if (!(v > 1e-9)) continue;
    const cos = (vx * hx + vz * hz) / v;
    if (cos > AHEAD_COS && boxDistance(c, s, h, bc) <= own + TOUCHING * c.frame.unit) return true;
    // A blast throws every way: its fall zone is the whole circle.
    if ((blast || cos > TOPPLE_COS) && v <= TOPPLE * (bc[1] + c.meta.half[3 * b + 1]!) + reach) return true;
  }
  return false;
}

/** How far a blast reaches from where the item first touches (the largest of its blasts), metres; 0 with none. */
export function blastReach(c: CompiledLevel, item: RackItem): number {
  return Math.max(0, ...(c.arms[item]?.blasts ?? []).map((b) => b.blast.radius));
}

/**
 * The opening aim for `setup` on the bodies in `s`, or null when no point passes (or the item aims at none). Points
 * on a GRID raster over the structure's box on screen are picked, ranked (nearest a crown, else highest), and the
 * first TRIES whose flight checks out win in that order.
 */
export function openingAim(c: CompiledLevel, s: Snapshot, setup: AimSetup): OpeningAim | null {
  if (!aimsAtPoint(setup.item)) return null;
  const unit = c.frame.unit, substeps = setup.substeps ?? SUBSTEPS;
  const heritage = new Set(c.meta.heritage);
  const crowns = [...c.meta.crowns].filter((i) => s.tier?.[i] !== TIER_FREE);
  // The structure's box on screen, from its bodies' poses now.
  const vp = viewProj(setup.view, setup.aspect), n = Math.min(c.meta.n, s.count);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (s.tier?.[i] === TIER_FREE) continue;
    const q = transform(vp, [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!]);
    if (!(q[3] > 1e-6)) continue;
    x0 = Math.min(x0, q[0] / q[3]); x1 = Math.max(x1, q[0] / q[3]); y0 = Math.min(y0, q[1] / q[3]); y1 = Math.max(y1, q[1] / q[3]);
  }
  if (!(x1 >= x0)) return null;
  [x0, x1, y0, y1] = [Math.max(-1, x0), Math.min(1, x1), Math.max(-1, y0), Math.min(1, y1)];
  const ranked: Array<{ ndc: [number, number]; body: number; point: Vec3; rank: number }> = [];
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    const ndc: [number, number] = [x0 + ((gx + 0.5) / GRID) * (x1 - x0), y0 + ((gy + 0.5) / GRID) * (y1 - y0)];
    const hit = pick(rayThrough(setup.view, setup.aspect, ndc[0], ndc[1]), s, c);
    if (!hit || hit.body < 0 || heritage.has(hit.body)) continue;
    if (heritageDistance(c, s, hit.point) < HERITAGE_CLEAR * unit) continue;
    // Nearest a crown's middle (in h), else highest; the middle of the screen breaks ties.
    const toCrown = crowns.length ? Math.min(...crowns.map((i) => Math.hypot(s.pos[3 * i]! - hit.point[0], s.pos[3 * i + 1]! - hit.point[1], s.pos[3 * i + 2]! - hit.point[2]))) / unit : -hit.point[1] / unit;
    ranked.push({ ndc, body: hit.body, point: hit.point, rank: toCrown + 1e-3 * Math.hypot(ndc[0], ndc[1]) });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const reach = blastReach(c, setup.item);
  // First the points whose flight lands on the block aimed at (the marker where the player sees the aim); then, in a
  // structure so dense that none does (T-B2C's city), any that lands on a structure block.
  for (const same of [true, false]) {
    let tried = 0;
    for (const r of ranked) {
      if (tried >= TRIES) break;
      const a = shotFor(c, setup.item, setup.az, setup.power, r.point, substeps, setup.at);
      // The cheap rules first (the flight's sweep is the cost): reached, and no heritage in the way of the block aimed at.
      if (!a?.reachable || heritageAhead(c, s, r.body, a.shot)) continue;
      tried++;
      const contact = arcContact(c, s, a.shot, substeps);
      if (!contact || contact.body < 0 || heritage.has(contact.body) || (same && contact.body !== r.body)) continue;
      const clear = heritageDistance(c, s, contact.point);
      if (clear < HERITAGE_CLEAR * unit || (reach > 0 && clear < reach + BLAST_MARGIN * unit)) continue;
      if (heritageAhead(c, s, contact.body, a.shot)) continue;
      return { shot: a.shot, contact, point: r.point, ndc: r.ndc };
    }
  }
  return null;
}
