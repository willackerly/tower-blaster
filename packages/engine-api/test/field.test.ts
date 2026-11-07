// Field events (field.ts, roadmap C7): the grid, the queue checks, the generators and fieldGravity.
import { describe, expect, it } from 'vitest';
import { checkInputQueue, exactCos, exactSin, FIELD_MAX, FIELD_QUANTUM, type FieldEvent, fieldGravity, gravityChanges, type InputEvent, joltEvent, kicks, onFieldGrid, quakeEvents, quantiseField, quantiseVec3, scheduleEvents, tiltEvent, type Vec3 } from '../src/index.ts';

const G: Vec3 = quantiseVec3([0, -9.81, 0]);
const f32 = (x: number) => Math.fround(x);

/** FNV-1a over a field schedule's steps and gravity components (as multiples of the quantum: integers). */
function fieldDigest(events: readonly FieldEvent[]): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => { for (const ch of String(v)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0; h = Math.imul(h ^ 44, 0x01000193) >>> 0; };
  for (const e of events) { mix(e.step); for (const g of e.gravity ?? []) mix(g / FIELD_QUANTUM); }
  return h.toString(16).padStart(8, '0');
}
/** The digest of the quake in the pinned test; a change here is a change to every level's quake. */
const QUAKE_DIGEST = '51ddc5f3';

describe('the field grid', () => {
  it('rounds to multiples of 2^-12, exactly representable in f32, and refuses values out of range', () => {
    expect(FIELD_QUANTUM).toBe(1 / 4096);
    for (const x of [-9.81, 0.1, 1e-5, -1e-5, 123.456789, FIELD_MAX, -FIELD_MAX, 0.5 * FIELD_QUANTUM, 3.5 * FIELD_QUANTUM]) {
      const q = quantiseField(x);
      expect(Math.abs(q - x)).toBeLessThanOrEqual(FIELD_QUANTUM / 2);
      expect(onFieldGrid(q)).toBe(true);
      expect(f32(q)).toBe(q);
      expect(JSON.parse(JSON.stringify(q))).toBe(q);
    }
    // No negative zero: equal fields serialise equally.
    expect(Object.is(quantiseField(-1e-6), 0)).toBe(true);
    expect(() => quantiseField(FIELD_MAX + 1)).toThrow();
    expect(() => quantiseField(Number.NaN)).toThrow();
    expect(onFieldGrid(-9.81)).toBe(false);
  });

  it('checkInputQueue refuses a field event off the grid, out of range, malformed, or with neither gravity nor kick', () => {
    const ok: InputEvent[] = [{ step: 1, kind: 'field', gravity: G }, { step: 2, kind: 'field', kick: [0.5, 0, 0] }, { step: 3, kind: 'field', gravity: G, kick: [0, 0, 0] }];
    expect(() => checkInputQueue(0, ok)).not.toThrow();
    const bad: Array<[FieldEvent, RegExp]> = [
      [{ step: 1, kind: 'field', gravity: [0, -9.81, 0] }, /multiples of 2\^-12/],
      [{ step: 1, kind: 'field', kick: [0, 2048, 0] }, /multiples of 2\^-12/],
      [{ step: 1, kind: 'field', gravity: [0, 0] as unknown as Vec3 }, /three multiples/],
      [{ step: 1, kind: 'field' }, /needs a gravity or a kick/],
    ];
    for (const [ev, msg] of bad) expect(() => checkInputQueue(0, [ev])).toThrow(msg);
  });

  it('kicks and gravityChanges compare exactly', () => {
    expect(kicks({ step: 0, kind: 'field', kick: [0, 0, 0] })).toBe(false);
    expect(kicks({ step: 0, kind: 'field', kick: [0, FIELD_QUANTUM, 0] })).toBe(true);
    expect(kicks({ step: 0, kind: 'field', gravity: G })).toBe(false);
    expect(gravityChanges(G, [...G])).toBe(false);
    expect(gravityChanges(G, undefined)).toBe(false);
    expect(gravityChanges(G, [FIELD_QUANTUM, G[1], 0])).toBe(true);
  });
});

describe('fieldGravity', () => {
  it('is SceneDesc.gravity until a field event sets another, in step then event order, and ignores kicks', () => {
    const g1: Vec3 = [1, -9, 0], g2: Vec3 = [0, -8, 0.5];
    const scene = { gravity: [0, -9.81, 0] as Vec3, inputs: [{ step: 10, kind: 'field', gravity: g2 }, { step: 5, kind: 'field', gravity: g1 }, { step: 5, kind: 'field', kick: [1, 0, 0] }, { step: 10, kind: 'field', gravity: G }] as InputEvent[] };
    expect(fieldGravity(scene, 0)).toEqual([0, -9.81, 0]);
    expect(fieldGravity(scene, 4)).toEqual([0, -9.81, 0]);
    expect(fieldGravity(scene, 5)).toEqual(g1);
    expect(fieldGravity(scene, 9)).toEqual(g1);
    // Two at step 10: the later in the list wins.
    expect(fieldGravity(scene, 10)).toEqual(G);
  });
});

describe('the generators', () => {
  it('tiltEvent turns gravity by an angle toward an azimuth, keeping its magnitude to the grid', () => {
    const e = tiltEvent(30, 20, G, Math.PI / 2);
    expect(e).toMatchObject({ step: 30, kind: 'field' });
    const g = e.gravity!;
    expect(g.every(onFieldGrid)).toBe(true);
    expect(Math.hypot(...g)).toBeCloseTo(9.81, 3);
    expect(Math.atan2(Math.hypot(g[0], g[2]), -g[1]) * 180 / Math.PI).toBeCloseTo(20, 2);
    expect(g[0]).toBe(0);
    expect(g[2]).toBeGreaterThan(0);
  });

  it('scheduleEvents keys only where the quantised gravity changes', () => {
    const ev = scheduleEvents(0, 10, (s) => (s < 5 ? [0, -9.81, 0] : [0.001, -9.81, 0]), [0, -9.81, 0]);
    expect(ev).toEqual([{ step: 5, kind: 'field', gravity: [quantiseField(0.001), G[1], 0] }]);
  });

  it('quakeEvents: one key per step that changes, the side load peaks near peak g along the azimuth, and the last key restores the base', () => {
    const dt = 1 / 60, q = quakeEvents({ step: 100, seconds: 4, dt, peak: 0.3, hz: 1, azimuth: 0 }, G);
    expect(q[0]!.step).toBeGreaterThanOrEqual(100);
    expect(q.at(-1)).toEqual({ step: 100 + 240, kind: 'field', gravity: G });
    for (const e of q) { expect(e.gravity!.every(onFieldGrid)).toBe(true); expect(e.gravity![1]).toBe(G[1]); expect(e.gravity![2]).toBe(0); }
    const side = Math.max(...q.map((e) => Math.abs(e.gravity![0])));
    // The envelope reaches 1 from 1 s to 3 s, where sin peaks at 1.25 s and 2.25 s.
    expect(side / 9.81).toBeCloseTo(0.3, 2);
    // Keys strictly increasing in step, at most one per step.
    for (let i = 1; i < q.length; i++) expect(q[i]!.step).toBeGreaterThan(q[i - 1]!.step);
    expect(() => quakeEvents({ step: 0, seconds: 0, dt, peak: 0.3 }, G)).toThrow();
  });

  it('exactSin and exactCos track Math.sin and Math.cos within 5e-13 out to 1500 rad, and keep sin odd', () => {
    let worst = 0;
    for (let i = -20000; i <= 20000; i++) {
      const x = i * 0.0731;
      if (Math.abs(x) < 2) expect(Math.abs(exactSin(x) - Math.sin(x))).toBeLessThan(1e-15);
      worst = Math.max(worst, Math.abs(exactSin(x) - Math.sin(x)), Math.abs(exactCos(x) - Math.cos(x)));
      expect(exactSin(-x) + exactSin(x)).toBe(0);
    }
    expect(worst).toBeLessThan(5e-13);
    expect(exactSin(0)).toBe(0);
    expect(Math.abs(exactSin(Math.PI / 2) - 1)).toBeLessThan(1e-15);
    expect(Math.abs(exactCos(0) - 1)).toBeLessThan(1e-15);
    expect(Number.isNaN(exactSin(Infinity))).toBe(true);
  });

  it('quakeEvents keys are pinned: exact arithmetic only, so Node and every browser give these bits (QUAKE_DIGEST)', () => {
    const q = quakeEvents({ step: 10, seconds: 3, dt: 1 / 60, peak: 0.45, hz: 1.3, azimuth: Math.PI / 3 }, G);
    expect(fieldDigest(q)).toBe(QUAKE_DIGEST);
  });

  it('joltEvent quantises its kick', () => {
    expect(joltEvent(7, [0.1, 0, -0.2])).toEqual({ step: 7, kind: 'field', kick: [quantiseField(0.1), 0, quantiseField(-0.2)] });
  });
});
