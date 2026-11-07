// Opt-in diagnostic (S5_PROBE=1; CI skips it): the S5 10k city struck with Bounce, watched for a blow-up. At
// e 0.5 with the energy cap, SwiftShader runs blow up hundreds of steps after the shot (2026-11-06: one cube
// thrown from 3 to 43 m/s by the restitution pass in a 6,274-body island at step 490 in a cloud container; first
// body over 40 m/s at step 592 on the Mac's SwiftShader; without the cap at step 311). watchRun (page.ts) logs
// every step around the onset and splits each step's change of semi-implicit Euler's invariant energy into the
// solve's and the restitution pass's, with the worst island excess over the cap's bound and the body that gained
// most, so the log says which part added the energy. Each mode's line names the adapter: with TB_CHANNEL=chrome a
// software one is an error under REQUIRE_WEBGPU=1 (testkit openWebGPU).
//   S5_PROBE=1 TB_CHANNEL=chrome REQUIRE_WEBGPU=1 npx vitest run packages/physics-gpu/test/s5-blowup-probe.test.ts
// Writes S5_PROBE_OUT (default s5-probe.log in the working directory). Options: S5MODES (cap,nocap; also b0, bounce
// off), S5N (10000), S5STEPS (3120), S5EVERY (20: a row every 20 steps), S5FROM/S5TO (560/600: every step between),
// S5THRESH (40 m/s: every step from the first one past it), S5AFTER (25: steps after that, then stop).
import { it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { buildScenario } from '@tb/scenarios';
import { ON, withE } from './bounce.ts';
import { call, gpu } from './harness.ts';

it('S5 blow-up probe', { timeout: 6_000_000 }, async (ctx) => {
  if (!gpu || process.env.S5_PROBE !== '1') return ctx.skip();
  const env = (k: string, d: number) => Number(process.env[k] ?? d);
  const out = process.env.S5_PROBE_OUT ?? 's5-probe.log';
  const N = env('S5N', 10000), steps = env('S5STEPS', 3120);
  const o = { every: env('S5EVERY', 20), from: env('S5FROM', 560), to: env('S5TO', 600), thresh: env('S5THRESH', 40), after: env('S5AFTER', 25) };
  const modes = (process.env.S5MODES ?? 'cap,nocap').split(',');
  writeFileSync(out, `S5 blow-up probe N ${N} steps ${steps} ${JSON.stringify(o)} ${new Date().toISOString()} adapter ${gpu.adapter.vendor} ${gpu.adapter.architecture}\n`);
  const base = buildScenario('S5', { N, F: 8, H: 25, street: 6, radius: 2, speed: 20, massRatio: 10, fireStep: 60 }, 1);
  const runs = { cap: [withE(base, 0.5), ON], nocap: [withE(base, 0.5), { ...ON, restitutionEnergyCap: false }], b0: [base, {}] } as const;
  for (const name of modes) {
    const [scene, p] = runs[name as keyof typeof runs];
    const r = await call('watchRun', scene, steps, p, o);
    appendFileSync(out, `${name}: adapter ${r.adapterText} error ${r.error} first vmax>${o.thresh} at ${r.hit} peak ${r.final.pairsRequiredPeak} of ${r.final.maxPairs} overflowSteps ${r.final.pairsOverflowSteps} wall ${r.wallMs.toFixed(0)} ms\n`);
    for (const l of r.lines) appendFileSync(out, `  ${name} ${l}\n`);
  }
});
