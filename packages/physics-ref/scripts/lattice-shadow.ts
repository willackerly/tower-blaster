// Shadow colouring on the f64 reference: run one trajectory with the `--run`
// params, and at every step colour that step's contact graph and start poses
// with each variant's rule as well (AvbdParams.colorMode / colorPriority). So
// every variant is counted on the same graph: the difference is the colouring
// alone, not a trajectory that diverged. The run's own colouring is checked
// against the shadow of its own rule (mismatches must be 0). Not used by tests.
//   npx tsx packages/physics-ref/scripts/lattice-shadow.ts --scene S1 --param F=8 --param H=30 --param gap=0 --steps 300
//     [--run '{"iterations":10}'] [--variants 'base|colorMode=3|colorPriority=1|colorMode=3+colorPriority=1']
//     [--windows 0-60,60-150,150-300] [--nudge seed] [--out f.jsonl]
// --scene Q6 is the brief's 2x2x20 tower tilted 8 deg (lattice-quality.ts Q6; --param deg=8).
import { appendFileSync } from 'node:fs';
import type { BodyDesc, SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { AvbdReferenceEngine, type AvbdParams, colorGraphWith, latticeParity, latticePreferences } from '../src/index.ts';

const argv = process.argv.slice(2);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const params: Record<string, number> = {};
argv.forEach((a, i) => { if (a === '--param') { const [k, v] = argv[i + 1]!.split('='); params[k!] = Number(v); } });
const sceneId = value('scene') ?? 'S1';
const steps = Number(value('steps') ?? 300);
const run = JSON.parse(value('run') ?? '{"iterations":10}') as Partial<AvbdParams>;
const variants = (value('variants') ?? 'base|colorMode=3|colorPriority=1|colorMode=3+colorPriority=1').split('|');
const windows = (value('windows') ?? `0-${steps}`).split(',').map((w) => w.split('-').map(Number) as [number, number]);
const nudge = Number(value('nudge') ?? 0);
const parseVariant = (v: string) => Object.fromEntries(v.split('+').filter((kv) => kv !== 'base').map((kv) => {
  const [k, x] = kv.split('=');
  if ((k !== 'colorMode' && k !== 'colorPriority') || x === undefined || !Number.isFinite(Number(x))) throw new Error(`bad variant piece "${kv}" in "${v}"`);
  return [k, Number(x)];
})) as { colorMode?: number; colorPriority?: number };

function q6(p: Record<string, number>): SceneDesc {
  const W = 2, H = 20, deg = p.deg ?? 8;
  const base = buildScenario('S1', { F: W, H, gap: 0 }, 1);
  const th = (deg * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th), e0 = W / 2;
  const bodies: BodyDesc[] = base.bodies.map((b, i) => {
    const layer = Math.floor(i / (W * W)), xr = b.pos[0] - e0, y = b.pos[1];
    return { ...b, pos: [e0 + xr * c + y * sn, -xr * sn + y * c + 1e-6 * (layer + 1), b.pos[2]], rot: [0, 0, -Math.sin(th / 2), Math.cos(th / 2)] };
  });
  return { ...base, id: 'Q6', params: { deg }, bodies };
}
let scene = sceneId === 'Q6' ? q6(params) : buildScenario(sceneId, params, 1);
if (nudge) {
  let t = nudge >>> 0;
  const rnd = () => { t = (Math.imul(t, 1664525) + 1013904223) >>> 0; return t / 2 ** 32 - 0.5; };
  scene = { ...scene, bodies: scene.bodies.map((b) => ({ ...b, pos: [b.pos[0] + 2e-6 * rnd(), b.pos[1] + 2e-6 * rnd(), b.pos[2] + 2e-6 * rnd()] })) };
}

const e = new AvbdReferenceEngine(run);
await e.init(scene);
const gy = scene.ground?.y ?? 0;
const rules = variants.map(parseVariant);
const own = rules.findIndex((r) => (r.colorMode ?? 0) === (run.colorMode ?? 0) && (r.colorPriority ?? 0) === (run.colorPriority ?? 0));
// Per variant, per step: K and ΣW (the most contact points a body of each colour walks, summed).
const K = rules.map(() => new Int32Array(steps + 1)), SW = rules.map(() => new Int32Array(steps + 1));
let mismatches = 0;
for (let s = 1; s <= steps; s++) {
  const w = e.world!;
  const poses = w.bodies.map((b) => ({ pos: [...b.pos], rot: [...b.rot], half: b.desc.shape.kind === 'box' && b.desc.shape.half[0] === b.desc.shape.half[1] && b.desc.shape.half[0] === b.desc.shape.half[2] ? b.desc.shape.half[0] : null }));
  e.step();
  const n = w.bodies.length, adj: Array<Set<number>> = Array.from({ length: n }, () => new Set()), pts = new Int32Array(n);
  for (const c of w.contacts) { pts[c.b]!++; if (c.a >= 0) { pts[c.a]!++; adj[c.a]!.add(c.b); adj[c.b]!.add(c.a); } }
  const lists = adj.map((x) => [...x].sort((a, b) => a - b));
  // A body added this step (an input) has no start pose here: no preference.
  const parity = Array.from({ length: n }, (_, i) => (poses[i] ? latticeParity(poses[i]!.pos, poses[i]!.rot, poses[i]!.half, gy) : -1));
  rules.forEach((r, k) => {
    const mode = r.colorMode ?? 0;
    const pref = mode ? latticePreferences(lists, parity, mode) : null;
    const color = colorGraphWith(lists, { degreeFirst: (r.colorPriority ?? 0) === 1, ...(pref ? { prefer: pref } : {}) });
    let colors = 0;
    for (let i = 0; i < n; i++) colors = Math.max(colors, color[i]! + 1);
    const Wc = new Array<number>(colors).fill(0);
    color.forEach((c, i) => { Wc[c] = Math.max(Wc[c]!, pts[i]!); });
    K[k]![s] = colors; SW[k]![s] = Wc.reduce((a, b) => a + b, 0);
    if (k === own) for (let i = 0; i < n; i++) if (color[i] !== w.stats.colorOf![i]) mismatches++;
  });
}
const mean = (a: Int32Array, lo: number, hi: number) => { let x = 0; for (let s = lo + 1; s <= hi; s++) x += a[s]!; return x / (hi - lo); };
const out = { scene: sceneId, params, run, nudge, steps, ownRuleMismatches: own >= 0 ? mismatches : null, windows: {} as Record<string, unknown> };
for (const [lo, hi] of windows) {
  out.windows[`${lo}-${hi}`] = Object.fromEntries(variants.map((v, k) => {
    let worse = 0, maxExcess = 0;
    for (let s = lo + 1; s <= hi; s++) { const d = SW[k]![s]! - SW[0]![s]!; if (d > 0) worse++; maxExcess = Math.max(maxExcess, d); }
    return [v, { meanK: +mean(K[k]!, lo, hi).toFixed(2), meanSumW: +mean(SW[k]!, lo, hi).toFixed(1), ratio: +(mean(SW[k]!, lo, hi) / mean(SW[0]!, lo, hi)).toFixed(3), stepsWorseThanFirst: worse, maxExcess }];
  }));
}
console.log(JSON.stringify(out));
if (value('out')) appendFileSync(value('out')!, JSON.stringify(out) + '\n');
if (own >= 0 && mismatches) { console.error(`the run's colouring differs from its own rule's shadow at ${mismatches} body-steps`); process.exitCode = 1; }
