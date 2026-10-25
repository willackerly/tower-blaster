// Camera juice: trauma-based shake and a field-of-view punch. Render-only
// state driven by feedback events; nothing here reaches the physics.

export const TRAUMA_DECAY = 1.4; // per second
export const SHAKE_YAW = 0.045; // rad at full trauma
export const SHAKE_PITCH = 0.03;
export const PUNCH_DECAY = 9; // 1/s, exponential
export const PUNCH_MAX = 0.12; // fraction of the field of view

/** Smooth deterministic noise in [-1, 1]: sums of incommensurate sines. */
export function wobble(t: number, seed: number): number {
  return (Math.sin(t * 31.7 + seed * 1.3) + Math.sin(t * 17.3 + seed * 4.1) * 0.6 + Math.sin(t * 47.9 + seed * 2.7) * 0.3) / 1.9;
}

export class CameraJuice {
  trauma = 0;
  punch = 0;
  private t = 0;

  /** Add trauma (0..1); shake grows with its square, so small hits stay subtle. */
  shake(amount: number) { this.trauma = Math.min(1, this.trauma + Math.max(0, amount)); }
  /** Narrow the view briefly by `amount` of the field of view. */
  kick(amount: number) { this.punch = Math.min(PUNCH_MAX, Math.max(this.punch, amount)); }
  reset() { this.trauma = 0; this.punch = 0; }

  /** Advance by dt seconds and return offsets to add to the orbit, and the FOV scale. */
  update(dt: number): { yaw: number; pitch: number; fovScale: number } {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.punch *= Math.exp(-PUNCH_DECAY * dt);
    if (this.punch < 1e-4) this.punch = 0;
    const s = this.trauma * this.trauma;
    if (s === 0) return { yaw: 0, pitch: 0, fovScale: 1 - this.punch };
    return { yaw: SHAKE_YAW * s * wobble(this.t, 1), pitch: SHAKE_PITCH * s * wobble(this.t, 2), fovScale: 1 - this.punch };
  }
}

/**
 * Hit-stop frames and shake for an ammo contact of `impulse` N·s: bigger hits
 * freeze longer. A marble hit is about 300 N·s (4 frames), a cannonball about
 * 2,500 (6 frames, the cap).
 */
export function contactJuice(impulse: number): { frames: number; trauma: number } {
  if (!(impulse > 0)) return { frames: 0, trauma: 0 };
  return { frames: Math.max(2, Math.min(6, Math.round(2 + Math.log2(1 + impulse / 150)))), trauma: Math.min(0.7, 0.15 + impulse / 2000) };
}
