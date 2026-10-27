// npx tsx packages/physics-gpu/scripts/lattice-structure.ts --scenario S4 --param N=10000 --steps 300 --at 60,300
//   [--variants 'base|colorMode=4|colorMode=4+colorPriority=1'] [--tail-threads 256] [--channel chrome] [--out f.jsonl]
// The GPU's own colouring structure (K, colour sizes, W_c, ΣW, the tail, JP
// rounds, contact pairs by lattice offset) at the given steps, per variant:
// AvbdParams separated by '+' ('base' alone for the defaults). Counts, not timings,
// so a software adapter is fine. tailThreads defaults to 256, the hardware
// tail width, so ΣW's tail term is the one the M5 runs (the results do not
// depend on it). Each line also checks the colours against the reference rule.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitNow, loadBundle, openWebGPU } from '@tb/testkit';
import { buildScenario } from '@tb/scenarios';
import type { ColourCheck } from '../test/lattice-page.ts';

const argv = process.argv.slice(2);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const params: Record<string, number> = {};
argv.forEach((a, i) => { if (a === '--param') { const [k, v] = argv[i + 1]!.split('='); params[k!] = Number(v); } });
const scenario = value('scenario') ?? 'S4';
const steps = Number(value('steps') ?? 300);
const at = (value('at') ?? '60,300').split(',').map(Number);
const tailThreads = Number(value('tail-threads') ?? 256);
const variants = (value('variants') ?? 'base|colorMode=1|colorMode=2|colorMode=3|colorMode=4|colorPriority=1|colorMode=4+colorPriority=1').split('|');
const parseVariant = (v: string) => Object.fromEntries(v.split('+').filter((kv) => kv !== 'base').map((kv) => {
  const [k, x] = kv.split('=');
  if (!k || x === undefined || !Number.isFinite(Number(x))) throw new Error(`bad variant piece "${kv}" in "${v}"`);
  return [k, Number(x)];
}));

const channel = value('channel');
const gpu = await openWebGPU([], channel ? { channel } : {});
if (!gpu) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  gpu.page.on('console', (m) => { if (m.text().startsWith('[lattice]')) console.error(m.text()); });
  await loadBundle(gpu.page, fileURLToPath(new URL('../test/lattice-page.ts', import.meta.url)), '__lattice');
  const scene = buildScenario(scenario, params, 1);
  for (const v of variants) {
    const p = parseVariant(v);
    console.error(`${scenario} ${JSON.stringify(params)} ${v}: ${steps} steps`);
    const r = await gpu.page.evaluate(([s, n, pp, o, a]) => (window as unknown as { __lattice: { latticeRun: (...x: unknown[]) => Promise<{ error: string | null; checks: ColourCheck[]; wallMs: number }> } }).__lattice.latticeRun(s, n, pp, o, a, true), [scene, steps, p, { tailThreads }, at] as const);
    if (r.error) throw new Error(r.error);
    for (const c of r.checks) {
      const line = { scenario, params, variant: v, ...c };
      console.log(`${v.padEnd(28)} step ${String(c.step).padStart(3)}: K ${c.K} (${c.nonEmpty} used), ΣW ${c.sumW}, tail ${c.tail.colours}/${c.tail.bodies}/${c.tail.Wcrit}, rounds ${c.jpRounds}, sizes ${c.sizes.join(' ')}, W ${c.W.join(' ')}, pairs ${JSON.stringify(c.pairs)}, preferring ${c.preferring} took ${c.tookPreference} fallback ${c.fallback}, match ${c.match}`);
      if (value('out')) appendFileSync(value('out')!, JSON.stringify(line) + '\n');
    }
  }
} finally {
  stuck = await gpu.close();
}
if (stuck.length) await exitNow();
