// FrameTap: AudioFrames from a stream of snapshots, on the CPU. It is
// buildFrame (frame.ts) made incremental and allocation-free in its loop: it
// keeps each slot's velocity from its last frame, so a caller hands it only
// the newest positions and velocities.
//
//   - A slot it has not seen (a new spawn, or every slot after reset) only
//     records its velocity: a ball spawned at 30 m/s is not an impact.
//   - Call it at most at the frame rate. Between its frames, steps add up: a
//     plank stopped over three substeps reads one dv, not three below dvMin.
//   - The K loudest are kept by insertion, an earlier slot first on a tie,
//     as buildFrame's stable sort does; the test holds the two equal.
//
// Cost: one pass over the slots (~10 ns each in V8), so 10k bodies are
// ~0.1 ms of main thread a frame. The GPU tap (plan S4) replaces it when the
// snapshots stop coming back to the CPU.
import { binOf, cellOf, DV_EDGES, pitchZ, sectorOf, TOP_FIELDS, type AudioFrame } from './frame.ts';

export interface TapInput {
  count: number;
  pos: ArrayLike<number>;
  linVel: ArrayLike<number>;
}

export interface TapParams {
  /** Metres per scene unit. */
  metres: number;
  /** Camera position (metres) and its unit right vector. */
  camera: { pos: readonly [number, number, number]; right: readonly [number, number, number] };
  dvMin: number;
  /** Wall-clock seconds this frame covers (the synth spreads its impacts over it). */
  dt: number;
  /** Loudest impacts to report one by one (foreground voices). */
  top: number;
}

export class FrameTap {
  readonly materials: number;
  readonly sectors: number;
  private prev = new Float64Array(0);
  private seen = 0;
  private mat = new Int8Array(0);
  private keyA = new Float64Array(0);
  private keyI = new Int32Array(0);
  private keyD = new Float64Array(0);

  constructor(opts: { materials: number; sectors: number }) {
    this.materials = opts.materials;
    this.sectors = opts.sectors;
  }

  /** Sound material per slot (-1 silent); slots past the end are silent. */
  setMaterials(m: ArrayLike<number>): void {
    this.mat = Int8Array.from(m);
  }

  /** Material of one slot (grow as bodies spawn). */
  setMaterial(slot: number, m: number): void {
    if (slot >= this.mat.length) { const g = new Int8Array(Math.max(slot + 1, 2 * this.mat.length)).fill(-1); g.set(this.mat); this.mat = g; }
    this.mat[slot] = m;
  }

  /** Forget every velocity (a new scene): the next frame only records. */
  reset(): void {
    this.seen = 0;
  }

  frame(s: TapInput, p: TapParams): AudioFrame {
    const cells = this.materials * DV_EDGES.length * this.sectors;
    const counts = new Float32Array(cells), a2 = new Float32Array(cells);
    const K = Math.max(0, Math.floor(p.top));
    if (this.keyA.length < K) { this.keyA = new Float64Array(K); this.keyI = new Int32Array(K); this.keyD = new Float64Array(K); }
    if (this.prev.length < 3 * s.count) { const g = new Float64Array(Math.max(3 * s.count, 2 * this.prev.length)); g.set(this.prev); this.prev = g; }
    const prev = this.prev, v = s.linVel, x = s.pos, mats = this.mat, M = this.materials, S = this.sectors, m = p.metres;
    const [cx, cy, cz] = p.camera.pos, [rx, ry, rz] = p.camera.right;
    const keyA = this.keyA, keyI = this.keyI, keyD = this.keyD;
    let kept = 0;
    const seen = Math.min(this.seen, s.count);
    for (let i = 0; i < seen; i++) {
      const o = 3 * i, vx = v[o]!, vy = v[o + 1]!, vz = v[o + 2]!;
      const dx = vx - prev[o]!, dy = vy - prev[o + 1]!, dz = vz - prev[o + 2]!;
      prev[o] = vx; prev[o + 1] = vy; prev[o + 2] = vz;
      const mi = i < mats.length ? mats[i]! : -1;
      if (mi < 0 || mi >= M) continue;
      const dv = Math.sqrt(dx * dx + dy * dy + dz * dz) * m;
      if (!(dv > p.dvMin)) continue;
      const px = x[o]! * m - cx, py = x[o + 1]! * m - cy, pz = x[o + 2]! * m - cz;
      const dist = Math.max(Math.sqrt(px * px + py * py + pz * pz), 0.5);
      const pan = (px * rx + py * ry + pz * rz) / dist;
      const A = dv / dist, c = cellOf(mi, binOf(dv), sectorOf(pan, S), S);
      counts[c]! += 1;
      a2[c]! += A * A;
      // Top K by A, strictly louder to enter: ties keep the earlier slot.
      if (kept < K || A > keyA[kept - 1]!) {
        let j = kept < K ? kept++ : kept - 1;
        while (j > 0 && keyA[j - 1]! < A) { keyA[j] = keyA[j - 1]!; keyI[j] = keyI[j - 1]!; keyD[j] = keyD[j - 1]!; j--; }
        keyA[j] = A; keyI[j] = i; keyD[j] = dv;
      }
    }
    for (let i = seen; i < s.count; i++) { prev[3 * i] = v[3 * i]!; prev[3 * i + 1] = v[3 * i + 1]!; prev[3 * i + 2] = v[3 * i + 2]!; }
    this.seen = s.count;
    const top = new Float32Array(kept * TOP_FIELDS);
    for (let j = 0; j < kept; j++) {
      const i = keyI[j]!, o = 3 * i;
      const px = x[o]! * m - cx, py = x[o + 1]! * m - cy, pz = x[o + 2]! * m - cz;
      const dist = Math.max(Math.sqrt(px * px + py * py + pz * pz), 0.5);
      top.set([keyD[j]!, dist, (px * rx + py * ry + pz * rz) / dist, mats[i]!, pitchZ(i)], j * TOP_FIELDS);
    }
    return { dt: p.dt, materials: M, sectors: S, counts, a2, top };
  }
}
