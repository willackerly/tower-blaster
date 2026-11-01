// The GPU pair buffer's default (DEFAULT_PAIRS_PER_BODY, 16 per body) against
// the most any scene at its defaults was measured to need (docs/plan.md, GPU
// pair buffer). At rest a packed unit-cube tower pairs each cube with its 26
// neighbours only, and the default grenade's blast inside the default S1
// tower, the worst case measured (13.5 per body), drops no pair at the
// tightest room any path builds: capacity = bodies, as the bench builds it
// (the viewer adds 256 spare bodies, and the game holds every pair). In a
// file of its own: 300 steps of 1920 cubes take about 90 s on SwiftShader.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import { DEFAULT_GRENADE } from '@tb/weapons';
import { DEFAULT_PAIRS_PER_BODY } from '../src/index.ts';
import { gpu, runGpu } from './harness.ts';

const { F, H } = SCENARIOS.S1!.defaults as { F: number; H: number };
// Pairs of an F x F x H block of cubes one lattice step apart on every axis (the 26 neighbours), each pair once.
const latticePairs = ((3 * F - 2) ** 2 * (3 * H - 2) - F * F * H) / 2;

describe('GPU pair buffer: the default holds the worst default case', () => {
  it('a packed tower at rest pairs each cube with its 26 neighbours only, 13 per body at most', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await runGpu(buildScenario('S1', {}, 1), 1);
    // 20,336 for the default 8 x 8 x 30 tower, 10.6 per body: the resting sweep and margin reach the
    // corner neighbours (sqrt 3 apart) and not the next ones (2 apart).
    expect(r.final.pairsRequired).toBe(latticePairs);
  });

  it('the default grenade\'s blast inside it drops no pair at the default buffer, capacity = bodies', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const tower = buildScenario('S1', {}, 1);
    const scene: SceneDesc = { ...tower, inputs: [...tower.inputs, { step: 10, kind: 'blast', blast: { centre: [0, 15, 0], ...DEFAULT_GRENADE.blast } }] };
    // runGpu fails on any of the 300 steps that dropped pairs (the sticky counter). Upper courses fall
    // onto the debris well after the blast, so the whole window runs.
    const r = await runGpu(scene, 300);
    expect(r.final.maxPairs).toBe(DEFAULT_PAIRS_PER_BODY * tower.bodies.length);
    // The blast did raise the demand: measured 25,852 pairs at the peak (13.5 per body) against 30,720 slots.
    expect(r.final.pairsRequiredPeak).toBeGreaterThan(1.2 * latticePairs);
    console.log(`S1 with the default grenade inside: peak ${r.final.pairsRequiredPeak} pairs (${(r.final.pairsRequiredPeak / tower.bodies.length).toFixed(2)} per body) of ${r.final.maxPairs}`);
  });
});
