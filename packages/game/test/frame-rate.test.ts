// FrameGovernor (frame-rate.ts): which display frames are drawn, on fake clocks.
import { describe, expect, it } from 'vitest';
import { factorFor, FrameGovernor, frameMode, HOLD_MS, type PhysicsLoad } from '../src/frame-rate.ts';

const IDLE: PhysicsLoad = { idle: true, behind: false, clear: true };
const BEHIND: PhysicsLoad = { idle: false, behind: true, clear: false };
const RUNNING_TIGHT: PhysicsLoad = { idle: false, behind: false, clear: false };
const RUNNING_CLEAR: PhysicsLoad = { idle: false, behind: false, clear: true };

/** Drive g for `frames` display frames of hz from t0; the draws, as 1/0, and the time after. */
function run(g: FrameGovernor, hz: number, frames: number, load: PhysicsLoad | ((t: number) => PhysicsLoad), t0 = 0): { draws: number[]; t: number } {
  const draws: number[] = [];
  let t = t0;
  for (let i = 0; i < frames; i++, t += 1000 / hz) draws.push(g.frame(t, typeof load === 'function' ? load(t) : load) ? 1 : 0);
  return { draws, t };
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('factorFor', () => {
  it('halves 110-120 Hz, keeps 60-100 Hz, and never goes under 55 drawn frames a second', () => {
    for (const [hz, k] of [[60, 1], [59.94, 1], [75, 1], [90, 1], [100, 1], [110, 2], [119.88, 2], [120, 2], [144, 2], [165, 3], [240, 4], [480, 4]] as const) {
      expect(factorFor(1000 / hz), `${hz} Hz`).toBe(k);
      if (k > 1) expect(hz / k).toBeGreaterThanOrEqual(55);
    }
  });
  it('is 1 before the interval is known', () => {
    expect(factorFor(NaN)).toBe(1);
    expect(factorFor(0)).toBe(1);
  });
});

describe('FrameGovernor', () => {
  it("'all' draws every frame whatever the load", () => {
    const g = new FrameGovernor('all');
    expect(sum(run(g, 120, 240, BEHIND).draws)).toBe(240);
    expect(g.skipped).toBe(0);
  });

  it("'half' draws every other frame at 120 Hz and every frame at 60 Hz", () => {
    const g = new FrameGovernor('half');
    const { draws } = run(g, 120, 240, IDLE);
    // The first frame has no interval yet; from the second on, alternate.
    expect(sum(draws.slice(10))).toBe(115);
    for (let i = 11; i < 240; i++) expect(draws[i]! + draws[i - 1]!).toBe(1);
    expect(sum(run(new FrameGovernor('half'), 60, 120, IDLE).draws)).toBe(120);
  });

  it('ignores missed frames when it estimates the display rate', () => {
    const g = new FrameGovernor('half');
    let t = 0;
    for (let i = 0; i < 400; i++) { t += i % 10 === 9 ? 2000 / 120 : 1000 / 120; g.frame(t, IDLE); }
    expect(g.interval).toBeCloseTo(1000 / 120, 6);
    expect(factorFor(g.interval)).toBe(2);
  });

  it('a capture always draws', () => {
    const g = new FrameGovernor('half');
    run(g, 120, 20, IDLE);
    const before = g.drawn;
    expect(g.frame(20 * 1000 / 120, IDLE, true)).toBe(true);
    expect(g.frame(21 * 1000 / 120, IDLE, true)).toBe(true);
    expect(g.drawn).toBe(before + 2);
  });

  it("'auto' decimates only while physics is behind, and stops at once when physics goes idle", () => {
    const g = new FrameGovernor('auto');
    expect(sum(run(g, 120, 120, IDLE).draws)).toBe(120);
    const behind = run(g, 120, 120, BEHIND, 1000);
    expect(sum(behind.draws)).toBe(60);
    expect(g.decimating).toBe(true);
    const idle = run(g, 120, 12, IDLE, behind.t);
    expect(sum(idle.draws)).toBe(12);
    expect(g.decimating).toBe(false);
  });

  it("'auto' keeps decimating without headroom, and stops HOLD_MS after headroom starts", () => {
    const g = new FrameGovernor('auto');
    const a = run(g, 120, 120, BEHIND);
    const b = run(g, 120, 240, RUNNING_TIGHT, a.t);
    expect(sum(b.draws)).toBe(120); // not behind, but no headroom: still halved
    const start = b.t;
    const c = run(g, 120, 240, RUNNING_CLEAR, start);
    const firstFull = c.draws.findIndex((d, i) => i > 0 && d === 1 && c.draws[i - 1] === 1);
    expect(firstFull * 1000 / 120).toBeGreaterThanOrEqual(HOLD_MS - 1000 / 120);
    expect(firstFull * 1000 / 120).toBeLessThanOrEqual(HOLD_MS + 2000 / 120);
    expect(g.decimating).toBe(false);
  });

  it("'auto' restarts the hold when headroom is lost", () => {
    const g = new FrameGovernor('auto');
    let t = run(g, 120, 60, BEHIND).t;
    t = run(g, 120, 60, RUNNING_CLEAR, t).t; // 0.5 s of headroom
    t = run(g, 120, 1, RUNNING_TIGHT, t).t; // lost
    t = run(g, 120, 72, RUNNING_CLEAR, t).t; // 0.6 s more: 1.1 s in all, but not in a row
    expect(g.decimating).toBe(true);
  });

  it('never draws under 55 frames a second while decimating, at any display rate', () => {
    for (const hz of [60, 90, 120, 144, 240]) {
      const g = new FrameGovernor('half');
      const { draws } = run(g, hz, hz * 3, BEHIND);
      expect(sum(draws.slice(hz)) / 2, `${hz} Hz`).toBeGreaterThanOrEqual(55);
    }
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
