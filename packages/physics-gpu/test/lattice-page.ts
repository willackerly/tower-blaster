// Page-side drivers for the lattice colouring (AvbdParams.colorMode,
// colorPriority): lattice*.test.ts and scripts/lattice-structure.ts. Bundled by
// loadBundle; the general drivers (simulateGpu) come from page.ts.
import { readBuffer, sharedDevice } from '@tb/gpu';
import { type SceneDesc, spawnedBodies } from '@tb/engine-api';
import { type AvbdParams, colorGraphWith, latticeParity, latticePreferences, outranks } from '@tb/physics-ref';
import { GpuAvbdEngine, type GpuEngineOptions, MAX_COLORS } from '../src/index.ts';

export { simulateGpu } from './page.ts';

const NONE = 0xffffffff;

/** Contact pairs between two lattice cubes, by the offset of their cells (the patterns' kernels; see physics-ref coloring.ts). */
export interface PairKinds { face: number; verticalDiagonal: number; inPlaneDiagonal: number; corner: number; other: number }

/** One step's colouring on the GPU: the solver's structure counters, and whether the reference rule gives the same colours. */
export interface ColourCheck {
  step: number;
  n: number;
  /** Colours used (largest + 1) and those with bodies. */
  K: number;
  nonEmpty: number;
  /** Bodies per colour, 0..K-1. */
  sizes: number[];
  /** Per colour, the most contact points one body of it walks (W_c). */
  W: number[];
  /**
   * The serial point chain of one sweep as the solver dispatches it (the probe's ΣW): W_c of each direct colour
   * (c < colorTail), plus the tail's critical path (per tail colour, the most points one of the tailThreads threads
   * walks, its bodies dealt round-robin), plus the serial colour 63.
   */
  sumW: number;
  tail: { colours: number; bodies: number; Wcrit: number };
  /** Points walked per sweep, all bodies. */
  points: number;
  /** Jones-Plassmann rounds the priority needs on this graph (the GPU runs 64). */
  jpRounds: number;
  /** Bodies with a lattice preference, those that took it, and those preferring a fallback colour (>= 4) in modes 2-3. */
  preferring: number;
  tookPreference: number;
  fallback: number;
  pairs: PairKinds;
  uncolored: number;
  overflow: number;
  /** GPU colours equal the reference rule's (physics-ref colorGraphWith, latticePreferences) on the GPU's poses and graph. */
  match: boolean;
  mismatches: number;
}

const halfOf = (b: SceneDesc['bodies'][number]) => (b.shape.kind === 'box' && b.shape.half[0] === b.shape.half[1] && b.shape.half[0] === b.shape.half[2] ? b.shape.half[0] : null);

/**
 * Run `scene` on the GPU engine and, at each step in `at`, read that step's
 * colouring and structure. The colouring is taken from the poses at the start
 * of the step, so the snapshot is read before stepping.
 */
export async function latticeRun(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'>, at: number[], log = false) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  await e.init(scene);
  // Bodies in the engine's order: the scene's, then its inputs by step.
  const descs = [...scene.bodies, ...spawnedBodies([...scene.inputs].sort((a, b) => a.step - b.step))];
  const mode = params.colorMode ?? 0, degreeFirst = (params.colorPriority ?? 0) === 1;
  const gy = scene.ground?.y ?? 0;
  const checks: ColourCheck[] = [];
  const t0 = performance.now();
  for (let s = 1; s <= steps; s++) {
    const want = at.includes(s);
    const before = want ? await e.snapshot() : null;
    e.step();
    if (!before) continue;
    const pp = e.probeParts();
    const { n, col, solver, dispatch } = pp;
    const d = await e.diagnostics();
    const u32 = async (b: GPUBuffer, bytes: number, offset = 0) => new Uint32Array(await readBuffer(device, b, Math.max(4, bytes), offset));
    const colors = await u32(col.colors, n * 4);
    const rowStart = await u32(col.rowStart, n * 4);
    const rowLength = await u32(col.rowLength, n * 4);
    let edges = 0;
    for (let i = 0; i < n; i++) edges = Math.max(edges, rowStart[i]! + rowLength[i]!);
    edges = Math.min(edges, col.maxEdges);
    const adj = await u32(col.adj, edges * 4);
    const adjSlot = await u32(col.adjSlot, edges * 4);
    const lists = Array.from({ length: n }, (_, i) => Array.from(adj.subarray(rowStart[i]!, Math.min(rowStart[i]! + rowLength[i]!, edges))));
    // The reference rule on the GPU's poses (f32) and graph.
    const parity = Array.from({ length: n }, (_, i) => latticeParity(before.pos.subarray(3 * i, 3 * i + 3), before.rot.subarray(4 * i, 4 * i + 4), halfOf(descs[i]!), gy));
    const prefer = mode ? latticePreferences(lists, parity, mode) : null;
    const ref = colorGraphWith(lists, { ...(prefer ? { prefer } : {}), degreeFirst });
    let mismatches = 0, preferring = 0, took = 0, fallback = 0;
    for (let i = 0; i < n; i++) {
      if (colors[i] !== ref[i]) mismatches++;
      if (prefer && prefer[i]! >= 0) { preferring++; if (colors[i] === prefer[i]) took++; if (prefer[i]! >= 4 && mode !== 1) fallback++; }
    }
    // Rounds: a body colours one round after the latest of its higher-priority neighbours.
    const beats = (v: number, u: number) => (degreeFirst && lists[v]!.length !== lists[u]!.length ? lists[v]!.length > lists[u]!.length : outranks(v, u));
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => (beats(i, j) ? -1 : beats(j, i) ? 1 : 0));
    const round = new Int32Array(n);
    let jpRounds = 0;
    for (const v of order) {
      let r = 1;
      for (const u of lists[v]!) if (beats(u, v)) r = Math.max(r, round[u]! + 1);
      round[v] = r;
      jpRounds = Math.max(jpRounds, r);
    }
    // Contact pairs by cell offset, both bodies on the lattice (cells from the nearer lattice, as latticeParity).
    const cellOf = (i: number) => {
      const h = halfOf(descs[i]!);
      if (h === null || parity[i]! < 0) return null;
      return [0, 1, 2].map((k) => {
        const q = (k === 1 ? before.pos[3 * i + 1]! - gy : before.pos[3 * i + k]!) / (2 * h), f = Math.floor(q);
        return Math.abs(q - f - 0.5) < 0.25 ? f : Math.floor(q + 0.5);
      });
    };
    const pairs: PairKinds = { face: 0, verticalDiagonal: 0, inPlaneDiagonal: 0, corner: 0, other: 0 };
    for (let i = 0; i < n; i++) for (const j of lists[i]!) {
      if (j <= i) continue;
      const a = cellOf(i), b = cellOf(j);
      if (!a || !b) continue;
      const o = [0, 1, 2].map((k) => Math.abs(a[k]! - b[k]!));
      const k = o[0]! + o[1]! + o[2]!;
      if (o.some((x) => x > 1) || k === 0) pairs.other++;
      else if (k === 1) pairs.face++;
      else if (k === 3) pairs.corner++;
      else if (o[1] === 0) pairs.inPlaneDiagonal++;
      else pairs.verticalDiagonal++;
    }
    // Points each body's primal walks (as the probe counts them): the points of each slot in its row, and of its ground slot.
    const slots = d.pairsWritten;
    const { pairs: pairPts, ground: groundPts } = await solver.slotPoints(slots, n);
    const pointsOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (let k = rowStart[i]!; k < Math.min(rowStart[i]! + rowLength[i]!, edges); k++) {
        const slot = adjSlot[k] ?? NONE;
        if (slot < slots) p += pairPts[slot]!;
      }
      pointsOf[i] = p + groundPts[i]!;
    }
    let K = 0;
    for (let i = 0; i < n; i++) K = Math.max(K, colors[i]! + 1);
    const sizes = new Array<number>(K).fill(0), W = new Array<number>(K).fill(0);
    const members: number[][] = Array.from({ length: K }, () => []);
    for (let i = 0; i < n; i++) { const c = colors[i]!; sizes[c]!++; W[c] = Math.max(W[c]!, pointsOf[i]!); members[c]!.push(i); }
    const nd = dispatch.indirectColors ? MAX_COLORS - 1 : dispatch.colorTail;
    let sumW = 0, tailColours = 0, tailBodies = 0, Wcrit = 0;
    for (let c = 0; c < K; c++) {
      if (c < nd) { sumW += W[c]!; continue; }
      const bs = members[c]!;
      if (!bs.length) continue;
      if (c === MAX_COLORS - 1) { const serial = bs.reduce((s2, b) => s2 + pointsOf[b]!, 0); Wcrit += serial; sumW += serial; continue; }
      tailColours++; tailBodies += bs.length;
      const perThread = new Array<number>(dispatch.tailThreads).fill(0);
      bs.forEach((b, k) => { perThread[k % dispatch.tailThreads]! += pointsOf[b]!; });
      const m = Math.max(...perThread);
      Wcrit += m; sumW += m;
    }
    checks.push({
      step: s, n, K, nonEmpty: sizes.filter((x) => x > 0).length, sizes, W, sumW, tail: { colours: tailColours, bodies: tailBodies, Wcrit },
      points: pointsOf.reduce((a, b) => a + b, 0), jpRounds, preferring, tookPreference: took, fallback, pairs,
      uncolored: d.uncolored, overflow: d.colorOverflow, match: mismatches === 0, mismatches,
    });
    if (log) console.log(`[lattice] step ${s}: K ${K}, ΣW ${sumW}, mismatches ${mismatches}, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  const snap = await e.snapshot();
  const error = await device.popErrorScope();
  e.dispose();
  return { error: error?.message ?? null, checks, final: { pos: [...snap.pos], rot: [...snap.rot], linVel: [...snap.linVel] }, wallMs: performance.now() - t0 };
}
