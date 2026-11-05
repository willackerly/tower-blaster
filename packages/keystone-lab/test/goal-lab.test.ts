// proveSheet (goal-lab.ts): goals that share a proof line share its play, nudges are per goal, and a
// goal without a proof is reported unproven and never played. On the reference, L5 (its plays are short).
import { describe, expect, it } from 'vitest';
import { L5, type LotSheet } from '@tb/keystone';
import { makeRunner, marginOk, proveSheet, type Runner } from '@tb/keystone-lab';

describe('proveSheet', () => {
  it('plays a shared proof line once, each goal its own nudges, and skips unproven goals', async () => {
    const inner = makeRunner({ kind: 'ref' }, 2);
    let plays = 0;
    const runner: Runner = { spec: inner.spec, jobs: inner.jobs, play: (l, s) => { plays++; return inner.play(l, s); }, close: () => inner.close() };
    const line = 'marble.166.8.269.414.77';
    const sheet: LotSheet = {
      level: 'L5', engine: 'ref',
      goals: [
        { id: 'take', text: 'Take the crown', when: { fact: 'cleared', op: '==', value: 1 }, proof: line },
        { id: 'one', text: 'In one shot', when: { fact: 'shots', op: '==', value: 1 }, proof: line },
        { id: 'never', text: 'Not proven', when: { fact: 'crowns', op: '>=', value: 1 } },
      ],
    };
    try {
      const proofs = await proveSheet(L5, sheet, runner, 1);
      expect(plays).toBe(1 + 2);
      expect(proofs.map((p) => [p.id, p.proven, p.met, p.nudged])).toEqual([['take', true, true, 1], ['one', true, true, 1], ['never', false, false, 0]]);
      expect(marginOk({ id: 'x', proven: true, met: true, nudged: 8, nudgedMet: 6 })).toBe(true);
      expect(marginOk({ id: 'x', proven: true, met: true, nudged: 8, nudgedMet: 5 })).toBe(false);
      expect(marginOk({ id: 'x', proven: true, met: false, nudged: 8, nudgedMet: 8 })).toBe(false);
    } finally {
      await runner.close();
    }
  }, 300_000);
});
