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

export const RenderInstance = defineStruct(
  'RenderInstance',
  [
    ['pos', 'vec3f'],
    ['palette', 'u32', 'colour index, e.g. original tower height'],
    ['rot', 'vec4f'],
  ],
  'What the renderer reads per cube.',
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

export const ALL_STRUCTS = [SimParams, Body, RenderInstance];
