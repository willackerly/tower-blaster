// The merge train's GitHub side (O6, docs/ci/merge-train.md); the decisions are merge-train.ts.
//
//   tsx merge-train-cli.ts pick   finds the next PR to test; writes pr, base_ref, base_sha, head_sha to $GITHUB_OUTPUT
//   tsx merge-train-cli.ts land   after CI: merges, aborts, keeps for a retest, or rejects; then dispatches the next run
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL; for land also PR, BASE_SHA, HEAD_SHA, BASE_REF, CI_RESULT,
// RUN_URL. Runs on a checkout of the default branch only: it reads PR heads with git but never runs their code.
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterMergeError, type Candidate, LABEL, type Land, landDecision, mergeTitle, queue } from './merge-train.ts';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const repo = env('GITHUB_REPOSITORY'), api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const headers = { authorization: `Bearer ${env('GITHUB_TOKEN')}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

async function gh(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; link: string | null }> {
  const r = await fetch(path.startsWith('http') ? path : `${api}/repos/${repo}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, link: r.headers.get('link') };
}
async function ok(method: string, path: string, body?: unknown): Promise<any> {
  const r = await gh(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
async function all(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let url: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=100`; url;) {
    const r = await gh('GET', url);
    if (r.status >= 300) throw new Error(`GET ${url}: ${r.status}`);
    out.push(...r.json);
    url = r.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return out;
}
const log = (s: string) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${s}\n`); };
const labelled = async () => (await all(`/issues?state=open&labels=${LABEL}`)).filter((i) => i.pull_request).map((i) => i.number as number);
const branchSha = async (ref: string) => (await ok('GET', `/branches/${encodeURIComponent(ref)}`)).commit.sha as string;
async function unlabel(n: number, comment: string): Promise<void> {
  await ok('POST', `/issues/${n}/comments`, { body: comment });
  const r = await gh('DELETE', `/issues/${n}/labels/${LABEL}`);
  if (r.status >= 300 && r.status !== 404) throw new Error(`unlabel #${n}: ${r.status}`);
  log(`#${n}: label removed: ${comment}`);
}
const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

async function pick(): Promise<void> {
  const prs: Candidate[] = [], info = new Map<number, any>();
  for (const n of await labelled()) {
    const pr = await ok('GET', `/pulls/${n}`);
    info.set(n, pr);
    const events = await all(`/issues/${n}/events`);
    const at = events.filter((e) => e.event === 'labeled' && e.label?.name === LABEL).at(-1)?.created_at ?? null;
    const files = (await all(`/pulls/${n}/files`)).map((f) => f.filename as string);
    prs.push({ number: n, labelledAt: at, draft: pr.draft, sameRepo: pr.head.repo?.full_name === repo, files });
  }
  const { order, refuse } = queue(prs);
  for (const r of refuse) await unlabel(r.number, `Merge train: not landing this, because ${r.reason}.`);
  for (const n of order) {
    const pr = info.get(n), baseRef: string = pr.base.ref, headSha: string = pr.head.sha, baseSha = await branchSha(baseRef);
    const f = git('fetch', '--no-tags', '--quiet', 'origin', baseSha, headSha);
    if (f.status !== 0) throw new Error(`git fetch: ${f.stderr}`);
    // A merge with no worktree: exit 0 clean, 1 conflicted (git 2.38+).
    const m = git('merge-tree', '--write-tree', '--name-only', baseSha, headSha);
    if (m.status === 1) {
      // --name-only output: the tree id, the conflicted files up to a blank line, then git's messages.
      const lines = m.stdout.split('\n').slice(1), files = lines.slice(0, Math.max(0, lines.indexOf(''))).slice(0, 10);
      await unlabel(n, `Merge train: ${headSha.slice(0, 7)} conflicts with ${baseRef} at ${baseSha.slice(0, 7)}${files.length ? ` (${files.join(', ')})` : ''}. Merge ${baseRef} in, then add \`${LABEL}\` again.`);
      continue;
    }
    if (m.status !== 0) throw new Error(`git merge-tree: ${m.stderr}`);
    log(`#${n} "${pr.title}": testing ${headSha.slice(0, 7)} merged into ${baseRef} at ${baseSha.slice(0, 7)}${order.length > 1 ? `; behind it: ${order.filter((x) => x !== n).map((x) => `#${x}`).join(', ')}` : ''}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pr=${n}\nbase_ref=${baseRef}\nbase_sha=${baseSha}\nhead_sha=${headSha}\n`);
    return;
  }
  log('No labelled PR to test.');
}

async function act(n: number, d: Land): Promise<void> {
  if (d.kind === 'abort') log(`#${n}: ${d.why}; nothing to land.`);
  else if (d.kind === 'retest') log(`#${n}: ${d.why}; keeping the label to test again.`);
  else if (d.kind === 'reject') await unlabel(n, d.comment);
}

async function land(): Promise<void> {
  const n = Number(env('PR')), tested = { headSha: env('HEAD_SHA'), baseSha: env('BASE_SHA'), ci: env('CI_RESULT') }, runUrl = env('RUN_URL');
  const pr = await ok('GET', `/pulls/${n}`);
  const now = { state: pr.state, merged: pr.merged, labelled: pr.labels.some((l: any) => l.name === LABEL), headSha: pr.head.sha, baseSha: await branchSha(env('BASE_REF')) };
  const d = landDecision(now, tested, runUrl);
  if (d.kind !== 'merge') await act(n, d);
  else {
    // sha makes GitHub refuse the merge if the head moved after the read above.
    const r = await gh('PUT', `/pulls/${n}/merge`, { merge_method: 'merge', sha: tested.headSha, commit_title: mergeTitle(n, pr.title), commit_message: `Landed by the merge train: ${runUrl}` });
    if (r.status === 200 && r.json?.merged) log(`#${n} "${pr.title}": merged as ${String(r.json.sha).slice(0, 7)} (tested ${tested.headSha.slice(0, 7)} on ${tested.baseSha.slice(0, 7)}).`);
    else await act(n, afterMergeError(r.status, r.json?.message ?? 'no message', runUrl));
  }
  await next();
}

/** Start the next run while labelled PRs remain (a dispatch from GITHUB_TOKEN does start a run). */
async function next(): Promise<void> {
  const left = await labelled();
  if (!left.length) { log('Queue empty.'); return; }
  const main = (await ok('GET', '')).default_branch as string;
  await ok('POST', `/actions/workflows/merge-train.yml/dispatches`, { ref: main });
  log(`Next run dispatched for ${left.map((x) => `#${x}`).join(', ')}.`);
}

const cmd = process.argv[2];
if (cmd === 'pick') await pick();
else if (cmd === 'land') await land();
else throw new Error('usage: merge-train-cli.ts pick | land');
