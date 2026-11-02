// pnpm playtest:testers: who entered the playtest (roadmap G8), from the KV
// namespace the gate writes (key tester:<email>, metadata first/last/entries),
// as CSV on stdout. Needs the same Cloudflare login as pnpm playtest:deploy.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECT, jsonArray, namespaceId, testersTitle, WRANGLER } from './deploy.ts';

interface KeyRow { name: string; metadata?: { first?: string; last?: string; entries?: number } }

/** CSV of the testers in `wrangler kv key list` output (a JSON array), first entry first. */
export function testersCsv(listJson: string): string {
  const rows = jsonArray<KeyRow>(listJson).filter((k) => k.name.startsWith('tester:'));
  rows.sort((a, b) => (a.metadata?.first ?? '').localeCompare(b.metadata?.first ?? ''));
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['email,first,last,entries', ...rows.map((k) => [k.name.slice('tester:'.length), k.metadata?.first ?? '', k.metadata?.last ?? '', String(k.metadata?.entries ?? '')].map(cell).join(','))].join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const w = (args: string[]) => execFileSync('npx', ['--yes', WRANGLER, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  const title = testersTitle(process.env.PLAYTEST_PROJECT ?? DEFAULT_PROJECT);
  const id = namespaceId(w(['kv', 'namespace', 'list']), title);
  if (!id) { console.error(`no KV namespace ${title}: has pnpm playtest:deploy run?`); process.exit(1); }
  process.stdout.write(testersCsv(w(['kv', 'key', 'list', '--namespace-id', id, '--remote'])));
}
