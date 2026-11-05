// FrameGovernor (frame-rate.ts): which display frames are drawn, on fake clocks.
import { describe, expect, it } from 'vitest';
import { FrameGovernor, frameMode, HOLD_MS, MIN_INTERVALS, type PhysicsLoad } from '../src/frame-rate.ts';

const IDLE: PhysicsLoad = { idle: true, behind: false, clear: true };
const BEHIND: PhysicsLoad = { idle: false, behind: true, clear: false };
const RUNNING_TIGHT: PhysicsLoad = { idle: false, behind: false, clear: false };
const RUNNING_CLEAR: PhysicsLoad = { idle: false, behind: false, clear: true };

/** Drive g at the frame times `ts`; the draws, as 1/0. */
function at(g: FrameGovernor, ts: readonly number[], load: PhysicsLoad, force = false): number[] {
  return ts.map((t) => (g.frame(t, load, force) ? 1 : 0));
}
/** n frame times of a steady hz display from t0. */
const steady = (hz: number, n: number, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + (i * 1000) / hz);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
/** Drawn frames a second over frame times ts, from the draws. */
const drawnHz = (ts: readonly number[], draws: number[]) => (sum(draws) - 1) / ((ts.at(-1)! - ts[0]!) / 1000);

describe('FrameGovernor', () => {
  it("'all' draws every frame whatever the load", () => {
    const g = new FrameGovernor('all');
    expect(sum(at(g, steady(120, 240), BEHIND))).toBe(240);
    expect(g.skipped).toBe(0);
    expect(g.decimating).toBe(false);
  });

  it("'half' draws the whole fraction of the display's rate nearest 60 (60 at 120 Hz, 72 at 144, 55 at 165, 60 at 240), and every frame from 60 to 100 Hz", () => {
    for (const [hz, want] of [[120, 60], [119.88, 59.94], [144, 72], [165, 55], [240, 60], [60, 60], [75, 75], [90, 90], [100, 100]] as const) {
      const g = new FrameGovernor('half'), ts = steady(hz, Math.round(hz * 4));
      const d = at(g, ts, IDLE).slice(Math.round(hz)); // after a second, once the rate is known
      expect(drawnHz(ts.slice(Math.round(hz)), d), `${hz} Hz`).toBeCloseTo(want, 0);
      expect(g.decimating, `${hz} Hz`).toBe(hz >= 110);
    }
  });

  it('draws 60 a second at 120 Hz when rAF ticks come unevenly (the E7 A/B drew 30 with the frame-counting version)', () => {
    // Ticks in pairs: one 1 ms after the last, the next 15.7 ms later (still 120 a second on average).
    const ts: number[] = [];
    for (let t = 0, i = 0; t < 4000; i++) { ts.push(t); t += i % 2 ? 15.67 : 1; }
    const g = new FrameGovernor('half');
    const d = at(g, ts, IDLE);
    expect(drawnHz(ts.slice(120), d.slice(120))).toBeGreaterThan(55);
    expect(drawnHz(ts.slice(120), d.slice(120))).toBeLessThan(65);
  });

  it('draws every frame when a 120 Hz display drops to 60 (ProMotion), and decimates again when it comes back', () => {
    const g = new FrameGovernor('half');
    const a = steady(120, 240), b = steady(60, 120, 2000), c = steady(120, 240, 4000);
    at(g, a, IDLE);
    const slow = at(g, b, IDLE);
    expect(sum(slow.slice(40))).toBe(80); // every frame once the median has moved
    expect(g.decimating).toBe(false);
    const fast = at(g, c, IDLE);
    expect(drawnHz(c.slice(60), fast.slice(60))).toBeCloseTo(60, 0);
    expect(g.decimating).toBe(true);
  });

  it('never leaves more than 1/60 s plus a display interval between drawn frames, with jitter', () => {
    let x = 7;
    const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const ts: number[] = [];
    for (let t = 0; t < 5000; t += 8.33 + (rand() - 0.5) * 3) ts.push(t);
    const g = new FrameGovernor('half');
    const d = at(g, ts, IDLE);
    const drawnAt = ts.filter((_, i) => d[i]);
    let worst = 0;
    for (let i = 20; i < drawnAt.length; i++) worst = Math.max(worst, drawnAt[i]! - drawnAt[i - 1]!);
    expect(worst).toBeLessThan(1000 / 60 + 8.33 + 3);
    expect(drawnHz(ts.slice(120), d.slice(120))).toBeGreaterThan(55);
  });

  it('draws every frame until MIN_INTERVALS intervals are known, then decimates (a fast burst after load is not a 120 Hz display)', () => {
    const g = new FrameGovernor('half');
    // Two quick ticks then a 60 Hz display: the first medians are ~1 ms, so without the gate frame 2 is skipped.
    const ts = [0, 1, 2, ...steady(60, 30, 2 + 1000 / 60)];
    expect(sum(at(g, ts, BEHIND))).toBe(ts.length);
    expect(g.skipped).toBe(0);
    const g120 = new FrameGovernor('half');
    const draws = at(g120, steady(120, 40), BEHIND);
    expect(draws.slice(0, MIN_INTERVALS)).toEqual(new Array(MIN_INTERVALS).fill(1)); // frame i has seen i intervals
    expect(g120.decimating).toBe(true);
    expect(g120.skipped).toBeGreaterThan(10);
  });

  it('a capture always draws', () => {
    const g = new FrameGovernor('half');
    at(g, steady(120, 20), IDLE);
    const before = g.drawn;
    expect(at(g, [20 * 1000 / 120, 21 * 1000 / 120], IDLE, true)).toEqual([1, 1]);
    expect(g.drawn).toBe(before + 2);
  });

  it("'auto' decimates only while physics is behind, and stops at once when physics goes idle", () => {
    const g = new FrameGovernor('auto');
    expect(sum(at(g, steady(120, 120), IDLE))).toBe(120);
    expect(sum(at(g, steady(120, 120, 1000), BEHIND))).toBe(60);
    expect(g.decimating).toBe(true);
    expect(sum(at(g, steady(120, 12, 2000), IDLE))).toBe(12);
    expect(g.decimating).toBe(false);
  });

  it("'auto' keeps decimating without headroom, and stops HOLD_MS after headroom starts", () => {
    const g = new FrameGovernor('auto');
    at(g, steady(120, 120), BEHIND);
    expect(sum(at(g, steady(120, 240, 1000), RUNNING_TIGHT))).toBe(120); // not behind, but no headroom: still halved
    const ts = steady(120, 240, 3000), d = at(g, ts, RUNNING_CLEAR);
    const firstFull = d.findIndex((v, i) => i > 0 && v === 1 && d[i - 1] === 1);
    expect(ts[firstFull]! - 3000).toBeGreaterThanOrEqual(HOLD_MS - 1000 / 120);
    expect(ts[firstFull]! - 3000).toBeLessThanOrEqual(HOLD_MS + 2000 / 120);
    expect(g.decimating).toBe(false);
  });

  it("'auto' restarts the hold when headroom is lost", () => {
    const g = new FrameGovernor('auto');
    at(g, steady(120, 60), BEHIND);
    at(g, steady(120, 60, 500), RUNNING_CLEAR); // 0.5 s of headroom
    at(g, [1000], RUNNING_TIGHT); // lost
    at(g, steady(120, 72, 1000 + 1000 / 120), RUNNING_CLEAR); // 0.6 s more: 1.1 s in all, but not in a row
    expect(g.decimating).toBe(true);
  });

  it("on a 60 Hz display 'auto' never skips a frame, though it still tracks the load", () => {
    const g = new FrameGovernor('auto');
    expect(sum(at(g, steady(60, 240), BEHIND))).toBe(240);
    expect(g.decimating).toBe(false);
  });
});

describe('frameMode', () => {
  it('reads all, half and auto, all by default, and refuses anything else', () => {
    expect(frameMode(null)).toBe('all');
    for (const m of ['all', 'half', 'auto'] as const) expect(frameMode(m)).toBe(m);
    expect(() => frameMode('60')).toThrow(/keystone.frames/);
    expect(() => frameMode('')).toThrow(/keystone.frames/);
  });
});
