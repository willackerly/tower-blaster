// The game's camera (play.ts viewOf, orbitDrag): framed over each level with the viewer's floor, so dragging up past
// level looks up (the eye slides in along its line and stays EYE_ABOVE_GROUND over the ground, y 0).
import { describe, expect, it } from 'vitest';
import { BIG_LEVELS, compileLevel, LEVELS } from '@tb/keystone';
import { EYE_ABOVE_GROUND, eyeOf, MAX_PITCH, type Orbit, viewProj } from '@tb/render/camera';
import { orbitDrag, viewOf } from '../src/play.ts';
import { PORTRAIT_HUD_SHARE, TOP_MARGIN } from '../src/view.ts';

describe('game camera', () => {
  it.each(LEVELS.map((l) => [l.id, l] as const))('%s: opens looking down with the floor set; dragging up looks up from above the ground, and back', (_, def) => {
    const o = viewOf(compileLevel(def));
    expect(o.floor).toBe(EYE_ABOVE_GROUND);
    expect(o.pitch).toBeGreaterThan(0);
    const start: Orbit = { ...o, target: [...o.target] };
    // Pointer up the screen is dy < 0: tilt up, in small steps as a drag sends them.
    let prevUp = -Infinity;
    for (let i = 0; i < 120; i++) {
      orbitDrag(o, 0, -10);
      const e = eyeOf(o);
      expect(e[1]).toBeGreaterThanOrEqual(EYE_ABOVE_GROUND - 1e-9);
      const up = (o.target[1] - e[1]) / Math.hypot(o.target[0] - e[0], o.target[2] - e[2]); // tan of the view's elevation
      expect(up).toBeGreaterThanOrEqual(prevUp - 1e-9);
      prevUp = up;
    }
    expect(o.pitch).toBe(-MAX_PITCH);
    expect(prevUp).toBeGreaterThan(0); // looking up
    // Dragging back down restores the opening view (the floor never changed the set distance).
    orbitDrag(o, 0, (start.pitch + MAX_PITCH) / 0.005);
    expect(o.pitch).toBeCloseTo(start.pitch, 12);
    expect(o.distance).toBe(start.distance);
    eyeOf(o).forEach((x, k) => expect(x).toBeCloseTo(eyeOf(start)[k]!, 9));
  });

  it.each([...LEVELS, ...BIG_LEVELS].map((l) => [l.id, l] as const))('%s: a phone held upright frames the whole structure below the HUD; every wide screen frames alike, with TOP_MARGIN over the top', async (_, def) => {
    const { transform } = await import('@tb/render/math');
    const c = compileLevel(def), base = viewOf(c);
    for (const a of [1, 640 / 400, 16 / 9, 21 / 9]) expect(viewOf(c, a)).toEqual(base);
    // Every block's box corners on screen: wide, under the top margin; upright, below the HUD's band (PORTRAIT_HUD_SHARE of the height).
    for (const [a, top] of [[1.6, TOP_MARGIN], [390 / 844, PORTRAIT_HUD_SHARE]] as const) {
      const o = viewOf(c, a), m = viewProj(o, a);
      let worst = 0, highest = -Infinity;
      for (let i = 0; i < c.meta.n; i++) for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const p = [0, 1, 2].map((k) => c.meta.home[3 * i + k]! + [sx, sy, sz][k]! * c.meta.half[3 * i + k]!) as [number, number, number];
        const [px, py, , pw] = transform(m, p);
        expect(pw).toBeGreaterThan(0);
        worst = Math.max(worst, Math.abs(px / pw), Math.abs(py / pw));
        highest = Math.max(highest, py / pw);
      }
      expect(worst).toBeLessThanOrEqual(1);
      expect(highest).toBeLessThanOrEqual(1 - 2 * top + 1e-9);
    }
  });

  it('a sideways drag turns about the target', () => {
    const o = viewOf(compileLevel(LEVELS[0]!)), yaw = o.yaw;
    orbitDrag(o, 100, 0);
    expect(o.yaw).toBeCloseTo(yaw - 0.5, 12);
  });
});

// The collapse-front camera (G4.3, follow.ts): frames the moving bodies and eases back at settle.
describe('follow camera', async () => {
  const { FOLLOW_FAR, FOLLOW_MIN_MOVING, FOLLOW_NEAR, FOLLOW_RATE, FollowCam, followGoal, spring } = await import('../src/follow.ts');
  const { transform } = await import('@tb/render/math');
  const { viewProj: vp } = await import('@tb/render/camera');
  const c = compileLevel(LEVELS[1]!), h = c.frame.unit, aspect = 640 / 400;
  const home = () => viewOf(c);
  /** Every corner of box inside the view (normalized device coordinates within ±1, in front of the eye). */
  const inView = (o: Orbit, box: number[]) => {
    const m = vp(o, aspect);
    for (const x of [box[0]!, box[3]!]) for (const y of [box[1]!, box[4]!]) for (const z of [box[2]!, box[5]!]) {
      const [px, py, , pw] = transform(m, [x, y, z]);
      if (!(pw > 0 && Math.abs(px / pw) <= 1 && Math.abs(py / pw) <= 1)) return false;
    }
    return true;
  };
  const run = (cam: InstanceType<typeof FollowCam>, o: Orbit, s: number, running: boolean, box: number[] | null, moving = 500) => {
    for (let t = 0; t < s; t += 1 / 60) cam.update(o, 1 / 60, running, box, moving, h);
  };

  it('the spring is critically damped: no overshoot, within 1% of a jump by 2.3 s, at any frame rate', () => {
    for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
      let x = 0, v = 0, peak = 0;
      for (let t = 0; t < 2.3 - 1e-9; t += dt) { [x, v] = spring(x, v, 1, FOLLOW_RATE, dt); peak = Math.max(peak, x); }
      expect(peak).toBeLessThanOrEqual(1);
      expect(x).toBeGreaterThan(0.99);
    }
    // Exact: one big step lands where many small ones do.
    const [a] = spring(0, 0, 1, FOLLOW_RATE, 1);
    let x = 0, v = 0;
    for (let i = 0; i < 1000; i++) [x, v] = spring(x, v, 1, FOLLOW_RATE, 1e-3);
    expect(a).toBeCloseTo(x, 9);
  });

  it('frames every moving body: the goal holds the box (padded) in view, at the player\'s yaw and pitch', () => {
    const o = home();
    for (const box of [[-3, 0, -3, 3, 4, 3], [2, 0, -1, 9, 2, 6], [-0.5, 1, -0.5, 0.5, 1.5, 0.5]]) {
      const g = followGoal(o, box, h, o.distance)!;
      const at: Orbit = { ...o, target: g.target, distance: g.distance };
      expect(inView(at, box)).toBe(true);
      expect(g.distance).toBeGreaterThanOrEqual(FOLLOW_NEAR * o.distance - 1e-9);
      expect(g.distance).toBeLessThanOrEqual(FOLLOW_FAR * o.distance + 1e-9);
    }
    // No box (nothing moves: +Infinity mins) gives no goal.
    expect(followGoal(o, [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], h, o.distance)).toBeNull();
  });

  it('cuts the moving box to the play area: a body flung far off does not drag the frame after it', () => {
    const o = home(), clip = [-6, 0, -6, 6, 10, 6];
    const near = followGoal(o, [-3, 0, -3, 3, 4, 3], h, o.distance, clip)!;
    const flung = followGoal(o, [-3, 0, -3, 80, 4, 3], h, o.distance, clip)!; // one body 80 m out
    const cut = followGoal(o, [-3, 0, -3, 6, 4, 3], h, o.distance)!;
    flung.target.forEach((x, k) => expect(x).toBeCloseTo(cut.target[k]!, 9));
    expect(flung.distance).toBeCloseTo(cut.distance, 9);
    expect(Math.abs(flung.target[0] - near.target[0])).toBeLessThan(2);
    // Wholly outside the area: no goal (the camera heads home).
    expect(followGoal(o, [40, 0, 40, 50, 2, 50], h, o.distance, clip)).toBeNull();
  });

  it('follows a spreading collapse, keeps the bodies in view, then eases back home and stops at settle', () => {
    const o = home(), start: Orbit = { ...o, target: [...o.target] }, cam = new FollowCam();
    cam.start(o);
    const box = [-4, 0, -4, 6, 3, 5];
    run(cam, o, 3, true, box);
    expect(inView(o, box)).toBe(true);
    expect(o.yaw).toBe(start.yaw);
    expect(o.pitch).toBe(start.pitch);
    expect(o.fovY).toBe(start.fovY);
    run(cam, o, 4, false, null);
    expect(cam.active).toBe(false);
    expect(o.target).toEqual(start.target);
    expect(o.distance).toBe(start.distance);
  });

  it('frames every box seen this shot: it grows with the collapse and does not dive in on the last stragglers', () => {
    const o = home(), cam = new FollowCam();
    cam.start(o);
    const big = [-6, 0, -6, 6, 5, 6];
    run(cam, o, 4, true, big);
    const held: Orbit = { ...o, target: [...o.target] };
    expect(inView(o, big)).toBe(true);
    // The collapse dies down to a few bodies (still at least FOLLOW_MIN_MOVING) in one corner: the frame holds.
    run(cam, o, 4, true, [4, 0, 4, 5, 1, 5], FOLLOW_MIN_MOVING);
    o.target.forEach((x, k) => expect(x).toBeCloseTo(held.target[k]!, 2));
    expect(o.distance).toBeCloseTo(held.distance, 2);
    expect(inView(o, big)).toBe(true);
    // And grows when it spreads further.
    run(cam, o, 4, true, [-6, 0, -6, 14, 5, 6]);
    expect(inView(o, [-6, 0, -6, 14, 5, 6])).toBe(true);
  });

  it('stays home while too little moves, and leaves the camera to the player once they touch it', () => {
    const o = home(), start: Orbit = { ...o, target: [...o.target] }, cam = new FollowCam();
    cam.start(o);
    run(cam, o, 2, true, [10, 0, 10, 12, 2, 12], FOLLOW_MIN_MOVING - 1);
    o.target.forEach((x, k) => expect(x).toBeCloseTo(start.target[k]!, 9));
    run(cam, o, 1, true, [10, 0, 10, 12, 2, 12]);
    const moved: Orbit = { ...o, target: [...o.target] };
    expect(moved.target).not.toEqual(start.target);
    cam.grab();
    run(cam, o, 3, true, [-10, 0, -10, -8, 2, -8]);
    expect(o).toEqual(moved);
    run(cam, o, 3, false, null);
    expect(o).toEqual(moved); // grabbed: no ease back either
    // Never NaN, whatever the box.
    const p = home(), cam2 = new FollowCam();
    cam2.start(p);
    run(cam2, p, 1, true, [NaN, 0, 0, 1, 1, 1]);
    expect([...p.target, p.distance].every(Number.isFinite)).toBe(true);
  });
});
