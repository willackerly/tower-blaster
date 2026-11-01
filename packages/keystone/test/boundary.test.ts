// The rules package stays engine-, DOM- and clock-free: it may import only the
// engine contract, scalar geometry, the weapons catalogue and logic (the rack's
// items), the scenarios (scenario parts, G2.3) and itself, and never read time
// or randomness, so the same inputs always give the same game. @tb/weapons and
// @tb/scenarios are held to the same rules here, so the guarantee holds through them.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ALLOWED = ['@tb/engine-api', '@tb/geom', '@tb/weapons', '@tb/scenarios'];
const packages = [
  { name: '@tb/keystone', dir: fileURLToPath(new URL('../src/', import.meta.url)), allowed: ALLOWED },
  { name: '@tb/weapons', dir: fileURLToPath(new URL('../../weapons/src/', import.meta.url)), allowed: ['@tb/engine-api', '@tb/geom'] },
  { name: '@tb/scenarios', dir: fileURLToPath(new URL('../../scenarios/src/', import.meta.url)), allowed: ['@tb/engine-api', '@tb/geom'] },
];

for (const pkg of packages) {
  const files = readdirSync(pkg.dir).filter((f) => f.endsWith('.ts'));
  describe(`${pkg.name} boundary`, () => {
    it.each(files)(`%s imports only ${pkg.allowed.join(', ')} and relative paths`, (f) => {
      const src = readFileSync(pkg.dir + f, 'utf8');
      const specs = [...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const s of specs) expect(pkg.allowed.includes(s) || s.startsWith('./'), `${f} imports ${s}`).toBe(true);
    });
    it.each(files)('%s never reads clocks or randomness', (f) => {
      const src = readFileSync(pkg.dir + f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now/);
    });
  });
}
