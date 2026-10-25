// Rapier 0.21 panics (wasm "unreachable") when a ball collider presses on an
// edge of a voxel collider. RapierHost works around it with icosphere hulls
// for spheres; the first test pins the upstream bug, so when it starts to
// fail Rapier has fixed it and the workaround can go.
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-simd-compat';
import { type BodyDesc, type HostWorld, massOf, MODE_DYNAMIC } from '@tb/engine-api';
import { createBody, icosphere, initRapier, RapierHost } from '../src/index.ts';

// An 8 x 25 x 8 tower of unit voxels with its -x face at x = -4, and a ball
// of radius 2 shot at 20 m/s into the face 12.5 m up: it bounces off and
// slides down the face into the tower's foot.
const tower = { origin: [-3.5, 0.5, -3.5] as [number, number, number], edge: 1, dims: [8, 25, 8] as [number, number, number], friction: 0.6 };
const ballDesc: BodyDesc = {
  shape: { kind: 'sphere', radius: 2 }, pos: [-10, 12.5, 0], rot: [0, 0, 0, 1], linVel: [20, 0, 0], angVel: [0, 0, 0],
  density: 10 / ((4 / 3) * Math.PI * 8), friction: 0.6, restitution: 0, tag: 1,
};

describe('Rapier ball against voxel edges', () => {
  it('panics in plain Rapier 0.21 (upstream bug)', async () => {
    await initRapier();
    const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    w.timestep = 1 / 60;
    w.createCollider(RAPIER.ColliderDesc.cuboid(1e4, 0.5, 1e4).setTranslation(0, -0.5, 0).setFriction(0.6));
    const vox = w.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array([0, 0, 0, 7, 24, 7]), { x: 1, y: 1, z: 1 }).setTranslation(-4, 0, -4).setFriction(0.6));
    for (let i = 0; i < 8; i++) for (let j = 0; j < 25; j++) for (let k = 0; k < 8; k++) vox.setVoxel(i, j, k, true);
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-10, 12.5, 0).setLinvel(20, 0, 0).setCcdEnabled(true));
    w.createCollider(RAPIER.ColliderDesc.ball(2).setDensity(ballDesc.density).setFriction(0.6), b);
    expect(() => { for (let s = 0; s < 120; s++) w.step(); }).toThrow(/unreachable/);
  });

  it('does not panic in RapierHost, whose spheres are hulls of the same mass', async () => {
    const n = 8 * 25 * 8;
    const table: BodyDesc[] = [];
    const cells = [];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 25; j++) for (let k = 0; k < 8; k++) {
      cells.push({ lattice: 0, i, j, k, id: table.length });
      table.push({ ...ballDesc, shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos: [i - 3.5, j + 0.5, k - 3.5], linVel: [0, 0, 0], density: 1, tag: 0 });
    }
    table.push(ballDesc);
    const world: HostWorld = { gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: true };
    const h = new RapierHost();
    await h.init(world, table, [tower]);
    h.apply({ changes: [{ id: n, mode: MODE_DYNAMIC, pos: ballDesc.pos, rot: ballDesc.rot, linVel: ballDesc.linVel }], wake: [], cells });
    let maxX = -Infinity, minVx = 0, y = 0;
    for (let s = 0; s < 120; s++) {
      h.step();
      const st = h.read();
      maxX = Math.max(maxX, st.pos[0]!); minVx = Math.min(minVx, st.linVel[0]!); y = st.pos[1]!;
    }
    expect(maxX).toBeGreaterThan(-6.1); // it met the face (restitution 0: it stops dead)
    expect(maxX).toBeLessThan(-5.9); // and stayed out of it
    expect(minVx).toBeGreaterThan(-1);
    expect(y).toBeLessThan(2.1); // and came down to its foot
    h.dispose();
  });

  it('gives the hull the mass of the sphere', async () => {
    const { volume } = icosphere(2);
    expect(volume / ((4 / 3) * Math.PI)).toBeGreaterThan(0.95); // 162 vertices on the unit sphere
    await initRapier();
    const w = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const { body } = createBody(w, ballDesc, false, RAPIER.RigidBodyDesc.dynamic(), 2);
    expect(body.mass() / massOf(ballDesc)).toBeCloseTo(1, 4);
  });
});
