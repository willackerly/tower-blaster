// The bench's frozen worlds (bench.ts), on their own so a page can build one
// without the bench's statistics: the render bench and the quality-tier probe
// (tier-probe.ts) draw the same 'near' heap.
import type { BodyDesc } from '@tb/engine-api';
import type { V3 } from './math.ts';

export type WorldName = 'near' | 'far';

export interface World { descs: BodyDesc[]; eye: V3; target: V3; center: V3; radius: number }

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cube(pos: V3, rot: [number, number, number, number] = [0, 0, 0, 1], tag = 0): BodyDesc {
  return { shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag };
}

/**
 * near: a rubble heap of randomly rotated unit cubes (a hemisphere at about
 * 60% packing) filling the view from close by: big cubes, heavy overdraw.
 * far: a city of 10 x 10 x 10 towers seen from where a cube is about 6 px
 * at 1440p: tiny triangles, the micro-triangle risk.
 */
export function buildWorld(name: WorldName, n: number, seed = 1): World {
  const r = rng(seed);
  const descs: BodyDesc[] = [];
  if (name === 'near') {
    const radius = Math.cbrt((3 * (n / 0.6)) / (2 * Math.PI));
    while (descs.length < n) {
      const p: V3 = [(r() * 2 - 1) * radius, r() * radius, (r() * 2 - 1) * radius];
      if (Math.hypot(...p) > radius) continue;
      const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5];
      const l = Math.hypot(...q);
      descs.push(cube([p[0], p[1] + 0.5, p[2]], q.map((x) => x / l) as [number, number, number, number], descs.length % 7));
    }
    return { descs, eye: [radius * 1.25, radius * 0.9, radius * 1.4], target: [0, radius * 0.2, 0], center: [0, radius * 0.4, 0], radius: radius * 1.2 };
  }
  const towers = Math.max(1, Math.round(n / 1000));
  const side = Math.ceil(Math.sqrt(towers));
  const pitch = 20;
  for (let t = 0; t < towers && descs.length < n; t++) {
    const tx = (t % side - (side - 1) / 2) * pitch, tz = (Math.floor(t / side) - (side - 1) / 2) * pitch;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) if (descs.length < n) descs.push(cube([tx + x - 4.5, y + 0.5, tz + z - 4.5], undefined, t));
  }
  const extent = side * pitch;
  // A cube is about 6 px at 1440p and fov 0.9 from 250 m.
  const d = 250;
  return { descs, eye: [d * 0.62, d * 0.45, d * 0.64], target: [0, 5, 0], center: [0, 5, 0], radius: extent * 0.75 };
}
