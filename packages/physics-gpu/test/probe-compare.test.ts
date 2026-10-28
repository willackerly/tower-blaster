// probe-compare.ts on made-up P2 results and bench:browser records: a base and a variant side by side, rule P's checks
// listed, nothing judged.
import { DEFAULT_AVBD } from '@tb/physics-ref';
import { describe, expect, it } from 'vitest';
import { compareBrowser, compareMarkdown, compareP2 } from '../src/probe-compare.ts';
import type { Checkpoint, P2Result } from '../src/probe.ts';

const stat = (ms: number) => ({ median: ms, p10: ms, p90: ms, samples: 15 });
// Step 60 of the cb697a2 M5 probe (Addendum 5): eight direct colours at W 56, the tail at W_crit 112; times in ms.
const T = [48.5, 48.4, 48.1, 48.1, 47.3, 45.9, 40.2, 36.2];
const checkpoint = (step: number, o: { perPoint?: number; tail?: number; solve: number; dual?: number }): Checkpoint => {
  const e = 0.001294;
  return {
    step, n: 10000, coloursUsed: 10, uncolored: 0, pairSlots: 105022, pairsRequired: 105022, contactPairs: 98000, colorTail: 8, tailThreads: 256,
    direct: T.map((t, colour) => ({ colour, bodies: 1000, W: 56, R: 14, points: 60000, loads: 57, t: stat(e + (t / 1000 - e) * (o.perPoint ?? 1)) })),
    tail: { colours: 2, bodies: 44, serialBodies: 0, Wcrit: 112, Rcrit: 28, points: 2428, t: stat(0.0653 * (o.tail ?? 1)) },
    dual: stat(o.dual ?? 0.122), emptyColour: 10, emptyDispatch: stat(e), solvePass: stat(o.solve), sumW: 560, sumR: 140, totalPoints: 475910, check: null,
  };
};
// What bench:probe records of each arm: the default engine (no spec), and a variant (records 2, as an example).
const ARMS = {
  off: {},
  on: { engine: 'avbd-gpu:records=2', variant: { records: 2 } },
} as const;
const p2 = (iterations: number, cps: Checkpoint[], arm: keyof typeof ARMS = 'on'): P2Result => ({
  scenario: 'S4', params: { N: 10000 }, gravityScale: 1, boxBroadphase: false, N: 10000, seed: 1, iterations, R: 50, checkpoints: cps, hessian: 'registers', ...ARMS[arm], fits: [], perPointNs: null, verdict: [],
});
const OFF = p2(10, [checkpoint(60, { solve: 7.53 }), checkpoint(300, { solve: 7.41 })], 'off');

describe('probe-compare: P2, a variant against the base', () => {
  it('reports the ratios, the solve pass and the dual; a 3% per-point rise holds rule P', () => {
    const on = p2(10, [checkpoint(60, { perPoint: 1.03, tail: 1.03, solve: 6.53 }), checkpoint(300, { perPoint: 1.03, solve: 6.41 })]);
    const c = compareP2(OFF, on);
    expect(c.note).toBeNull();
    expect([c.offEngine, c.onEngine]).toEqual(['avbd-gpu (default)', 'avbd-gpu:records=2']);
    expect(c.checkpoints).toHaveLength(2);
    expect(c.checkpoints[0]!.medianRatio).toBeCloseTo(1.03, 9);
    expect(c.checkpoints[0]!.tail!.ratio).toBeCloseTo(1.03, 9);
    expect(c.checkpoints[0]!.solvePass!.savingMs).toBeCloseTo(1.0, 9);
    expect(c.checkpoints[0]!.structure.same).toBe(true);
    expect(c.checkpoints.map((k) => k.fails)).toEqual([[], []]);
    const md = compareMarkdown([c], []);
    expect(md).toContain('## P2 at I = 10: avbd-gpu:records=2 against avbd-gpu (default)');
    expect(md).toContain('saving **1000 µs** (off − on)');
    expect(md).toContain('Rule P holds at every checkpoint.');
    expect(md).not.toMatch(/KILL|Pass|judged/);
  });
  it('lists a 6% per-point rise in the direct colours, or in the tail, as a rule P miss, even with the solve faster', () => {
    const direct = compareP2(OFF, p2(10, [checkpoint(60, { perPoint: 1.06, solve: 6.5 }), checkpoint(300, { solve: 6.4 })]));
    expect(direct.checkpoints.map((k) => k.fails)).toEqual([[expect.stringMatching(/^step 60: per-point cost rose 6\.0% \(median over 8 direct colours; limit 5%\)$/)], []]);
    expect(compareMarkdown([direct], [])).toMatch(/Rule P misses: step 60: per-point cost rose 6\.0%/);
    const tail = compareP2(OFF, p2(10, [checkpoint(60, { tail: 1.06, solve: 6.5 }), checkpoint(300, { solve: 6.4 })]));
    expect(tail.checkpoints[0]!.fails).toEqual([expect.stringMatching(/step 60: the tail's cost per critical-path point rose 6\.0%/)]);
  });
  it('one slow colour does not miss rule P (the median), five do', () => {
    const one = checkpoint(60, { solve: 6.5 });
    one.direct[7]!.t = stat(one.direct[7]!.t!.median * 1.2);
    expect(compareP2(OFF, p2(10, [one, checkpoint(300, { solve: 6.4 })])).checkpoints[0]!.fails).toEqual([]);
    const five = checkpoint(60, { solve: 6.5 });
    for (const k of [0, 1, 2, 3, 4]) five.direct[k]!.t = stat(five.direct[k]!.t!.median * 1.2);
    expect(compareP2(OFF, p2(10, [five, checkpoint(300, { solve: 6.4 })])).checkpoints[0]!.fails).toHaveLength(1);
  });
  it('a slower solve pass is reported, not a miss (the I x 60 µs bar was the fused dual\'s)', () => {
    const c = compareP2(OFF, p2(10, [checkpoint(60, { solve: 7.9 }), checkpoint(300, { solve: 7.6 })]));
    expect(c.checkpoints[0]!.solvePass!.savingMs).toBeCloseTo(-0.37, 9);
    expect(c.checkpoints.map((k) => k.fails)).toEqual([[], []]);
    expect(compareMarkdown([c], [])).toContain('saving **-370 µs**');
  });
  it('reports one sweep\'s colour time, the direct colours and with the tail (the colorMode and records lines)', () => {
    // A city in 4 colours against 8 (made up: the first four of the default's times), as colorMode 3 would colour it.
    const four = checkpoint(60, { solve: 4.2 });
    four.direct = four.direct.slice(0, 4);
    const c = compareP2(OFF, { ...p2(10, [four], 'off'), engine: 'avbd-gpu:colorMode=3', variant: { colorMode: 3 } });
    expect(c.note).toBeNull();
    const s = c.checkpoints[0]!.sweep!;
    expect([s.direct.off, s.direct.on, s.withTail.off, s.withTail.on]).toEqual([0.3627, 0.1931, 0.428, 0.2584].map((x) => expect.closeTo(x, 9)));
    expect(s.direct.ratio).toBeCloseTo(193.1 / 362.7, 9);
    expect(compareMarkdown([c], [])).toContain('One sweep: direct colours 363 → 193 µs (**0.532x**), with the tail 428 → 258 µs (**0.604x**).');
    // Not reported when a colour was not timed.
    four.direct[0]!.t = null;
    expect(compareP2(OFF, p2(10, [four])).checkpoints[0]!.sweep).toBeNull();
  });
  it('notes points (records 0) against the default (records 1 on the GPU): two contact layouts', () => {
    const pts = { engine: 'avbd-gpu:records=0', variant: { records: 0 } };
    const note = 'the base and the variant solve different contact layouts (records 0 against the default, records 1)';
    expect(compareP2(OFF, { ...p2(10, OFF.checkpoints), ...pts }).note).toBe(note);
    expect(compareP2({ ...OFF, ...pts }, p2(10, OFF.checkpoints, 'off')).note).toBe(note);
    expect(compareMarkdown([compareP2(OFF, { ...p2(10, OFF.checkpoints), ...pts })], [])).toContain(`Note: ${note}. Rule P holds`);
    // records 0 on both sides, or records 2 against the default, is one layout against itself or an option under test.
    expect(compareP2({ ...OFF, ...pts }, { ...p2(10, OFF.checkpoints), engine: 'avbd-gpu:records=0,colorMode=3', variant: { records: 0, colorMode: 3 } }).note).toBeNull();
    expect(compareP2(OFF, p2(10, OFF.checkpoints)).note).toBeNull();
  });
  it('refuses runs at different I or of different scenes, and flags a structure that differs', () => {
    expect(() => compareP2(OFF, p2(20, OFF.checkpoints))).toThrow(/same I/);
    expect(() => compareP2(OFF, { ...OFF, N: 5000 })).toThrow(/different scenes/);
    const other = checkpoint(60, { solve: 6.5 });
    other.sumW = 600;
    const c = compareP2(OFF, p2(10, [other]));
    expect(c.checkpoints[0]!.structure.same).toBe(false);
    expect(compareMarkdown([c], [])).toContain('structure differs');
    // A checkpoint with no direct colour timed in both runs says so.
    const none = checkpoint(60, { solve: 6.5 });
    none.direct = [];
    expect(compareP2(OFF, p2(10, [none])).checkpoints[0]!.fails).toEqual(['step 60: no direct colour timed in both runs']);
  });
});

describe('probe-compare: bench:browser A/B records', () => {
  /** A record of 6 blocks of 30 steps after `warmup` steps (60: steps 60-240), as bench:browser writes it; warmup null: an older record without it. */
  const rec = (scene: string, base: Record<string, unknown>, arm: Record<string, unknown>, baseMs: number, armMs: number, warmup: number | null = 60, blocks = 6) => ({
    kind: 'compare', scene: { id: scene, params: { N: 10000 } }, timingValid: true, ...(warmup === null ? {} : { warmup }),
    engines: [{ name: 'avbd-gpu', variant: base }, { name: 'avbd-gpu', variant: arm }],
    timing: [{ blocks, stepsPerBlock: 30, blockMedians: [baseMs, baseMs + 0.1, baseMs - 0.1] }, { blocks, stepsPerBlock: 30, blockMedians: [armMs, armMs + 0.1, armMs - 0.1] }],
  });
  it('the saving in ms and in percent of the base\'s step, and each engine\'s block spread', () => {
    const r = compareBrowser(rec('S4', {}, { records: 2 }, 8.5, 7.8));
    expect(r).toMatchObject({ iterations: 10, steps: 180, window: [60, 240], valid: true, note: null });
    expect(r.savingMs).toBeCloseTo(0.7, 9);
    expect(compareBrowser(rec('S4', {}, { records: 2 }, 8.5, 8.0, 300)).window).toEqual([300, 480]);
    expect(compareBrowser(rec('S4', { iterations: 20 }, { iterations: 20, records: 2 }, 14, 12.9))).toMatchObject({ iterations: 20 });
    // 0.7 of 8.5 ms; then each engine's block spread, 0.2 ms over the blocks of 8.5 and of 7.8 ms; no note.
    expect(compareMarkdown([], [r])).toContain('| **0.700** | 8.2 | 2.4 / 2.6 |  |');
    expect(compareMarkdown([], [r])).not.toMatch(/Kill|KILL|Verdict/);
    // Steps 0-150, and a record that does not say which steps it timed, are reported as they are.
    expect(compareBrowser(rec('S4', {}, { records: 2 }, 18.0, 17.5, 0, 5))).toMatchObject({ window: [0, 150], steps: 150, note: null });
    expect(compareBrowser(rec('S4', {}, { records: 2 }, 8.5, 8.0, null))).toMatchObject({ window: null, steps: 180 });
    expect(() => compareBrowser(rec('S4', { iterations: 20 }, { records: 2 }, 8, 7))).toThrow(/iterations/);
  });
  it('notes points on one side only (unset is records 1 on the GPU): two contact layouts', () => {
    for (const [base, arm] of [[{ records: 0 }, {}], [{}, { records: 0, colorMode: 3 }]]) {
      expect(compareBrowser(rec('S4', base!, arm!, 8.5, 7.8)).note).toMatch(/^the base and the variant solve different contact layouts/);
    }
    expect(compareBrowser(rec('S4', { records: 0 }, { records: 0, colorMode: 3 }, 8.5, 7.8)).note).toBeNull();
    expect(compareMarkdown([], [compareBrowser(rec('S4', { records: 0 }, {}, 8.5, 7.8))])).toContain('| the base and the variant solve different contact layouts');
  });
  it('notes colorMode 0 on one side only (unset is colorMode 3 on the GPU): two colourings', () => {
    for (const [base, arm] of [[{ colorMode: 0 }, {}], [{}, { colorMode: 0, records: 2 }]]) {
      expect(compareBrowser(rec('S4', base!, arm!, 8.5, 7.8)).note).toBe('the base and the variant colour differently (colorMode 0 against the default, colorMode 3)');
    }
    expect(compareBrowser(rec('S4', { colorMode: 0 }, { colorMode: 0, records: 2 }, 8.5, 7.8)).note).toBeNull();
    expect(compareBrowser(rec('S4', {}, { colorMode: 3 }, 8.5, 7.8)).note).toBeNull();
  });
  it('names each engine by what differs from the defaults, and gives the median saving of a cell timed more than once', () => {
    // Variants as GpuAvbdEngine reports them: every AvbdParams entry, the opt-in switches only while on.
    const gpu = (o: Record<string, unknown>) => ({ ...DEFAULT_AVBD, iterations: 20, ...o });
    const runs = [23, 21, 22].map((pct) => rec('S4', gpu({}), gpu({ records: 1 }), 14, 14 * (1 - pct / 100)));
    const rows = runs.map((r) => compareBrowser(r));
    expect(rows[0]!.engines).toEqual(['avbd-gpu:iterations=20', 'avbd-gpu:iterations=20,records=1']);
    expect(compareBrowser(rec('S4', gpu({}), gpu({ records: 2, colorMode: 3 }), 14, 13)).engines[1]).toBe('avbd-gpu:iterations=20,records=2,colorMode=3');
    // The records rule reads the median of the three runs per window.
    const md = compareMarkdown([], [...rows, compareBrowser(rec('S4', gpu({}), gpu({ records: 1 }), 14, 11, 300))]);
    expect(md).toContain('| S4 {"N":10000} | avbd-gpu:iterations=20 | avbd-gpu:iterations=20,records=1 | 60-240 | 3 | 23.0, 21.0, 22.0 | **22.0** |');
    // A cell timed once has no line there, and nor does a record whose timing is not valid.
    expect(md).not.toMatch(/\| 300-480 \| \d+ \|/);
    const invalid = { ...runs[0]!, timingValid: false };
    expect(compareMarkdown([], [compareBrowser(invalid), rows[1]!])).not.toContain('Cells timed more than once');
  });
  it('notes a record whose timing is not valid (code review 1, item 5)', () => {
    const problems = ['page is not cross-origin isolated (timer clamped to 100 µs)'];
    const r = compareBrowser({ ...rec('S4', {}, { records: 2 }, 8.5, 8.4), timingValid: false, timingProblems: problems });
    expect(r).toMatchObject({ valid: false, note: `the timing is not valid here (${problems[0]})` });
    expect(compareMarkdown([], [r])).toContain(`| the timing is not valid here (${problems[0]}) |`);
  });
  it('notes a record whose engine hit a limit that changed its physics, and leaves it out of the repeated cells', () => {
    const hit = ['engine 0 (avbd-gpu): contacts dropped on 5 of 240 steps'];
    const r = compareBrowser({ ...rec('S15', {}, { boxBroadphase: true }, 9, 6), limitProblems: hit });
    expect(r).toMatchObject({ valid: false, note: `an engine hit a limit that changed its physics, so the arms time different simulations (${hit[0]})` });
    expect(compareMarkdown([], [r])).toContain(`| an engine hit a limit that changed its physics, so the arms time different simulations (${hit[0]}) |`);
    // Invalid timing is named first; a record with no limit hit (or from before limits were recorded) stays valid.
    expect(compareBrowser({ ...rec('S15', {}, {}, 9, 6), limitProblems: hit, timingValid: false }).note).toMatch(/^the timing is not valid here/);
    expect(compareBrowser({ ...rec('S15', {}, {}, 9, 6), limitProblems: [] })).toMatchObject({ valid: true, note: null });
    const ok = compareBrowser(rec('S15', {}, {}, 9, 6));
    expect(compareMarkdown([], [r, r, ok])).not.toContain('Cells timed more than once');
  });
});
