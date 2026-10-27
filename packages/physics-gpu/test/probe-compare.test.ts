// The fused dual's kill rules (probe-compare.ts) on made-up P2 results and bench:browser records.
import { describe, expect, it } from 'vitest';
import { compareBrowser, compareMarkdown, compareP2, JUDGED_WINDOWS, killMs } from '../src/probe-compare.ts';
import type { Checkpoint, P2Result } from '../src/probe.ts';

const stat = (ms: number) => ({ median: ms, p10: ms, p90: ms, samples: 15 });
// Step 60 of the cb697a2 M5 probe (Addendum 5): eight direct colours at W 56, the tail at W_crit 112; times in ms.
const T = [48.5, 48.4, 48.1, 48.1, 47.3, 45.9, 40.2, 36.2];
const checkpoint = (step: number, o: { perPoint?: number; tail?: number; solve: number; dual?: number }): Checkpoint => {
  const e = 0.001294;
  return {
    step, n: 10000, coloursUsed: 10, uncolored: 0, pairSlots: 105022, pairsRequired: 105022, contactPairs: 98000, colorTail: 8, tailThreads: 256,
    direct: T.map((t, colour) => ({ colour, bodies: 1000, W: 56, points: 60000, loads: 57, t: stat(e + (t / 1000 - e) * (o.perPoint ?? 1)) })),
    tail: { colours: 2, bodies: 44, serialBodies: 0, Wcrit: 112, points: 2428, t: stat(0.0653 * (o.tail ?? 1)) },
    dual: stat(o.dual ?? 0.122), emptyColour: 10, emptyDispatch: stat(e), solvePass: stat(o.solve), sumW: 560, totalPoints: 475910, check: null,
  };
};
// What bench:probe records of each arm: the default engine (no spec), the fused dual in its side array, and in place.
const ARMS = {
  off: {},
  side: { engine: 'avbd-gpu:dualFusion=true', dualPasses: 1, dualFusion: true, solveContactsRW: false },
  inPlace: { engine: 'avbd-gpu:dualFusion=true,solveContactsRW=true', dualPasses: 1, dualFusion: true, solveContactsRW: true },
} as const;
const p2 = (iterations: number, cps: Checkpoint[], arm: keyof typeof ARMS = 'side'): P2Result => ({
  scenario: 'S4', params: { N: 10000 }, gravityScale: 1, boxBroadphase: false, N: 10000, seed: 1, iterations, R: 50, checkpoints: cps, hessian: 'registers', ...ARMS[arm], fits: [], perPointNs: null, verdict: [],
});
const OFF = p2(10, [checkpoint(60, { solve: 7.53 }), checkpoint(300, { solve: 7.41 })], 'off');

describe('probe-compare: P2, fused against off', () => {
  it('passes a 3% per-point rise with a 1 ms faster solve at I = 10, and reports the ratios', () => {
    const on = p2(10, [checkpoint(60, { perPoint: 1.03, tail: 1.03, solve: 6.53 }), checkpoint(300, { perPoint: 1.03, solve: 6.41 })]);
    const c = compareP2(OFF, on);
    expect(c.kill).toEqual([]);
    expect(c.reported).toBeNull();
    expect(c.killMs).toBeCloseTo(0.6, 12);
    expect(c.checkpoints).toHaveLength(2);
    expect(c.checkpoints[0]!.medianRatio).toBeCloseTo(1.03, 9);
    expect(c.checkpoints[0]!.tail!.ratio).toBeCloseTo(1.03, 9);
    expect(c.checkpoints[0]!.solvePass!.savingMs).toBeCloseTo(1.0, 9);
    expect(c.checkpoints[0]!.structure.same).toBe(true);
    expect(compareMarkdown([c], [])).toContain('**Pass**');
  });
  it('kills a 6% per-point rise in the direct colours, or in the tail, even with the solve faster', () => {
    const direct = compareP2(OFF, p2(10, [checkpoint(60, { perPoint: 1.06, solve: 6.5 }), checkpoint(300, { solve: 6.4 })]));
    expect(direct.kill).toHaveLength(1);
    expect(direct.kill[0]).toMatch(/step 60: per-point cost rose 6\.0%/);
    const tail = compareP2(OFF, p2(10, [checkpoint(60, { tail: 1.06, solve: 6.5 }), checkpoint(300, { solve: 6.4 })]));
    expect(tail.kill).toEqual([expect.stringMatching(/step 60: the tail's cost per critical-path point rose 6\.0%/)]);
  });
  it('one slow colour does not kill (the median), five do', () => {
    const one = checkpoint(60, { solve: 6.5 });
    one.direct[7]!.t = stat(one.direct[7]!.t!.median * 1.2);
    expect(compareP2(OFF, p2(10, [one, checkpoint(300, { solve: 6.4 })])).kill).toEqual([]);
    const five = checkpoint(60, { solve: 6.5 });
    for (const k of [0, 1, 2, 3, 4]) five.direct[k]!.t = stat(five.direct[k]!.t!.median * 1.2);
    expect(compareP2(OFF, p2(10, [five, checkpoint(300, { solve: 6.4 })])).kill).toHaveLength(1);
  });
  it('kills a solve pass that falls by less than I x 60 µs: 0.6 ms at I = 10, 1.2 ms at I = 20', () => {
    expect(killMs(10)).toBeCloseTo(0.6, 12);
    expect(killMs(20)).toBeCloseTo(1.2, 12);
    const c = compareP2(OFF, p2(10, [checkpoint(60, { solve: 6.98 }), checkpoint(300, { solve: 6.81 })]));
    expect(c.kill).toEqual([expect.stringMatching(/step 60: the solve pass fell 550 µs, below I x 60 µs = 600 µs/)]);
    const off20 = p2(20, [checkpoint(60, { solve: 13.0 })], 'off');
    expect(compareP2(off20, p2(20, [checkpoint(60, { solve: 11.85 })])).kill).toHaveLength(1);
    expect(compareP2(off20, p2(20, [checkpoint(60, { solve: 11.75 })])).kill).toEqual([]);
  });
  it('refuses runs at different I, of different scenes or in the wrong order, and flags a structure that differs', () => {
    expect(() => compareP2(OFF, p2(20, OFF.checkpoints))).toThrow(/same I/);
    expect(() => compareP2(OFF, { ...OFF, N: 5000 })).toThrow(/different scenes/);
    // Fused first would flip the saving's sign.
    expect(() => compareP2(p2(10, OFF.checkpoints), OFF)).toThrow(/give the unfused run first/);
    const other = checkpoint(60, { solve: 6.5 });
    other.sumW = 600;
    const c = compareP2(OFF, p2(10, [other]));
    expect(c.checkpoints[0]!.structure.same).toBe(false);
    expect(compareMarkdown([c], [])).toContain('structure differs');
  });
});

describe('probe-compare: only the side-array arm, in the judged windows, can kill', () => {
  // A P2 pair that fails every rule at both checkpoints: per point +10%, the solve pass 0.1 ms faster.
  const failing = (arm: keyof typeof ARMS, steps = [60, 300]) => p2(10, steps.map((step) => checkpoint(step, { perPoint: 1.1, tail: 1.1, solve: 7.4 })), arm);
  it('P2: the in-place arm is reported with the rules it fails, never a kill', () => {
    const c = compareP2(OFF, failing('inPlace'));
    expect(c.reported).toMatch(/in-place arm/);
    expect(c.kill).toEqual([]);
    expect(c.checkpoints.map((k) => k.fails.length)).toEqual([3, 3]);
    expect(compareMarkdown([c], [])).toMatch(/\*\*Reported, not judged\*\* \(the in-place arm .*\); the rules would fail on: step 60: per-point cost rose 10\.0%/);
    // The side-array arm with the same numbers is killed.
    expect(compareP2(OFF, failing('side')).kill).toHaveLength(6);
    // The binding-only A/B (solveContactsRW without dualFusion) is reported too.
    const binding = compareP2(OFF, { ...failing('off'), engine: 'avbd-gpu:solveContactsRW=true', solveContactsRW: true });
    expect([binding.reported, binding.kill]).toEqual([expect.stringMatching(/binding-only/), []]);
  });
  it('P2: a checkpoint outside steps 60-240 and 300-480 is reported, not judged', () => {
    expect(JUDGED_WINDOWS).toEqual([[60, 240], [300, 480]]);
    const off = p2(10, [checkpoint(30, { solve: 7.5 }), checkpoint(60, { solve: 7.53 })], 'off');
    const c = compareP2(off, p2(10, [checkpoint(30, { perPoint: 1.1, solve: 7.4 }), checkpoint(60, { solve: 6.5 })]));
    expect(c.checkpoints.map((k) => [k.step, k.judged, k.fails.length])).toEqual([[30, false, 2], [60, true, 0]]);
    expect(c.kill).toEqual([]);
    expect(compareMarkdown([c], [])).toContain('Outside the judged windows: reported only.');
    // With no judged checkpoint there is nothing to pass.
    expect(compareP2(p2(10, [checkpoint(30, { solve: 7.5 })], 'off'), p2(10, [checkpoint(30, { solve: 6.5 })])).kill).toEqual(['no checkpoint of a judged window in both runs']);
  });
});

describe('probe-compare: bench:browser A/B records', () => {
  /** A record of 6 blocks of 30 steps after `warmup` steps (60: steps 60-240), as bench:browser writes it; warmup null: an older record without it. */
  const rec = (scene: string, base: Record<string, unknown>, arm: Record<string, unknown>, baseMs: number, armMs: number, warmup: number | null = 60, blocks = 6) => ({
    kind: 'compare', scene: { id: scene, params: { N: 10000 } }, timingValid: true, ...(warmup === null ? {} : { warmup }),
    engines: [{ name: 'avbd-gpu', variant: base }, { name: 'avbd-gpu', variant: arm }],
    timing: [{ blocks, stepsPerBlock: 30, blockMedians: [baseMs, baseMs + 0.1, baseMs - 0.1] }, { blocks, stepsPerBlock: 30, blockMedians: [armMs, armMs + 0.1, armMs - 0.1] }],
  });
  it('S4 with the variant fused: kill below I x 60 µs, I x 90 µs reported', () => {
    const pass = compareBrowser(rec('S4', {}, { dualFusion: true }, 8.5, 7.8));
    expect(pass).toMatchObject({ iterations: 10, governs: true, reported: null, kill: false, steps: 180, window: [60, 240] });
    expect(compareBrowser(rec('S4', {}, { dualFusion: true }, 8.5, 8.0, 300))).toMatchObject({ governs: true, kill: true, window: [300, 480] });
    expect(pass.savingMs).toBeCloseTo(0.7, 9);
    expect(pass.stretchMs).toBeCloseTo(0.9, 12);
    expect(compareBrowser(rec('S4', {}, { dualFusion: true }, 8.5, 8.0)).kill).toBe(true);
    const i20 = compareBrowser(rec('S4', { iterations: 20 }, { iterations: 20, dualFusion: true }, 14, 12.9));
    expect(i20).toMatchObject({ iterations: 20, kill: true });
    expect(i20.killMs).toBeCloseTo(1.2, 12);
    expect(compareMarkdown([], [pass])).toMatch(/\| pass \|/);
  });
  it('reports, but does not judge, other scenes and the binding-only A/B', () => {
    expect(compareBrowser(rec('S5', {}, { dualFusion: true }, 11, 11))).toMatchObject({ governs: false, kill: false });
    expect(compareBrowser(rec('S4', {}, { solveContactsRW: true }, 8.5, 8.5))).toMatchObject({ governs: false, kill: false });
    expect(() => compareBrowser(rec('S4', { iterations: 20 }, { dualFusion: true }, 8, 7))).toThrow(/iterations/);
  });
  it('reports, but does not judge, the in-place arm (review B1, first repro: 8.5 -> 8.0 ms killed it)', () => {
    const r = compareBrowser(rec('S4', { iterations: 10 }, { iterations: 10, dualFusion: true, solveContactsRW: true }, 8.5, 8.0));
    expect(r).toMatchObject({ governs: false, kill: false, window: [60, 240] });
    expect(r.reported).toMatch(/in-place arm/);
    expect(compareMarkdown([], [r])).toMatch(/\| reported \(the in-place arm/);
  });
  it('reports, but does not judge, steps 0-150 (review B1, second repro: 5 blocks from step 0, 18.0 -> 17.5 ms killed it)', () => {
    const r = compareBrowser(rec('S4', {}, { dualFusion: true }, 18.0, 17.5, 0, 5));
    expect(r).toMatchObject({ governs: false, kill: false, window: [0, 150], steps: 150 });
    expect(r.reported).toMatch(/steps 0-150: the rule judges steps 60-240 and 300-480 only/);
    // Nor a record that does not say which steps it timed.
    expect(compareBrowser(rec('S4', {}, { dualFusion: true }, 8.5, 8.0, null))).toMatchObject({ governs: false, kill: false, window: null, reported: expect.stringMatching(/no warmup/) });
  });
  it('reports, but does not judge, a record whose timing is not valid (code review 1, item 5)', () => {
    const problems = ['page is not cross-origin isolated (timer clamped to 100 µs)'];
    const r = compareBrowser({ ...rec('S4', {}, { dualFusion: true }, 8.5, 8.4), timingValid: false, timingProblems: problems });
    expect(r).toMatchObject({ governs: false, kill: false, valid: false, reported: `the timing is not valid here (${problems[0]})` });
    // With valid timing the same numbers kill.
    expect(compareBrowser(rec('S4', {}, { dualFusion: true }, 8.5, 8.4)).kill).toBe(true);
    expect(compareMarkdown([], [r])).toContain(`| reported (the timing is not valid here (${problems[0]})) |`);
  });
});
