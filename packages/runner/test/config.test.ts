import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseConfig, timingProblems, toQuery, type BrowserEnv, type RunConfig } from '../src/index.ts';

describe('run config in the URL', () => {
  it('parses engines, scenario params and timing', () => {
    const c = parseConfig('?engines=rapier,rapier:iterations=8&scenario=S4&param.N=5000&param.running=true&blocks=4&sleep=false&autorun=1');
    expect(c.engines).toEqual(['rapier', 'rapier:iterations=8']);
    expect(c.scenario).toBe('S4');
    expect(c.params).toEqual({ N: 5000, running: true });
    expect(c.timing.blocks).toBe(4);
    expect(c.timing.warmup).toBe(120);
    expect(c.sleep).toBe(false);
    expect(c.autorun).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => parseConfig('?engines=a,b,c')).toThrow(/one or two/);
    expect(() => parseConfig('?param.N=lots')).toThrow(/number/);
  });

  it('round-trips through toQuery', () => {
    const cfg = fc.record({
      engines: fc.constantFrom(['rapier'], ['rapier', 'rapier:iterations=6']),
      scenario: fc.constantFrom('S1', 'S4', 'S7'),
      params: fc.dictionary(fc.constantFrom('N', 'F', 'H', 'running'), fc.oneof(fc.integer({ min: 1, max: 1e5 }), fc.boolean())),
      seed: fc.integer({ min: 0, max: 1e6 }),
      sleep: fc.constantFrom(null, true, false),
      timing: fc.record({ warmup: fc.nat(500), blockSteps: fc.integer({ min: 1, max: 500 }), blocks: fc.integer({ min: 1, max: 50 }) }),
      qualitySteps: fc.nat(1000),
      autorun: fc.boolean(),
    }) as fc.Arbitrary<RunConfig>;
    fc.assert(fc.property(cfg, (c) => { expect(parseConfig(toQuery(c))).toEqual(c); }));
  });
});

describe('timingProblems', () => {
  const env = (over: Partial<BrowserEnv>): BrowserEnv => ({
    userAgent: 'x', crossOriginIsolated: true, hardwareConcurrency: 8, timerResolutionMs: 0.005,
    gpu: { vendor: 'apple', architecture: 'metal-3', description: '', device: '', features: [], software: false }, ...over,
  });
  it('accepts an isolated page with a hardware adapter', () => {
    expect(timingProblems(env({}), ['webgpu:apple'])).toEqual([]);
  });
  it('flags missing isolation, a coarse timer, and software or missing GPUs for GPU engines only', () => {
    expect(timingProblems(env({ crossOriginIsolated: false, timerResolutionMs: 0.1 }), ['wasm-simd-st'])).toHaveLength(2);
    const sw = env({ gpu: { vendor: 'google', architecture: 'swiftshader', description: '', device: '', features: [], software: true } });
    expect(timingProblems(sw, ['wasm-simd-st'])).toEqual([]);
    expect(timingProblems(sw, ['webgpu:x'])[0]).toMatch(/software/);
    expect(timingProblems(env({ gpu: null }), ['webgpu:x'])[0]).toMatch(/no WebGPU/);
  });
});
