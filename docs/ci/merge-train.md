# Merge train (O6)

PRs used to land by each thread merging its own once CI went green. On a busy day main took a merge every
30–40 min, about one CI run, so a PR's green run was usually against a main that had already moved. #295 lost
that race three times in a row. Landing on a stale green also means main can break with no PR ever red.

To land a PR: **add the `merge-ready` label** and do nothing else. The train tests main with your PR merged in,
merges it if that passed and nothing moved, and moves on to the next PR. If it can't land the PR, it takes the
label off and comments why.

## How it works

`.github/workflows/merge-train.yml` runs in one concurrency group, `merge-train`, so only one train run is ever
active. Each run handles at most one PR:

1. **pick** (`merge-train-cli.ts pick`, default-branch code only):
   - Lists the open PRs with the label, skipping any that has closed since the listing was made, and orders them:
     labelled longest ago first, then lowest number.
   - Refuses three kinds of PR, each with a comment and the label taken off:
     - a fork, since the train never runs a fork's code with its token;
     - a draft;
     - a PR that changes `.github/workflows`, which GITHUB_TOKEN may not merge.
   - For the first remaining PR, reads the base's sha and the head's sha, and test-merges them with
     `git merge-tree`. That touches no worktree and runs no code.
   - A conflict means a comment and the label off, and the next PR is tried.
2. **ci**: calls `ci.yml` through `workflow_call` with `base_sha` and `head_sha`. Every job checks out
   `base_sha`, merges `head_sha` into it, and runs the full suite: the static job and all 20 shards. The tree
   tested is the tree that lands. The call has a concurrency group of its own, so it never queues behind main's
   push runs or displaces them.
3. **land** (`merge-train-cli.ts land`, `if: always()`) re-reads the PR and the base, then takes the first case
   that applies:

| situation | action |
|---|---|
| PR merged, closed, or label removed during the run | abort: nothing merged, no comment |
| PR head moved since the test | keep the label, test again next run |
| CI passed, base moved (something merged outside the train) | keep the label, test again |
| CI passed, nothing moved | merge (merge commit, `sha` = the tested head, title `Merge pull request #N: <title>`) |
| GitHub refuses the merge with 409 (head moved after the read) | keep the label, test again |
| GitHub refuses the merge for any other reason | label off, comment with the status |
| CI failed (a job timing out counts) | label off, comment linking the run |
| run cancelled before CI finished | label off, comment ("cancelled or timed out; add the label again") |

   Then, if any labelled PR is left, it dispatches the next run (`workflow_dispatch`). A dispatch made with
   GITHUB_TOKEN does start a run; other GITHUB_TOKEN events don't.

The rules live in `packages/testkit/src/merge-train.ts` (`queue`, `landDecision`, `afterMergeError`). Those are
pure functions, tested in `packages/testkit/test/merge-train.test.ts`. The CLI is only GitHub REST calls and git.

## Why runs are only nudges

GitHub keeps **one** pending run per concurrency group and cancels any older pending one. Labelling three PRs at
once therefore leaves one run active, one pending, and drops the third. So a run never carries a PR. Every run
picks from the labelled PRs afresh, and every land ends by dispatching the next. A dropped trigger loses
nothing, because whichever run does start finds every label. The triggers are:

- `pull_request_target: labeled`, for any label, since a run only picks;
- `workflow_dispatch`, which is the chain;
- `schedule` at :17 and :47, which restarts the train if a run died without dispatching.

A label can't stay on with nothing testing it. When a run is cancelled or its CI times out, land still runs
(`always()`) and takes the label off. If even land never ran (the runner was lost, or pick crashed), the label is
still on, so the next scheduled run picks it up. GitHub drops scheduled runs under load (twice in about 12 h on the
night of 2026-11-07), so that can take hours; any new label on any PR also starts a run that finds it.

## Not chosen

- **GitHub's merge queue.** It is offered only on organization-owned repositories (public, or private on
  Enterprise Cloud). `willackerly/tower-blaster` is owned by a user account.
- **An auto-rebase or auto-update bot alone.** It keeps branches current, but the merge itself still races: two
  PRs updated against the same main both go green, then both merge.
- **A lease file or "I'm merging" note.** Nothing enforces it, and a thread that dies holding it blocks everyone.
- **Squash merges.** The history is merge commits ("Merge pull request #N: ..."), and each PR's atomic commits
  are kept.
- **A PAT or GitHub App token.** That would let train merges trigger main's push CI, and would let the train
  merge workflow changes. It needs a secret from Will, and it adds little: the train has already run CI on the
  exact tree that lands.

## What this changes for main's CI

A merge made with GITHUB_TOKEN starts no `push` workflow, so main gets no CI run of its own for PRs the train
lands. The train's run of the merged tree is that run: same tree, same jobs. To see main's history of CI, read
the merge-train runs alongside the `ci` push runs. PRs merged by hand still get main's push run.

## Safety

- **Untrusted code.** `pull_request_target` runs with the default branch's workflow. Only pick and land, which
  never run PR code, hold write permissions. The PR's code runs only in the `ci` jobs, with `contents: read`.
- **Who can trigger it.** Labels need triage or write access, and forks are refused anyway.
- **The cache.** One shared risk remains: the `ci` jobs may save a pnpm cache under the default branch's scope.
  For same-repository PRs by collaborators, that is accepted.

## Runner time

A PR's own `ci` run still runs on its pushes, and the train runs the suite once more on the merged tree. The
repository is public, so the minutes are free, but the account has a limited number of concurrent runners. With
another PR's run and main's push run in flight, the first verify run below waited about 25 minutes for runners
before its slowest shard (8 min) ran. A train run with free runners takes about 14 minutes.

## Verify (O6)

Requirement: two PRs labelled at the same moment land one after the other, with no thread action. This was run on
2026-11-07 on a scratch base branch, `merge-train-test` (main at fc32dfe), with two throwaway PRs, #312 and #313,
each adding one docs file. The train treats any base branch as it treats main.

| time (UTC) | event |
|---|---|
| 20:48:01 | #312 and #313 labelled in the same second (both label events read `20:48:01Z`) |
| 20:48:03 | two `pull_request_target` runs: one active, one pending |
| 20:48:51 | run 1 picks #312 (equal times, so the lower number): "testing 95d669b merged into merge-train-test at fc32dfe; behind it: #313" |
| 20:55:40 | another thread labels a real PR, #315. Its run replaces the pending one, which GitHub cancels (the dropped nudge this design expects) |
| 21:28:35 | run 1 lands #312 as 3b6b64d (parents fc32dfe, 95d669b) and dispatches the next run. That replaces #315's pending run, also cancelled |
| 21:28:37 | run 2 (`workflow_dispatch`) picks #313: "testing 6376b50 merged into merge-train-test at 3b6b64d; behind it: #315" |
| 21:42:27 | run 2 lands #313 as 696507c (parents 3b6b64d, 6376b50) and dispatches run 3 |
| 21:42:50 | run 3 picks #315, the first real PR: "testing e59c7be merged into main at ddd0ea2" |

Both scratch PRs landed in label order, each tested on the base it then landed on, with no action between labelling
and landing. Two of the four nudges were dropped and nothing was lost.

One finding, fixed in the same follow-up: the issues listing lags a merge by a moment. Both lands logged the PR they
had just merged among those still labelled ("Next run dispatched for #315, #313, #312"). A pick that saw that listing
would have spent a CI run on a merged PR before land aborted it. `queue` now skips a PR that is no longer open.
