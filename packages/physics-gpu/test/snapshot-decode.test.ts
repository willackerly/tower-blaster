// decodeBodies (snapshot.ts) against readField, field by field, on random Body bytes.
import { describe, expect, it } from 'vitest';
import { Body, readField } from '@tb/schema';
import { decodeBodies } from '../src/snapshot.ts';

/** n random bodies' bytes, a little longer than they need (the staging buffer is a power of two). */
function randomBodies(n: number, seed: number): ArrayBuffer {
  const buf = new ArrayBuffer(n * Body.size + 64);
  const f = new Float32Array(buf), u = new Uint32Array(buf);
  let x = seed >>> 0;
  const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let w = 0; w < f.length; w++) f[w] = (rand() - 0.5) * 100;
  // Flags: awake bit, tier byte and junk in the other bits, which neither may read.
  const flags = Body.fields.find((fl) => fl.name === 'flags')!.offset / 4;
  for (let i = 0; i < n; i++) u[i * (Body.size / 4) + flags] = (rand() * 2 ** 32) >>> 0;
  return buf;
}

describe('decodeBodies', () => {
  for (const n of [0, 1, 7, 1000]) {
    for (const tiers of [false, true]) {
      it(`equals readField for ${n} bodies${tiers ? ' with tiers' : ''}`, () => {
        const buf = randomBodies(n, 17 + n);
        const s = decodeBodies(buf, n, tiers);
        expect(s.count).toBe(n);
        expect(s.pos).toEqual(readField(buf, Body, 'pos', n, new Float64Array(3 * n)));
        expect(s.rot).toEqual(readField(buf, Body, 'rot', n, new Float64Array(4 * n)));
        expect(s.linVel).toEqual(readField(buf, Body, 'linVel', n, new Float64Array(3 * n)));
        expect(s.angVel).toEqual(readField(buf, Body, 'angVel', n, new Float64Array(3 * n)));
        const flags = readField(buf, Body, 'flags', n, new Uint32Array(n));
        expect(s.awake).toEqual(Uint8Array.from(flags, (fl) => fl & 1));
        if (tiers) expect(s.tier).toEqual(Uint8Array.from(flags, (fl) => (fl >> 8) & 0xff));
        else expect(s.tier).toBeUndefined();
      });
    }
  }

  it('refuses a count the bytes do not hold, and a bad count', () => {
    const buf = new ArrayBuffer(2 * Body.size);
    expect(() => decodeBodies(buf, 3)).toThrow(/need/);
    expect(() => decodeBodies(buf, -1)).toThrow(/bad count/);
    expect(() => decodeBodies(buf, 1.5)).toThrow(/bad count/);
  });
});
