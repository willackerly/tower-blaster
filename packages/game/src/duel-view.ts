// Where to aim from in a Siege Table duel (docs/game/siege-table.md, "Whose side"):
// Will, 2026-11-06: "it's hard to tell where you need to rotate to", and reset the
// view to the centre of the side whose turn it is. Three aids, all render-only
// (nothing here reaches the physics or the record):
//   - the turn view: when the turn passes, the camera swings to the level's opening
//     framing seen from the middle of the next player's arc (TurnSwing, duelView).
//     On by default in a duel (PaceFeel.turnView, keystone.turnview=0 or the
//     door's "Duel turns" setting turns it off): the one place the camera moves
//     without the player's hand, by Will's ask, against the 2026-11-02 still-camera
//     rule that every other motion keeps;
//   - the arc on the ground: the player to fire's half of the launcher ring, dotted
//     in their ink (arcBeads; PaceFeel.arcs, keystone.arcs=0 hides it);
//   - the turn cue: while the view is outside that arc, which way to drag to reach
//     it by the shorter way (turnCue), in the HUD and on a refused shot's banner.
import type { Vec3 } from '@tb/engine-api';
import { type CompiledLevel, type DuelDef, type DuelSide, inArc, launcherPos, type Player, selectGroup } from '@tb/keystone';
import { type Orbit, viewProj } from '@tb/render/camera';
import { MARK_HIT, MARK_SAVE } from '@tb/render';
import { rgbe, structureMarks } from './scene.ts';
import { viewOf } from './view.ts';

/** The middle of an arc [from, to] of launcher azimuths (0.5 deg, wrapping through 0 when from > to), from 0 to below 720. */
export function arcMiddle([from, to]: [number, number]): number {
  return ((from + (from <= to ? to : to + 720)) / 2) % 720;
}

/** The orbit yaw (rad) whose eye, and so the launcher (aim.ts azFromYaw), is at azimuth az (0.5 deg). */
export const yawOfAz = (az: number): number => ((90 - az / 2) * Math.PI) / 180;

/**
 * The turn view's pitch, degrees: higher than the level framing's 12 so the far side shows over the near one (the
 * 2026-11-06 projection from the arc's middle on D1: at 12 deg your own keep hides two thirds of the other).
 */
export const DUEL_PITCH = 26;

/**
 * How far round from the middle of the side's arc the turn view looks, degrees: an over-the-shoulder three-quarter
 * view. From the arc's exact middle (the first cut) D1's own keep and king stood dead centre in line with the
 * rival's, so a click at the middle of the screen aimed at your own king and the novice bot lost by toppling it
 * (agent playtest 1, PT5). 30 deg round puts your keep at the lower left and leaves the line from the launcher (which
 * sits at the view's azimuth on the ring) to the rival keep about 7 cells clear of yours, still well inside the arc's
 * 80 deg either side of its middle. The playtest's best duel frame was the swing passing about here.
 */
export const DUEL_YAW_OFFSET = 30;

/** The box (home pose, half extents) around structure bodies `idx`. */
function boxOf(c: CompiledLevel, idx: ArrayLike<number>): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j]!;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]!); hi[k] = Math.max(hi[k]!, c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]!); }
  }
  return [lo, hi];
}

/** Where a duel turn's view looks: the middle of the rival's blocks, a little below half their height (as frame() aims at a box). */
export function duelFocus(c: CompiledLevel, def: Pick<DuelDef, 'sides'>, player: Player): Vec3 {
  const [lo, hi] = boxOf(c, selectGroup(c, def.sides[1 - player]!.owns));
  return [(lo[0] + hi[0]) / 2, lo[1] + 0.45 * (hi[1] - lo[1]), (lo[2] + hi[2]) / 2];
}

/**
 * A duel turn's view: over the player's shoulder at the rival. It looks at the rival's blocks (duelFocus: the middle of
 * the screen, where a click lands on them) from DUEL_YAW_OFFSET round from the middle of the player's arc, at
 * DUEL_PITCH, as far back as everything but the player's own blocks needs (view.ts viewOf): framing your own keep too
 * would take the eye twice as far back, since it stands between you and the rival; it shows at the lower left, cut by
 * the edge on a narrow screen. Of the two ways round, the one that puts the player's own blocks left of the middle
 * (both alike on a shared tower: the first).
 */
export function duelView(c: CompiledLevel, def: Pick<DuelDef, 'sides'>, player: Player, aspect = 1): Orbit {
  const side = def.sides[player]!, mid = (yawOfAz(arcMiddle(side.arc)) * 180) / Math.PI, focus = duelFocus(c, def, player);
  const mine = selectGroup(c, side.owns), [lo, hi] = boxOf(c, mine), own: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const isMine = new Set(mine), rest = Int32Array.from({ length: c.meta.n }, (_, i) => i).filter((i) => !isMine.has(i));
  const views = [1, -1].map((sign) => viewOf(c, aspect, { yaw: mid + sign * DUEL_YAW_OFFSET, pitch: DUEL_PITCH }, focus, rest));
  const x = (o: Orbit) => { const m = viewProj(o, aspect); return (m[0]! * own[0] + m[4]! * own[1] + m[8]! * own[2] + m[12]!) / (m[3]! * own[0] + m[7]! * own[1] + m[11]! * own[2] + m[15]!); };
  return x(views[1]!) < x(views[0]!) - 1e-6 ? views[1]! : views[0]!;
}

/**
 * Which way to drag the view to bring the launcher at azimuth az into arc by the shorter way, or null when it is
 * in it. Dragging right (play.ts orbitDrag: dx above 0 lowers the yaw) raises the azimuth; two fingers turn alike.
 */
export function turnCue(arc: [number, number], az: number): 'left' | 'right' | null {
  if (inArc(az, arc)) return null;
  const up = (((arc[0] - az) % 720) + 720) % 720, down = (((az - arc[1]) % 720) + 720) % 720;
  return up <= down ? 'right' : 'left';
}

/** The cue in words, for a banner (plain text) and the HUD: drag (or, on a touch screen, two fingers) that way. */
export function turnCueText(name: string, cue: 'left' | 'right', touch: boolean): string {
  return `${touch ? 'Two fingers' : 'Drag'} ${cue} ${cue === 'right' ? '▸' : '◂'} to turn to ${name}'s side`;
}

/** The turn view's swing, s: long enough to see the table turn (where the next player stands), short enough not to wait on. */
export const TURN_SWING_S = 1;
/** Ease in and out: 0 at 0, 1 at 1, level at both ends. */
export const smooth = (x: number): number => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
/** An angle brought to -pi to pi. */
const wrapPi = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * The turn view's camera move: from where the player left the camera to the next side's view over TURN_SWING_S,
 * eased, the yaw the shorter way round, the distance in proportion (so a zoom reads evenly). Any camera input by
 * the player (orbit, pan, zoom) or a shot grabs it: it stops where it is and the camera is theirs again.
 */
export class TurnSwing {
  private from: Orbit | null = null;
  private to: Orbit | null = null;
  private t = 0;

  get active(): boolean { return this.to !== null; }

  start(from: Orbit, to: Orbit): void {
    this.from = { ...from, target: [...from.target] };
    this.to = { ...to, target: [...to.target] };
    this.t = 0;
  }

  /** Move o dt seconds along the swing; true while it still runs. At the end o is the goal's framing exactly. */
  update(o: Orbit, dt: number): boolean {
    const a = this.from, b = this.to;
    if (!a || !b) return false;
    this.t = Math.min(1, this.t + dt / TURN_SWING_S);
    if (this.t >= 1) {
      Object.assign(o, { ...b, target: [...b.target] });
      this.to = null;
      return false;
    }
    const k = smooth(this.t), mix = (x: number, y: number) => x + (y - x) * k;
    o.yaw = a.yaw + wrapPi(b.yaw - a.yaw) * k;
    o.pitch = mix(a.pitch, b.pitch);
    o.distance = a.distance * (b.distance / a.distance) ** k;
    o.fovY = mix(a.fovY, b.fovY);
    o.target = [mix(a.target[0], b.target[0]), mix(a.target[1], b.target[1]), mix(a.target[2], b.target[2])];
    if (b.floor !== undefined) o.floor = b.floor;
    return true;
  }

  grab(): void { this.to = null; }
}

/**
 * A duel's stone marks (Renderer.setMarks): the level's (scene.ts structureMarks: a crosshair on every crown), with the
 * king of the player to fire carved with the shield instead (PT5, agent playtest 1: your own king wore the target's
 * crosshair, and the aim preview ran through it). The rival's king keeps the crosshair; the marks change with the turn.
 * All plain when marks are off.
 */
export function duelMarks(c: CompiledLevel, duel: { turn: Player; kings: readonly (Int32Array | null)[] }, on = true): Uint8Array {
  const out = structureMarks(c, on);
  if (!on) return out;
  for (const k of [0, 1] as const) for (const i of duel.kings[k] ?? []) out[i] = k === duel.turn ? MARK_SAVE : MARK_HIT;
  return out;
}

/** Arc beads: about this many cube edges apart along the ring, this big (in cube edges), glowing this much. */
export const ARC_SPACING = 1.25;
export const ARC_RADIUS = 0.2;
export const ARC_GLOW = 0.45;

/** An ink (linear RGB) as an overlay colour word (sRGB, scene.ts rgbe) with the arc's glow. */
const inkWord = (ink: readonly number[], glow: number) => {
  const b = (x: number) => Math.round(255 * Math.min(1, Math.max(0, x)) ** (1 / 2.2));
  return rgbe(b(ink[0]!), b(ink[1]!), b(ink[2]!), glow);
};

/**
 * Overlay spheres (Renderer.setOverlay) that dot a side's arc of the launcher ring on the ground, in its ink, from
 * one end to the other: the ends exactly at the arc's ends, the beads between about ARC_SPACING cube edges apart.
 */
export function arcBeads(c: CompiledLevel, side: Pick<DuelSide, 'arc' | 'ink'>): Overlay {
  const [from, to] = side.arc, span = from <= to ? to - from : to + 720 - from, f = c.frame, u = f.unit;
  const ringR = f.launcher.radius * f.pitch * u, quantum = (0.5 * Math.PI) / 180;
  const n = Math.max(2, Math.round((span * quantum * ringR) / (ARC_SPACING * u)) + 1);
  const xyzr = new Float32Array(4 * n), r = ARC_RADIUS * u;
  for (let k = 0; k < n; k++) {
    const p = launcherPos(f, (from + (span * k) / (n - 1)) % 720, 0);
    xyzr.set([p[0], r, p[2], r], 4 * k);
  }
  return { xyzr, colours: new Uint32Array(n).fill(inkWord(side.ink, ARC_GLOW)) };
}

/** Overlay spheres and their colour words, as Renderer.setOverlay takes them. */
export interface Overlay { xyzr: Float32Array<ArrayBuffer>; colours: Uint32Array<ArrayBuffer> }

/** Overlays as one list (the renderer draws one), in order: the first ones win if the renderer's cap cuts it. One alone is itself. */
export function joinOverlays(...os: (Overlay | null)[]): Overlay | null {
  const live = os.filter((o): o is Overlay => o !== null && o.colours.length > 0);
  if (live.length <= 1) return live[0] ?? null;
  const xyzr = new Float32Array(live.reduce((s, o) => s + o.xyzr.length, 0)), colours = new Uint32Array(live.reduce((s, o) => s + o.colours.length, 0));
  let i = 0, j = 0;
  for (const o of live) { xyzr.set(o.xyzr, i); colours.set(o.colours, j); i += o.xyzr.length; j += o.colours.length; }
  return { xyzr, colours };
}
