// Writes air-table.ts: the air filter's fit (air.ts) per distance, AIR_D0 x AIR_STEP^i m up to 400 m.
// Minimax on 60 log-spaced frequencies, 500 Hz to 20 kHz, where the standard's loss is under 20 dB: nine
// fixed starts per distance, then passes warm-started from each neighbour's fit, keeping the best.
// usage: tsx packages/audio/src/air-cli.ts [out=packages/audio/src/air-table.ts]
import { writeFileSync } from 'node:fs';
import { AIR_D0, AIR_RATE, AIR_STEP, airAlpha, airLoss } from './air.ts';

export const AIR_FREQS = Array.from({ length: 60 }, (_, i) => 500 * (20000 / 500) ** (i / 59));
export const AIR_MASK_DB = 20;

/** Worst |fit - standard| (dB) over the grid where the standard loses under AIR_MASK_DB. */
export function airError(p: readonly number[], d: number): number {
  let worst = 0;
  for (const f of AIR_FREQS) { const t = airAlpha(f) * d; if (t < AIR_MASK_DB) worst = Math.max(worst, Math.abs(airLoss(p, f, AIR_RATE) - t)); }
  return worst;
}

/** Nelder-Mead from x0 (a fixed, deterministic schedule). */
function nelderMead(f: (x: number[]) => number, x0: number[], step = 0.5, iters = 3000): { x: number[]; fx: number } {
  const n = x0.length, s: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i]! += step; s.push(x); }
  let fs = s.map(f);
  for (let it = 0; it < iters; it++) {
    const ord = fs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    const S = ord.map((i) => s[i]!), F = ord.map((i) => fs[i]!);
    s.splice(0, s.length, ...S); fs = F;
    const c = Array.from({ length: n }, (_, j) => S.slice(0, n).reduce((a, x) => a + x[j]!, 0) / n);
    const at = (t: number) => c.map((v, j) => v + t * (S[n]![j]! - v));
    const xr = at(-1), fr = f(xr);
    if (fr < F[0]!) { const xe = at(-2), fe = f(xe); if (fe < fr) { s[n] = xe; fs[n] = fe; } else { s[n] = xr; fs[n] = fr; } continue; }
    if (fr < F[n - 1]!) { s[n] = xr; fs[n] = fr; continue; }
    const xc = at(fr < F[n]! ? -0.5 : 0.5), fc = f(xc);
    if (fc < Math.min(fr, F[n]!)) { s[n] = xc; fs[n] = fc; continue; }
    for (let i = 1; i <= n; i++) { s[i] = s[i]!.map((v, j) => S[0]![j]! + 0.5 * (v - S[0]![j]!)); fs[i] = f(s[i]!); }
    if (Math.abs(fs[n]! - fs[0]!) < 1e-9 && it > 200) break;
  }
  const b = fs.indexOf(Math.min(...fs));
  return { x: s[b]!, fx: fs[b]! };
}

export function fitAir(): { d: number; p: number[]; err: number }[] {
  const ds: number[] = [];
  for (let i = 0; AIR_D0 * AIR_STEP ** i <= 400 * 1.0001; i++) ds.push(AIR_D0 * AIR_STEP ** i);
  // Fixed starts (a deterministic grid over both sections' pole and zero), then a forward pass warm-started from
  // the previous distance's fit and a backward pass from the next one's; each distance keeps its best.
  const grid: number[][] = [];
  for (const p1 of [0.5, 1.5, 2.5]) for (const z1 of [-1, 0.5, 2]) grid.push([p1, z1, p1 + 0.7, z1 - 0.8]);
  const best = ds.map((d) => {
    const f = (x: number[]) => airError(x, d);
    let b = { x: grid[0]!, fx: Infinity };
    for (const x0 of grid) { const r = nelderMead(f, x0, 0.5, 1500); if (r.fx < b.fx) b = r; }
    return b;
  });
  for (const order of [ds.map((_, i) => i), ds.map((_, i) => ds.length - 1 - i)]) {
    for (let k = 1; k < order.length; k++) {
      const i = order[k]!, j = order[k - 1]!, f = (x: number[]) => airError(x, ds[i]!);
      const r = nelderMead(f, best[j]!.x, 0.2);
      if (r.fx < best[i]!.fx) best[i] = r;
    }
  }
  return ds.map((d, i) => { const r = nelderMead((x) => airError(x, d), best[i]!.x, 0.02); return { d, p: r.fx < best[i]!.fx ? r.x : best[i]!.x, err: Math.min(r.fx, best[i]!.fx) }; });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kv = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=') as [string, string]));
  const rows = fitAir();
  const body = rows.map((r) => `  [${r.p.map((v) => v.toFixed(6)).join(', ')}], // ${r.d.toFixed(2)} m, worst ${r.err.toFixed(2)} dB`).join('\n');
  writeFileSync(kv.out ?? new URL('./air-table.ts', import.meta.url).pathname,
    `// Written by air-cli.ts (do not edit): the air filter's fit per distance (air.ts), AIR_D0 x AIR_STEP^i m.\n// Each row: tanh^-1 of [pole 1, zero 1, pole 2, zero 2]; the comment: its distance and worst error against ISO 9613-1.\nexport const AIR_TABLE: readonly (readonly [number, number, number, number])[] = [\n${body}\n];\n`);
  console.log(`${rows.length} rows; worst ${Math.max(...rows.map((r) => r.err)).toFixed(2)} dB; at 25/50/100/200 m: ${[25, 50, 100, 200].map((d) => rows.reduce((a, r) => (Math.abs(r.d - d) < Math.abs(a.d - d) ? r : a)).err.toFixed(2)).join(' ')}`);
}
