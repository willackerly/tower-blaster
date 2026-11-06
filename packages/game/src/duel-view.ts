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
import { type CompiledLevel, type DuelSide, inArc, launcherPos } from '@tb/keystone';
import type { Orbit } from '@tb/render/camera';
import { rgbe } from './scene.ts';
import { viewOf } from './view.ts';

/** The middle of an arc [from, to] of launcher azimuths (0.5 deg, wrapping through 0 when from > to), from 0 to below 720. */
export function arcMiddle([from, to]: [number, number]): number {
  return ((from + (from <= to ? to : to + 720)) / 2) % 720;
}

/** The orbit yaw (rad) whose eye, and so the launcher (aim.ts azFromYaw), is at azimuth az (0.5 deg). */
export const yawOfAz = (az: number): number => ((90 - az / 2) * Math.PI) / 180;

/**
 * The turn view's pitch, degrees: higher than the level framing's 12 so the far side shows over the near one. Seen
 * from the middle of a side the table lines up: on D1 your own keep and king stand in line with the other keep,
 * and at 12 deg they hide two thirds of it (the 2026-11-06 projection: 77% of it shows at 18, all of it from 24).
 * 26 keeps a margin; the alternative, looking from off the middle of the arc, is not the middle Will asked for.
 */
export const DUEL_PITCH = 26;

/** A duel turn's view: the level's opening framing (view.ts viewOf) seen from the middle of the side's arc, from DUEL_PITCH. */
export function duelView(c: CompiledLevel, side: Pick<DuelSide, 'arc'>, aspect = 1): Orbit {
  return viewOf(c, aspect, { yaw: (yawOfAz(arcMiddle(side.arc)) * 180) / Math.PI, pitch: DUEL_PITCH });
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
