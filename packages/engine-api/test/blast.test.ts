// The blast definition (blast.ts): what every engine's kick must match.
import { describe, expect, it } from 'vitest';
import {
  type Blast, blastArea, blastCentre, blastKick, blastVelocity, blastWeight, checkBlast, checkBlastQueue, DEFAULT_BLAST_MAX_DV, DEFAULT_BLAST_MAX_SPEED,
  type InputEvent, MAX_BLAST_EXCLUDE, queueInputs, type Vec3,
} from '../src/index.ts';

describe('blast definition', () => {
  const O: Vec3 = [0, 0, 0];
  const B: Blast = { centre: O, radius: 4, impulse: 100, maxDv: 1e9 };
  const b = checkBlast(B);

  it('fills defaults: linear falloff, no core, the caps, no exclusions', () => {
    const d = checkBlast({ centre: [1, 2, 3], radius: 1, impulse: 0 });
    expect(d).toMatchObject({ point: [1, 2, 3], body: -1, falloff: 1, core: 0, maxDv: DEFAULT_BLAST_MAX_DV, maxSpeed: DEFAULT_BLAST_MAX_SPEED, exclude: [] });
  });

  it('pushes radially by impulse * w(d) * area / m', () => {
    // Area 1, 2 kg at d = 1 along +x, linear: 100 * 0.75 * 1 / 2.
    expect(blastKick(b, O, 0, [1, 0, 0], 2, 1)).toEqual([37.5, 0, 0]);
    // Off-axis, quadratic falloff, area 0.25, 0.125 kg at d = 2: 100 * 0.25 * 0.25 / 0.125 = 50.
    const k = blastKick(checkBlast({ ...B, falloff: 2 }), O, 0, [0, 2 * Math.SQRT1_2, -2 * Math.SQRT1_2], 0.125, 0.25)!;
    expect(Math.hypot(...k)).toBeCloseTo(50, 12);
    expect(k[1]).toBeCloseTo(-k[2], 12);
    expect(k[0]).toBe(0);
    // Flat falloff: the same at every distance inside.
    expect(blastKick(checkBlast({ ...B, falloff: 0 }), O, 0, [3.99, 0, 0], 1, 1)).toEqual([100, 0, 0]);
  });

  it('a flat core, then the falloff over the rest of the radius', () => {
    const c = checkBlast({ ...B, core: 0.5, falloff: 2 });
    expect(blastWeight(c, 0)).toBe(1);
    expect(blastWeight(c, 2)).toBe(1);
    expect(blastWeight(c, 3)).toBe(0.25);
    expect(blastWeight(c, 3.9)).toBeCloseTo(0.0025, 15);
  });

  it('area is the mean silhouette: a quarter of the surface', () => {
    expect(blastArea({ kind: 'box', half: [0.5, 0.5, 0.5] })).toBe(1.5);
    expect(blastArea({ kind: 'box', half: [1, 0.5, 0.25] })).toBe(2 * (0.5 + 0.125 + 0.25));
    expect(blastArea({ kind: 'sphere', radius: 2 })).toBe(4 * Math.PI);
  });

  it('a heavier body of the same size moves slower; a body on the centre goes straight up', () => {
    const light = blastKick(b, O, 0, [0, 2, 0], 1, 1)!, heavy = blastKick(b, O, 0, [0, 2, 0], 4, 1)!;
    expect(light[1]).toBeCloseTo(4 * heavy[1], 12);
    expect(blastKick(b, O, 0, [0, 0, 0], 1, 1)).toEqual([0, 100, 0]);
  });

  it('nothing at or beyond the radius or for excluded ids; the kick is capped at maxDv', () => {
    expect(blastKick(b, O, 0, [4, 0, 0], 1, 1)).toBeNull();
    expect(blastKick(b, O, 0, [0, 0, 5], 1, 1)).toBeNull();
    expect(blastKick(checkBlast({ ...B, exclude: [7] }), O, 7, [1, 0, 0], 1, 1)).toBeNull();
    expect(blastKick(checkBlast({ ...B, exclude: [7] }), O, 6, [1, 0, 0], 1, 1)).not.toBeNull();
    expect(blastKick(checkBlast({ ...B, maxDv: 10 }), O, 0, [0, -1, 0], 1, 1)).toEqual([0, -10, 0]);
  });

  it('the final speed is capped at maxSpeed, direction kept; under it, velocity plus kick', () => {
    const c = checkBlast({ ...B, maxSpeed: 13 });
    // Kick 75 along +x on a body moving 5 along +y: 75 + (0, 5) has speed > 13, scaled to 13.
    const v = blastVelocity(c, O, 0, [1, 0, 0], [0, 5, 0], 1, 1)!;
    expect(Math.hypot(...v)).toBeCloseTo(13, 12);
    expect(v[1] / v[0]).toBeCloseTo(5 / 75, 12);
    expect(blastVelocity(checkBlast({ ...B, impulse: 4 }), O, 0, [1, 0, 0], [0, 5, 0], 1, 1)).toEqual([3, 5, 0]);
    expect(blastVelocity(c, O, 0, [9, 0, 0], [0, 5, 0], 1, 1)).toBeNull();
  });

  it('a body centre is that body\'s position plus the offset', () => {
    const c = checkBlast({ ...B, centre: { body: 2, offset: [0, -1, 0] } });
    expect(c).toMatchObject({ point: null, body: 2, offset: [0, -1, 0] });
    expect(blastCentre(c, [5, 5, 5])).toEqual([5, 4, 5]);
    expect(blastCentre(checkBlast({ ...B, centre: { body: 2 } }), [5, 5, 5])).toEqual([5, 5, 5]);
    expect(blastCentre(b, null)).toEqual(O);
    expect(() => blastCentre(c, null)).toThrow(/body 2/);
  });

  it('a queue is refused when a blast is centred on a body that does not exist when it is due', () => {
    const spawn = (step: number): InputEvent => ({ step, kind: 'spawn', body: { shape: { kind: 'sphere', radius: 1 }, pos: O, rot: [0, 0, 0, 1], linVel: O, angVel: O, density: 1, friction: 0, restitution: 0, tag: 0 } });
    const on = (step: number, body: number): InputEvent => ({ step, kind: 'blast', blast: { ...B, centre: { body } } });
    expect(() => checkBlastQueue(2, [on(0, 1)])).not.toThrow();
    expect(() => checkBlastQueue(2, [on(0, 2)])).toThrow(/body 2/);
    expect(() => checkBlastQueue(2, [spawn(0), on(0, 2)])).not.toThrow();
    // Pushed after: the spawn at the same step queues after the blast, so body 2 does not exist yet.
    expect(() => checkBlastQueue(2, queueInputs([on(3, 2)], [spawn(3)]))).toThrow(/body 2/);
    expect(() => checkBlastQueue(2, queueInputs([on(3, 2)], [spawn(2)]))).not.toThrow();
  });

  it('refuses blasts no engine should apply', () => {
    const ok: Blast = { centre: O, radius: 1, impulse: 1 };
    expect(() => checkBlast({ ...ok, radius: 0 })).toThrow(/radius/);
    expect(() => checkBlast({ ...ok, radius: Infinity })).toThrow(/radius/);
    expect(() => checkBlast({ ...ok, impulse: -1 })).toThrow(/impulse/);
    expect(() => checkBlast({ ...ok, centre: [0, NaN, 0] })).toThrow(/centre/);
    expect(() => checkBlast({ ...ok, centre: { body: -1 } })).toThrow(/centre/);
    expect(() => checkBlast({ ...ok, centre: { body: 1, offset: [0, 0] as unknown as Vec3 } })).toThrow(/offset/);
    expect(() => checkBlast({ ...ok, centre: { body: 1, bogus: 1 } as unknown as Vec3 })).toThrow(/centre/);
    expect(() => checkBlast({ ...ok, falloff: 9 })).toThrow(/falloff/);
    expect(() => checkBlast({ ...ok, falloff: 1.5 })).toThrow(/falloff/);
    expect(() => checkBlast({ ...ok, core: 1 })).toThrow(/core/);
    expect(() => checkBlast({ ...ok, maxDv: -1 })).toThrow(/maxDv/);
    expect(() => checkBlast({ ...ok, maxSpeed: 0 })).toThrow(/maxSpeed/);
    expect(checkBlast({ ...ok, maxSpeed: Infinity }).maxSpeed).toBe(Infinity);
    expect(() => checkBlast({ ...ok, exclude: [1.5] })).toThrow(/exclude/);
    expect(() => checkBlast({ ...ok, exclude: Array.from({ length: MAX_BLAST_EXCLUDE + 1 }, (_, i) => i) })).toThrow(/exclude/);
  });
});
