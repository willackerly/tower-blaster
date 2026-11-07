// The merge train's decisions (O6, docs/ci/merge-train.md), pure so they are tested without GitHub. The workflow
// (.github/workflows/merge-train.yml) runs merge-train-cli.ts, which reads GitHub, asks these, and acts.
//
// One run lands at most one PR: pick the PR labelled longest ago, test main at base_sha with its head_sha merged
// in (ci.yml through workflow_call), then land it only if the PR is still open, still labelled, and neither sha
// moved since the test. Every run ends by dispatching the next while labelled PRs remain.

export const LABEL = 'merge-ready';

export interface Candidate {
  number: number;
  /** Still open. The issues listing can lag a merge by a moment, so a PR the last run just landed may still be listed. */
  open: boolean;
  /** When the label was last added (ISO time); null when the events don't say, which sorts last. */
  labelledAt: string | null;
  draft: boolean;
  /** The PR's head lives in this repository (not a fork: the train never runs a fork's code with this token). */
  sameRepo: boolean;
  /** Files the PR changes; a workflow file can't be merged with GITHUB_TOKEN (no `workflows` permission). */
  files: readonly string[];
}

export type Refusal = { number: number; reason: string };

/** The PRs to try in order (labelled longest ago first, then lowest number), and the ones to refuse with why. A PR
 * that is no longer open is skipped without a word. */
export function queue(prs: readonly Candidate[]): { order: number[]; refuse: Refusal[] } {
  const refuse: Refusal[] = [], ok: Candidate[] = [];
  for (const p of prs) {
    if (!p.open) continue;
    else if (!p.sameRepo) refuse.push({ number: p.number, reason: 'its head is on a fork; the train only lands branches of this repository' });
    else if (p.draft) refuse.push({ number: p.number, reason: 'it is a draft; mark it ready for review, then add the label again' });
    else if (p.files.some((f) => f.startsWith('.github/workflows/'))) refuse.push({ number: p.number, reason: 'it changes .github/workflows, which the train\'s GITHUB_TOKEN may not merge (no workflows permission); merge it by hand when its CI is green' });
    else ok.push(p);
  }
  const t = (p: Candidate) => (p.labelledAt === null ? Infinity : Date.parse(p.labelledAt));
  ok.sort((a, b) => t(a) - t(b) || a.number - b.number);
  return { order: ok.map((p) => p.number), refuse };
}

/** The PR and its base as the land step reads them, after CI. */
export interface Now {
  state: 'open' | 'closed';
  merged: boolean;
  labelled: boolean;
  headSha: string;
  baseSha: string;
}

/** What was tested. */
export interface Tested {
  headSha: string;
  baseSha: string;
  /** needs.ci.result: success, failure, cancelled or skipped. */
  ci: string;
}

export type Land =
  | { kind: 'merge' }
  /** Nothing to do for this PR: closed, merged or unlabelled while its run was in flight. */
  | { kind: 'abort'; why: string }
  /** Keep the label and test again on the next run: something moved under the test. */
  | { kind: 'retest'; why: string }
  /** Take the label off and say why on the PR. */
  | { kind: 'reject'; comment: string };

export function landDecision(now: Now, tested: Tested, runUrl: string): Land {
  if (now.merged) return { kind: 'abort', why: 'already merged' };
  if (now.state !== 'open') return { kind: 'abort', why: 'closed while its train run was in flight' };
  if (!now.labelled) return { kind: 'abort', why: `the ${LABEL} label came off while its train run was in flight` };
  if (now.headSha !== tested.headSha) return { kind: 'retest', why: `the PR's head moved (${short(tested.headSha)} tested, ${short(now.headSha)} now)` };
  if (tested.ci === 'success') {
    if (now.baseSha !== tested.baseSha) return { kind: 'retest', why: `the base moved (${short(tested.baseSha)} tested, ${short(now.baseSha)} now): something merged outside the train` };
    return { kind: 'merge' };
  }
  if (tested.ci === 'cancelled') return { kind: 'reject', comment: `Merge train: the run testing ${short(tested.headSha)} on ${short(tested.baseSha)} was cancelled or timed out before CI finished (${runUrl}). Add \`${LABEL}\` again to retry.` };
  return { kind: 'reject', comment: `Merge train: CI failed on ${short(tested.headSha)} merged into ${short(tested.baseSha)} (${runUrl}). Fix it and add \`${LABEL}\` again.` };
}

/** After an attempted merge: GitHub's 409 means the head moved after our read (test again); any other error is final. */
export function afterMergeError(status: number, message: string, runUrl: string): Land {
  if (status === 409) return { kind: 'retest', why: `GitHub refused the merge: ${message}` };
  return { kind: 'reject', comment: `Merge train: CI passed, but GitHub refused the merge (${status}: ${message}; ${runUrl}). Merge it by hand, or fix the cause and add \`${LABEL}\` again.` };
}

/** The merge commit's title, as the repository's history writes them. */
export const mergeTitle = (number: number, title: string) => `Merge pull request #${number}: ${title}`;

const short = (sha: string) => sha.slice(0, 7);
