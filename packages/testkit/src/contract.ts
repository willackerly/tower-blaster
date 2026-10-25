// Shared cases for engine-contract tests, so every engine runs the same scenes
// against the same analytic answers.
import { type BodyDesc, combineFriction, type CombineRule, type SceneDesc, type Vec3 } from '@tb/engine-api';

const G = 9.81;

const cube = (pos: Vec3, linVel: Vec3, friction: number): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction, restitution: 0, tag: 0,
});

/**
 * A cube of friction 0.3 sliding at 3 m/s on ground of friction 0.9. The four
 * rules give four distinct coefficients: average 0.6, min 0.3, max 0.9,
 * multiply 0.27. `rule` undefined leaves SceneDesc.frictionCombine unset.
 * Every rule keeps it sliding for at least 20 steps.
 */
export const SLIDE = { body: 0.3, ground: 0.9, v0: 3 } as const;

/**
 * The friction coefficient an engine applied, from SLIDE's deceleration
 * between steps 1 and 11 (mu = dv / (g dt)); vx1 and vx11 are the cube's x
 * velocity after those steps.
 */
export const appliedMu = (vx1: number, vx11: number, dt = 1 / 60) => (vx1 - vx11) / (10 * dt * G);

export function slideScene(rule: CombineRule | undefined): SceneDesc {
  return {
    id: 'contract-slide', params: {}, seed: 0, gravity: [0, -G, 0], dt: 1 / 60, ground: { y: 0, friction: SLIDE.ground }, sleep: false,
    ...(rule ? { frictionCombine: rule } : {}),
    bodies: [cube([0, 0.5, 0], [SLIDE.v0, 0, 0], SLIDE.body)], inputs: [],
  };
}

export const slideMu = (rule: CombineRule) => combineFriction(rule, SLIDE.body, SLIDE.ground);

/**
 * Implicit Euler with Coulomb friction: v drops by mu g h per step and x
 * advances by h v_(k+1), so the cube stops after h * sum_k max(0, v0 - k mu g h).
 */
export function stoppingDistance(v0: number, mu: number, h = 1 / 60, g = G): number {
  let x = 0;
  for (let v = v0 - mu * g * h; v > 0; v -= mu * g * h) x += h * v;
  return x;
}

/** A cube thrown up and sideways with no ground: free flight for integrator checks. */
export const THROW = { pos: [0, 10, 0] as Vec3, vel: [2, 8, -1] as Vec3, steps: 60 } as const;

export function throwScene(): SceneDesc {
  return {
    id: 'contract-throw', params: {}, seed: 0, gravity: [0, -G, 0], dt: 1 / 60, ground: null, sleep: false,
    bodies: [cube([...THROW.pos], [...THROW.vel], 0.5)], inputs: [],
  };
}
