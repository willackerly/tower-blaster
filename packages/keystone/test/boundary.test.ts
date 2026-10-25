// The rules package stays engine-, DOM- and clock-free: it may import only the
// engine contract, scalar geometry and itself, and never read time or
// randomness, so the same inputs always give the same game.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

describe('@tb/keystone boundary', () => {
  it.each(files)('%s imports only @tb/engine-api, @tb/geom and relative paths', (f) => {
    const src = readFileSync(dir + f, 'utf8');
    const specs = [...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const s of specs) expect(s === '@tb/engine-api' || s === '@tb/geom' || s.startsWith('./'), `${f} imports ${s}`).toBe(true);
  });
  it.each(files)('%s never reads clocks or randomness', (f) => {
    const src = readFileSync(dir + f, 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now/);
  });
});
