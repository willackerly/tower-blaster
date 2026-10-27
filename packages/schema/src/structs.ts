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
    ['axis', 'u32', 'box-box SAT axis: 0..2 face k of a, 3..5 face k of b, 6 + 3i + j edges; 0xffffffff otherwise'],
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

/**
 * One impact, for sparks and flashes. The renderer's own detector writes
 * these; a physics contact ring (later) uses the same layout.
 */
export const ImpactEvent = defineStruct(
  'ImpactEvent',
  [
    ['pos', 'vec3f', 'world position of the contact'],
    ['strength', 'f32', 'speed change, m/s'],
    ['dir', 'vec3f', 'unit; sparks fly out around it'],
    ['packed', 'u32', 'bits 0-23 slot (0xffffff: none), 24-27 kind (0 detector, 1 injected), 28-31 material'],
    ['normal', 'vec3f', 'unit; the contact normal into the body (debris: the face normal nearest dir; else dir)'],
    ['raw', 'f32', 'speed change before the debris face weight, m/s (strength in sparks mode)'],
  ],
  'An impact that spawns sparks.',
);

export const Spark = defineStruct(
  'Spark',
  [
    ['pos', 'vec3f', 'world position'],
    ['age', 'f32', 'seconds; negative means dead'],
    ['vel', 'vec3f', 'm/s'],
    ['packed', 'u32', 'bits 0-7 life (0.4 + 0.8 * q / 255 s), 8-31 seed'],
  ],
  'One spark of the renderer\'s pool.',
);

export const FxState = defineStruct(
  'FxState',
  [
    ['prevLinVel', 'vec3f', 'velocity when the detector last saw the slot'],
    ['bits', 'u32', 'bits 0-15 heat (f16), 16-23 tier last seen, 24 valid'],
  ],
  'Renderer-side per-slot effect state.',
);


export const BodyProps = defineStruct(
  'BodyProps',
  [
    ['inertia', 'vec3f', 'principal moments in the body frame'],
    ['mass', 'f32'],
    ['friction', 'f32'],
    ['radius', 'f32', 'bounding sphere radius'],
    ['sphere', 'u32', '1 for a sphere (radius is its radius), 0 for a box: picks rolling contacts (SolverParams.rollingContacts)'],
    ['pad1', 'u32'],
  ],
  'Constant per-body properties for the solver, written by the host.',
);

export const SolverBody = defineStruct(
  'SolverBody',
  [
    ['x0', 'vec3f', 'position at the start of the step'],
    ['sweep', 'f32', 'speculative margin growth: how far the body can move this step'],
    ['q0', 'vec4f', 'rotation at the start of the step'],
    ['dp', 'vec3f', 'position minus x0 (the primal variable)'],
    ['pad0', 'u32'],
    ['phi', 'vec3f', 'rotation vector since q0 (the primal variable)'],
    ['pad1', 'u32'],
    ['tp', 'vec3f', 'inertial target for dp: h v + h^2 g'],
    ['pad2', 'u32'],
    ['tphi', 'vec3f', 'inertial target for phi: h w'],
    ['pad3', 'u32'],
    ['prevVel', 'vec3f', 'linear velocity one step earlier (adaptive warm start)'],
    ['pad4', 'u32'],
  ],
  'Per-body AVBD solver state.',
);

export const SolverContact = defineStruct(
  'SolverContact',
  [
    ['n', 'vec3f', 'normal from a to b, fixed over the step'],
    ['mu', 'f32'],
    ['t1', 'vec3f', 'first tangent (t2 = n x t1)'],
    ['used', 'u32', '1 if this point is in use'],
    ['ra', 'vec3f', "anchor in a's frame (world for the ground)"],
    ['lambdaN', 'f32', 'normal force (<= 0 pushes apart)'],
    ['rb', 'vec3f', "anchor in b's frame"],
    ['kN', 'f32', 'normal penalty'],
    ['raw', 'vec3f', "a's lever arm in world space at the start of the step"],
    ['kT', 'f32', 'tangent penalty (shared by both rows)'],
    ['rbw', 'vec3f', "b's lever arm"],
    ['stick', 'u32', 'static friction held last step: anchors (a rolling contact: slip) carried over'],
    ['c0', 'vec3f', 'constraint at the start of the step along n, t1, t2'],
    ['a', 'u32', 'body a, 0xffffffff for the ground'],
    ['lt', 'vec2f', 'friction force along t1, t2'],
    ['b', 'u32'],
    ['inCone', 'u32', "1 if the last dual update's trial friction was inside the cone (static friction held)"],
  ],
  'One AVBD contact point (three rows), four per manifold.',
);

export const SolverParams = defineStruct(
  'SolverParams',
  [
    ['gravity', 'vec3f'],
    ['dt', 'f32'],
    ['n', 'u32', 'bodies this step'],
    ['prevN', 'u32', 'bodies last step (persistence lookups)'],
    ['cur', 'u32', 'history half written this step (0 or 1)'],
    ['iterations', 'u32'],
    ['beta', 'f32'],
    ['gamma', 'f32'],
    ['penaltyMin', 'f32'],
    ['penaltyMax', 'f32'],
    ['margin', 'f32'],
    ['slop', 'f32'],
    ['stickThreshold', 'f32'],
    ['matchDistance', 'f32'],
    ['maxAngularSpeed', 'f32'],
    ['maxSweep', 'f32'],
    ['groundY', 'f32'],
    ['hasGround', 'u32'],
    ['groundFriction', 'f32'],
    ['maxPairs', 'u32'],
    ['capacity', 'u32'],
    ['slidingHessian', 'u32'],
    ['sweepOn', 'u32'],
    ['frictionCombine', 'u32', '0 average, 1 min, 2 max, 3 multiply (SceneDesc.frictionCombine)'],
    ['restDepth', 'f32', 'load floor: a reused contact starts with kN >= |lambdaN| / restDepth; 0 = off'],
    ['rollingContacts', 'u32', '1: a contact on a sphere is a rolling contact (AvbdParams.rollingContacts)'],
    ['loadCap', 'f32', 'load cap: a reused contact eases kN towards loadCap * (largest |lambdaN| on a point of its pair) / restDepth; 0 = off'],
    ['capFall', 'f32', 'how fast kN falls to the load cap: at least capFall x its uncapped value each step'],
  ],
  'Per-step uniforms of the GPU AVBD solver.',
);

export const ColorParams = defineStruct(
  'ColorParams',
  [
    ['color', 'u32', 'colour swept by this primal dispatch'],
    ['alpha', 'f32', '1 in the main iterations, 0 in post-stabilization'],
    ['pad0', 'u32'],
    ['pad1', 'u32'],
  ],
  'Per-dispatch uniforms (bound with a dynamic offset).',
);

export const ALL_STRUCTS = [SimParams, Body, RenderRecord, Shape, Manifold, ImpactEvent, Spark, FxState, BodyProps, SolverBody, SolverContact, SolverParams, ColorParams];
