// Page waits must not pass before the page's script has run. `window.__x?.status !== 'loading'` is true while
// __x is undefined (a page whose module has not run, for example after Vite's dependency reload), so the wait
// passes and the next read of __x.status throws: #330's train run, cast-browser.ts, 2026-11-08. Write
// `window.__x !== undefined && window.__x.status !== 'loading'` instead.
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
/** An optional-chained read compared with !== (or !=): true when the object is missing. */
const TRAP = /window\.__\w+\?\.\w+\s*!==?\s*['"]/;

describe('page waits', () => {
  it('no waitForFunction passes on a page whose handle does not exist yet', () => {
    const files = globSync('packages/*/{src,test}/**/*.ts', { cwd: root }).filter((f) => !f.includes('node_modules') && !f.endsWith('page-waits.test.ts'));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) => readFileSync(`${root}/${f}`, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
      .filter(({ line }) => line.includes('waitForFunction') && TRAP.test(line))
      .map(({ f, i, line }) => `${f}:${i}: ${line.trim()}`);
    expect(hits).toEqual([]);
  });
  it('the pattern catches the trap and passes the fix', () => {
    expect(TRAP.test("waitForFunction(() => window.__cast?.status !== 'loading')")).toBe(true);
    expect(TRAP.test("waitForFunction(() => window.__cast !== undefined && window.__cast.status !== 'loading')")).toBe(false);
  });
});
