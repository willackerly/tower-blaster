// PROBE (branch claude/project-thread-qw97yn, draft PR, not for main). E4b: why S5 at 10k with Bounce 0.5 and the energy cap needed
// 316,789 broadphase pairs on 9 of 3120 steps on the M5 (bench m5-d83eb15-e4b-cap). Runs S5 as the bench did
// (cap, nocap, bounce off) and writes a per-20-step summary to S5_PROBE_OUT (default s5-probe.log in the repo).
// On the Mac: REQUIRE_WEBGPU=1 npx vitest run packages/physics-gpu/test/zz-s5-probe.test.ts
import { it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { buildScenario } from '@tb/scenarios';
import { ON, withE } from './bounce.ts';
import { call, gpu } from './harness.ts';

it('S5 probe', { timeout: 6_000_000 }, async (ctx) => {
  if (!gpu) return ctx.skip();
  const out = process.env.S5_PROBE_OUT ?? 's5-probe.log';
  const N = Number(process.env.S5N ?? 10000), steps = Number(process.env.S5STEPS ?? 3120), every = Number(process.env.S5EVERY ?? 20);
  writeFileSync(out, `S5 probe N ${N} steps ${steps} every ${every} ${new Date().toISOString()} ${navigator.userAgent}\n`);
  const base = buildScenario('S5', { N, F: 8, H: 25, street: 6, radius: 2, speed: 20, massRatio: 10, fireStep: 60 }, 1);
  for (const [name, scene, p] of [['cap', withE(base, 0.5), ON], ['nocap', withE(base, 0.5), { ...ON, restitutionEnergyCap: false }], ['b0', base, {}]] as const) {
    const r = await call('summaryRun', scene, steps, p, every);
    appendFileSync(out, `${name}: error ${r.error} peak ${r.final.pairsRequiredPeak} of ${r.final.maxPairs} overflowSteps ${r.final.pairsOverflowSteps} sleepSkipped ${r.final.sleepSkippedSteps} wall ${(r.wallMs / steps).toFixed(2)} ms/step\n`);
    for (const x of r.rows) appendFileSync(out, `  ${name} ${x.step} vmax ${x.vmax.toFixed(1)} fast ${x.fast} awake ${x.awake} top ${x.top.toFixed(1)} v2sum ${x.v2sum.toFixed(0)} pairs ${x.pairs} bounced ${x.contacts} capped ${x.capped} alpha ${x.capAlpha.toFixed(3)}\n`);
  }
});
