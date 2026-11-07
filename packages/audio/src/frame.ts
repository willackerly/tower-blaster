// AudioFrame: what the audio thread hears about one rendered frame. The GPU
// audio tap (render, plan S4) and buildFrame below produce the same thing:
//
//   counts, a2  per (material, dv bin, sector): impacts and the sum of
//               A^2, A = dv / distance (m/s per m); sectors split the stereo
//               field left to right as seen from the camera.
//   top         the frame's loudest impacts (largest A), up to K, which the
//               engine plays as their own voices (they are also in counts).
//   space       per sector, SPACE_FIELDS sums over its impacts with weight
//               w = A^2: sum w, sum w pan, sum w distance. The engine plays a
//               sector at its impacts' mean pan and sends it to the room by
//               their mean distance (A8a). Optional: a frame without it plays
//               every sector at its centre, at the reference distance.
//
//   slide       per (material, sector), SLIDE_FIELDS sums over its sliding bodies (A8b): bodies with no
//               impact this frame that moved (faster than vMin on average) and lost energy to their
//               contacts, D = (|v0|^2 - |v|^2) / 2 + g . dx per unit mass (friction's work: a body in free
//               flight, or tipping without slipping, loses none). With w = 2 D / distance^2, in A^2's units:
//               sum w (net: contacts also hand energy from body to body), sum w over the bodies that lost
//               some, that sum weighted by their speed, and their speeds' sum (metres slid a second, at any
//               distance: how many grains the scraping sheds). The engine plays the net as scraping. Optional:
//               only taps asked for it fill it, and their sliding bodies join the space sums.
//
// An impact is a body whose velocity changed by more than dvMin (m/s) since
// the previous frame: a resting body reads 0, a falling one g dt per step, so
// dvMin must stay above g dt (0.16 m/s at 60 steps/s).

/** Lower edges of the dv bins, m/s; the last bin is open. Twice per bin, as the study's (the 3-6 dB loudness bins of Zhang et al. 2019). */
export const DV_EDGES = [0.25, 0.5, 1, 2, 4, 8] as const;
export const TOP_FIELDS = 5; // dv, dist, pan, material, pitch z
export const SPACE_FIELDS = 3; // sum w, sum w pan, sum w dist (w = A^2), per sector
export const SLIDE_FIELDS = 4; // sum w (net), sum w over w > 0, sum w speed over w > 0 (w = 2 D / dist^2), sum speed over w > 0 (m slid a second), per (material, sector)

export interface AudioFrame {
  /** Seconds of simulation since the previous frame (0: paused, nothing to hear). */
  dt: number;
  materials: number;
  sectors: number;
  counts: Float32Array;
  a2: Float32Array;
  /** TOP_FIELDS per impact, loudest first. */
  top: Float32Array;
  /** SPACE_FIELDS per sector (A8a); absent in frames captured before it. */
  space?: Float32Array;
  /** SLIDE_FIELDS per (material, sector) (A8b); absent unless the tap was asked for it. */
  slide?: Float32Array;
}

/** An AudioFrame as JSON (capture-cli.ts, @tb/game sound-cli.ts frames=dir): plain arrays; materials and
 *  sectors may be absent (capture-cli wrote neither before 2026-11-07: its tap is 1 material, 4 sectors). */
export interface FrameRecord { dt: number; materials?: number; sectors?: number; counts: ArrayLike<number>; a2: ArrayLike<number>; top: ArrayLike<number>; space?: ArrayLike<number>; slide?: ArrayLike<number> }

/** Frames from their JSON records, absent materials and sectors as capture-cli's (1, 4); throws on a record
 *  whose arrays do not fit them (a frame without them played only its voices: the engine skips the bank). */
export function framesFrom(records: readonly FrameRecord[]): AudioFrame[] {
  return records.map((r, i) => {
    const materials = r.materials ?? 1, sectors = r.sectors ?? 4, cells = materials * DV_EDGES.length * sectors;
    if (r.counts.length !== cells || r.a2.length !== cells || r.top.length % TOP_FIELDS !== 0 || (r.space && r.space.length !== SPACE_FIELDS * sectors) || (r.slide && r.slide.length !== SLIDE_FIELDS * materials * sectors))
      throw new Error(`frame ${i} does not fit ${materials} materials x ${sectors} sectors: counts ${r.counts.length}, a2 ${r.a2.length}, top ${r.top.length}, space ${r.space?.length ?? '-'}, slide ${r.slide?.length ?? '-'}`);
    const f: AudioFrame = { dt: r.dt, materials, sectors, counts: Float32Array.from(r.counts), a2: Float32Array.from(r.a2), top: Float32Array.from(r.top), space: r.space ? Float32Array.from(r.space) : undefined };
    if (r.slide) f.slide = Float32Array.from(r.slide);
    return f;
  });
}

/** A frame's arrays, to transfer with it to the worklet (postMessage's transfer list). */
export const frameBuffers = (f: AudioFrame): ArrayBuffer[] => [f.counts, f.a2, f.top, f.space, f.slide].flatMap((a) => (a ? [a.buffer as ArrayBuffer] : []));

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
  /** Sliding contacts (A8b): positions at the previous frame (units) turn the slide sums on. */
  prevPos?: ArrayLike<number>;
  slide?: SlideParams;
}

/** What counts as sliding (A8b). */
export interface SlideParams {
  /** Slower than this (m/s) on average over the frame: resting or settling, not sliding (a tower built with gaps settles at ~0.06). Default SLIDE_VMIN. */
  vMin?: number;
  /** Gravity, m/s^2 (default [0, -9.81, 0]). */
  gravity?: readonly [number, number, number];
}
export const SLIDE_VMIN = 0.2;
const G0 = [0, -9.81, 0] as const;

/** A sliding body's D (energy lost to its contacts, per unit mass, J/kg) and speed (m/s), or null if it is not one. */
export function slideOf(v: readonly [number, number, number], v0: readonly [number, number, number], dx: readonly [number, number, number], p: SlideParams = {}): [number, number] | null {
  const s2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2, s02 = v0[0] ** 2 + v0[1] ** 2 + v0[2] ** 2, vm = p.vMin ?? SLIDE_VMIN, g = p.gravity ?? G0;
  const speed = (Math.sqrt(s2) + Math.sqrt(s02)) / 2;
  if (speed < vm) return null;
  return [(s02 - s2) / 2 + g[0] * dx[0] + g[1] * dx[1] + g[2] * dx[2], speed];
}

/** CPU reference for the GPU tap: the definition its results must match. */
export function buildFrame(f: FrameInput): AudioFrame {
  const cells = f.materials * DV_EDGES.length * f.sectors;
  const counts = new Float32Array(cells), a2 = new Float32Array(cells), space = new Float32Array(SPACE_FIELDS * f.sectors);
  const cand: number[][] = [], slide = f.prevPos ? new Float32Array(SLIDE_FIELDS * f.materials * f.sectors) : null;
  for (let i = 0; i < f.n; i++) {
    const m = f.material[i]!;
    if (m < 0 || m >= f.materials) continue;
    const dx = f.vel[3 * i]! - f.prevVel[3 * i]!, dy = f.vel[3 * i + 1]! - f.prevVel[3 * i + 1]!, dz = f.vel[3 * i + 2]! - f.prevVel[3 * i + 2]!;
    const dv = Math.hypot(dx, dy, dz) * f.metres;
    if (!(dv > f.dvMin)) {
      if (slide) {
        const M = f.metres, o = 3 * i, pp = f.prevPos!;
        const r = slideOf([f.vel[o]! * M, f.vel[o + 1]! * M, f.vel[o + 2]! * M], [f.prevVel[o]! * M, f.prevVel[o + 1]! * M, f.prevVel[o + 2]! * M], [(f.pos[o]! - pp[o]!) * M, (f.pos[o + 1]! - pp[o + 1]!) * M, (f.pos[o + 2]! - pp[o + 2]!) * M], f.slide);
        if (r) {
          const px = f.pos[o]! * M - f.camera.pos[0], py = f.pos[o + 1]! * M - f.camera.pos[1], pz = f.pos[o + 2]! * M - f.camera.pos[2];
          const dist = Math.max(Math.hypot(px, py, pz), 0.5), pan = (px * f.camera.right[0] + py * f.camera.right[1] + pz * f.camera.right[2]) / dist;
          const sec = sectorOf(pan, f.sectors), w = (2 * r[0]) / (dist * dist), q = SLIDE_FIELDS * (m * f.sectors + sec);
          slide[q]! += w;
          if (w > 0) { slide[q + 1]! += w; slide[q + 2]! += w * r[1]; slide[q + 3]! += r[1]; space[SPACE_FIELDS * sec]! += w; space[SPACE_FIELDS * sec + 1]! += w * pan; space[SPACE_FIELDS * sec + 2]! += w * dist; }
        }
      }
      continue;
    }
    const px = f.pos[3 * i]! * f.metres - f.camera.pos[0], py = f.pos[3 * i + 1]! * f.metres - f.camera.pos[1], pz = f.pos[3 * i + 2]! * f.metres - f.camera.pos[2];
    const dist = Math.max(Math.hypot(px, py, pz), 0.5);
    const pan = (px * f.camera.right[0] + py * f.camera.right[1] + pz * f.camera.right[2]) / dist;
    const A = dv / dist, sec = sectorOf(pan, f.sectors), c = cellOf(m, binOf(dv), sec, f.sectors);
    counts[c]! += 1;
    a2[c]! += A * A;
    space[SPACE_FIELDS * sec]! += A * A; space[SPACE_FIELDS * sec + 1]! += A * A * pan; space[SPACE_FIELDS * sec + 2]! += A * A * dist;
    cand.push([A, dv, dist, pan, m, pitchZ(i)]);
  }
  cand.sort((p, q) => q[0]! - p[0]!);
  const k = Math.min(f.top, cand.length), top = new Float32Array(k * TOP_FIELDS);
  for (let j = 0; j < k; j++) top.set(cand[j]!.slice(1), j * TOP_FIELDS);
  const out: AudioFrame = { dt: f.dt, materials: f.materials, sectors: f.sectors, counts, a2, top, space };
  if (slide) out.slide = slide;
  return out;
}
