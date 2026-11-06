// RapierEngine.checkpoint() (engine-api EngineCheckpoint; the game's undo on ?engine=rapier): after
// a checkpoint, a different future, then restore(), the engine steps bit for bit as the run that
// never left, every snapshot field at every step, with inputs pending at the checkpoint (a removal,
// a blast, a spawn) and the sleep the scene allows.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, InputEvent, SceneDesc, Snapshot, Vec3 } from '@tb/engine-api';
import { RapierEngine } from '../src/index.ts';

const cube = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0,
});
const ball = (pos: Vec3, linVel: Vec3): BodyDesc => ({
  shape: { kind: 'sphere', radius: 0.4 }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 4, friction: 0.4, restitution: 0.3, tag: -1,
});
const columns = (k: number): BodyDesc[] => [0, 1.02].flatMap((x) => Array.from({ length: k }, (_, j) => cube([x, 0.5 + j, 0])));
const scene: SceneDesc = {
  id: 'checkpoint', params: {}, seed: 1, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6, restitution: 0.1 }, sleep: true,
  bodies: columns(6),
  inputs: [
    { step: 4, kind: 'spawn', body: ball([-4, 2.5, 0], [14, 1, 0]) },
    { step: 30, kind: 'remove', id: 1 },
    { step: 36, kind: 'blast', blast: { centre: [1, 1.5, 0.8], radius: 2, impulse: 3 } },
    { step: 40, kind: 'spawn', body: ball([-4, 4.5, 0.2], [12, 0, 0]) },
  ],
};
const diverge: InputEvent[] = [
  { step: 26, kind: 'spawn', body: ball([4, 3.5, 0], [-15, 0, 0]) },
  { step: 28, kind: 'blast', blast: { centre: [0.5, 3, -0.6], radius: 2.5, impulse: 6 } },
];
const AT = 24, AFTER = 200;

const flat = (s: Snapshot) => [s.count, ...s.pos, ...s.rot, ...s.linVel, ...s.angVel, ...s.awake, ...(s.tier ?? [])];
function trace(e: RapierEngine, steps: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < steps; i++) { e.step(); out.push(flat(e.snapshot())); }
  return out;
}

describe('RapierEngine: checkpoint and restore', () => {
  it('a restored engine steps bit for bit as the run that never left; twice; refuses once disposed or after init()', async () => {
    const ref = new RapierEngine();
    await ref.init(scene);
    for (let i = 0; i < AT; i++) ref.step();
    const want = trace(ref, AFTER);
    const end = ref.snapshot();
    ref.dispose();

    const e = new RapierEngine();
    await e.init(scene);
    for (let i = 0; i < AT; i++) e.step();
    const at = flat(e.snapshot());
    const cp = e.checkpoint();
    expect(cp.step).toBe(AT);
    e.push(diverge);
    const thrown = trace(e, 30);
    expect(thrown.at(-1)).not.toEqual(want[29]);
    for (let r = 0; r < 2; r++) {
      cp.restore();
      expect(e.stepIndex).toBe(AT);
      expect(flat(e.snapshot())).toEqual(at);
      const got = trace(e, AFTER);
      const first = got.findIndex((s, i) => s.some((x, k) => !Object.is(x, want[i]![k])));
      expect(first, `restore ${r + 1}: first step that differs`).toBe(-1);
    }
    // Bodies are asleep by the end (and compared asleep: the sleep state is restored too).
    expect(end.awake.filter((a) => a === 0).length).toBeGreaterThan(3);
    cp.dispose();
    expect(() => cp.restore()).toThrow(/disposed checkpoint/);
    const cp2 = e.checkpoint();
    await e.init(scene);
    expect(() => cp2.restore()).toThrow(/init\(\)ed again/);
    e.dispose();
  });
});
