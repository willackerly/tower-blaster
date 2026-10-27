// Kapla tower geometry for S15: pure layout, no engine types.
//
// Units are plank widths: a Kapla plank is 117 x 23.4 x 7.8 mm (15:3:1), so it
// is 5 x 1 x 1/3 units and one unit is KAPLA_SCALE metres. Simulating in these
// units keeps the solver's length tolerances (tuned on 1 m cubes) at the same
// proportion of a plank's thickness as of a cube; the viewer's world scale
// turns units into metres.
//
// Pattern ("frame"): the tower stands on a square grid of cells one plank
// long (pitch P = L + joint). Every storey is
//   A: flat planks along x on the grid lines z = kP, ends butted at the nodes;
//   B: flat planks along z on the lines x = iP, crossing on top of A's ends;
//   pillars: planks on end at the nodes, standing on B and carrying the next A.
// Inside the footprint every plank's support is symmetric about its centre
// line: a pillar (wide face along z) straddles the butt joint of the two B
// planks under it, and a B plank's ends straddle the joint of two A planks.
// At the edge only one plank meets a node, so the plank resting there moves
// half a width inwards (plus half a joint) to sit wholly on it: B planks on an
// edge column move in x, pillars follow the B planks under them, and A planks
// on an edge row move in z when both pillars under them did. Without this the
// edge planks' centres sit half a joint outside their supports and tip.
// Footprints only shrink going up, so every edge node above a setback is an
// inside node below it, where nothing moved. Towers never share a node.

export const KAPLA_SCALE = 0.0234; // metres per unit (one plank width)
export const PLANK_L = 5;
export const PLANK_W = 1;
export const PLANK_T = 1 / 3;
/** Height of one storey: two flat layers and a pillar. */
export const STOREY = 2 * PLANK_T + PLANK_L;

export const enum PlankRole { A = 0, B = 1, Pillar = 2 }

export interface Plank {
  pos: [number, number, number];
  half: [number, number, number];
  storey: number;
  role: PlankRole;
}

/** Cell rectangle [x0, x1) x [z0, z1) in cell coordinates; cell (i, k) has its low corner at node (i, k). */
export type Rect = [number, number, number, number];

export interface KaplaShape {
  /** Base width of the central tower in cells. */
  cells: number;
  /** Storeys in all. */
  storeys: number;
  /** 1, or 5 for a central tower with four satellites, one empty cell away. */
  towers: number;
  /** Tiers the central tower steps in through (before the spire). */
  setbacks: number;
  /** Width of the top tier over the base width, 0..1. */
  taper: number;
  /** Fraction of the storeys that make the one-cell spire, 0..1. */
  spire: number;
}

/** Storeys [from, to) share one footprint. */
export interface Segment { from: number; to: number; rects: Rect[] }

function centred(w: number): [number, number] {
  return [0 - Math.floor(w / 2), Math.ceil(w / 2)]; // 0 - x: never -0, which JSON would turn into 0
}

/** The footprint of every storey, as runs of storeys. Footprints only shrink going up. */
export function layout(s: KaplaShape): Segment[] {
  const H = s.storeys;
  const spire = H >= 2 && s.spire > 0 ? Math.min(H - 1, Math.round(H * s.spire)) : 0;
  const body = H - spire;
  const tiers = Math.max(1, Math.min(s.setbacks, body));
  const out: Segment[] = [];
  const tierWidth = (k: number) => Math.max(1, Math.round(s.cells * (1 - (1 - s.taper) * (tiers > 1 ? k / (tiers - 1) : 0))));
  const square = (w: number): Rect => { const [a, b] = centred(w); return [a, b, a, b]; };
  for (let k = 0; k < tiers; k++) {
    const from = Math.floor((k * body) / tiers), to = Math.floor(((k + 1) * body) / tiers);
    if (to > from) out.push({ from, to, rects: [square(tierWidth(k))] });
  }
  if (spire > 0) out.push({ from: body, to: H, rects: [square(1)] });

  // Satellites stand beside the base tier, one empty cell away, as tall as that tier.
  if (s.towers === 5 && s.cells >= 3 && out.length > 0) {
    const ws = Math.max(1, Math.floor(s.cells / 3));
    const [c0, c1] = centred(s.cells), [s0, s1] = centred(ws);
    const sats: Rect[] = [[c1 + 1, c1 + 1 + ws, s0, s1], [c0 - 1 - ws, c0 - 1, s0, s1], [s0, s1, c1 + 1, c1 + 1 + ws], [s0, s1, c0 - 1 - ws, c0 - 1]];
    out[0] = { ...out[0]!, rects: [...out[0]!.rects, ...sats] };
  }
  return out;
}

const inside = (rects: Rect[], i: number, k: number) => rects.some(([x0, x1, z0, z1]) => i >= x0 && i < x1 && k >= z0 && k < z1);

/** The grid sides and nodes of one footprint. */
export function storeyParts(rects: Rect[]) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[1]); z0 = Math.min(z0, r[2]); z1 = Math.max(z1, r[3]); }
  const cell = (i: number, k: number) => inside(rects, i, k);
  const a: Array<[number, number]> = []; // side (i, k)-(i+1, k)
  const b: Array<[number, number]> = []; // side (i, k)-(i, k+1)
  const nodes: Array<[number, number]> = [];
  for (let k = z0; k <= z1; k++)
    for (let i = x0; i <= x1; i++) {
      if (cell(i, k - 1) || cell(i, k)) a.push([i, k]);
      if (cell(i - 1, k) || cell(i, k)) b.push([i, k]);
      if (cell(i - 1, k - 1) || cell(i, k - 1) || cell(i - 1, k) || cell(i, k)) nodes.push([i, k]);
    }
  return { a, b, nodes };
}

const perStoreyCache = new Map<string, number>();
function perStorey(rects: Rect[]): number {
  const key = rects.join(';');
  let n = perStoreyCache.get(key);
  if (n === undefined) {
    const p = storeyParts(rects);
    n = p.a.length + p.b.length + p.nodes.length;
    perStoreyCache.set(key, n);
  }
  return n;
}

export function plankCount(s: KaplaShape): number {
  let n = 0;
  for (const seg of layout(s)) n += (seg.to - seg.from) * perStorey(seg.rects);
  return n;
}

/**
 * Storeys (and, when cells is 0, the base width) that bring the count closest
 * to target. With cells 0 the base width is the one whose tower is closest to
 * `slender` (height over central base width).
 */
export function fitShape(base: Omit<KaplaShape, 'storeys'>, target: number, slender: number): KaplaShape {
  const fitStoreys = (cells: number): KaplaShape => {
    const at = (storeys: number) => ({ ...base, cells, storeys });
    let lo = 1, hi = 1;
    while (plankCount(at(hi)) < target && hi < 1 << 16) hi *= 2;
    while (lo < hi) { const m = (lo + hi) >> 1; if (plankCount(at(m)) < target) lo = m + 1; else hi = m; }
    const above = at(lo), below = at(Math.max(1, lo - 1));
    return Math.abs(plankCount(below) - target) < Math.abs(plankCount(above) - target) ? below : above;
  };
  if (base.cells > 0) return fitStoreys(base.cells);
  let best: KaplaShape | null = null, bestErr = Infinity;
  for (let cells = 1; cells <= 256; cells++) {
    const s = fitStoreys(cells);
    const aspect = (s.storeys * STOREY) / (cells * (PLANK_L));
    const err = Math.abs(Math.log(aspect / slender));
    if (err < bestErr) { best = s; bestErr = err; }
    if (aspect < slender / 2) break;
  }
  return best!;
}

/**
 * Every plank of the tower, storey by storey (A, B, then pillars), resting on
 * y = 0. joint: gap at each butt joint; jitter: uniform horizontal placement
 * noise, at most joint / 2 so butted planks never overlap.
 */
export function buildPlanks(s: KaplaShape, joint: number, jitter: number, rand: () => number): Plank[] {
  // Pillars are T wide along x and carry the butted ends of the A planks above them.
  if (!(joint >= 0 && joint < PLANK_T)) throw new Error('joint must be in [0, 1/3) units');
  if (!(jitter >= 0) || 2 * jitter > joint) throw new Error('jitter must be in [0, joint / 2]');
  const P = PLANK_L + joint, L = PLANK_L, T = PLANK_T, W = PLANK_W;
  const d = (W + joint) / 2; // edge shift: half a width plus half a joint
  const j = () => (jitter > 0 ? (rand() * 2 - 1) * jitter : 0);
  const key = (i: number, k: number) => `${i},${k}`;
  const out: Plank[] = [];
  let pillarDz = new Map<string, number>(); // the storey below's pillar z shifts
  for (const seg of layout(s)) {
    const parts = storeyParts(seg.rects);
    const aSet = new Set(parts.a.map(([i, k]) => key(i, k)));
    const bSet = new Set(parts.b.map(([i, k]) => key(i, k)));
    // x shift of the B plank (i, k)-(i, k+1): +1 when only A planks on the right meet both its ends, -1 on the left.
    const side = (i: number, k: number) => (aSet.has(key(i - 1, k)) ? (aSet.has(key(i, k)) ? 0 : -1) : 1);
    const bDx = new Map(parts.b.map(([i, k]) => { const e = side(i, k), f = side(i, k + 1); return [key(i, k), e === f ? e : 0]; }));
    const pDx = new Map<string, number>(), pDz = new Map<string, number>();
    for (const [i, k] of parts.nodes) {
      const up = bDx.get(key(i, k)), down = bDx.get(key(i, k - 1));
      pDz.set(key(i, k), up !== undefined && down !== undefined ? 0 : up !== undefined ? 1 : -1);
      pDx.set(key(i, k), up !== undefined && down !== undefined ? (up === down ? up : 0) : (up ?? down!));
    }
    for (let y = seg.from; y < seg.to; y++) {
      const y0 = y * STOREY;
      for (const [i, k] of parts.a) {
        const e = pillarDz.get(key(i, k)) ?? 0, f = pillarDz.get(key(i + 1, k)) ?? 0;
        out.push({ pos: [(i + 0.5) * P + j(), y0 + T / 2, k * P + (e === f ? e * d : 0) + j()], half: [L / 2, T / 2, W / 2], storey: y, role: PlankRole.A });
      }
      for (const [i, k] of parts.b) out.push({ pos: [i * P + bDx.get(key(i, k))! * d + j(), y0 + T + T / 2, (k + 0.5) * P + j()], half: [W / 2, T / 2, L / 2], storey: y, role: PlankRole.B });
      for (const [i, k] of parts.nodes) out.push({ pos: [i * P + pDx.get(key(i, k))! * d + j(), y0 + 2 * T + L / 2, k * P + pDz.get(key(i, k))! * d + j()], half: [T / 2, L / 2, W / 2], storey: y, role: PlankRole.Pillar });
      pillarDz = pDz;
    }
  }
  return out;
}
