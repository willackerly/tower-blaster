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
   - Lists the open PRs with the label and orders them: labelled longest ago first, then lowest number.
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
still on, so the next scheduled run picks the PR up within 30 min.

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

## Verify (O6)

Two PRs labelled at the same moment land one after the other, with no thread action. This was run on a scratch
base branch, `merge-train-test`, with two throwaway PRs; the train treats any base branch the same as main.
Results are in the PR that added this.
