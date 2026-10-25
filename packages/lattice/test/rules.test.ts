import { describe, expect, it } from 'vitest';
import {
  type BodyDesc, type BodyMode, type HostBatch, type HostCaps, type HostState, type HostWorld, MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type PhysicsHost, type Vec3,
} from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { type TransitionCause, TIER_ACTIVE, TIER_LATTICE, TieredEngine } from '../src/index.ts';

/**
 * A host that simulates nothing: dynamic bodies stay at rest where they were
 * put, and each step reports the contact forces the test scripts. It isolates
 * the W3 force rule from solver noise.
 */
class ScriptedHost implements PhysicsHost {
  readonly info = { name: 'scripted', variant: {}, backend: 'none' };
  caps: HostCaps = { capacity: 0, stateLag: 0, contactForces: true, latticeNative: true };
  private modes: BodyMode[] = [];
  private pose = new Map<number, { pos: Vec3; rot: [number, number, number, number] }>();
  private steps = 0;
  /** Forces on static ids reported by the next read(). */
  next = new Map<number, Vec3>();

  async init(_w: HostWorld, table: readonly BodyDesc[]): Promise<void> {
    this.caps = { ...this.caps, capacity: table.length };
    this.modes = table.map(() => MODE_OFF);
    table.forEach((b, id) => this.pose.set(id, { pos: b.pos, rot: b.rot }));
  }
  apply(batch: HostBatch): void {
    for (const c of batch.cells ?? []) if (c.id >= 0) this.modes[c.id] = MODE_STATIC;
    for (const c of batch.changes) {
      this.modes[c.id] = c.mode;
      if (c.pos && c.rot) this.pose.set(c.id, { pos: c.pos, rot: c.rot });
    }
  }
  step(): void { this.steps++; }
  read(): HostState {
    const ids = this.modes.flatMap((m, id) => (m === MODE_DYNAMIC ? [id] : []));
    const n = ids.length;
    const pos = new Float64Array(3 * n), rot = new Float64Array(4 * n);
    ids.forEach((id, k) => { const p = this.pose.get(id)!; pos.set(p.pos, 3 * k); rot.set(p.rot, 4 * k); });
    const forced = [...this.next.keys()].sort((a, b) => a - b);
    const force = new Float64Array(3 * forced.length), magnitude = new Float64Array(forced.length);
    forced.forEach((id, k) => { const f = this.next.get(id)!; force.set(f, 3 * k); magnitude[k] = Math.hypot(...f); });
    this.next.clear();
    return {
      step: this.steps, ids: Int32Array.from(ids), pos, rot, linVel: new Float64Array(3 * n), angVel: new Float64Array(3 * n), awake: new Uint8Array(n).fill(1),
      contacts: { ids: Int32Array.from(forced), force, magnitude },
    };
  }
  current(): HostState { const s = this.read(); return s; }
  /** Move a body as if the solver had. */
  place(id: number, pos: Vec3): void { this.pose.set(id, { ...this.pose.get(id)!, pos }); }
  modeOf(id: number): BodyMode { return this.modes[id]!; }
  dispose(): void {}
}

async function settledCube() {
  // One cube on the ground: column weight 9.81 N, friction 0.6, so with
  // kappa 0.8 and forceMin 2 it holds 0.48 * (load from above + 9.81) + 2 N sideways.
  const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
  const host = new ScriptedHost();
  const e = new TieredEngine(host);
  const log: TransitionCause[] = [];
  e.onTransition = (_id, _to, cause) => log.push(cause);
  await e.init(scene);
  e.wakeSphere(scene.bodies[0]!.pos, 0.1);
  for (let s = 0; s <= e.p.minActiveSteps + 1; s++) await e.step();
  expect(log).toEqual(['command', 'settle']);
  const push = async (f: Vec3) => { host.next.set(0, f); await e.step(); return e.tier[0]; };
  return { e, log, push };
}

describe('settle snaps', () => {
  it('are refused when they would push a cube into a moving neighbour, and allowed when clear', async () => {
    for (const ballX of [0.985, 1.2]) {
      // The cube sits 1.5 cm off its cell in -x; a ball touches its +x face.
      const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
      scene.bodies.push({ ...scene.bodies[0]!, shape: { kind: 'sphere', radius: 0.5 }, pos: [ballX, 0.5, 0] });
      const host = new ScriptedHost();
      const e = new TieredEngine(host);
      await e.init(scene);
      e.wakeSphere(scene.bodies[0]!.pos, 0.1);
      await e.step();
      host.place(0, [-0.015, 0.5, 0]);
      for (let s = 0; s < 2 * e.p.minActiveSteps; s++) await e.step();
      expect(e.tier[0], `ball at x = ${ballX}`).toBe(ballX < 1 ? TIER_ACTIVE : TIER_LATTICE);
    }
  });
});

describe('W3 force wakes after a settle', () => {
  it('the first force after settling is the reference and never wakes', async () => {
    const { push } = await settledCube();
    expect(await push([-300, -98, 0])).toBe(TIER_LATTICE);
  });

  it('a held sideways load that reverses within capacity does not wake (measured case: -40 N to +30 N under 10 cubes of rubble)', async () => {
    const { push, log } = await settledCube();
    expect(await push([-40, -97.6, 10.8])).toBe(TIER_LATTICE);
    // Change since the reference: 70.6 N > capacity 67.6 N; total: 30.4 N, well held.
    expect(await push([30.4, -126.9, 1])).toBe(TIER_LATTICE);
    expect(log).toEqual(['command', 'settle']);
  });

  it('a total over capacity that the cube already carried when it settled does not wake', async () => {
    const { push } = await settledCube();
    expect(await push([-80, -98, 0])).toBe(TIER_LATTICE);
    expect(await push([-80, -98, 0])).toBe(TIER_LATTICE); // 80 N > 53.7 N capacity, but unchanged
  });

  it('a push that takes both the total and the change over capacity wakes', async () => {
    const { push, log } = await settledCube();
    expect(await push([-40, -98, 0])).toBe(TIER_LATTICE);
    expect(await push([-100, -98, 0])).toBe(TIER_ACTIVE); // total 100 N and change 60 N > 53.7 N
    expect(log.at(-1)).toBe('force');
  });

  it('a cell that never settled has no reference: the total alone decides', async () => {
    const scene = buildScenario('S1', { F: 1, H: 1 }, 1);
    const host = new ScriptedHost();
    const e = new TieredEngine(host);
    await e.init(scene);
    host.next.set(0, [-50, 0, 0]); // capacity with no load from above: 0.48 * 9.81 + 2 = 6.7 N
    await e.step();
    expect(e.tier[0]).toBe(TIER_ACTIVE);
  });
});
