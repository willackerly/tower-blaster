// PROBE (branch claude/project-thread-qw97yn, draft PR, not for main). E4b: S5 at 10k with Bounce 0.5 explodes on
// Metal even with the energy cap (s5-probe.log at 91eb299: calm to step 580, then 844 m/s and 8190 fast bodies by
// 600, the cap scaling nothing at the sampled steps). watchRun (page.ts) logs every step around the onset and splits
// each step's energy change into the solve's and the pass's, with the worst island excess, so the log says which one
// added the energy and whether the cap held. Writes to S5_PROBE_OUT (default s5-probe2.log in the repo).
// Opt-in (S5_PROBE=1), so CI skips it. On the Mac:
//   S5_PROBE=1 REQUIRE_WEBGPU=1 npx vitest run packages/physics-gpu/test/zz-s5-probe.test.ts
// Optional: S5MODES=cap,nocap,b0 (default cap,nocap), S5N, S5STEPS (3120), S5EVERY (20), S5FROM/S5TO (560/600: every
// step logged), S5THRESH (40 m/s: from the first step past it, every step), S5AFTER (25 steps after that, then stop).
import { it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { buildScenario } from '@tb/scenarios';
import { ON, withE } from './bounce.ts';
import { call, gpu } from './harness.ts';

it('S5 probe', { timeout: 6_000_000 }, async (ctx) => {
  if (!gpu || process.env.S5_PROBE !== '1') return ctx.skip();
  const env = (k: string, d: number) => Number(process.env[k] ?? d);
  const out = process.env.S5_PROBE_OUT ?? 's5-probe2.log';
  const N = env('S5N', 10000), steps = env('S5STEPS', 3120);
  const o = { every: env('S5EVERY', 20), from: env('S5FROM', 560), to: env('S5TO', 600), thresh: env('S5THRESH', 40), after: env('S5AFTER', 25) };
  const modes = (process.env.S5MODES ?? 'cap,nocap').split(',');
  writeFileSync(out, `S5 probe2 N ${N} steps ${steps} ${JSON.stringify(o)} ${new Date().toISOString()}\n`);
  const base = buildScenario('S5', { N, F: 8, H: 25, street: 6, radius: 2, speed: 20, massRatio: 10, fireStep: 60 }, 1);
  const runs = { cap: [withE(base, 0.5), ON], nocap: [withE(base, 0.5), { ...ON, restitutionEnergyCap: false }], b0: [base, {}] } as const;
  for (const name of modes) {
    const [scene, p] = runs[name as keyof typeof runs];
    const r = await call('watchRun', scene, steps, p, o);
    appendFileSync(out, `${name}: adapter ${r.adapterText} error ${r.error} first vmax>${o.thresh} at ${r.hit} peak ${r.final.pairsRequiredPeak} of ${r.final.maxPairs} overflowSteps ${r.final.pairsOverflowSteps} wall ${r.wallMs.toFixed(0)} ms\n`);
    for (const l of r.lines) appendFileSync(out, `  ${name} ${l}\n`);
  }
});
