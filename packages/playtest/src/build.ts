// The playtest build (roadmap G8): the game page as static files for Cloudflare
// Pages, plus the headers the dev server sends (cross-origin isolation, as
// vite.config.ts's ISOLATION_HEADERS), long caching for hashed assets, no
// indexing, and a build.json naming the commit. The gate is not in here: it is
// the Pages Function in ../functions, which runs in front of these files.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { ISOLATION_HEADERS } from '../../runner/vite.config.ts';

/** Where the build goes by default (packages/playtest/dist, which wrangler deploys). */
export const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const GAME_CONFIG = fileURLToPath(new URL('../../game/vite.config.ts', import.meta.url));

/** Cloudflare Pages' _headers file for the build. */
export function headersFile(): string {
  const iso = Object.entries(ISOLATION_HEADERS).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return `/*\n${iso}\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: same-origin\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`;
}

export interface BuildInfo { commit: string; dirty: boolean; builtAt: string }

/** The commit the build is made from, and whether the tree has changes on top of it. */
export function buildInfo(now = new Date()): BuildInfo {
  const git = (...a: string[]) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  return { commit: git('rev-parse', 'HEAD') || 'unknown', dirty: git('status', '--porcelain', '--untracked-files=no') !== '', builtAt: now.toISOString() };
}

/** Build the game into outDir with the playtest's extra files; returns what build.json says. */
export async function buildPlaytest(outDir = DIST): Promise<BuildInfo> {
  await build({ configFile: GAME_CONFIG, logLevel: 'warn', build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 8000 } });
  if (!existsSync(`${outDir}/index.html`)) throw new Error(`playtest build: no index.html in ${outDir}`);
  const info = buildInfo();
  writeFileSync(`${outDir}/_headers`, headersFile());
  writeFileSync(`${outDir}/robots.txt`, 'User-agent: *\nDisallow: /\n');
  writeFileSync(`${outDir}/build.json`, `${JSON.stringify(info, null, 1)}\n`);
  return info;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? DIST;
  const info = await buildPlaytest(out);
  console.log(`playtest build in ${out}: ${readdirSync(out).join(', ')} (commit ${info.commit.slice(0, 7)}${info.dirty ? ', with local changes' : ''})`);
}
