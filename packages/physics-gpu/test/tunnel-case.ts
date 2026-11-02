// Tunnelling: fast small bodies fired head-on at thin slabs, one projectile per
// slab, at a dozen start phases (where in a step's travel the face lies), in
// one zero-gravity scene so every engine runs the same case in one go. A
// projectile tunnels when it is seen past its slab's far face still moving at
// more than 0.8 of its launch speed: it went through without stopping (a
// projectile that knocks the slab away, or bounces, never counts).
//
// AVBD's guarantee (physics-ref avbd.ts sweep, physics-gpu solver.ts prepare):
// each body's contact margin grows by min(maxSweep, |v| dt), so a contact that
// a step's travel can reach is found before the step and solved as a
// speculative contact. maxSweep is 1 m at 60 Hz, so up to 60 m/s nothing
// tunnels, however thin the slab; past it, the contact is found too late.
// The case checks both sides of that line, so it proves the bound and that
// the detector can see a tunnel.
import type { BodyDesc, SceneDesc, Snapshot } from '@tb/engine-api';

/** Slab thicknesses, m: a quarter of a 0.5 m block and 2 cm. */
export const TUNNEL_THICKNESS = [0.125, 0.02] as const;
/** Launch speeds, m/s: two under AVBD's sweep limit (60 m/s at 60 Hz, maxSweep 1) and one past it. */
export const TUNNEL_SPEEDS = [45, 57, 90] as const;
export const TUNNEL_PHASES = 12;
/** The projectiles: Keystone's p-cannonball at its model density (14 cm iron, x 625 / 2400) and a blast-kicked half-metre stone block. */
export const TUNNEL_KINDS = ['ball', 'cube'] as const;
export type TunnelKind = (typeof TUNNEL_KINDS)[number];

// Solid stone slabs: heavier than Keystone's model stone (625), so they give way later and the solver has to stop the projectile itself.
const STONE = 2400;
const BALL = { radius: 0.07, density: (7200 * 625) / 2400 };
const CUBE_HALF = 0.25;

export interface TunnelShot { kind: TunnelKind; thickness: number; speed: number; phase: number; slab: number; projectile: number; farFace: number; reach: number }
export interface TunnelCase { scene: SceneDesc; shots: TunnelShot[]; steps: number }

/** Rows of slabs along z (one row per kind, thickness and speed), a dozen slabs per row along x. */
export function tunnelCase(): TunnelCase {
  const slabs: BodyDesc[] = [], shots: Omit<TunnelShot, 'slab' | 'projectile'>[] = [], projectiles: BodyDesc[] = [];
  let row = 0;
  for (const kind of TUNNEL_KINDS) for (const thickness of TUNNEL_THICKNESS) for (const speed of TUNNEL_SPEEDS) {
    // Rows 40 m apart: a tunnelling projectile at 90 m/s covers 18 m in the 12 steps run.
    const z = 40 * row++;
    const reach = kind === 'ball' ? BALL.radius : CUBE_HALF;
    for (let k = 0; k < TUNNEL_PHASES; k++) {
      const x = 2 * k;
      slabs.push({ shape: { kind: 'box', half: [0.75, 0.75, thickness / 2] }, pos: [x, 0, z], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: STONE, friction: 0.6, restitution: 0, tag: 0 });
      // 0.2 m clear of the face, then k twelfths of a step's travel further back.
      const z0 = z - thickness / 2 - reach - 0.2 - (k / TUNNEL_PHASES) * (speed / 60);
      projectiles.push({
        shape: kind === 'ball' ? { kind: 'sphere', radius: BALL.radius } : { kind: 'box', half: [CUBE_HALF, CUBE_HALF, CUBE_HALF] },
        pos: [x + 0.05, 0.03, z0], rot: [0, 0, 0, 1], linVel: [0, 0, speed], angVel: [0, 0, 0],
        density: kind === 'ball' ? BALL.density : STONE, friction: 0.5, restitution: 0, tag: -1,
      });
      shots.push({ kind, thickness, speed, phase: k, farFace: z + thickness / 2, reach });
    }
  }
  const n = slabs.length;
  const scene: SceneDesc = { id: 'tunnel', params: {}, seed: 1, gravity: [0, 0, 0], dt: 1 / 60, ground: null, sleep: false, bodies: [...slabs, ...projectiles], inputs: [] };
  return { scene, steps: 12, shots: shots.map((s, i) => ({ ...s, slab: i, projectile: n + i })) };
}

/** Whether shot s has tunnelled by snapshot `snap`: its projectile wholly past the far face, still faster than 0.8 x its launch. */
export const tunnelled = (s: TunnelShot, snap: Snapshot) =>
  snap.pos[3 * s.projectile + 2]! - s.reach > s.farFace && snap.linVel[3 * s.projectile + 2]! > 0.8 * s.speed;

/** Tunnels per (kind, thickness, speed), over every snapshot. */
export function tunnelCounts(c: TunnelCase, snaps: readonly Snapshot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of c.shots) {
    const key = `${s.kind} ${s.thickness} ${s.speed}`;
    out.set(key, (out.get(key) ?? 0) + (snaps.some((snap) => tunnelled(s, snap)) ? 1 : 0));
  }
  return out;
}
