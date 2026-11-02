// The playtest build and its deploy helpers (roadmap G8): the static build has
// the game, the Pages headers and build.json; the deploy script finds what an
// earlier run made in wrangler's output; the testers list reads what the gate
// wrote (a fixture captured from wrangler pages dev, 2026-11-02).
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlaytest, headersFile } from '../src/build.ts';
import { hasProject, loggedIn, namespaceId, testersTitle, wranglerToml } from '../src/deploy.ts';
import { testersCsv } from '../src/testers.ts';

describe('playtest build', () => {
  it('builds the game page with the Pages headers, robots.txt and build.json', async () => {
    const out = mkdtempSync(join(tmpdir(), 'tb-playtest-'));
    const info = await buildPlaytest(out);
    expect(readdirSync(out).sort()).toEqual(['_headers', 'assets', 'build.json', 'index.html', 'robots.txt']);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('id="door"');
    expect(html).toMatch(/src="\/assets\/index-[\w-]+\.js"/);
    expect(readdirSync(join(out, 'assets')).some((f) => f.startsWith('worklet-'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'))).toEqual(info);
    expect(info.commit).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(readFileSync(join(out, '_headers'), 'utf8')).toBe(headersFile());
    expect(readFileSync(join(out, 'robots.txt'), 'utf8')).toContain('Disallow: /');
  }, 120_000);
  it('the headers isolate the page as the dev server does, keep it unindexed and cache hashed assets for good', () => {
    const h = headersFile();
    expect(h).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(h).toContain('Cross-Origin-Embedder-Policy: require-corp');
    expect(h).toContain('X-Robots-Tag: noindex, nofollow');
    expect(h).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
  });
});

describe('deploy helpers', () => {
  it('finds the testers namespace by its title in wrangler\'s list (with a banner before the JSON)', () => {
    const list = `▲ [WARNING] Proxy environment variables detected.\n${JSON.stringify([{ id: 'aaa', title: 'other' }, { id: 'bbb', title: testersTitle('tower-blaster-playtest') }])}`;
    expect(namespaceId(list, 'tower-blaster-playtest-testers')).toBe('bbb');
    expect(namespaceId('[]', 'x')).toBeNull();
  });
  it('knows whether the Pages project exists', () => {
    const list = JSON.stringify([{ 'Project Name': 'tower-blaster-playtest', 'Project Domains': 'tower-blaster-playtest.pages.dev' }]);
    expect(hasProject(list, 'tower-blaster-playtest')).toBe(true);
    expect(hasProject(list, 'other')).toBe(false);
  });
  it('reads the login from wrangler whoami (which exits 0 when logged out)', () => {
    // Captured from wrangler 4.151.0 with no login.
    const out = '▲ [WARNING] Proxy environment variables detected.\n\n ⛅️ wrangler 4.151.0\n────────────────────\nGetting User settings...\nYou are not authenticated. Please run `wrangler login`.\nTo deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.\n';
    expect(loggedIn(out)).toBe(false);
    expect(loggedIn('')).toBe(false);
    expect(loggedIn('Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email will@example.com.\n┌──────────────┬──────────┐\n│ Account Name │ Account ID │')).toBe(true);
  });
  it('writes the Pages config with the TESTERS binding', () => {
    const toml = wranglerToml('p', 'kv123');
    expect(toml).toContain('name = "p"');
    expect(toml).toContain('pages_build_output_dir = "./dist"');
    expect(toml).toMatch(/\[\[kv_namespaces\]\]\nbinding = "TESTERS"\nid = "kv123"/);
  });
});

describe('testers list', () => {
  // `wrangler kv key list --local` after two testers entered through the gate in wrangler pages dev.
  const captured = JSON.stringify([
    { name: 'tester:tester@example.com', metadata: { first: '2026-11-02T03:05:04.396Z', last: '2026-11-02T03:05:04.396Z', entries: 1 } },
    { name: 'tester:will.test@example.com', metadata: { first: '2026-11-02T03:04:54.237Z', last: '2026-11-02T03:04:54.237Z', entries: 1 } },
    { name: 'something-else' },
  ], null, 2);
  it('lists testers as CSV, earliest first, other keys left out', () => {
    expect(testersCsv(captured)).toBe([
      'email,first,last,entries',
      'will.test@example.com,2026-11-02T03:04:54.237Z,2026-11-02T03:04:54.237Z,1',
      'tester@example.com,2026-11-02T03:05:04.396Z,2026-11-02T03:05:04.396Z,1',
      '',
    ].join('\n'));
  });
  it('quotes a cell that needs it', () => {
    expect(testersCsv(JSON.stringify([{ name: 'tester:"a,b"@c.d', metadata: {} }]))).toContain('"""a,b""@c.d",,,');
  });
});
