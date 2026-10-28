// The package graph: which @tb packages each package's source imports. It
// must stay acyclic (apart from the cycles listed below, each with its
// reason), so a lower package never needs a higher one to load. The game and
// the viewer are the case that matters now: the viewer runs the game's
// scenes with the game's modules (docs/design/viewer-superset.md), so the
// game may not import the viewer.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url).pathname;
const packages = readdirSync(join(root, 'packages')).filter((p) => statSync(join(root, 'packages', p)).isDirectory());

function sources(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(sources(p));
    else if (/\.m?ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Package name (without @tb/) to the @tb packages its src/ imports, statically or dynamically. */
function importGraph(): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  for (const p of packages) {
    const deps = new Set<string>();
    let files: string[] = [];
    try { files = sources(join(root, 'packages', p, 'src')); } catch { /* no src */ }
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]@tb\/([\w-]+)/g)) if (m[1] !== p) deps.add(m[1]!);
    g.set(p, deps);
  }
  return g;
}

/** The cycles a depth-first search closes, one per back edge, each a path that ends where it starts. */
function cycles(g: Map<string, Set<string>>): string[][] {
  const state = new Map<string, 1 | 2>(), out: string[][] = [];
  const visit = (u: string, path: string[]) => {
    state.set(u, 1);
    for (const v of [...(g.get(u) ?? [])].sort()) {
      if (state.get(v) === 1) out.push([...path.slice(path.indexOf(v)), v]);
      else if (!state.has(v)) visit(v, [...path, v]);
    }
    state.set(u, 2);
  };
  for (const u of [...g.keys()].sort()) if (!state.has(u)) visit(u, [u]);
  return out;
}

/**
 * Known cycles, each an edge that closes it. physics-gpu's probe tooling
 * (probe-engine.ts) parses bench engine specs, and bench builds the GPU engine.
 */
const KNOWN = new Set(['physics-gpu>bench']);

describe('package layering', () => {
  const g = importGraph();

  it('finds the imports (the viewer imports render, the game keystone)', () => {
    expect(g.get('viewer')?.has('render')).toBe(true);
    expect(g.get('game')?.has('keystone')).toBe(true);
  });

  it('cycles() names a cycle and ignores a DAG', () => {
    expect(cycles(new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set<string>()]]))).toEqual([]);
    expect(cycles(new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]))).toEqual([['a', 'b', 'a']]);
  });

  it('has no package cycle but the known ones', () => {
    const unknown = cycles(g).filter((c) => !c.some((_, i) => i > 0 && KNOWN.has(`${c[i - 1]}>${c[i]}`)));
    expect(unknown).toEqual([]);
  });

  it('the game does not import the viewer', () => {
    expect([...(g.get('game') ?? [])]).not.toContain('viewer');
  });
});
