// The game's opening camera for a level (no WebGPU or WebAudio here, so node CLIs can use it).
import type { Vec3 } from '@tb/engine-api';
import type { CompiledLevel } from '@tb/keystone';
import { EYE_ABOVE_GROUND, frame, type Orbit } from '@tb/render/camera';

/** Frame the structure; face the par line's launcher when it has one. The eye stays EYE_ABOVE_GROUND over the ground (y 0), as in the viewer. */
export function viewOf(c: CompiledLevel): Orbit {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const o = frame(min, max);
  const first = c.def.solutions?.par?.[0];
  if (first && 'az' in first) o.yaw = ((90 - first.az / 2) * Math.PI) / 180;
  return { ...o, floor: EYE_ABOVE_GROUND };
}

