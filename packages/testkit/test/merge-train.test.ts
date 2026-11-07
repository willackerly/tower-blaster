// The merge train's decisions (merge-train.ts; O6, docs/ci/merge-train.md).
import { describe, expect, it } from 'vitest';
import { afterMergeError, type Candidate, LABEL, landDecision, mergeTitle, type Now, queue, type Tested } from '../src/merge-train.ts';

const pr = (number: number, labelledAt: string | null, more: Partial<Candidate> = {}): Candidate => ({ number, labelledAt, draft: false, sameRepo: true, files: ['packages/game/src/a.ts'], ...more });
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const tested: Tested = { headSha: A, baseSha: B, ci: 'success' };
const now = (more: Partial<Now> = {}): Now => ({ state: 'open', merged: false, labelled: true, headSha: A, baseSha: B, ...more });
const RUN = 'https://github.com/o/r/actions/runs/1';

describe('queue: who goes next', () => {
  it('the PR labelled longest ago first, then the lower number; two labelled the same second land in number order', () => {
    const q = queue([pr(9, '2026-11-07T19:00:05Z'), pr(7, '2026-11-07T19:00:05Z'), pr(3, '2026-11-07T19:01:00Z'), pr(12, '2026-11-07T18:59:00Z')]);
    expect(q.order).toEqual([12, 7, 9, 3]);
    expect(q.refuse).toEqual([]);
  });
  it('a PR whose label time the events do not show goes last', () => {
    expect(queue([pr(2, null), pr(5, '2026-11-07T19:00:00Z')]).order).toEqual([5, 2]);
  });
  it('refuses, with a reason, a fork, a draft and a PR touching .github/workflows; the rest still queue', () => {
    const q = queue([pr(1, null, { sameRepo: false }), pr(2, null, { draft: true }), pr(3, null, { files: ['docs/x.md', '.github/workflows/ci.yml'] }), pr(4, null, { files: ['.github/actions/x.yml'] })]);
    expect(q.order).toEqual([4]);
    expect(q.refuse.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(q.refuse[0]!.reason).toMatch(/fork/);
    expect(q.refuse[1]!.reason).toMatch(/draft/);
    expect(q.refuse[2]!.reason).toMatch(/workflows/);
  });
});

describe('landDecision: after CI', () => {
  it('merges when CI passed and neither the head nor the base moved', () => {
    expect(landDecision(now(), tested, RUN)).toEqual({ kind: 'merge' });
  });
  it('aborts cleanly, with no comment, when the PR was unlabelled, closed or merged during the run', () => {
    expect(landDecision(now({ labelled: false }), tested, RUN).kind).toBe('abort');
    expect(landDecision(now({ state: 'closed' }), tested, RUN).kind).toBe('abort');
    expect(landDecision(now({ state: 'closed', merged: true }), tested, RUN).kind).toBe('abort');
    // Whatever CI said: an unlabelled PR is not commented on.
    for (const ci of ['failure', 'cancelled']) expect(landDecision(now({ labelled: false }), { ...tested, ci }, RUN).kind).toBe('abort');
  });
  it('keeps the label to test again when the base moved (a merge outside the train) or the head moved', () => {
    const base = landDecision(now({ baseSha: C }), tested, RUN), head = landDecision(now({ headSha: D }), tested, RUN);
    expect(base.kind).toBe('retest');
    expect(head.kind).toBe('retest');
    // A failure on a head that has since moved is not the new head's: test that instead of rejecting it.
    expect(landDecision(now({ headSha: D }), { ...tested, ci: 'failure' }, RUN).kind).toBe('retest');
  });
  it('takes the label off, linking the run, when CI failed or the run was cancelled or timed out', () => {
    const failed = landDecision(now(), { ...tested, ci: 'failure' }, RUN), cancelled = landDecision(now(), { ...tested, ci: 'cancelled' }, RUN);
    for (const d of [failed, cancelled]) {
      expect(d.kind).toBe('reject');
      if (d.kind === 'reject') { expect(d.comment).toContain(RUN); expect(d.comment).toContain(LABEL); }
    }
    if (cancelled.kind === 'reject') expect(cancelled.comment).toMatch(/cancelled or timed out/);
    // A failure on a moved base is still a failure of this head: the comment says which base it was.
    const onOld = landDecision(now({ baseSha: C }), { ...tested, ci: 'failure' }, RUN);
    expect(onOld.kind).toBe('reject');
    if (onOld.kind === 'reject') expect(onOld.comment).toContain(B.slice(0, 7));
  });
});

describe('after a refused merge', () => {
  it('409 (the head moved after the read) tests again; any other refusal takes the label off and says why', () => {
    expect(afterMergeError(409, 'Head branch was modified', RUN).kind).toBe('retest');
    const d = afterMergeError(405, 'Pull Request is not mergeable', RUN);
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') expect(d.comment).toContain('405: Pull Request is not mergeable');
  });
  it('titles the merge commit as the history does', () => {
    expect(mergeTitle(295, 'O5: shards under 10 min')).toBe('Merge pull request #295: O5: shards under 10 min');
  });
});
