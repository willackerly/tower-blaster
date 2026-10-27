// pnpm bench:probe-compare [--p2 base.json variant.json]... [--browser records.jsonl]...
// A base and a variant side by side (probe-compare.ts), from measured results:
// pairs of bench:probe JSON files (P2 base, then variant, at the same I) and
// bench:browser JSONL files of A/B records (base first). Prints markdown; it
// judges nothing (exit 1 only on bad input).
import { readFileSync } from 'node:fs';
import { type BrowserCompare, compareBrowser, compareMarkdown, compareP2, type P2Compare } from './probe-compare.ts';
import type { P2Result } from './probe.ts';

const argv = process.argv.slice(2);
const p2: P2Compare[] = [], browser: BrowserCompare[] = [];
const readP2 = (f: string): P2Result => {
  const j = JSON.parse(readFileSync(f, 'utf8')) as { p2?: P2Result; valid?: boolean };
  if (!j.p2) throw new Error(`${f}: no P2 section (run bench:probe with --only p2)`);
  if (j.valid === false) console.error(`warning: ${f} is from a software adapter or has no timestamps: its verdict is not a performance result`);
  return j.p2;
};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--p2') { p2.push(compareP2(readP2(argv[i + 1]!), readP2(argv[i + 2]!))); i += 2; }
  else if (argv[i] === '--browser') {
    for (const line of readFileSync(argv[++i]!, 'utf8').split('\n')) if (line.trim()) browser.push(compareBrowser(JSON.parse(line)));
  } else throw new Error(`unknown argument ${argv[i]}; usage: --p2 base.json variant.json | --browser records.jsonl`);
}
if (!p2.length && !browser.length) throw new Error('usage: pnpm bench:probe-compare [--p2 base.json variant.json]... [--browser records.jsonl]...');
console.log(compareMarkdown(p2, browser));
