// pnpm playtest:deploy: build the playtest and put it on Cloudflare Pages behind
// the gate (roadmap G8). Run on a machine logged in to Cloudflare (it runs
// `wrangler login` first when it is not). Idempotent: the first run creates the
// Pages project, the KV namespace for testers' emails and the cookie secret;
// later runs reuse them and only upload a new build.
//
//   PLAYTEST_PASSWORD=...  pnpm playtest:deploy          (the password: set on every run, never stored here)
//   PLAYTEST_PROJECT=name  (default tower-blaster-playtest: the site is https://<name>.pages.dev)
//
// Wrangler runs through npx at a pinned version (WRANGLER), so it is not a
// dependency of the repo.
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlaytest, DIST } from './build.ts';

export const WRANGLER = 'wrangler@4.151.0';
export const DEFAULT_PROJECT = 'tower-blaster-playtest';
const HERE = fileURLToPath(new URL('..', import.meta.url));

/** The KV namespace's title for a project (also how a later run finds it). */
export const testersTitle = (project: string) => `${project}-testers`;

/** The Pages config for a project with its testers' KV namespace (written next to functions/, not committed). */
export function wranglerToml(project: string, kvId: string): string {
  return [
    `# Written by pnpm playtest:deploy (packages/playtest/src/deploy.ts); not committed.`,
    `name = "${project}"`,
    `pages_build_output_dir = "./dist"`,
    `compatibility_date = "2026-10-01"`,
    ``,
    `[[kv_namespaces]]`,
    `binding = "TESTERS"`,
    `id = "${kvId}"`,
    ``,
  ].join('\n');
}

/** The JSON array in wrangler's output: from the first line that opens one (warnings such as "▲ [WARNING] ..." can come first). */
export function jsonArray<T>(text: string): T[] {
  const m = /^\[\s*(?:[{\]]|$)/m.exec(text);
  if (!m) throw new Error(`wrangler printed no JSON list: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(m.index)) as T[];
}

/** The id of the namespace titled `title` in `wrangler kv namespace list` output (a JSON array), or null. */
export function namespaceId(listJson: string, title: string): string | null {
  const list = jsonArray<{ id: string; title: string }>(listJson);
  return list.find((n) => n.title === title)?.id ?? null;
}

/** Whether `wrangler pages project list --json` output has the project. */
export function hasProject(listJson: string, project: string): boolean {
  const list = jsonArray<Record<string, unknown>>(listJson);
  return list.some((p) => p['Project Name'] === project || p.name === project);
}

/** Whether `wrangler whoami` output shows a login (it exits 0 either way, printing "You are not authenticated"). */
export const loggedIn = (whoamiText: string) => !/not authenticated|not logged in/i.test(whoamiText) && /logged in|associated with|Account (Name|ID)/i.test(whoamiText);

function whoami(): string {
  try { return wrangler(['whoami']); } catch (e) { return String((e as { stdout?: unknown }).stdout ?? ''); }
}

function wrangler(args: string[], opts: ExecFileSyncOptions & { input?: string } = {}): string {
  return String(execFileSync('npx', ['--yes', WRANGLER, ...args], { cwd: HERE, encoding: 'utf8', stdio: opts.input !== undefined ? ['pipe', 'pipe', 'inherit'] : ['inherit', 'pipe', 'inherit'], ...opts }));
}

async function main() {
  const password = process.env.PLAYTEST_PASSWORD;
  if (!password) throw new Error('set PLAYTEST_PASSWORD (the playtest password) for this run');
  const project = process.env.PLAYTEST_PROJECT ?? DEFAULT_PROJECT;

  const info = await buildPlaytest(DIST);
  console.log(`built ${info.commit.slice(0, 7)}${info.dirty ? ' (with local changes)' : ''} into ${DIST}`);

  // `wrangler whoami` exits 0 when logged out, so read what it prints. Without a login every later call
  // (its output piped, so not interactive) would stop and ask for CLOUDFLARE_API_TOKEN instead.
  if (!process.env.CLOUDFLARE_API_TOKEN && !loggedIn(whoami())) {
    console.log('not logged in to Cloudflare: opening wrangler login in the browser');
    execFileSync('npx', ['--yes', WRANGLER, 'login'], { stdio: 'inherit' });
    if (!loggedIn(whoami())) throw new Error('still not logged in to Cloudflare after wrangler login');
  }

  // The testers' KV namespace, made once (from an empty directory, so its title is exactly ours).
  const title = testersTitle(project);
  let kvId = namespaceId(wrangler(['kv', 'namespace', 'list']), title);
  if (!kvId) {
    wrangler(['kv', 'namespace', 'create', title], { cwd: mkdtempSync(join(tmpdir(), 'tb-kv-')) });
    kvId = namespaceId(wrangler(['kv', 'namespace', 'list']), title);
    if (!kvId) throw new Error(`created KV namespace ${title} but cannot find it in the list`);
    console.log(`created KV namespace ${title} (${kvId})`);
  }
  writeFileSync(join(HERE, 'wrangler.toml'), wranglerToml(project, kvId));

  // The Pages project, made once.
  if (!hasProject(wrangler(['pages', 'project', 'list', '--json']), project)) {
    wrangler(['pages', 'project', 'create', project, '--production-branch', 'main']);
    console.log(`created Pages project ${project}`);
  }

  // Secrets: the password on every run (so changing it is one run); the cookie key only once
  // (a new key would sign every tester out).
  wrangler(['pages', 'secret', 'put', 'GATE_PASSWORD', '--project-name', project], { input: password });
  const secrets = wrangler(['pages', 'secret', 'list', '--project-name', project]);
  if (!secrets.includes('GATE_SECRET')) {
    wrangler(['pages', 'secret', 'put', 'GATE_SECRET', '--project-name', project], { input: randomBytes(32).toString('base64') });
    console.log('set a new GATE_SECRET (cookie signing key)');
  }

  const out = wrangler(['pages', 'deploy', 'dist', '--project-name', project, '--branch', 'main', '--commit-hash', info.commit, `--commit-dirty=${info.dirty}`]);
  console.log(out.trim());
  console.log(`\nplaytest: https://${project}.pages.dev  (testers: pnpm playtest:testers)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
