// pnpm playtest:local: the playtest build behind its gate on this machine, in
// Cloudflare's own runtime (wrangler pages dev, local KV), at
// http://localhost:8788. The password is PLAYTEST_PASSWORD, else "local".
// Nothing leaves the machine; testers' emails go to .wrangler/state here.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPlaytest, DIST } from './build.ts';
import { WRANGLER } from './deploy.ts';

const HERE = fileURLToPath(new URL('..', import.meta.url));
await buildPlaytest(DIST);
writeFileSync(`${HERE}.dev.vars`, `GATE_PASSWORD=${process.env.PLAYTEST_PASSWORD ?? 'local'}\nGATE_SECRET=${randomBytes(32).toString('base64')}\n`);
execFileSync('npx', ['--yes', WRANGLER, 'pages', 'dev', 'dist', '--port', '8788', '--kv', 'TESTERS', '--compatibility-date', '2026-10-01'], { cwd: HERE, stdio: 'inherit' });
