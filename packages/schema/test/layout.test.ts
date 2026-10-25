import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALL_STRUCTS, Body, defineStruct, field, readStruct, RenderInstance, wgslModule, writeStruct } from '../src/index.ts';

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

describe('generated WGSL', () => {
  it('is up to date with structs.ts (run `pnpm codegen`)', () => {
    const path = fileURLToPath(new URL('../generated/structs.wgsl', import.meta.url));
    expect(readFileSync(path, 'utf8')).toBe(wgslModule(ALL_STRUCTS));
  });
});
