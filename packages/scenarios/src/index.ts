// Canonical benchmark scenes S1-S13, plus S14, a configurable city for the viewer. Each is a pure function of
// (params, seed) so any engine, on any machine, starts from identical state.
import { type BodyDesc, type Quat, type SceneDesc, type Vec3, TAG_BALL, TAG_DEBRIS, volumeOf } from '@tb/engine-api';
import { quatNormalize, QUAT_IDENTITY } from '@tb/geom';

export type Params = Record<string, number | boolean>;

export interface ScenarioDef {
  id: string;
  title: string;
  /** What the scenario is for, shown in reports. */
  catches: string;
  defaults: Params;
  build(params: Params, seed: number): SceneDesc;
}

/** mulberry32: tiny, fast, good enough for scene jitter, identical everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRotation(r: () => number): Quat {
  // Shoemake's uniform random unit quaternion.
  const u1 = r(), u2 = r() * 2 * Math.PI, u3 = r() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return quatNormalize([a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)]);
}

const CUBE_HALF: Vec3 = [0.5, 0.5, 0.5];
const FRICTION = 0.6;

function box(pos: Vec3, half: Vec3, tag: number, rot: Quat = QUAT_IDENTITY, density = 1): BodyDesc {
  return { shape: { kind: 'box', half }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density, friction: FRICTION, restitution: 0, tag };
}

const cube = (pos: Vec3, tag: number, rot?: Quat, density?: number) => box(pos, CUBE_HALF, tag, rot, density);

function scene(id: string, params: Params, seed: number, bodies: BodyDesc[], extra: Partial<SceneDesc> = {}): SceneDesc {
  return { id, params: { ...params }, seed, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: FRICTION }, sleep: true, bodies, inputs: [], ...extra };
}

const num = (p: Params, k: string) => {
  const v = p[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`param ${k} must be a finite number`);
  return v;
};
const int = (p: Params, k: string, min = 1) => {
  const v = num(p, k);
  if (!Number.isInteger(v) || v < min) throw new Error(`param ${k} must be an integer >= ${min}`);
  return v;
};

/** F x F x H block of unit cubes, centred on (ox, oz), resting on y = 0. */
function tower(F: number, H: number, gap: number, ox: number, oz: number, tag: number, limit = Infinity): BodyDesc[] {
  const out: BodyDesc[] = [];
  const pitch = 1 + gap;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < F; x++)
      for (let z = 0; z < F; z++) {
        if (out.length >= limit) return out;
        out.push(cube([ox + (x - (F - 1) / 2) * pitch, 0.5 + y, oz + (z - (F - 1) / 2) * pitch], tag));
      }
  return out;
}

/** Jittered, randomly rotated cubes on a lattice wide enough that none overlap. */
function looseCubes(N: number, seed: number, layerSpacing: number, y0: number): BodyDesc[] {
  const r = rng(seed);
  const pitch = 1.9; // > cube diameter sqrt(3) plus twice the jitter
  const jitter = 0.08;
  const side = Math.max(1, Math.ceil(Math.sqrt(N / 20)));
  const out: BodyDesc[] = [];
  for (let i = 0; i < N; i++) {
    const layer = Math.floor(i / (side * side));
    const x = (i % side) - (side - 1) / 2;
    const z = Math.floor(i / side) % side - (side - 1) / 2;
    const j = () => (r() * 2 - 1) * jitter;
    out.push(cube([x * pitch + j(), y0 + layer * layerSpacing + j(), z * pitch + j()], TAG_DEBRIS, randomRotation(r)));
  }
  return out;
}

const S1: ScenarioDef = {
  id: 'S1', title: 'Tall tower at rest', catches: 'creep, jitter, time to sleep',
  defaults: { F: 8, H: 30, gap: 0 },
  build: (p, seed) => scene('S1', p, seed, tower(int(p, 'F'), int(p, 'H'), num(p, 'gap'), 0, 0, 0)),
};

const S2: ScenarioDef = {
  id: 'S2', title: 'Stepped cube pyramid', catches: 'stack convergence at low iteration counts',
  defaults: { C: 40, depth: 1 },
  build(p, seed) {
    const C = int(p, 'C'), D = int(p, 'depth');
    const out: BodyDesc[] = [];
    for (let k = 0; k < C; k++) {
      const n = C - k;
      for (let i = 0; i < n; i++)
        for (let d = 0; d < D; d++) out.push(cube([i - (n - 1) / 2, 0.5 + k, d - (D - 1) / 2], 0));
    }
    return scene('S2', p, seed, out);
  },
};

const S3: ScenarioDef = {
  id: 'S3', title: 'Wall', catches: 'drift, sleep ratio',
  defaults: { W: 50, H: 20, running: false },
  build(p, seed) {
    const W = int(p, 'W'), H = int(p, 'H');
    const out: BodyDesc[] = [];
    for (let y = 0; y < H; y++) {
      const shift = p.running && y % 2 === 1 ? 0.5 : 0;
      for (let x = 0; x < W; x++) out.push(cube([x - (W - 1) / 2 + shift, 0.5 + y, 0], 0));
    }
    return scene('S3', p, seed, out);
  },
};

function city(N: number, F: number, H: number, street: number): BodyDesc[] {
  const per = F * F * H;
  const towers = Math.ceil(N / per);
  const side = Math.ceil(Math.sqrt(towers));
  const pitch = F + street;
  const out: BodyDesc[] = [];
  for (let t = 0; t < towers; t++) {
    const ox = ((t % side) - (side - 1) / 2) * pitch;
    const oz = (Math.floor(t / side) - (side - 1) / 2) * pitch;
    out.push(...tower(F, H, 0, ox, oz, t, N - out.length));
  }
  return out;
}

const S4: ScenarioDef = {
  id: 'S4', title: 'City of towers', catches: 'idle cost of a mostly sleeping world',
  defaults: { N: 10000, F: 8, H: 25, street: 6 },
  build: (p, seed) => scene('S4', p, seed, city(int(p, 'N'), int(p, 'F'), int(p, 'H'), num(p, 'street'))),
};

const S5: ScenarioDef = {
  id: 'S5', title: 'Ball impact', catches: 'collapse spikes, tunnelling, momentum transfer',
  defaults: { N: 10000, F: 8, H: 25, street: 6, radius: 2, speed: 20, massRatio: 10, fireStep: 60 },
  build(p, seed) {
    const F = int(p, 'F'), H = int(p, 'H'), N = int(p, 'N');
    const bodies = city(N, F, H, num(p, 'street'));
    const first = bodies.filter((b) => b.tag === 0);
    const cx = first.reduce((s, b) => s + b.pos[0], 0) / first.length;
    const cz = first.reduce((s, b) => s + b.pos[2], 0) / first.length;
    const radius = num(p, 'radius');
    const ballMass = num(p, 'massRatio') * 1; // cube mass is 1 (density 1, unit volume)
    const density = ballMass / volumeOf({ kind: 'sphere', radius });
    const ball: BodyDesc = {
      shape: { kind: 'sphere', radius },
      pos: [cx - F / 2 - radius - 4, Math.min(H / 2, H - radius), cz],
      rot: QUAT_IDENTITY, linVel: [num(p, 'speed'), 0, 0], angVel: [0, 0, 0],
      density, friction: FRICTION, restitution: 0, tag: TAG_BALL,
    };
    return scene('S5', p, seed, bodies, { inputs: [{ step: int(p, 'fireStep', 0), kind: 'spawn', body: ball }] });
  },
};

const S6: ScenarioDef = {
  id: 'S6', title: 'Debris heap settle', catches: 'time to sleep, energy decay',
  defaults: { N: 20000 },
  build: (p, seed) => scene('S6', p, seed, looseCubes(int(p, 'N'), seed, 1.9, 1.5)),
};

const S7: ScenarioDef = {
  id: 'S7', title: 'Rain, worst case', catches: 'throughput ceiling and scaling with sleep disabled',
  defaults: { N: 20000, stretch: 3 },
  build: (p, seed) => scene('S7', p, seed, looseCubes(int(p, 'N'), seed, 1.9 * num(p, 'stretch'), 1.5), { sleep: false }),
};

const S8: ScenarioDef = {
  id: 'S8', title: 'Slab and rod tower', catches: 'thin bodies, poor conditioning, tunnelling',
  defaults: { floors: 30, bays: 3, bay: 4, rodHeight: 1, rodWidth: 0.2, slab: 0.2 },
  build(p, seed) {
    const floors = int(p, 'floors'), bays = int(p, 'bays');
    const bay = num(p, 'bay'), rh = num(p, 'rodHeight'), rw = num(p, 'rodWidth'), slab = num(p, 'slab');
    const out: BodyDesc[] = [];
    const span = bays * bay;
    for (let f = 0; f < floors; f++) {
      const y0 = f * (rh + slab);
      for (let i = 0; i <= bays; i++)
        for (let k = 0; k <= bays; k++) {
          // Rods sit just inside the outer edge so slabs fully cover them.
          const x = Math.min(span - rw / 2, Math.max(rw / 2, i * bay)) - span / 2;
          const z = Math.min(span - rw / 2, Math.max(rw / 2, k * bay)) - span / 2;
          out.push(box([x, y0 + rh / 2, z], [rw / 2, rh / 2, rw / 2], f));
        }
      for (let i = 0; i < bays; i++)
        for (let k = 0; k < bays; k++)
          out.push(box([(i + 0.5) * bay - span / 2, y0 + rh + slab / 2, (k + 0.5) * bay - span / 2], [bay / 2, slab / 2, bay / 2], f));
    }
    return scene('S8', p, seed, out);
  },
};

const S9: ScenarioDef = {
  id: 'S9', title: 'Mass-ratio stack', catches: 'penetration and NaNs under a heavy top',
  defaults: { H: 10, ratio: 100 },
  build(p, seed) {
    const H = int(p, 'H');
    const out = tower(1, H, 0, 0, 0, 0);
    out.push(cube([0, 0.5 + H, 0], 1, QUAT_IDENTITY, num(p, 'ratio')));
    return scene('S9', p, seed, out);
  },
};

const S10: ScenarioDef = {
  id: 'S10', title: 'Far from origin', catches: 'f32 precision loss (compare against S1)',
  defaults: { F: 8, H: 30, gap: 0, offset: 5000 },
  build(p, seed) {
    const o = num(p, 'offset');
    return scene('S10', p, seed, tower(int(p, 'F'), int(p, 'H'), num(p, 'gap'), o, o, 0));
  },
};

const S11: ScenarioDef = {
  id: 'S11', title: 'Determinism canary', catches: 'any change in results: sleep step count plus state hash',
  defaults: { N: 500 },
  build: (p, seed) => scene('S11', p, seed, looseCubes(int(p, 'N'), seed, 1.9, 1.5)),
};

const S12: ScenarioDef = {
  id: 'S12', title: 'Wall with a hole', catches: 'friction holding cubes up over a hole with no side force (stack bond)',
  defaults: { W: 20, H: 14, holeW: 3, holeH: 5, holeY: 3, running: false },
  build(p, seed) {
    const W = int(p, 'W'), H = int(p, 'H'), hw = int(p, 'holeW'), hh = int(p, 'holeH'), hy = int(p, 'holeY', 0);
    if (hw > W || hy + hh > H) throw new Error('S12: the hole must fit inside the wall');
    // The hole spans columns x0 .. x0 + hw - 1 (of the unshifted rows), centred, and rows hy .. hy + hh - 1.
    // running: odd rows shift by half a cube (running bond). Each course over the hole then overhangs
    // by exactly half, a knife edge for what stays up, so only stack bond is a test.
    const x0 = Math.floor((W - hw) / 2);
    const out: BodyDesc[] = [];
    for (let y = 0; y < H; y++) {
      const shift = p.running && y % 2 === 1 ? 0.5 : 0;
      for (let x = 0; x < W; x++) {
        if (y >= hy && y < hy + hh && x >= x0 && x < x0 + hw) continue;
        out.push(cube([x - (W - 1) / 2 + shift, 0.5 + y, 0], 0));
      }
    }
    return scene('S12', p, seed, out);
  },
};

const S13: ScenarioDef = {
  id: 'S13', title: 'Leaning column', catches: 'toppling too slowly, or leaning past the tipping angle without falling',
  defaults: { H: 20, deg: 4 },
  build(p, seed) {
    const H = int(p, 'H'), th = (num(p, 'deg') * Math.PI) / 180;
    // A column of H cubes turned rigidly by deg about its base edge (x = 0.5, y = 0), leaning towards +x.
    // Each cube sits 1e-6 m above the one below, so none overlap after rounding.
    // Not quatFromAxisAngle: its 0 * -s is -0, which JSON turns into 0. 0 - s is +0 at deg 0 too.
    const rot: Quat = [0, 0, 0 - Math.sin(th / 2), Math.cos(th / 2)];
    const out: BodyDesc[] = [];
    for (let k = 0; k < H; k++) {
      const x = -0.5, y = 0.5 + k;
      out.push(cube([0.5 + x * Math.cos(th) + y * Math.sin(th), -x * Math.sin(th) + y * Math.cos(th) + 1e-6 * (k + 1), 0], 0, rot));
    }
    return scene('S13', p, seed, out);
  },
};

const S14: ScenarioDef = {
  id: 'S14', title: 'Buildings', catches: 'a city set by building count and size (the viewer\'s scene controls)',
  defaults: { towers: 9, W: 4, D: 4, H: 12, street: 4, vary: 0 },
  build(p, seed) {
    const towers = int(p, 'towers'), W = int(p, 'W'), D = int(p, 'D'), H = int(p, 'H'), street = num(p, 'street'), vary = num(p, 'vary');
    if (street < 0) throw new Error('param street must be >= 0');
    if (vary < 0 || vary > 1) throw new Error('param vary must be from 0 to 1');
    // Towers on a square grid, row by row. vary: each tower's height is uniform in [H (1 - vary), H],
    // rounded, at least 1 cube; vary 0 draws nothing from the seed, so every tower is H tall.
    const r = rng(seed);
    const side = Math.ceil(Math.sqrt(towers));
    const out: BodyDesc[] = [];
    for (let t = 0; t < towers; t++) {
      const ox = ((t % side) - (side - 1) / 2) * (W + street);
      const oz = (Math.floor(t / side) - (side - 1) / 2) * (D + street);
      const h = vary === 0 ? H : Math.max(1, Math.round(H * (1 - vary * r())));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < W; x++)
          for (let z = 0; z < D; z++) out.push(cube([ox + x - (W - 1) / 2, 0.5 + y, oz + z - (D - 1) / 2], t));
    }
    return scene('S14', p, seed, out);
  },
};

export const SCENARIOS: Record<string, ScenarioDef> = Object.fromEntries(
  [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14].map((s) => [s.id, s]),
);

export function buildScenario(id: string, overrides: Params = {}, seed = 1): SceneDesc {
  const def = SCENARIOS[id];
  if (!def) throw new Error(`unknown scenario ${id}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  for (const k of Object.keys(overrides)) if (!(k in def.defaults)) throw new Error(`${id} has no param ${k}`);
  return def.build({ ...def.defaults, ...overrides }, seed);
}
