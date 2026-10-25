// Shared Rapier setup for the engine and the host.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import type { BodyDesc } from '@tb/engine-api';

let ready: Promise<void> | null = null;
export const initRapier = () => (ready ??= RAPIER.init());

/** A body and its one collider, built from a BodyDesc. */
export function createBody(w: RAPIER.World, b: BodyDesc, canSleep: boolean, desc: RAPIER.RigidBodyDesc) {
  desc
    .setTranslation(b.pos[0], b.pos[1], b.pos[2])
    .setRotation({ x: b.rot[0], y: b.rot[1], z: b.rot[2], w: b.rot[3] })
    .setLinvel(b.linVel[0], b.linVel[1], b.linVel[2])
    .setAngvel({ x: b.angVel[0], y: b.angVel[1], z: b.angVel[2] })
    .setCanSleep(canSleep)
    // Fast balls tunnel without continuous collision detection.
    .setCcdEnabled(b.shape.kind === 'sphere');
  const body = w.createRigidBody(desc);
  const col = b.shape.kind === 'box'
    ? RAPIER.ColliderDesc.cuboid(b.shape.half[0], b.shape.half[1], b.shape.half[2])
    : RAPIER.ColliderDesc.ball(b.shape.radius);
  const collider = w.createCollider(col.setDensity(b.density).setFriction(b.friction).setRestitution(b.restitution), body);
  return { body, collider };
}

export function createGround(w: RAPIER.World, ground: { y: number; friction: number }) {
  return w.createCollider(RAPIER.ColliderDesc.cuboid(1e4, 0.5, 1e4).setTranslation(0, ground.y - 0.5, 0).setFriction(ground.friction));
}
