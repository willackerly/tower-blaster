// AudioFrame: what the audio thread hears about one rendered frame. The GPU
// audio tap (render, plan S4) and buildFrame below produce the same thing:
//
//   counts, a2  per (material, dv bin, sector): impacts and the sum of
//               A^2, A = dv / distance (m/s per m); sectors split the stereo
//               field left to right as seen from the camera.
//   top         the frame's loudest impacts (largest A), up to K, which the
//               engine plays as their own voices (they are also in counts).
//
// An impact is a body whose velocity changed by more than dvMin (m/s) since
// the previous frame: a resting body reads 0, a falling one g dt per step, so
// dvMin must stay above g dt (0.16 m/s at 60 steps/s).

/** Lower edges of the dv bins, m/s; the last bin is open. Twice per bin, as the study's (the 3-6 dB loudness bins of Zhang et al. 2019). */
export const DV_EDGES = [0.25, 0.5, 1, 2, 4, 8] as const;
export const TOP_FIELDS = 5; // dv, dist, pan, material, pitch z

export interface AudioFrame {
  /** Seconds of simulation since the previous frame (0: paused, nothing to hear). */
  dt: number;
  materials: number;
  sectors: number;
  counts: Float32Array;
  a2: Float32Array;
  /** TOP_FIELDS per impact, loudest first. */
  top: Float32Array;
}

export const binOf = (dv: number): number => {
  let b = 0;
  while (b + 1 < DV_EDGES.length && dv >= DV_EDGES[b + 1]!) b++;
  return b;
};
export const cellOf = (material: number, bin: number, sector: number, sectors: number): number => (material * DV_EDGES.length + bin) * sectors + sector;
export const sectorOf = (pan: number, sectors: number): number => Math.min(sectors - 1, Math.max(0, Math.floor(((pan + 1) / 2) * sectors)));

/** A body's pitch: a standard normal from its slot (stable across frames, so a plank always rings the same). */
export function pitchZ(slot: number): number {
  let h = Math.imul(slot ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  const u1 = ((h & 0xffff) + 0.5) / 65536, u2 = ((h >>> 16) + 0.5) / 65536;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface FrameInput {
  /** Body slots in [0, n): positions (units), velocity now and at the previous frame (units/s), sound material (-1: silent). */
  n: number;
  pos: ArrayLike<number>;
  vel: ArrayLike<number>;
  prevVel: ArrayLike<number>;
  material: ArrayLike<number>;
  /** Metres per scene unit (the viewer's world scale). Velocities are already real-time. */
  metres: number;
  camera: { pos: [number, number, number]; right: [number, number, number] };
  dt: number;
  dvMin: number;
  materials: number;
  sectors: number;
  top: number;
}

/** CPU reference for the GPU tap: the definition its results must match. */
export function buildFrame(f: FrameInput): AudioFrame {
  const cells = f.materials * DV_EDGES.length * f.sectors;
  const counts = new Float32Array(cells), a2 = new Float32Array(cells);
  const cand: number[][] = [];
  for (let i = 0; i < f.n; i++) {
    const m = f.material[i]!;
    if (m < 0 || m >= f.materials) continue;
    const dx = f.vel[3 * i]! - f.prevVel[3 * i]!, dy = f.vel[3 * i + 1]! - f.prevVel[3 * i + 1]!, dz = f.vel[3 * i + 2]! - f.prevVel[3 * i + 2]!;
    const dv = Math.hypot(dx, dy, dz) * f.metres;
    if (!(dv > f.dvMin)) continue;
    const px = f.pos[3 * i]! * f.metres - f.camera.pos[0], py = f.pos[3 * i + 1]! * f.metres - f.camera.pos[1], pz = f.pos[3 * i + 2]! * f.metres - f.camera.pos[2];
    const dist = Math.max(Math.hypot(px, py, pz), 0.5);
    const pan = (px * f.camera.right[0] + py * f.camera.right[1] + pz * f.camera.right[2]) / dist;
    const A = dv / dist, c = cellOf(m, binOf(dv), sectorOf(pan, f.sectors), f.sectors);
    counts[c]! += 1;
    a2[c]! += A * A;
    cand.push([A, dv, dist, pan, m, pitchZ(i)]);
  }
  cand.sort((p, q) => q[0]! - p[0]!);
  const k = Math.min(f.top, cand.length), top = new Float32Array(k * TOP_FIELDS);
  for (let j = 0; j < k; j++) top.set(cand[j]!.slice(1), j * TOP_FIELDS);
  return { dt: f.dt, materials: f.materials, sectors: f.sectors, counts, a2, top };
}
