// The listening ladder's scripts are the tap's definition applied to known impacts: these pin the
// scripts (what each step plays) and that the frames carry exactly what buildFrame would post.
import { describe, expect, it } from 'vitest';
import { DV_EDGES, TOP_FIELDS } from '../src/frame.ts';
import { framesOf, renderLadder, script } from '../src/ladder-cli.ts';
import { SOUND_MATERIALS } from '../src/material.ts';

describe('listening ladder', () => {
  it('knock: a 5 cm drop onto a resting twin, both ring, two bounces at restitution 0.35', () => {
    const h = script('knock', 0.6);
    expect(h.length).toBe(6); // three strikes, two bodies each
    const v = Math.sqrt(2 * 9.81 * 0.05);
    expect(h[0]!.dv).toBeCloseTo((v * 1.35) / 2, 6);
    expect(h[2]!.dv / h[0]!.dv).toBeCloseTo(0.35, 6);
    expect(h[2]!.t - h[0]!.t).toBeCloseTo((2 * v * 0.35) / 9.81, 6);
    expect(new Set(h.map((x) => x.body)).size).toBe(2);
  });

  it('clatter and tumble are fixed scripts (seeded), sorted in time', () => {
    for (const [step, n] of [['clatter', 24], ['tumble', 60]] as const) {
      const a = script(step, 0.6), b = script(step, 0.6);
      expect(a).toEqual(b);
      expect(a.length).toBe(n);
      for (let i = 1; i < a.length; i++) expect(a[i]!.t).toBeGreaterThanOrEqual(a[i - 1]!.t);
    }
    expect(() => script('avalanche', 1)).toThrow(/unknown step/);
  });

  it('frames hold every hit once, in its own 60 Hz frame, loudest first in top', () => {
    const hits = script('clatter', 0.6), frames = framesOf(hits, 2);
    expect(frames.length).toBe(120);
    let count = 0, a2 = 0;
    for (const f of frames) {
      count += f.counts.reduce((s, x) => s + x, 0); a2 += f.a2.reduce((s, x) => s + x, 0);
      expect(f.counts.length).toBe(DV_EDGES.length * f.sectors);
      for (let i = 1; i < f.top.length / TOP_FIELDS; i++) expect(f.top[i * TOP_FIELDS]!).toBeLessThanOrEqual(f.top[(i - 1) * TOP_FIELDS]! + 1e-6);
    }
    expect(count).toBe(hits.length);
    expect(a2).toBeCloseTo(hits.reduce((s, h) => s + (h.dv / Math.max(h.dist, 0.5)) ** 2, 0), 3);
  });

  it('renders under the limiter (the ladder hears the synth) and is deterministic', () => {
    const f = framesOf(script('knock', 0.6), 0.6);
    const a = renderLadder(f, SOUND_MATERIALS.stone, 0.5, 0.5), b = renderLadder(f, SOUND_MATERIALS.stone, 0.5, 0.5);
    let peak = 0;
    for (let i = 0; i < a.L.length; i++) peak = Math.max(peak, Math.abs(a.L[i]!));
    expect(peak).toBeGreaterThan(1e-4);
    expect(peak).toBeLessThan(0.5);
    expect(a.L).toEqual(b.L);
  });
});
