// pnpm playtest:smoke: check the deployed playtest from outside, as a tester would
// (roadmap G8): the form without a pass, the password getting a pass, and the pass
// opening build.json, which must name the expected commit. CI runs it after every
// deploy; it works from any machine, no Cloudflare login needed.
//
//   PLAYTEST_PASSWORD=...  pnpm playtest:smoke [commit]   (default commit: HEAD)
//   PLAYTEST_URL=https://...  (default https://tower-blaster-playtest.pages.dev)
//
// It signs in as SMOKE_EMAIL, so that address shows up in the KV namespace;
// pnpm playtest:testers leaves it out.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECT } from './deploy.ts';
import { COOKIE, cookieOf, GATE_PATH } from './gate.ts';

export const SMOKE_EMAIL = 'ci-smoke@tower-blaster.invalid';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What is wrong with the playtest at `base` (empty when it passes): gate, pass, then build.json's commit. */
export async function smoke(base: string, password: string, commit: string, fetchFn: Fetch = fetch): Promise<string[]> {
  const form = await fetchFn(`${base}/`, { redirect: 'manual' });
  if (form.status !== 401) return [`GET / without a pass: ${form.status}, expected 401 (the gate form)`];

  const body = new URLSearchParams({ email: SMOKE_EMAIL, password, next: '/build.json' });
  const entry = await fetchFn(`${base}${GATE_PATH}`, { method: 'POST', body, redirect: 'manual' });
  if (entry.status !== 303) return [`POST ${GATE_PATH}: ${entry.status}, expected 303 (wrong password, or the gate is misconfigured)`];
  const setCookie = entry.headers.getSetCookie?.().join(', ') || entry.headers.get('set-cookie');
  const pass = cookieOf(setCookie, COOKIE);
  if (!pass) return [`POST ${GATE_PATH}: 303 but no ${COOKIE} cookie`];

  const build = await fetchFn(`${base}/build.json`, { headers: { cookie: `${COOKIE}=${pass}` }, redirect: 'manual' });
  if (build.status !== 200) return [`GET /build.json with the pass: ${build.status}, expected 200`];
  const info = (await build.json()) as { commit?: string };
  if (info.commit !== commit) return [`build.json names ${info.commit}, expected ${commit}`];
  return [];
}

async function main() {
  const password = process.env.PLAYTEST_PASSWORD;
  if (!password) throw new Error('set PLAYTEST_PASSWORD (the playtest password) for this run');
  const base = (process.env.PLAYTEST_URL ?? `https://${process.env.PLAYTEST_PROJECT ?? DEFAULT_PROJECT}.pages.dev`).replace(/\/$/, '');
  const commit = process.argv[2] ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // The production alias can lag the deploy by a few seconds, so a stale build.json is retried for a while.
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 12; attempt++) {
    problems = await smoke(base, password, commit);
    if (problems.length === 0) break;
    if (!problems[0]?.startsWith('build.json names')) break;
    console.log(`attempt ${attempt}: ${problems[0]}; retrying in 10 s`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (problems.length) throw new Error(`playtest smoke failed at ${base}: ${problems.join('; ')}`);
  console.log(`playtest smoke passed at ${base}: gate 401, pass 303, build.json ${commit.slice(0, 7)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
