import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALL_STRUCTS, Body, defineStruct, field, readField, readStruct, RenderInstance, type StructLayout, wgslModule, writeStruct } from '../src/index.ts';

describe('defineStruct follows WGSL alignment rules', () => {
  it('pads a vec3 after a scalar to 16', () => {
    const s = defineStruct('A', [['a', 'f32'], ['b', 'vec3f']]);
    expect(field(s, 'b').offset).toBe(16);
    expect(s.size).toBe(32);
    expect(s.align).toBe(16);
  });

  it('packs a scalar into the tail of a vec3', () => {
    const s = defineStruct('B', [['a', 'vec3f'], ['b', 'f32']]);
    expect(field(s, 'b').offset).toBe(12);
    expect(s.size).toBe(16);
  });

  it('rounds struct size up to its alignment', () => {
    const s = defineStruct('C', [['a', 'vec2f'], ['b', 'f32']]);
    expect(s.align).toBe(8);
    expect(s.size).toBe(16);
  });

  it('gives the shared structs their intended sizes', () => {
    expect(Body.size).toBe(64);
    expect(RenderInstance.size).toBe(32);
    expect(Body.fields.map((f) => [f.name, f.offset])).toEqual([
      ['pos', 0], ['invMass', 12], ['rot', 16], ['linVel', 32], ['flags', 44], ['angVel', 48], ['shape', 60],
    ]);
  });

  it('rejects duplicate and empty definitions', () => {
    expect(() => defineStruct('D', [['a', 'f32'], ['a', 'u32']])).toThrow(/duplicate/);
    expect(() => defineStruct('E', [])).toThrow(/no fields/);
  });

  it('never overlaps fields and keeps every field aligned (random structs)', () => {
    const types = ['f32', 'u32', 'i32', 'vec2f', 'vec3f', 'vec4f', 'vec2u', 'vec3i', 'mat4x4f'] as const;
    const align: Record<string, number> = { f32: 4, u32: 4, i32: 4, vec2f: 8, vec2u: 8, vec3f: 16, vec3i: 16, vec4f: 16, mat4x4f: 16 };
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...types), { minLength: 1, maxLength: 12 }), (ts) => {
        const s = defineStruct('R', ts.map((t, i) => [`f${i}`, t] as [string, (typeof types)[number]]));
        let end = 0;
        for (const f of s.fields) {
          expect(f.offset % align[f.type]!).toBe(0);
          expect(f.offset).toBeGreaterThanOrEqual(end);
          end = f.offset + f.size;
        }
        expect(s.size).toBeGreaterThanOrEqual(end);
        expect(s.size % s.align).toBe(0);
      }),
    );
  });
});

describe('writeStruct / readStruct', () => {
  it('round-trips values through an array of structs', () => {
    const buf = new DataView(new ArrayBuffer(Body.size * 3));
    const v = { pos: [1.5, -2, 3], invMass: 0.25, rot: [0, 0, 0, 1], linVel: [4, 5, 6], flags: 0xdeadbeef, angVel: [-1, 0, 1], shape: 7 };
    writeStruct(buf, Body, 2, v);
    const r = readStruct(buf, Body, 2);
    expect(r.pos).toEqual([1.5, -2, 3]);
    expect(r.flags).toEqual([0xdeadbeef]);
    expect(r.shape).toEqual([7]);
    expect(readStruct(buf, Body, 0).pos).toEqual([0, 0, 0]);
  });

  it('rejects a wrong component count', () => {
    const buf = new DataView(new ArrayBuffer(Body.size));
    expect(() => writeStruct(buf, Body, 0, { pos: [1, 2] })).toThrow(/expected 3/);
  });
});

describe('readField', () => {
  // NaN payloads (quiet, signalling, all ones), ±Inf, ±0, the extreme
  // subnormals and normals, and the i32/u32 extremes.
  const SPECIAL = [0x7fc00000, 0x7f800001, 0xffffffff, 0x7fffffff, 0x7f800000, 0xff800000, 0x80000000, 0, 1, 0x807fffff, 0x00800000, 0x7f7fffff, 0xff7fffff];
  // Every type, so i32, vec2 and mat4x4 fields are covered too.
  const Probe = defineStruct('Probe', [
    ['a', 'f32'], ['b', 'vec3f'], ['c', 'u32'], ['d', 'vec2f'], ['e', 'i32'], ['f', 'vec4u'],
    ['g', 'f32'], ['h', 'mat4x4f'], ['i', 'vec2i'], ['j', 'vec3u'], ['k', 'vec4i'],
  ]);
  const structs = [...ALL_STRUCTS, Probe];

  /** The first value where readField and readStruct differ (Object.is, so -0 and NaN count), or null. */
  function firstDiff(buf: ArrayBuffer, s: StructLayout, n: number): string | null {
    const view = new DataView(buf);
    const rows = Array.from({ length: n }, (_, i) => readStruct(view, s, i));
    for (const f of s.fields) {
      const got = readField(buf, s, f.name, n, new Float64Array(n * f.components));
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < f.components; k++) {
          const want = rows[i]![f.name]![k]!, g = got[i * f.components + k]!;
          if (!Object.is(g, want)) return `${s.name}.${f.name} element ${i} component ${k}: ${g} vs ${want}`;
        }
      }
    }
    return null;
  }

  it.for(structs.map((s) => [s.name, s] as const))('equals readStruct for every field of %s on random words', ([, s]) => {
    const word = fc.oneof(fc.integer({ min: 0, max: 0xffffffff }), fc.constantFrom(...SPECIAL));
    const words = (7 * s.size) / 4;
    fc.assert(
      fc.property(fc.constantFrom(0, 1, 7), fc.array(word, { minLength: words, maxLength: words }), (n, ws) => {
        // Exactly n elements: no slack after the last one.
        expect(firstDiff(Uint32Array.from(ws).buffer.slice(0, n * s.size), s, n)).toBeNull();
      }),
    );
  });

  it.for(structs.map((s) => [s.name, s] as const))('equals readStruct for every field of %s with every special pattern in every word', ([, s]) => {
    const words = (7 * s.size) / 4;
    for (let r = 0; r < SPECIAL.length; r++) {
      const buf = Uint32Array.from({ length: words }, (_, j) => SPECIAL[(j + r) % SPECIAL.length]!).buffer;
      expect(firstDiff(buf, s, 7)).toBeNull();
    }
  });

  it('packs components, leaves the rest of out alone and returns it', () => {
    const view = new DataView(new ArrayBuffer(Body.size * 3));
    for (let i = 0; i < 3; i++) writeStruct(view, Body, i, { rot: [i, -i, 0.5 + i, -0], flags: 0x100 | i });
    const out = new Float64Array(14).fill(9);
    expect(readField(view.buffer, Body, 'rot', 3, out)).toBe(out);
    expect([...out]).toEqual([0, -0, 0.5, -0, 1, -1, 1.5, -0, 2, -2, 2.5, -0, 9, 9]);
    expect(Object.is(out[1], -0)).toBe(true);
    expect([...readField(view.buffer, Body, 'flags', 3, new Uint32Array(3))]).toEqual([0x100, 0x101, 0x102]);
  });

  it('rejects an unknown field, a bad count, a short buffer and a short output', () => {
    const buf = new ArrayBuffer(Body.size * 2);
    expect(() => readField(buf, Body, 'nope', 1, new Float64Array(3))).toThrow(/no field nope/);
    expect(() => readField(buf, Body, 'pos', -1, new Float64Array(3))).toThrow(/bad count/);
    expect(() => readField(buf, Body, 'pos', 1.5, new Float64Array(6))).toThrow(/bad count/);
    expect(() => readField(buf, Body, 'pos', 3, new Float64Array(9))).toThrow(/need 192 bytes, the buffer has 128/);
    expect(() => readField(buf, Body, 'pos', 2, new Float64Array(5))).toThrow(/6 values do not fit an output of length 5/);
    expect(readField(buf, Body, 'pos', 0, new Float64Array(0))).toHaveLength(0);
  });
});

describe('generated WGSL', () => {
  it('is up to date with structs.ts (run `pnpm codegen`)', () => {
    const path = fileURLToPath(new URL('../generated/structs.wgsl', import.meta.url));
    expect(readFileSync(path, 'utf8')).toBe(wgslModule(ALL_STRUCTS));
  });
});
