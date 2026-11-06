// X5: are never-wake anchors solid? (modes-roadmap.md section 7; gates C8,
// pinned bodies, which M8 Mason's Trial and M10 Rube Lab build on.)
//
// C8 is not built. Its mechanism is: a sleeper is an anchor (sleep.ts: its
// pose fixed, its velocity 0, solved against as an infinite mass), and a
// pinned body is a sleeper that never wakes. The probe emulates that on
// today's engine: sleep on with a rule under which nothing falls asleep
// (sleepSteps 1e8) and no contact wakes anything (wakeSpeed and wakeDepth
// 1e30), and the pinned bodies written asleep right after init (RunSpec.pins).
// No blast or removal runs, the only other wake.
//
// Every case runs twice, and the two runs are the same physics in two frames:
//   pinned     a pinned box whose top face (local +y, normal n = Q y) is the
//              surface, through the point S, under gravity g;
//   reference  no box: the engine's ground plane y = 0 is the surface, under
//              gravity Q^-1 g, with every other body moved to Q^-1 (p - S).
// The ground plane is the engine's one true static body, so a pinned anchor
// is solid when the bodies on it move as they move on the ground. Cases:
//   slab   a 50 x 1 x 10 m slab, its top 5 m up, struck at 45 m/s, 30 deg
//          down, by the weapons' cannonball (0.14 m, 7,200 kg/m^3), which
//          then slides along it (long enough that it never leaves in 0.5 s);
//   wall   a 6 x 1 x 6 m slab stood on edge (Q: 90 deg about z, its face
//          toward -x, 0.5 to 6.5 m up), struck level at 45 m/s: gravity runs
//          along the face, and the ball slides down it for 0.67 s;
//   ramp   a 20 x 1 x 6 m ramp tilted 15 deg (Q: -15 deg about z, downhill
//          +x), under a flood of glass marbles (0.05 m, 2,500 kg/m^3; 1,000
//          in a 10 x 10 x 10 block, 0.15 m apart, 1 m above it at the top end).
// Nudges jitter the cannonball's speed (+-5 %) and aim (+-1 deg), or the
// marbles' placement (+-1 cm), from their own seed.
//
// Compared in the surface's frame (u along the surface, h off it): the pinned
// bodies' pose (must not change at all), the dynamic bodies' end positions,
// and how deep any sphere ever sank into the surface (r - h).
import type { BodyDesc, Quat, SceneDesc, Snapshot, Vec3 } from '@tb/engine-api';
import { quatFromAxisAngle, quatMul, QUAT_IDENTITY, rotate } from '@tb/geom';
import { PROJECTILE_PRESETS } from '@tb/weapons';
import { ball, box, GAME_PARAMS, gameScene, GRAVITY, ks2, rng, sym } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export type Design = 'slab' | 'wall' | 'ramp';
export interface X5Case { design: Design; frame: 'pinned' | 'reference'; nudge: number; marbles: number; steps: number }

const cannon = PROJECTILE_PRESETS.cannonball;
/** The emulated C8 rule: nothing ever falls asleep, no contact wakes anything. */
export const PIN_SLEEP = { sleep: true, sleepSteps: 1e8, wakeSpeed: 1e30, wakeDepth: 1e30 } as const;

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export interface Surface { Q: Quat; S: Vec3; half: Vec3 }

export function surfaceOf(d: Design): Surface {
  if (d === 'slab') return { Q: QUAT_IDENTITY, S: [0, 5, 0], half: [25, 0.5, 5] };
  if (d === 'wall') return { Q: quatFromAxisAngle([0, 0, 1], Math.PI / 2), S: [0, 3.5, 0], half: [3, 0.5, 3] };
  return { Q: quatFromAxisAngle([0, 0, 1], (-15 * Math.PI) / 180), S: [0, 6, 0], half: [10, 0.5, 3] };
}

/** World point -> the surface's frame, and back. */
export const toSurface = (s: Surface, p: Vec3): Vec3 => rotate(conj(s.Q), sub(p, s.S));
export const fromSurface = (s: Surface, p: Vec3): Vec3 => { const r = rotate(s.Q, p); return [r[0] + s.S[0], r[1] + s.S[1], r[2] + s.S[2]]; };

/** The dynamic bodies in the surface's frame (u, h, w: h = 0 on the surface). */
function movers(c: X5Case): BodyDesc[] {
  const r = rng(5000 + c.nudge), jit = c.nudge > 0;
  if (c.design === 'ramp') {
    const out: BodyDesc[] = [], n = Math.round(Math.cbrt(c.marbles)), radius = 0.05, pitch = 0.15;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const p: Vec3 = [-8 + i * pitch + (jit ? 0.01 * sym(r) : 0), 1 + radius + k * pitch, (j - (n - 1) / 2) * pitch + (jit ? 0.01 * sym(r) : 0)];
      out.push(ball(p, radius, [0, 0, 0], { density: 2500, friction: 0.4 }));
    }
    return out;
  }
  // The cannonball 4 m out along the surface's -u, aimed at its centre: 30 deg into a slab, level into a wall.
  const speed = cannon.speed * (1 + (jit ? 0.05 * sym(r) : 0)), aim = ((c.design === 'slab' ? 30 : 0) + (jit ? sym(r) : 0)) * Math.PI / 180;
  const radius = cannon.diameter / 2, d = 4;
  // In the surface frame the approach is along +u and -h at `aim` to the surface; a wall is approached head-on (aim 90 deg).
  const a = c.design === 'wall' ? Math.PI / 2 + aim : aim;
  const v: Vec3 = [speed * Math.cos(a), -speed * Math.sin(a), 0];
  const p: Vec3 = [-d * Math.cos(a), radius + d * Math.sin(a), 0];
  return [ball(p, radius, v, { density: cannon.density, friction: cannon.friction })];
}

export function x5Spec(c: X5Case): RunSpec {
  const s = surfaceOf(c.design), local = movers(c), params = GAME_PARAMS;
  if (c.frame === 'reference') {
    // Gravity in the surface frame; the ground plane is the surface.
    const g = rotate(conj(s.Q), [0, -GRAVITY, 0]);
    const scene: SceneDesc = gameScene(`X5-${c.design}-ref`, { ...c }, local, [], { gravity: g, ground: { y: 0, friction: 0.6 } });
    return { scene, steps: c.steps, params, opts: { capacity: local.length, pairsPerBody: 24 } };
  }
  const pinned = box(fromSurface(s, [0, -s.half[1], 0]), s.half, s.Q);
  const world = local.map((b) => ({ ...b, pos: fromSurface(s, b.pos), linVel: rotate(s.Q, b.linVel), rot: quatMul(s.Q, b.rot) }));
  const scene = gameScene(`X5-${c.design}`, { ...c }, [pinned, ...world]);
  return { scene, steps: c.steps, params, opts: { capacity: world.length + 1, pairsPerBody: 24, ...PIN_SLEEP }, pins: [0] };
}

export interface X5Result {
  /** The pinned body's largest change of position (m) and of orientation (quaternion components) over the run: 0 for solid. */
  pinMove: number;
  pinTurn: number;
  /** Dynamic bodies' end positions in the surface frame (u, h, w). */
  end: Vec3[];
  /** The deepest any sphere sank into the surface (r - h, m), and the share of marbles still on it (h < 0.5 m and over it) at the end. */
  maxSink: number;
  /** The closest any sphere came to the surface while over it (h - r, m): about 0 once it touched. */
  minGap: number;
  onSurface: number;
  /** A sphere ever past the surface's far side (h below minus its thickness): tunnelled. */
  tunnelled: boolean;
}

function x5Meter(c: X5Case, spec: RunSpec): Meter<X5Result> {
  const s = surfaceOf(c.design), off = c.frame === 'pinned' ? 1 : 0, bodies = spec.scene.bodies.slice(off);
  // The pinned body's pose as the engine holds it (f32) at step 0.
  let p0: number[] | null = null, q0: number[] | null = null;
  let pinMove = 0, pinTurn = 0, maxSink = 0, minGap = Infinity, tunnelled = false, end: Vec3[] = [], onSurface = 0;
  const local = (snap: Snapshot, i: number): Vec3 => {
    const p: Vec3 = [snap.pos[3 * (i + off)]!, snap.pos[3 * (i + off) + 1]!, snap.pos[3 * (i + off) + 2]!];
    return c.frame === 'pinned' ? toSurface(s, p) : p;
  };
  return {
    every: 2,
    sample(_step, snap) {
      if (off && !p0) { p0 = [...snap.pos.slice(0, 3)]; q0 = [...snap.rot.slice(0, 4)]; }
      if (off && p0 && q0) {
        pinMove = Math.max(pinMove, Math.hypot(snap.pos[0]! - p0[0]!, snap.pos[1]! - p0[1]!, snap.pos[2]! - p0[2]!));
        pinTurn = Math.max(pinTurn, ...[0, 1, 2, 3].map((k) => Math.abs(snap.rot[k]! - q0![k]!)));
      }
      end = []; onSurface = 0;
      for (let i = 0; i < bodies.length; i++) {
        const p = local(snap, i), r = (bodies[i]!.shape as { radius: number }).radius;
        const over = Math.abs(p[0]) <= s.half[0] && Math.abs(p[2]) <= s.half[2];
        if (over) { maxSink = Math.max(maxSink, r - p[1]); minGap = Math.min(minGap, p[1] - r); if (p[1] < -2 * s.half[1]) tunnelled = true; if (p[1] < 0.5) onSurface++; }
        end.push(p);
      }
    },
    result: () => ({ pinMove, pinTurn, end: end.map((p) => p.map((x) => Math.round(x * 1e5) / 1e5) as Vec3), maxSink, minGap, onSurface: onSurface / bodies.length, tunnelled }),
  };
}

function x5Cases(size: Size): X5Case[] {
  const out: X5Case[] = [];
  const designs: Design[] = ['slab', 'wall', 'ramp'];
  for (const design of designs) for (const frame of ['pinned', 'reference'] as const) {
    const nudges = size === 'full' ? 4 : 1;
    for (let nudge = 0; nudge < nudges; nudge++) {
      if (design === 'ramp') out.push({ design, frame, nudge, marbles: size === 'full' ? 1000 : 64, steps: size === 'full' ? 180 : 120 });
      else out.push({ design, frame, nudge, marbles: 0, steps: design === 'wall' ? 40 : 30 });
    }
  }
  return out;
}

const f4 = (x: number) => x.toFixed(4);

function x5Verdict(runs: CaseRun<X5Case, X5Result>[], size: Size): Verdict {
  const table = ['| case | pinned: pin moved m / turned | end difference, pinned vs ground | deepest sink m, pinned / ground | on the surface, pinned / ground | tunnelled | limits |', '|---|---|---|---|---|---|---|'], checks: Check[] = [];
  const key = (c: X5Case) => `${c.design} nudge ${c.nudge}`;
  const pairs = new Map<string, { p?: CaseRun<X5Case, X5Result>; g?: CaseRun<X5Case, X5Result> }>();
  for (const r of runs) { const k = key(r.c), e = pairs.get(k) ?? {}; if (r.c.frame === 'pinned') e.p = r; else e.g = r; pairs.set(k, e); }
  let solid = true, match = true;
  for (const [k, { p, g }] of pairs) {
    if (!p || !g) continue;
    const a = p.result, b = g.result, ramp = p.c.design === 'ramp';
    let diff: string, ok: boolean;
    if (ramp) {
      // The flood is chaotic, so the two runs are two draws of it: their end distributions along and across the slope must agree.
      const ku = ks2(a.end.map((q) => q[0]), b.end.map((q) => q[0])), kw = ks2(a.end.map((q) => q[2]), b.end.map((q) => q[2]));
      const mean = (xs: Vec3[]) => xs.reduce((t, q) => t + q[0], 0) / xs.length;
      ok = ku.p > 0.05 && kw.p > 0.05 && Math.abs(a.onSurface - b.onSurface) <= 0.05;
      diff = `mean u ${mean(a.end).toFixed(3)} vs ${mean(b.end).toFixed(3)} m; KS along D ${ku.D.toFixed(3)} p ${ku.p.toFixed(2)}, across D ${kw.D.toFixed(3)} p ${kw.p.toFixed(2)}`;
    } else {
      const d = Math.hypot(...sub(a.end[0]!, b.end[0]!)), path = (cannon.speed * p.c.steps) / 60;
      ok = d <= 0.01 + 0.01 * path;
      diff = `${d.toFixed(3)} m (allowed ${(0.01 + 0.01 * path).toFixed(2)} m)`;
    }
    const sinkOk = a.maxSink <= b.maxSink + (ramp ? 2e-3 : 1e-3);
    solid &&= a.pinMove === 0 && a.pinTurn === 0 && !a.tunnelled;
    match &&= ok && sinkOk;
    table.push(`| ${k} | ${a.pinMove} / ${a.pinTurn} | ${diff} | ${f4(a.maxSink)} / ${f4(b.maxSink)} | ${(100 * a.onSurface).toFixed(0)}% / ${(100 * b.onSurface).toFixed(0)}% | ${a.tunnelled ? 'yes' : 'no'} | ${p.limits.length + g.limits.length} |`);
    checks.push({ name: `${k}: the bodies on the pinned ${p.c.design} move as on the ground`, pass: ok && sinkOk, detail: `${diff}; sink ${f4(a.maxSink)} vs ${f4(b.maxSink)} m` });
  }
  checks.unshift({ name: 'no pinned body moves or turns at all, and nothing tunnels through one', pass: solid, detail: solid ? 'exactly 0 in every run' : 'see table' });
  checks.push({ name: 'no engine limit hit', pass: runs.every((r) => r.limits.length === 0), detail: runs.flatMap((r) => r.limits)[0] ?? 'none' });
  return { pass: size === 'full' ? solid && match && runs.every((r) => r.limits.length === 0) : null, checks, table };
}

export const X5: Probe<X5Case, X5Result> = {
  id: 'X5',
  title: 'Pinned anchors solid',
  question: 'Is a never-wake sleeper (the C8 pinned body, emulated) as solid as the ground under impacts and a flood?',
  rule: 'No pinned body moves; the bodies on it match a reference within tolerance (here: the same case on the ground plane in the surface\'s frame: a cannonball ends within 1 cm + 1% of its path, a flood\'s end positions along and across the slope the same distribution, two-sample KS p > 0.05; no deeper sinking).',
  cases: x5Cases,
  label: (c) => `${c.design} ${c.frame} nudge ${c.nudge}`,
  spec: x5Spec,
  meter: x5Meter,
  verdict: x5Verdict,
};
