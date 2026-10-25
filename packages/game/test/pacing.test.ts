import { describe, expect, it } from 'vitest';
import { FAST_SCALE, Pacer, SLOWMO_IN, SLOWMO_MAX, SLOWMO_OUT, SLOWMO_SCALE } from '../src/pacing.ts';

const DT = 1 / 60, FRAME = 1000 / 60;
const run = (p: Pacer, frames: number, o = {}) => Array.from({ length: frames }, () => p.stepsThisFrame(FRAME, DT, o));

describe('Pacer', () => {
  it('runs one step per 60 Hz frame at normal speed and catches up at most two', () => {
    const p = new Pacer();
    expect(run(p, 10)).toEqual(Array(10).fill(1));
    expect(p.stepsThisFrame(100, DT)).toBe(2);
  });
  it('hit-stop gives zero steps for exactly N frames, the longer request winning', () => {
    const p = new Pacer();
    p.hitStop(3); p.hitStop(5); p.hitStop(2);
    expect(p.frozen).toBe(true);
    expect(run(p, 7)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(p.frozen).toBe(false);
  });
  it('slow motion follows its curve: ramp down, hold, ramp back after release', () => {
    expect(Pacer.curve(0, null)).toBe(1);
    expect(Pacer.curve(SLOWMO_IN / 2, null)).toBeCloseTo((1 + SLOWMO_SCALE) / 2, 12);
    expect(Pacer.curve(1, null)).toBe(SLOWMO_SCALE);
    expect(Pacer.curve(1 + SLOWMO_OUT / 2, 1)).toBeCloseTo((1 + SLOWMO_SCALE) / 2, 12);
    expect(Pacer.curve(SLOWMO_MAX + SLOWMO_OUT, null)).toBe(1); // never held forever
  });
  it('slow motion runs about 0.3 steps per frame while held, then recovers', () => {
    const p = new Pacer();
    p.slowMo();
    run(p, 10);
    const held = run(p, 30).reduce((a, b) => a + b);
    expect(held).toBeGreaterThanOrEqual(8);
    expect(held).toBeLessThanOrEqual(10);
    p.release();
    run(p, 30);
    expect(p.slowing).toBe(false);
    expect(run(p, 5)).toEqual([1, 1, 1, 1, 1]);
  });
  it('fast-forward runs four steps a frame', () => {
    const p = new Pacer();
    expect(run(p, 3, { fastForward: true })).toEqual([FAST_SCALE, FAST_SCALE, FAST_SCALE]);
  });
  it('the valve slows time when steps cost more than the budget, never below a quarter', () => {
    const p = new Pacer();
    run(p, 60, { stepMs: 20, budgetMs: 10 }); // twice over budget: half speed
    expect(p.timeScale).toBeCloseTo(0.5, 6);
    run(p, 1, { stepMs: 1000, budgetMs: 10 });
    expect(p.timeScale).toBe(0.25);
    run(p, 1, { stepMs: 1, budgetMs: 10 });
    expect(p.timeScale).toBe(1);
  });
});
