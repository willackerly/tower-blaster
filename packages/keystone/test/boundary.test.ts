// The rules package stays engine-, DOM- and clock-free: it may import only the
// engine contract, scalar geometry, the scenarios (scenario parts, G2.3) and
// itself, and never read time or randomness, so the same inputs always give the
// same game. @tb/scenarios is held to the same rule, since levels build from it.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const files = [at('../src/'), at('../../scenarios/src/')].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => dir + f));
const name = (f: string) => f.split('/packages/')[1]!;

describe('@tb/keystone boundary', () => {
  it.each(files.map(name))('%s imports only @tb/engine-api, @tb/geom, @tb/scenarios and relative paths', (f) => {
    const src = readFileSync(files.find((x) => name(x) === f)!, 'utf8');
    const specs = [...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    const allowed = f.startsWith('scenarios/') ? ['@tb/engine-api', '@tb/geom'] : ['@tb/engine-api', '@tb/geom', '@tb/scenarios'];
    for (const s of specs) expect(allowed.includes(s) || s.startsWith('./'), `${f} imports ${s}`).toBe(true);
  });
  it.each(files.map(name))('%s never reads clocks or randomness', (f) => {
    const src = readFileSync(files.find((x) => name(x) === f)!, 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now/);
  });
});
