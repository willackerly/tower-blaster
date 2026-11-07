// Rube Lab's goal, drawn (PT26, agent playtest round 2: "nothing says ring the bell"; the bell a grey sphere
// like the ball, the target of RL1 invisible, the ball 10 px, the ring a puff of sparks). What this module
// draws, as overlay beads (Renderer.setOverlay) the game joins to its others:
//
//   - the goal zone of a region bell (RL1, RL5: the runner is the bell, and must arrive in the region): a dotted
//     outline on the region's floor in the bell's gilt, so the target is a place you can see;
//   - the ball's start: a ring of beads round the runner and a short column over it, in the Go button's orange,
//     while the release has not gone yet, so the thing Go lets go of is found at a glance.
//
// The bell itself is gilt (scene.ts coatOf: a crown's coat, which spheres now take too), in the build phase as
// in play (edit-view.ts sets the coats), and a ring is a flash, two ring waves and a chime (play.ts ringBell,
// Renderer.ring, audio.ts BELL_PARTIALS). Alternatives considered for the zone: a translucent box (no
// transparent pass for bodies; it would hide the ball in it), a ground decal (a new pass for one level kind);
// beads are what Fuse & Fold's lot already uses (fuse-timeline.ts lotBeads), and read in every look.
import type { CompiledLevel } from '@tb/keystone';
import { type Overlay } from './duel-view.ts';
import { rgbe } from './scene.ts';

/** The zone's beads: the bell's gilt (coats.ts COAT_SRGB gilt, #E3A62F), glowing a little. */
export const ZONE_COLOUR = rgbe(0xe3, 0xa6, 0x2f, 0.35);
/** Zone beads' radius and spacing, h. */
export const ZONE_RADIUS = 0.12;
export const ZONE_SPACING = 0.75;
/** The start marker's beads: the Go button's orange (ui.ts .kg-build button.go, #D8693F), glowing. */
export const START_COLOUR = rgbe(0xd8, 0x69, 0x3f, 0.45);
/** The start ring's beads and radius (h, about the runner's centre), and the column's beads over it. */
export const START_BEADS = 10;
export const START_RING = 1.1;
export const START_RADIUS = 0.1;
export const START_COLUMN = [1.1, 1.6, 2.1];

/** A level's runner: Rube Lab's part 1 (rube-levels.ts rubeLevel), its body index; -1 on any other level. */
export function runnerOf(c: CompiledLevel): number {
  if (!c.def.rube) return -1;
  for (let i = 0; i < c.meta.n; i++) if (c.meta.part[i] === 1) return i;
  return -1;
}

/** The dotted outline of a region bell's zone on its floor (world units); null when the bell has no region. */
export function zoneBeads(c: CompiledLevel): Overlay | null {
  const o = c.def.objective;
  if (o.kind !== 'bell' || !o.region) return null;
  const h = c.frame.unit, r = ZONE_RADIUS * h, y = o.region.min[1] * h + r;
  const [x0, , z0] = o.region.min.map((v) => v * h), [x1, , z1] = o.region.max.map((v) => v * h);
  const corners: [number, number][] = [[x0!, z0!], [x1!, z0!], [x1!, z1!], [x0!, z1!]], pts: number[] = [];
  corners.forEach(([ax, az], k) => {
    const [bx, bz] = corners[(k + 1) % 4]!, n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / (ZONE_SPACING * h)));
    for (let i = 0; i < n; i++) pts.push(ax + ((bx - ax) * i) / n, y, az + ((bz - az) * i) / n, r);
  });
  return { xyzr: Float32Array.from(pts), colours: new Uint32Array(pts.length / 4).fill(ZONE_COLOUR) };
}

/** The ball's start marker round the runner where the level puts it (world units); null on a level with no runner. */
export function startBeads(c: CompiledLevel): Overlay | null {
  const b = runnerOf(c);
  if (b < 0) return null;
  const h = c.frame.unit, [x, y, z] = [c.meta.home[3 * b]!, c.meta.home[3 * b + 1]!, c.meta.home[3 * b + 2]!], pts: number[] = [];
  for (let k = 0; k < START_BEADS; k++) {
    const a = (2 * Math.PI * k) / START_BEADS;
    pts.push(x + START_RING * h * Math.cos(a), y, z + START_RING * h * Math.sin(a), START_RADIUS * h);
  }
  for (const dy of START_COLUMN) pts.push(x, y + dy * h, z, START_RADIUS * h);
  return { xyzr: Float32Array.from(pts), colours: new Uint32Array(pts.length / 4).fill(START_COLOUR) };
}

/** A ring's waves reach this far (h): Renderer.ring's radius. */
export const RING_REACH = 3;
/** A rung bell's flash: full glow fading over this long (s), in the bell's own gilt. */
export const BELL_FLASH = { emissive: 1, flash: 1.6 } as const;
