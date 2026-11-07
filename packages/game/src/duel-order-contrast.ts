// PT22's controlled contrast on the GPU (docs/game/siege-table.md, "What that does not show"): one geometry, D1 as
// round 2 played it (six-course keeps), in its old part order and in the image order (unitCubes + halfTurn), paired
// first shots per seed as duel-bot-cli.ts --probe fires them. `npx tsx packages/game/src/duel-order-contrast.ts
// [seeds=8] [aspect=0.462]`; headless Chromium on the cast page (SwiftShader here; TB_CHANNEL is not read).
import { D1, type DuelDef, halfTurn, type Part, unitCubes } from '@tb/keystone';
const { openBrowserCastPlayer } = await import('../../keystone-lab/src/cast-browser.ts');
const bat = (x: number, y: number): Part[] => [
  { kind: 'block', at: [x, y, -1.5], size: [3, 1, 1], material: 'stone' }, { kind: 'block', at: [x, y, 0.5], size: [3, 1, 1], material: 'stone' },
  { kind: 'block', at: [x, y, -0.5], size: [1, 1, 1], material: 'stone' }, { kind: 'block', at: [x + 2, y, -0.5], size: [1, 1, 1], material: 'stone' }];
const wall: Part = { kind: 'block', at: [-0.5, 0, -3], size: [1, 3, 6], material: 'plaster' };
const level = (parts: Part[]) => ({ ...D1.level, parts, launcher: { ...D1.level.launcher!, dropY: 12 } });
const OLD: DuelDef = { ...D1, level: level([
  { kind: 'block', at: [-12, 0, -1.5], size: [3, 6, 3], material: 'stone' }, { kind: 'block', at: [9, 0, -1.5], size: [3, 6, 3], material: 'stone' },
  { kind: 'block', at: [-11, 6, -0.5], size: [1, 2, 1], material: 'stone', role: 'crown' }, { kind: 'block', at: [10, 6, -0.5], size: [1, 2, 1], material: 'stone', role: 'crown' },
  wall, ...bat(-12, 6), ...bat(9, 6)]),
  sides: [{ ...D1.sides[0], owns: { parts: [0, 2, 5, 6, 7, 8] }, king: { parts: [2] } }, { ...D1.sides[1], owns: { parts: [1, 3, 9, 10, 11, 12] }, king: { parts: [3] } }] };
const gold = unitCubes([{ kind: 'block', at: [-12, 0, -1.5], size: [3, 6, 3], material: 'stone' }, { kind: 'block', at: [-11, 6, -0.5], size: [1, 2, 1], material: 'stone', role: 'crown' }, ...bat(-12, 6)]);
const n = gold.length, king = gold.flatMap((p, i) => (p.role === 'crown' ? [i] : [])), r = (a: number) => Array.from({ length: n }, (_, k) => a + k);
const IMAGED: DuelDef = { ...D1, level: level([...gold, ...gold.map(halfTurn), wall]),
  sides: [{ ...D1.sides[0], owns: { parts: r(0) }, king: { parts: king } }, { ...D1.sides[1], owns: { parts: r(n) }, king: { parts: king.map((i) => i + n) } }] };
const gpu = await openBrowserCastPlayer({ engine: 'gpu' });
const [seeds = '8', aspect = '0.462'] = process.argv.slice(2);
try {
  for (const [name, def] of [['old order', OLD], ['imaged order', IMAGED]] as const) {
    let level = 0, mirror = 0, gs = 0, bs = 0;
    for (let s = 0; s < Number(seeds); s++) {
      const shot = async (p: 0 | 1) => { const x = await gpu.duel('D1', p, 5000 + s, Number(aspect), { turns: 1, rivalOnly: true, def }); mirror = Math.max(mirror, x.mirror); const t = x.shots[0]; return { n: t?.rival ?? 0, k: !!t?.kingsDown[1 - p] }; };
      const g = await shot(0), b = await shot(1);
      gs += g.n; bs += b.n;
      if (g.n === b.n && g.k === b.k) level++;
      console.log(`${name} aspect ${aspect} seed ${5000 + s}: Gold ${g.n}${g.k ? '+king' : ''}, Blue ${b.n}${b.k ? '+king' : ''}`);
    }
    console.log(`${name} aspect ${aspect}: ${level} of ${seeds} pairs level; rival blocks down Gold ${gs}, Blue ${bs}; settled table off its mirror by up to ${(1000 * mirror).toFixed(3)} mm`);
  }
} finally { await gpu.close(); }
