// Fixed-step scheduling for a render loop. Physics runs at the scene's dt;
// each frame takes the steps that real time owes, capped so a slow engine
// degrades into slow motion instead of a death spiral.

export interface StepClock { acc: number; simSpeed: number }

export function newClock(): StepClock {
  return { acc: 0, simSpeed: 1 };
}

/** Steps to run this frame; mutates the clock. frameMs is real time since the last frame. */
export function stepsDue(c: StepClock, frameMs: number, dt: number, maxSteps = 2): number {
  const frame = Math.min(frameMs / 1000, 0.25);
  c.acc += frame;
  let n = Math.floor(c.acc / dt + 1e-9);
  if (n > maxSteps) {
    n = maxSteps;
    c.acc = 0; // drop owed time: slow motion, not catch-up
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
