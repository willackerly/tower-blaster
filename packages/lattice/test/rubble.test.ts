import { describe, expect, it } from 'vitest';
import { type BodyDesc, MODE_STATIC, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { checkTiers, TIER_ACTIVE, TIER_LATTICE, TIER_RUBBLE, TieredEngine, type TransitionCause } from '../src/index.ts';
import { RapierHost } from '@tb/adapter-rapier';
import { TIER } from '@tb/schema';
import { ScriptedHost } from './scripted-host.ts';

// One lattice cube at the origin (id 0) plus balls that start active. The
// scripted host never moves anything, so every transition is the rules'.
function scene(balls: Array<{ pos: Vec3; vel?: Vec3 }>): SceneDesc {
  const s = buildScenario('S1', { F: 1, H: 1 }, 1);
  const cube = s.bodies[0]!;
  for (const b of balls) s.bodies.push({ ...cube, shape: { kind: 'sphere', radius: 0.5 }, pos: b.pos, linVel: b.vel ?? [0, 0, 0] } satisfies BodyDesc);
  return s;
}

async function start(s: SceneDesc) {
  const host = new ScriptedHost();
  const e = new TieredEngine(host);
  const log: Array<{ id: number; cause: TransitionCause }> = [];
  e.onTransition = (id, _to, cause) => log.push({ id, cause });
  await e.init(s);
  const steps = async (n: number) => {
    for (let k = 0; k < n; k++) { await e.step(); expect(await checkTiers(e)).toEqual([]); }
  };
  return { e, host, log, steps };
}

describe('rubble', () => {
  it('quiet bodies freeze in place bottom-up, each recording what it rests on', async () => {
    // Ball 1 on the ground, ball 2 on ball 1, ball 3 on the lattice cube.
    const { e, host, steps } = await start(scene([{ pos: [3, 0.5, 0] }, { pos: [3, 1.5, 0] }, { pos: [0, 1.5, 0] }]));
    await steps(e.p.minActiveSteps); // a body may come to rest after minActiveSteps active
    expect([1, 2, 3].map((id) => e.tier[id])).toEqual([TIER_ACTIVE, TIER_ACTIVE, TIER_ACTIVE]);
    expect(Array.from((await e.snapshot()).tier!)).toEqual([TIER.lattice, TIER.active, TIER.active, TIER.active]);
    await steps(1);
    expect([1, 2, 3].map((id) => e.tier[id])).toEqual([TIER_RUBBLE, TIER_RUBBLE, TIER_RUBBLE]);
    expect(e.supporters.get(1)).toEqual([]);
    expect(e.supporters.get(2)).toEqual([1]);
    expect(e.supporters.get(3)).toEqual([0]);
    for (const id of [1, 2, 3]) expect(host.modeOf(id)).toBe(MODE_STATIC);
    const snap = await e.snapshot();
    expect(Array.from(snap.pos.subarray(6, 9))).toEqual([3, 1.5, 0]);
    expect(Array.from(snap.tier!)).toEqual([TIER.lattice, TIER.rubble, TIER.rubble, TIER.rubble]);
    expect(e.stats.rubble).toBe(3);
    expect(e.stats.active).toBe(0);
  });

  it('freezes a body at the pose it recorded, even where the host has moved on (state lag)', async () => {
    // The host reports ball 1 lagging 3 mm behind where it really is.
    class Lagging extends ScriptedHost {
      override read() {
        const s = super.read();
        for (let n = 0; n < s.ids.length; n++) if (s.ids[n] === 1) s.pos[3 * n] = s.pos[3 * n]! - 0.003;
        return s;
      }
    }
    const host = new Lagging();
    const e = new TieredEngine(host);
    await e.init(scene([{ pos: [3, 0.5, 0] }]));
    for (let k = 0; k <= e.p.minActiveSteps && e.tier[1] !== TIER_RUBBLE; k++) await e.step();
    expect(e.tier[1]).toBe(TIER_RUBBLE);
    expect(host.modeOf(1)).toBe(MODE_STATIC);
    expect(host.poseOf(1).pos).toEqual([2.997, 0.5, 0]);
    expect(Array.from(e.rubblePos.subarray(3, 6))).toEqual([2.997, 0.5, 0]);
    expect(Array.from((await e.snapshot()).pos.subarray(3, 6))).toEqual([2.997, 0.5, 0]);
  });

  it('thaws what rests on a body that moves (T1), transitively', async () => {
    const { e, log, steps } = await start(scene([{ pos: [3, 0.5, 0] }, { pos: [3, 1.5, 0] }, { pos: [0, 1.5, 0] }]));
    await steps(e.p.minActiveSteps + 1);
    log.length = 0;
    e.wakeSphere([3, 0.5, 0], 0.1); // ball 1 only
    await steps(1);
    expect(log).toEqual([{ id: 1, cause: 'command' }, { id: 2, cause: 'support' }]);
    e.wakeSphere([0, 0.5, 0], 0.1); // the lattice cube under ball 3
    await steps(1);
    expect(log.slice(2)).toEqual([{ id: 0, cause: 'command' }, { id: 3, cause: 'support' }]);
    expect(e.tier[0]).toBe(TIER_ACTIVE);
  });

  it('thaws on a force over capacity (T3), using the post-freeze force as reference', async () => {
    const { e, host, log, steps } = await start(scene([{ pos: [3, 0.5, 0] }]));
    await steps(e.p.minActiveSteps + 1);
    expect(e.tier[1]).toBe(TIER_RUBBLE);
    // Ball weight 0.52 kg * 9.81 = 5.1 N; with 5 N from above it holds 0.48 * 10.1 + 2 = 6.9 N.
    const push = async (f: Vec3) => { host.next.set(1, f); await steps(1); return e.tier[1]; };
    expect(await push([-6, -5, 0])).toBe(TIER_RUBBLE); // reference
    expect(await push([-6, -5, 0])).toBe(TIER_RUBBLE); // carried when it froze
    // Total 14 N, change 8 N: it must hold for rubbleForceSteps consecutive steps.
    for (let k = 1; k < e.p.rubbleForceSteps; k++) expect(await push([-14, -5, 0])).toBe(TIER_RUBBLE);
    expect(await push([-14, -5, 0])).toBe(TIER_ACTIVE);
    expect(log.at(-1)).toEqual({ id: 1, cause: 'force' });
  });

  it('counts the rubble resting on a body in its capacity, and never slides it into something at rest', async () => {
    // Ball 1 alone holds 0.48 * 5.1 + 2 = 4.5 N sideways; with ball 2 on it, 0.48 * 10.3 + 2 = 6.9 N.
    for (const [stacked, thaws] of [[false, true], [true, false]] as const) {
      const { e, host, steps } = await start(scene([{ pos: [3, 0.5, 0] }, { pos: stacked ? [3, 1.5, 0] : [9, 0.5, 0] }]));
      await steps(e.p.minActiveSteps + 1);
      host.next.set(1, [0, 0, 0]);
      await steps(1); // reference
      for (let k = 0; k < e.p.rubbleForceSteps; k++) { host.next.set(1, [-6, 0, 0]); await steps(1); }
      expect(e.tier[1], stacked ? 'with ball 2 on it' : 'alone').toBe(thaws ? TIER_ACTIVE : TIER_RUBBLE);
    }
    // Ball 2 frozen beside ball 1 in +x: a +x push goes into it; a -x push slides ball 1.
    for (const [fx, thaws] of [[20, false], [-20, true]] as const) {
      const { e, host, steps } = await start(scene([{ pos: [3, 0.5, 0] }, { pos: [4, 0.5, 0] }]));
      await steps(e.p.minActiveSteps + 1);
      host.next.set(1, [0, 0, 0]);
      await steps(1);
      for (let k = 0; k < e.p.rubbleForceSteps; k++) { host.next.set(1, [fx, 0, 0]); await steps(1); }
      expect(e.tier[1], `push ${fx} N`).toBe(thaws ? TIER_ACTIVE : TIER_RUBBLE);
    }
  });

  it('counts slow creep as rest and steady motion as not', async () => {
    // Ball radius 0.5, restDrift 0.02: at most 1 cm in any restSteps (0.5 s) window.
    for (const [speed, freezes] of [[0.01, true], [0.04, false]] as const) {
      const { e, host, steps } = await start(scene([{ pos: [3, 0.5, 0] }]));
      for (let k = 0; k <= e.p.minActiveSteps + e.p.restSteps; k++) {
        if (e.tier[1] !== TIER_ACTIVE) break;
        host.place(1, [3 + speed * k * (1 / 60), 0.5, 0]);
        host.vel.set(1, [speed, 0, 0]);
        await steps(1);
      }
      expect(e.tier[1], `${speed} m/s`).toBe(freezes ? TIER_RUBBLE : TIER_ACTIVE);
    }
  });

  it('thaws when a body closes in fast enough to move it (T2), not when one slides past', async () => {
    for (const [vel, thaws] of [[[-2, 0, 0], true], [[0, 0, 2], false], [[-0.4, 0, 0], false]] as Array<[Vec3, boolean]>) {
      // Ball 2 keeps moving (never quiet), far away until it is placed against ball 1.
      const { e, host, steps } = await start(scene([{ pos: [3, 0.5, 0] }, { pos: [9, 0.5, 0], vel: [0, 0, 1] }]));
      await steps(e.p.minActiveSteps + 1);
      expect(e.tier[1]).toBe(TIER_RUBBLE);
      host.place(2, [4.01, 0.5, 0]);
      host.vel.set(2, vel);
      await steps(1);
      // Closing at 2 m/s shares 1 m/s >= vWake; 0.4 m/s shares 0.2 < vWake; sliding past closes at 0.
      expect(e.tier[1], `ball 2 at ${vel}`).toBe(thaws ? TIER_ACTIVE : TIER_RUBBLE);
    }
  });

  it('does not freeze a body on top of one that is still moving', async () => {
    const { e, steps } = await start(scene([{ pos: [3, 0.5, 0], vel: [0, 0, 1] }, { pos: [3, 1.5, 0] }]));
    await steps(2 * e.p.minActiveSteps);
    expect(e.tier[2]).toBe(TIER_ACTIVE);
    expect(e.tier[0]).toBe(TIER_LATTICE);
  });

  it('after a ball shot on Rapier without host sleep, the piles freeze and nothing floats', { timeout: 60_000 }, async () => {
    // Rubble is the tiers' own sleep for hosts that have none (the GPU host);
    // all-dynamic Rapier with sleep off has 1 body over 5 cm/s by 1,200 steps.
    const s = buildScenario('S5', { N: 1024, F: 4, H: 16, radius: 1, speed: 20, fireStep: 2 }, 1);
    s.sleep = false;
    const e = new TieredEngine(new RapierHost());
    const changes = new Int32Array(s.bodies.length + 1);
    e.onTransition = (id) => changes[id]!++;
    await e.init(s);
    const T = 900;
    for (let k = 1; k <= T; k++) {
      await e.step();
      if (k % 30 === 0) expect(await checkTiers(e), `step ${k}`).toEqual([]);
    }
    expect(e.stats.active).toBeLessThanOrEqual(1); // at most the ball, rolling away (it may also come to rest and freeze)
    expect(e.stats.rubble).toBeGreaterThan(600);
    // No backoff on freezing, only the rate limit: at most 2 T / minActiveSteps + 1 changes per body.
    expect(Math.max(...changes)).toBeLessThanOrEqual(2 * T / e.p.minActiveSteps + 1);
    e.dispose();
  });

  it('reports each body\'s tier in the snapshot, and a body outside the active tier keeps its exact state until its tier changes', { timeout: 60_000 }, async () => {
    // What the renderer relies on to upload only active bodies and tier changes.
    const s = buildScenario('S5', { N: 1024, F: 4, H: 16, radius: 1, speed: 20, fireStep: 2 }, 1);
    const e = new TieredEngine(new RapierHost());
    await e.init(s);
    let prev = await e.snapshot(), held = 0, seen = new Set<number>();
    for (let k = 1; k <= 400; k++) {
      await e.step();
      const cur = await e.snapshot();
      expect(cur.tier!.length).toBe(cur.count);
      for (let id = 0; id < prev.count; id++) {
        const t = cur.tier![id]!;
        seen.add(t);
        if (t === TIER.active || t !== prev.tier![id]) continue;
        held++;
        const same = (a: Float64Array, b: Float64Array, w: number) => a.subarray(w * id, w * id + w).every((x, q) => x === b[w * id + q]);
        expect(same(cur.pos, prev.pos, 3) && same(cur.rot, prev.rot, 4), `body ${id} at step ${k}`).toBe(true);
        expect([...cur.linVel.subarray(3 * id, 3 * id + 3), ...cur.angVel.subarray(3 * id, 3 * id + 3), cur.awake[id]]).toEqual([0, 0, 0, 0, 0, 0, 0]);
      }
      prev = cur;
    }
    expect([...seen].sort()).toEqual([TIER.active, TIER.rubble, TIER.lattice]);
    expect(held).toBeGreaterThan(100_000);
    e.dispose();
  });
});
