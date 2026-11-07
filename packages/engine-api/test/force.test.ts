// Forces (force.ts): the checks, the force each kind gives, and the table engines keep.
import { describe, expect, it } from 'vitest';
import { type BodyMotion, checkForce, cosSin, type ForceEvent, forceAt, forceIsWorld, forceKick, ForceTable, headingBasis, rotateByQuat, vibration } from '../src/index.ts';

const still: BodyMotion = { pos: [1, 2, 3], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0] };
const close = (a: number[], b: number[], tol = 1e-12) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, -Math.log10(tol)));

describe('checkForce', () => {
  it('fills in the defaults', () => {
    expect(checkForce({ steps: 3, thrust: [1, 0, 0] })).toEqual({ kind: 'thrust', steps: 3, thrust: [1, 0, 0], axes: 'world' });
    expect(checkForce({ steps: 3, vibrate: [0, 1, 0], period: 0.5 })).toEqual({ kind: 'vibrate', steps: 3, vibrate: [0, 1, 0], period: 0.5, phase: 0 });
    expect(checkForce({ steps: 3, pull: [0, 1, 0], stiffness: 2 })).toEqual({ kind: 'pull', steps: 3, pull: [0, 1, 0], stiffness: 2, damping: 0, max: Infinity });
  });

  it('refuses what no engine should apply', () => {
    const bad: [unknown, RegExp][] = [
      [null, /object/], [[1], /object/], [{ steps: 1 }, /exactly one/], [{ steps: 1, thrust: [0, 0, 0], pull: [0, 0, 0], stiffness: 1 }, /exactly one/],
      [{ steps: 0, thrust: [0, 0, 0] }, /steps/], [{ steps: 1.5, thrust: [0, 0, 0] }, /steps/], [{ steps: 2 ** 31, thrust: [0, 0, 0] }, /steps/],
      [{ steps: 1, thrust: [0, 0, Infinity] }, /thrust/], [{ steps: 1, thrust: [0, 0] }, /thrust/], [{ steps: 1, thrust: [0, 0, 0], axes: 'up' }, /axes/],
      [{ steps: 1, thrust: [0, 0, 0], stiffness: 1 }, /unknown keys/],
      [{ steps: 1, vibrate: [0, 0, 1] }, /period/], [{ steps: 1, vibrate: [0, 0, 1], period: 0 }, /period/], [{ steps: 1, vibrate: [0, 0, 1], period: 1, phase: 1 }, /phase/],
      [{ steps: 1, pull: [0, 0, 1] }, /stiffness/], [{ steps: 1, pull: [0, 0, 1], stiffness: 1, damping: -1 }, /damping/], [{ steps: 1, pull: [0, 0, 1], stiffness: 1, max: 0 }, /max/],
    ];
    for (const [f, re] of bad) expect(() => checkForce(f as never), JSON.stringify(f)).toThrow(re);
  });
});

describe('forceAt', () => {
  it('a world thrust is itself; a body-axes thrust turns with the body; a heading thrust follows its velocity', () => {
    const q: BodyMotion = { ...still, rot: [0, Math.SQRT1_2, 0, Math.SQRT1_2], linVel: [3, 0, 4] };
    expect(forceAt(checkForce({ steps: 1, thrust: [1, 2, 3] }), 0, 1 / 60, q)).toEqual([1, 2, 3]);
    close(forceAt(checkForce({ steps: 1, thrust: [1, 2, 3], axes: 'body' }), 0, 1 / 60, q), rotateByQuat(q.rot, [1, 2, 3]));
    // +y in heading axes is along the velocity.
    close(forceAt(checkForce({ steps: 1, thrust: [0, 5, 0], axes: 'heading' }), 0, 1 / 60, q), [3, 0, 4]);
    const [x, y, z] = headingBasis([0.6, 0, 0.8]);
    close(forceAt(checkForce({ steps: 1, thrust: [1, 2, 3], axes: 'heading' }), 0, 1 / 60, q), [0, 1, 2].map((a) => x[a]! + 2 * y[a]! + 3 * z[a]!));
    expect(forceIsWorld(checkForce({ steps: 1, thrust: [1, 2, 3] }))).toBe(true);
    expect(forceIsWorld(checkForce({ steps: 1, thrust: [1, 2, 3], axes: 'body' }))).toBe(false);
  });

  it('a vibration is the sine of its phase at step k, the angle wrapped first', () => {
    const f = checkForce({ steps: 100, vibrate: [0, 2, 0], period: 0.1, phase: 0.25 });
    const h = 1 / 60;
    for (const k of [0, 1, 5, 6, 59, 1e6]) {
      const want = Math.sin(2 * Math.PI * ((k * h) / 0.1 + 0.25));
      expect(vibration(f as { period: number; phase: number }, k, h)).toBeCloseTo(want, 9);
      expect(forceAt(f, k, h, still)[1]).toBeCloseTo(2 * want, 9);
    }
    // The same bits on every machine: cosSin, not Math.sin.
    expect(vibration({ period: 0.1, phase: 0.25 }, 3, h)).toBe(cosSin(2 * Math.PI * (((3 * h) / 0.1 + 0.25) % 1))[1]);
  });

  it('a pull is a spring to its point and a dashpot, its length capped', () => {
    const b: BodyMotion = { ...still, pos: [0, 0, 0], linVel: [1, 0, 0] };
    expect(forceAt(checkForce({ steps: 1, pull: [0, 2, 0], stiffness: 3, damping: 0.5 }), 0, 1 / 60, b)).toEqual([-0.5, 6, 0]);
    const capped = forceAt(checkForce({ steps: 1, pull: [0, 2, 0], stiffness: 3, damping: 0.5, max: 2 }), 0, 1 / 60, b);
    expect(Math.hypot(...capped)).toBeCloseTo(2, 14);
    close(capped.map((x) => x / 2), [-0.5 / Math.hypot(0.5, 6), 6 / Math.hypot(0.5, 6), 0]);
    expect(forceKick([6, 0, -3], 2, 0.5)).toEqual([1.5, 0, -0.75]);
  });
});

describe('ForceTable', () => {
  const ev = (id: number, steps: number | null, step = 0): ForceEvent => ({ step, kind: 'force', id, force: steps === null ? null : { steps, thrust: [id, 0, 0] } });

  it('a force acts from the step it applies for its steps; a new one replaces it; null and a removal end it', () => {
    const t = new ForceTable();
    t.apply(ev(5, 3), 10);
    t.apply(ev(2, 1), 10);
    expect(t.act(10).map((f) => f.id)).toEqual([2, 5]);
    expect(t.act(11).map((f) => f.id)).toEqual([5]);
    expect(t.acting(12)).toBe(true);
    expect(t.act(13)).toEqual([]);
    expect(t.size).toBe(0);
    expect(t.acting(13)).toBe(false);
    t.apply(ev(1, 10), 20);
    t.apply(ev(1, 2), 22);
    expect(t.act(22)).toEqual([{ id: 1, force: checkForce({ steps: 2, thrust: [1, 0, 0] }), start: 22, end: 24 }]);
    t.apply(ev(1, null), 23);
    expect(t.act(23)).toEqual([]);
    t.apply(ev(3, 5), 30);
    t.remove(3);
    expect(t.act(30)).toEqual([]);
  });

  it('a clone is its own table; ends() maps each forced body to its end', () => {
    const t = new ForceTable();
    t.apply(ev(4, 6), 1);
    const c = t.clone();
    t.apply(ev(4, null), 2);
    expect(t.ends()).toEqual(new Map());
    expect(c.ends()).toEqual(new Map([[4, 7]]));
  });
});
