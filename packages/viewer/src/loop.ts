// Fixed-step scheduling for a render loop. Physics runs at the scene's dt;
// each frame takes the steps that real time owes, capped so a slow engine
// degrades into slow motion instead of a death spiral. The cap defaults to one
// step: when a step costs more than a frame, a second step in the same frame
// doubles that frame without making the simulation any faster.

export interface StepClock { acc: number; simSpeed: number }

export function newClock(): StepClock {
  return { acc: 0, simSpeed: 1 };
}

/** Most steps a frame may take (the viewer's maxSteps URL option). */
export const MAX_STEPS_LIMIT = 4;

/** Steps to run this frame; mutates the clock. frameMs is real time since the last frame. */
export function stepsDue(c: StepClock, frameMs: number, dt: number, maxSteps = 1): number {
  const frame = Math.min(frameMs / 1000, 0.25);
  c.acc += frame;
  let n = Math.floor(c.acc / dt + 1e-9);
  if (n > maxSteps) {
    n = maxSteps;
    // Drop the owed time (slow motion, not catch-up), but keep just under one step, so the
    // renderer's alpha = acc / dt stays near 1 and draws the newest pose instead of the one before.
    c.acc = dt * (1 - 1e-6);
  } else {
    c.acc -= n * dt;
  }
  if (frame > 0) c.simSpeed = 0.9 * c.simSpeed + 0.1 * Math.min(1, (n * dt) / frame);
  return n;
}

/** Rolling window of step times for the HUD. */
export class Window {
  private xs: number[] = [];
  constructor(private readonly size = 120) {}
  push(x: number) {
    this.xs.push(x);
    if (this.xs.length > this.size) this.xs.shift();
  }
  quantile(q: number): number {
    if (!this.xs.length) return NaN;
    const s = [...this.xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  }
}
