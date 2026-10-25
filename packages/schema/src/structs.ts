import { defineStruct } from './layout.ts';

// Shared GPU buffer element types. Every stage that touches one of these
// buffers uses this definition; the WGSL is generated from it.

export const Body = defineStruct(
  'Body',
  [
    ['pos', 'vec3f', 'world position of the centre'],
    ['invMass', 'f32', '0 for static'],
    ['rot', 'vec4f', 'unit quaternion (x, y, z, w)'],
    ['linVel', 'vec3f'],
    ['flags', 'u32', 'bit 0 awake, bits 8-15 tier'],
    ['angVel', 'vec3f'],
    ['shape', 'u32', 'index into the shape table'],
  ],
  'Rigid body state, one per active body.',
);

export const RenderRecord = defineStruct(
  'RenderRecord',
  [
    ['pos', 'vec3f', 'camera-relative centre, interpolated between the last two steps'],
    ['look', 'u32', 'BodyLook bits: 0-7 ramp, 8-11 hue, 12-15 material, 16-31 seed'],
    ['rot', 'vec4f', 'unit quaternion (x, y, z, w), interpolated'],
    ['half', 'vec3f', 'box half extents; x is the radius for a sphere'],
    ['slot', 'u32', 'body index'],
  ],
  'Per-body pose the renderer draws, written once per frame by its prepare pass.',
);

export const SimParams = defineStruct(
  'SimParams',
  [
    ['gravity', 'vec3f'],
    ['dt', 'f32'],
    ['bodyCount', 'u32'],
    ['iterations', 'u32'],
    ['stepIndex', 'u32'],
    ['flags', 'u32'],
  ],
  'Per-step uniforms.',
);

export const Shape = defineStruct(
  'Shape',
  [
    ['half', 'vec3f', 'box half extents; x is the radius for a sphere'],
    ['kind', 'u32', '0 box, 1 sphere'],
  ],
  'Collision shape, indexed by Body.shape.',
);

export const Manifold = defineStruct(
  'Manifold',
  [
    ['normal', 'vec3f', 'unit, from body a to body b (from the ground up for ground contacts)'],
    ['count', 'u32', 'contact points used, 0..4; 0 means no contact'],
    ['a', 'u32'],
    ['b', 'u32', '0xffffffff for the ground'],
    ['feature', 'u32', '0 face of a, 1 face of b, 2 edge-edge'],
    ['pad', 'u32'],
    ['p0', 'vec4f', 'point xyz (midway between the surfaces), depth w (> 0 overlapping)'],
    ['p1', 'vec4f'],
    ['p2', 'vec4f'],
    ['p3', 'vec4f'],
  ],
  'Contact manifold for one body pair, written by the narrowphase.',
);

/**
 * Body.flags bits 8-15. lattice: a dormant cell, drawn by the lattice pass
 * from the brick masks, never from Body[]. free: an unused slot. The
 * renderer draws every other tier from Body[].
 */
export const TIER = { active: 0, rubble: 1, lattice: 2, debris: 3, free: 255 } as const;
export const FLAG_AWAKE = 1;

export const ALL_STRUCTS = [SimParams, Body, RenderRecord, Shape, Manifold];
