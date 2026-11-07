// Two guards against a restitution pass that throws a body (2026-11-06, S5 at 10k with Bounce 0.5 on SwiftShader:
// at step 592 the pass threw a resting ground cube to about 220 km/s, and the energy cap scaled it only to
// 2,498 m/s, 3.4 times its island's bound; the scene blew up from there).
// - The jam guard, AvbdParams.restitutionAnchorCut (restitute() in physics-ref, "Jam guard"; resp() in
//   src/restitution.ts): a row the anchors hold all but a fraction f of takes no bounce below the cut, so no row
//   moves a seated body more than 1/f times as fast as a free row would. Held here against the reference.
// - The energy cap's range (src/restitution.ts, "Energy cap"): a term outside the fixed point's range, or a sum
//   that wraps, makes the island's alpha 0 instead of an alpha from clamped sums.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { RESTITUTION_DEFAULTS } from '@tb/physics-ref';
import { ball, both, cube, gpuRun, islandExcess, ON, type Run, sceneOf, speed } from './bounce.ts';
import { gpu } from './harness.ts';

/** A 2-cube column (yawed, a little off line) and a 50 kg ball at 5.1 m/s, spawned at step 30, at its top cube from above; e 0.6 everywhere. */
function column(): SceneDesc {
  const e = 0.6, yaw = (a: number): [number, number, number, number] => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const bodies = [cube([0.088107, 0.5, 0.014114], { e, rot: yaw(-0.196) }), cube([0.002009, 1.5, -0.050612], { e, rot: yaw(-0.2795) })];
  const b = ball([-1.331438, 2.281974, -0.460762], { e, mass: 50, radius: 0.4958, linVel: [4.536048, -1.753703, 1.569759] });
  return { ...sceneOf(bodies, { groundE: e }), inputs: [{ step: 30, kind: 'spawn', body: b }] };
}
/** The fastest of the first n bodies over the run, and the step. */
const fastest = (r: Run, n: number) => {
  let v = 0, at = 0;
  r.snaps.forEach((s, k) => { for (let i = 0; i < n; i++) if (speed(s, i) > v) { v = speed(s, i); at = k; } });
  return { v, at };
};

describe('GPU AVBD engine: restitution jam guards', () => {
  // Measured with the energy cap on (the default; reference, GPU within 2e-3 m/s at 0.03): at the default cut neither
  // cube passes 8.6 m/s; at 0.03 (and at 1e-4, the cut before the guard) the pass throws the top cube at 32.7 m/s on
  // step 46 (34.4 with the cap off: the 50 kg ball's energy pays for it). Before the GPU's sums left out each side's
  // cut rows (RestSlot.linA), its update projected them anyway: 29.8 m/s at the default cut.
  it('a heavy ball onto a seated 2-cube column: the default cut throws neither cube, as the reference; a cut of 0.03 throws the top one at 6.7 v', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = column();
    const at = async (cut: number) => {
      const r = await both(scene, 90, { ...ON, restitutionAnchorCut: cut });
      const g = fastest(r.gpu, 2), f = fastest(r.ref, 2);
      return { g, f };
    };
    const guarded = await at(RESTITUTION_DEFAULTS.restitutionAnchorCut), old = await at(0.03);
    expect(guarded.f.v).toBeLessThan(10);
    expect(guarded.g.v).toBeLessThan(10);
    expect(old.f.v).toBeGreaterThan(30);
    expect(old.g.v).toBeGreaterThan(30);
    expect(Math.abs(old.g.v - old.f.v)).toBeLessThan(0.1);
    expect(old.g.at).toBe(old.f.at);
  });

  // A 3e6 kg ball at 25 m/s onto the ground (e 0.9): the first steps it touches, the pass would turn it around
  // (du about 47 m/s), whose Q term (m du.du, about 7e9 J) is past the fixed point's 2^29 J, so its island's alpha is
  // 0 and it keeps the solve's velocity, which the host's energies confirm (islandExcess); without the range check
  // (islandAlpha's first line removed) the clamped sums let the whole bounce through (alpha 1). A 1e5 kg ball's
  // terms fit (Q about 1.5e8 J): it bounces, alpha 1.
  it('an island whose energy terms leave the fixed point\'s range gets alpha 0, not an alpha from clamped sums; within range, alpha as before', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const drop = (mass: number, v: number): SceneDesc => sceneOf([ball([0, 0.5 + v / 20, 0], { e: 0.9, mass, linVel: [0, -v, 0] })], { groundE: 0.9 });
    for (const [mass, v, out] of [[3e6, 25, true], [1e5, 20, false]] as const) {
      const scene = drop(mass, v), r = await gpuRun(scene, 12, ON, {}, true), id = `${mass} kg`;
      // The first step the pass marked a bounce: capped (alpha < 1) or bounced (an impulse).
      const k = r.stats.findIndex((s) => (s?.capped ?? 0) > 0 || (s?.contacts ?? 0) > 0);
      expect(k, id).toBeGreaterThanOrEqual(0);
      const st = r.stats[k]!, after = r.snaps[k + 1]!.linVel[1]!, solved = r.solved![k]!.linVel[1]!;
      if (out) {
        expect(st.capped, id).toBe(1);
        expect(st.capAlpha, id).toBe(0);
        expect(st.contacts, id).toBe(0);
        expect(after, id).toBe(solved);
      } else {
        expect(st.capped, id).toBe(0);
        expect(after, id).toBeGreaterThan(0.8 * v);
      }
      expect(islandExcess(scene, r).worst, id).toBeLessThanOrEqual(1e-5);
    }
  });
});
