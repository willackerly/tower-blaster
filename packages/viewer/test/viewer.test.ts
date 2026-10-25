import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emptySnapshot, type BodyDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { RenderInstance, readStruct } from '@tb/schema';
import {
  eyeOf, frame, invert, multiply, newClock, packInstances, paletteOf, parseViewerConfig, rayThrough, stepsDue, toSearch, transform, viewProj, Window, type Orbit,
} from '../src/index.ts';

const orbit: Orbit = { target: [1, 2, 3], yaw: 0.7, pitch: 0.4, distance: 25, fovY: 0.9 };

describe('math and camera', () => {
  it('invert is a true inverse', () => {
    const m = viewProj(orbit, 1.6);
    const id = multiply(m, invert(m));
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) expect(id[c * 4 + r]).toBeCloseTo(c === r ? 1 : 0, 4);
  });

  it('projects the target to the screen centre, in front of the camera', () => {
    const p = transform(viewProj(orbit, 1.6), orbit.target);
    expect(p[0] / p[3]).toBeCloseTo(0, 5);
    expect(p[1] / p[3]).toBeCloseTo(0, 5);
    const z = p[2] / p[3];
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1);
  });

  it('the centre ray starts at the eye and points at the target', () => {
    const { origin, dir } = rayThrough(orbit, 1.6, 0, 0);
    const eye = eyeOf(orbit);
    expect(origin).toEqual(eye);
    const want = [0, 1, 2].map((k) => (orbit.target[k]! - eye[k]!) / orbit.distance);
    dir.forEach((d, k) => expect(d).toBeCloseTo(want[k]!, 4));
  });

  it('any ray re-projects to the pixel it was cast through', () => {
    fc.assert(fc.property(fc.double({ min: -0.95, max: 0.95, noNaN: true }), fc.double({ min: -0.95, max: 0.95, noNaN: true }), fc.double({ min: 2, max: 50, noNaN: true }), (x, y, t) => {
      const { origin, dir } = rayThrough(orbit, 1.6, x, y);
      const p = transform(viewProj(orbit, 1.6), [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]]);
      return Math.abs(p[0] / p[3] - x) < 1e-3 && Math.abs(p[1] / p[3] - y) < 1e-3;
    }));
  });

  it('frame() keeps the whole box on screen', () => {
    const o = frame([-20, 0, -20], [20, 25, 20]);
    const m = viewProj(o, 16 / 9);
    for (const x of [-20, 20]) for (const y of [0, 25]) for (const z of [-20, 20]) {
      const p = transform(m, [x, y, z]);
      expect(Math.abs(p[0] / p[3])).toBeLessThan(1);
      expect(Math.abs(p[1] / p[3])).toBeLessThan(1);
    }
  });
});

describe('packInstances', () => {
  it('writes the schema layout, boxes first, spheres after', () => {
    const scene = buildScenario('S5', { N: 64, F: 2, H: 4, fireStep: 0 });
    const shapes: BodyDesc[] = [scene.inputs[0]!.body, ...scene.bodies];
    const s = emptySnapshot(shapes.length);
    shapes.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); });
    const p = packInstances(s, shapes);
    expect([p.boxes, p.spheres]).toEqual([shapes.length - 1, 1]);
    const view = new DataView(p.data);
    const first = readStruct(view, RenderInstance, 0);
    expect(first.shape).toEqual([0]);
    expect(first.half).toEqual([0.5, 0.5, 0.5]);
    expect(first.pos!.map((x, k) => Math.abs(x - shapes[1]!.pos[k]!) < 1e-5)).toEqual([true, true, true]);
    const ball = readStruct(view, RenderInstance, p.boxes);
    const r = (shapes[0]!.shape as { radius: number }).radius;
    expect(ball.shape).toEqual([1]);
    expect(ball.half).toEqual([r, r, r]);
    expect(ball.palette).toEqual([paletteOf(-1)]);
  });

  it('reuses the output buffer when it is big enough', () => {
    const scene = buildScenario('S1', { F: 2, H: 2 });
    const s = emptySnapshot(scene.bodies.length);
    const a = packInstances(s, scene.bodies);
    expect(packInstances(s, scene.bodies, a.data).data).toBe(a.data);
  });
});

describe('stepsDue', () => {
  const dt = 1 / 60;
  it('at 60 fps takes one step per frame and tracks real time', () => {
    const c = newClock();
    let total = 0;
    for (let i = 0; i < 600; i++) total += stepsDue(c, 1000 / 60, dt);
    expect(total).toBeGreaterThanOrEqual(599);
    expect(total).toBeLessThanOrEqual(600);
    expect(c.simSpeed).toBeCloseTo(1, 2);
  });
  it('at 120 Hz display alternates zero and one steps', () => {
    const c = newClock();
    const steps = Array.from({ length: 240 }, () => stepsDue(c, 1000 / 120, dt));
    expect(steps.reduce((a, b) => a + b)).toBeGreaterThanOrEqual(119);
    expect(Math.max(...steps)).toBe(1);
  });
  it('a slow frame is capped and becomes slow motion, not a spiral', () => {
    const c = newClock();
    for (let i = 0; i < 100; i++) expect(stepsDue(c, 100, dt)).toBe(2);
    expect(c.acc).toBe(0);
    expect(c.simSpeed).toBeCloseTo((2 * dt) / 0.1, 2);
  });
  it('Window quantiles', () => {
    const w = new Window(10);
    for (let i = 1; i <= 20; i++) w.push(i);
    expect(w.quantile(0)).toBe(11);
    expect(w.quantile(0.5)).toBe(16);
    expect(new Window().quantile(0.5)).toBeNaN();
  });
});

describe('viewer config', () => {
  it('defaults to a 2k city', () => {
    expect(parseViewerConfig('')).toMatchObject({ scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, engine: 'rapier', sleep: null });
  });
  it('round-trips through the URL', () => {
    const c = parseViewerConfig('?scenario=s1&param.F=3&param.gap=0.02&sleep=0&autofire=30&seed=4&offscreen=1');
    expect(c).toMatchObject({ scenario: 'S1', params: { F: 3, gap: 0.02 }, sleep: false, autofire: 30, seed: 4, offscreen: true });
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
  });
  it('rejects unknown scenarios and non-numeric params', () => {
    expect(() => parseViewerConfig('?scenario=S99')).toThrow(/unknown scenario/);
    expect(() => parseViewerConfig('?param.N=lots')).toThrow(/not a number/);
  });
});
