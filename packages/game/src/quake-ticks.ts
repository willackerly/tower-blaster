// Each tower's marks on the quake dial (PT25, docs/game/aftershock.md "Reading the dial"): where on Strength it starts
// to rock, and where on Frequency its rocking frequency sits. Both from the level's geometry alone, so they are exact
// for rigid blocks and cost nothing to compute.
//
// Probe X6 found that a friction stack does not resonate: it rocks as a Housner block (Housner 1963). Two numbers
// follow from that model and tell towers apart:
//  - **Uplift** (Strength): a block on a joint lifts off its edge only when the side load passes g times its
//    contact half-width over the height of the centre of mass above the joint (a tilt, statically). Below a tower's
//    uplift no joint of it can open, at any frequency or duration: the quake can only slide it. A column of n cubes
//    lifts at g/n. It is a floor, not a promise: the search found 0.5 Hz quakes felling towers near it, and faster
//    ones needing more.
//  - **Rocking frequency** (Frequency): p = sqrt(3 g / 4 R), R the half-diagonal of the tower as one block. A quake
//    near or below p pushes the tower over like a slow tilt; above it, the load to fell it climbs about as
//    sqrt(1 + (omega / p)^2), and faster for a bigger tower (its p is lower): the size lever on the levels (a slab
//    tower rides out the 1 Hz quake that fells a column of its slenderness). Not a resonance: nothing peaks there.
import { type CompiledLevel } from '@tb/keystone';

export interface TowerTick {
  /** The tower's top body (a crown or a heritage body). */
  body: number;
  role: 'condemned' | 'protected';
  /** Side load at which a joint of the tower first lifts, as a fraction of g, shaken along `axis`. */
  uplift: number;
  /** The tower's rocking frequency as one block, Hz. */
  rockHz: number;
}

/** Bodies under body `top` whose footprint covers its centre (the tower it crowns), base first, top last. */
export function columnUnder(c: CompiledLevel, top: number): number[] {
  const { home, half, n } = c.meta, x = home[3 * top]!, z = home[3 * top + 2]!, y = home[3 * top + 1]!;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (c.scene.bodies[i]!.pinned) continue; // bolted to the world: part of the ground, not the tower
    if (home[3 * i + 1]! > y + 1e-9) continue;
    if (Math.abs(home[3 * i]! - x) < half[3 * i]! - 1e-9 && Math.abs(home[3 * i + 2]! - z) < half[3 * i + 2]! - 1e-9) out.push(i);
  }
  return out.sort((a, b) => home[3 * a + 1]! - home[3 * b + 1]!);
}

/** The tower ticks of level `c` for a quake along `axis` degrees (0 is +x, 90 is +z), condemned and protected. */
export function towerTicks(c: CompiledLevel, axis: number): TowerTick[] {
  const { home, half, mass } = c.meta, g = Math.hypot(...c.scene.gravity), th = (axis * Math.PI) / 180;
  const ux = Math.abs(Math.cos(th)), uz = Math.abs(Math.sin(th));
  // A body's half-width along the axis (its world box is axis-aligned at rest).
  const along = (i: number) => ux * half[3 * i]! + uz * half[3 * i + 2]!;
  const tops = [...c.meta.crowns, ...c.meta.heritage].sort((a, b) => a - b);
  return tops.map((top) => {
    const col = columnUnder(c, top);
    let uplift = Infinity;
    for (let k = 0; k < col.length; k++) {
      const b = col[k]!, joint = home[3 * b + 1]! - half[3 * b + 1]!;
      // The contact at the joint under body b: the narrower of b and what it stands on (the ground is wide).
      const w = Math.min(along(b), k > 0 ? along(col[k - 1]!) : Infinity);
      let m = 0, my = 0;
      for (let j = k; j < col.length; j++) { const i = col[j]!; m += mass[i]!; my += mass[i]! * home[3 * i + 1]!; }
      uplift = Math.min(uplift, w / (my / m - joint));
    }
    const base = col[0]!, b = 2 * along(base), h = home[3 * top + 1]! + half[3 * top + 1]! - (home[3 * base + 1]! - half[3 * base + 1]!);
    const R = Math.hypot(b, h) / 2, rockHz = Math.sqrt((3 * g) / (4 * R)) / (2 * Math.PI);
    return { body: top, role: c.meta.crowns.includes(top) ? 'condemned' : 'protected', uplift, rockHz };
  });
}
