// The GPU engine's floats pinned: a ball into two towers (S5) on the default
// and on every remaining option that changes the solver's or the broadphase's
// shaders or the order of their arithmetic, each run's final bodies and whole contact buffer
// against digests captured on SwiftShader before the fused dual was removed
// (at 8a9a308, PR #79: records 1 the default). The removal must not change a
// float: the other bit-for-bit tests compare layouts and dispatch splits with
// each other, this one compares each against the build before it. Since
// colorMode 3 became the GPU default (gpuColorMode) the default is pinned to
// colorMode 3's digests, the cases about the hash colouring name colorMode 0,
// and unset is checked against an explicit colorMode 3 on every contact
// layout and with the slop. The pair buffer cases (pairsPerBody 2, which
// drops pairs every step, and the box test; colorMode 0) were captured at dd7727f, before the broadphase's sticky overflow
// counters: they pin today's truncation too, so a deliberate change of what
// an overflowing step drops re-pins them.
import { describe, expect, it } from 'vitest';
import type { AvbdParams } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import type { GpuEngineOptions } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, gpu } from './harness.ts';

/** FNV-1a over the f32 bits of the final bodies' pos, rot, linVel and angVel. */
const digest = (s: Drivers.PlainSnapshot) => {
  let h = 0x811c9dc5;
  for (const w of new Uint32Array(Float32Array.from([...s.pos, ...s.rot, ...s.linVel, ...s.angVel]).buffer)) h = Math.imul(h ^ w, 0x01000193) >>> 0;
  return h;
};
const hex = (x: number) => `0x${x.toString(16).padStart(8, '0')}`;

// A ball into two 2x2x8 towers (it reaches them at about step 17): contacts from the first step, and colours that change.
const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

type Case = { name: string; params?: Partial<AvbdParams>; opts?: Omit<GpuEngineOptions, 'device'>; bodies: string; contacts: string; overflows?: boolean };
const CASES: Case[] = [
  // The default since colorMode 3 became the GPU's (gpuColorMode): colorMode 3's floats, bit for bit, in either dispatch.
  { name: 'default (records 1, colorMode 3)', bodies: '0x8077fb07', contacts: '0xf65833cc' },
  { name: 'colorMode 3', params: { colorMode: 3 }, bodies: '0x8077fb07', contacts: '0xf65833cc' },
  { name: 'default, every colour in the tail', opts: { colorTail: 0 }, bodies: '0x8077fb07', contacts: '0xf65833cc' },
  // The hash colouring alone (the default before): explicit colorMode 0.
  { name: 'colorMode 0 (records 1)', params: { colorMode: 0 }, bodies: '0x121b9efe', contacts: '0x1c7ce49d' },
  { name: 'colorMode 0, records 0 (points)', params: { colorMode: 0, records: 0 }, bodies: '0x121b9efe', contacts: '0x61e66bb3' },
  { name: 'colorMode 0, records 0, array Hessian', params: { colorMode: 0, records: 0 }, opts: { hessian: 'array' }, bodies: '0x121b9efe', contacts: '0x61e66bb3' },
  { name: 'colorMode 0, records 2', params: { colorMode: 0, records: 2 }, bodies: '0x27fa48c1', contacts: '0xacfb43ab' },
  { name: 'colorMode 4, colorPriority 1, records 2', params: { colorMode: 4, colorPriority: 1, records: 2 }, bodies: '0x70875c84', contacts: '0x7da56860' },
  { name: 'colorMode 0, gapSlop 3e-5', params: { colorMode: 0, gapSlop: 3e-5 }, bodies: '0xd7dd78aa', contacts: '0x19f83d1c' },
  { name: 'colorMode 0, gapSlop 3e-5, records 2', params: { colorMode: 0, gapSlop: 3e-5, records: 2 }, bodies: '0x984364f5', contacts: '0xbb83c076' },
  { name: 'colorMode 0, every colour in the tail', params: { colorMode: 0 }, opts: { colorTail: 0 }, bodies: '0x121b9efe', contacts: '0x1c7ce49d' },
  { name: 'colorMode 0, indirect colour dispatches', params: { colorMode: 0 }, opts: { indirectColors: true }, bodies: '0x121b9efe', contacts: '0x1c7ce49d' },
  { name: 'colorMode 0, pair buffer overflow (pairsPerBody 2)', params: { colorMode: 0 }, opts: { pairsPerBody: 2 }, bodies: '0xe85232f1', contacts: '0xb15a8daa', overflows: true },
  { name: 'colorMode 0, box broadphase', params: { colorMode: 0 }, opts: { boxBroadphase: true }, bodies: '0x121b9efe', contacts: '0x7749ac74' },
  { name: 'colorMode 0, box broadphase, pair buffer overflow (pairsPerBody 2)', params: { colorMode: 0 }, opts: { boxBroadphase: true, pairsPerBody: 2 }, bodies: '0xd83d6300', contacts: '0x43aa2cd5', overflows: true },
];

describe('GPU AVBD engine: the floats pinned against earlier builds', () => {
  it.for(CASES)('$name', { timeout: 300_000 }, async (c, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('simulateGpu', knock(), 30, { iterations: 6, ...c.params }, 0, c.opts ?? {}, [], true);
    expect(r.error).toBeNull();
    expect(r.contacts!.used).toBeGreaterThan(10);
    // Pairs dropped on every one of the 30 steps where the case says so, and on none elsewhere (the sticky counters).
    expect(r.final).toMatchObject({ steps: 30, pairsOverflowSteps: c.overflows ? 30 : 0 });
    expect(r.final.pairsRequiredPeak > r.final.maxPairs).toBe(!!c.overflows);
    const got = { bodies: hex(digest(r.snaps.at(-1)!)), contacts: hex(r.contacts!.digest) };
    expect(got).toEqual({ bodies: c.bodies, contacts: c.contacts });
  });
});

describe('GPU AVBD engine: colorMode 3 is the default (gpuColorMode)', () => {
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  it('unset is colorMode 3 bit for bit, and not colorMode 0, with records 1, 0 and 2 and with the slop: every 6th step\'s bodies', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const extra of [{}, { records: 0 }, { records: 2 }, { gapSlop: 3e-5 }] as Array<Partial<AvbdParams>>) {
      const run = async (params: Partial<AvbdParams>) => {
        const r = await call('simulateGpu', knock(), 30, { iterations: 4, ...extra, ...params }, 6, {});
        expect(r.error, JSON.stringify(params)).toBeNull();
        return r.snaps.map(state);
      };
      const unset = await run({});
      expect(unset, JSON.stringify(extra)).toEqual(await run({ colorMode: 3 }));
      expect(unset.at(-1), JSON.stringify(extra)).not.toEqual((await run({ colorMode: 0 })).at(-1));
    }
  });
});
