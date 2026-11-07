// Scraping (A8b). The tap sums, per (material, sector), the energy sliding bodies lose to their contacts:
// D = (|v0|^2 - |v|^2) / 2 + g . dx per unit mass, for bodies with no impact that move faster than vMin on
// average (frame.ts slideOf). The engine plays it (setSlide) as stick-slip crackle: grains of a few ms, one per
// scrapePulse slid, at 10^((levelDb + scrapeDb)/10) of the modal energy a bin-0 impact of the same A^2 rings.
// Off (the default), and on with frames that carry no slide sums, it plays exactly as before.
import { describe, expect, it } from 'vitest';
import { type AudioFrame, BLOCK, buildFrame, CollapseEngine, type FrameInput, framesFrom, FrameTap, SCRAPE_DB, SCRAPE_PULSE, sectorOf, SLIDE_FIELDS, SLIDE_VMIN, slideOf, type SoundMaterial, soundMaterials, SPACE_FIELDS } from '@tb/audio';
import { rng } from '@tb/scenarios';
import { db, FRAME, frame, pine, SR } from './helpers.ts';

const G = 9.81, DT = 1 / 60;

describe('slide sums (frame.ts, tap.ts)', () => {
  it('slideOf: free flight loses nothing, a body braking on the floor loses its kinetic energy, a slow one is not sliding', () => {
    // Free fall over one step (constant acceleration): kinetic energy gained is gravity's work, D = 0.
    const v0 = -1, v1 = v0 - G * DT;
    expect(slideOf([0.3, v1, 0], [0.3, v0, 0], [0.3 * DT, ((v0 + v1) / 2) * DT, 0])![0]).toBeCloseTo(0, 12);
    // Braking from 1 to 0.9 m/s on the floor: D = (1 - 0.81) / 2, speed the mean.
    expect(slideOf([0.9, 0, 0], [1, 0, 0], [0.95 * DT, 0, 0])).toEqual([expect.closeTo(0.095, 12), 0.95]);
    // Sliding up a slope also loses what gravity takes back: none of it is friction.
    const up = slideOf([0, 0.8, 0], [0, 1, 0], [0, 0.9 * DT, 0])!;
    expect(up[0]).toBeCloseTo(0.18 - G * 0.9 * DT, 12);
    // Other gravity (a level's): its work is the scene's.
    expect(slideOf([0, v1 / 2, 0], [0, v0, 0], [0, 0, 0], { gravity: [0, -G / 2, 0] })![0]).toBeCloseTo((1 - (v1 / 2) ** 2) / 2, 12);
    // A tower settling (~0.06 m/s) is not sliding; the threshold is the mean speed over the frame.
    expect(slideOf([0.06, 0, 0], [0.07, 0, 0], [0, 0, 0])).toBeNull();
    expect(slideOf([SLIDE_VMIN * 1.5, 0, 0], [SLIDE_VMIN * 0.4, 0, 0], [0, 0, 0])).toBeNull();
    expect(slideOf([SLIDE_VMIN * 1.5, 0, 0], [SLIDE_VMIN * 0.6, 0, 0], [0, 0, 0])).not.toBeNull();
    expect(slideOf([0.5, 0, 0], [0.5, 0, 0], [0, 0, 0], { vMin: 0.6 })).toBeNull();
  });

  it('buildFrame sums a sliding body per (material, sector) and adds it to the space sums; impacts, resting and silent bodies are not', () => {
    // Camera at the origin, right = +x. Body 0 brakes at 10 m straight ahead; 1 is hit (an impact); 2 rests; 3 is silent.
    const bodies = [
      { pos: [0, 0, -10], vel: [0.9, 0, 0], prev: [1, 0, 0], dx: [0.95 * DT, 0, 0], mat: 1 },
      { pos: [3, 0, -4], vel: [0, 2, 0], prev: [0, 0, 0], dx: [0, 0, 0], mat: 0 },
      { pos: [-3, 0, -4], vel: [0, 0, 0], prev: [0, 0, 0], dx: [0, 0, 0], mat: 0 },
      { pos: [0, 0, -2], vel: [0.5, 0, 0], prev: [1, 0, 0], dx: [0.75 * DT, 0, 0], mat: -1 },
    ];
    const input: FrameInput = {
      n: bodies.length, pos: bodies.flatMap((b) => b.pos), vel: bodies.flatMap((b) => b.vel), prevVel: bodies.flatMap((b) => b.prev),
      prevPos: bodies.flatMap((b) => b.pos.map((p, k) => p - b.dx[k]!)), slide: {},
      material: bodies.map((b) => b.mat), metres: 1, camera: { pos: [0, 0, 0], right: [1, 0, 0] }, dt: DT, dvMin: 0.25, materials: 2, sectors: 4, top: 8,
    };
    const f = buildFrame(input), s = sectorOf(0, 4), q = SLIDE_FIELDS * (1 * 4 + s), w = (2 * 0.095) / 100;
    expect(f.slide!.length).toBe(SLIDE_FIELDS * 2 * 4);
    expect([...f.slide!.subarray(q, q + SLIDE_FIELDS)].map((x) => +x.toFixed(9))).toEqual([w, w, w * 0.95, 0.95].map((x) => +Math.fround(x).toFixed(9)));
    expect([...f.slide!].filter((x, i) => x !== 0 && (i < q || i >= q + SLIDE_FIELDS))).toEqual([]);
    // Space: the impact's A^2 in its sector, the slide's w (at pan 0, 10 m) in its own.
    const sp = f.space!, imp = sectorOf(3 / 5, 4);
    expect(sp[SPACE_FIELDS * imp]).toBeCloseTo((2 / 5) ** 2, 6);
    expect([sp[SPACE_FIELDS * s], sp[SPACE_FIELDS * s + 1], sp[SPACE_FIELDS * s + 2]].map((x) => +x!.toFixed(7))).toEqual([w, 0, 10 * w].map((x) => +x.toFixed(7)));
    // Without prevPos there are no slide sums, and the rest of the frame is the same.
    const plain = buildFrame({ ...input, prevPos: undefined, slide: undefined });
    expect(plain.slide).toBeUndefined();
    expect(plain.counts).toEqual(f.counts);
    expect(plain.top).toEqual(f.top);
    expect(plain.space![SPACE_FIELDS * s]).toBe(0);
  });

  it('a body gaining energy (pushed by another) counts in the net sum only', () => {
    const one = (v: number, v0: number) => buildFrame({ n: 1, pos: [0, 0, -1], vel: [v, 0, 0], prevVel: [v0, 0, 0], prevPos: [-((v + v0) / 2) * DT, 0, -1], slide: {}, material: [0], metres: 1, camera: { pos: [0, 0, 0], right: [1, 0, 0] }, dt: DT, dvMin: 0.25, materials: 1, sectors: 4, top: 0 });
    const q = SLIDE_FIELDS * sectorOf(0, 4), f = one(0.9, 0.8);
    expect(f.slide![q]).toBeCloseTo(0.64 - 0.81, 6); // 2 D / 1 m^2, D < 0
    expect(f.slide![q]! < 0 && f.slide![q + 1] === 0 && f.slide![q + 2] === 0 && f.slide![q + 3] === 0).toBe(true);
    expect(f.space!.every((x) => x === 0)).toBe(true);
  });

  it('FrameTap matches buildFrame, frame after frame, with gravity and units', () => {
    const r = rng(11), n = 2000, mats = 3, metres = 0.25, gravity = [0, -G, 0] as const;
    const material = Array.from({ length: n }, (_, i) => (i % 13 === 0 ? -1 : i % mats));
    let pos = Float64Array.from({ length: 3 * n }, () => 40 * r() - 20), vel = Float64Array.from({ length: 3 * n }, () => 4 * (r() - 0.5));
    const tap = new FrameTap({ materials: mats, sectors: 4 });
    tap.setMaterials(material);
    const p = { metres, camera: { pos: [1, 2, 30] as [number, number, number], right: [0.6, 0, -0.8] as [number, number, number] }, dvMin: 0.25, dt: DT, top: 8, slide: { gravity } };
    tap.frame({ count: n, pos, linVel: vel }, p); // records only
    let slid = 0;
    for (let k = 0; k < 5; k++) {
      const prevVel = vel, prevPos = pos;
      // Most bodies brake a little (sliding), some are knocked (impacts), some speed up (pushed), some rest.
      vel = Float64Array.from(prevVel, (v, j) => { const b = Math.floor(j / 3) % 7; return b === 0 ? v + 30 * (r() - 0.5) : b === 1 ? v * 1.05 : b === 2 ? 0 : v * 0.97; });
      pos = Float64Array.from(prevPos, (x, j) => x + ((vel[j]! + prevVel[j]!) / 2) * DT);
      const got = tap.frame({ count: n, pos, linVel: vel }, p);
      const want = buildFrame({ n, pos, vel, prevVel, prevPos, slide: { gravity }, material, metres, camera: p.camera, dt: DT, dvMin: p.dvMin, materials: mats, sectors: 4, top: p.top });
      expect(got.slide!.length).toBe(want.slide!.length);
      for (let c = 0; c < want.slide!.length; c++) expect(got.slide![c]).toBeCloseTo(want.slide![c]!, 4);
      for (let c = 0; c < want.space!.length; c++) expect(got.space![c]).toBeCloseTo(want.space![c]!, 3);
      expect(got.counts).toEqual(want.counts);
      for (let c = 1; c < want.slide!.length; c += SLIDE_FIELDS) slid += want.slide![c]!;
    }
    expect(slid).toBeGreaterThan(0);
  });

  it('FrameTap sums a slot only once it knows its last position: not on the frame slides turn on, nor after a reset or a spawn', () => {
    const tap = new FrameTap({ materials: 1, sectors: 4 });
    tap.setMaterials([0, 0]);
    let x = 0;
    const step = (v: number, slide: boolean, count = 1) => {
      x += v * DT;
      const pos = [x, 0, -5, x, 0, -6], linVel = [v, 0, 0, v, 0, 0];
      return tap.frame({ count, pos, linVel }, { metres: 1, camera: { pos: [0, 0, 0], right: [1, 0, 0] }, dvMin: 0.25, dt: DT, top: 0, ...(slide ? { slide: {} } : {}) });
    };
    const total = (f: AudioFrame) => (f.slide ? [...f.slide].reduce((a, b) => a + b, 0) : NaN);
    step(1, false); step(0.98, false);
    expect(total(step(0.96, true))).toBe(0); // its last position is not known yet
    expect(total(step(0.94, true))).toBeGreaterThan(0);
    expect(step(0.92, false).slide).toBeUndefined();
    expect(total(step(0.9, true))).toBe(0); // positions were not kept while it was off
    tap.reset();
    expect(total(step(0.88, true))).toBe(0);
    const one = total(step(0.86, true));
    expect(one).toBeGreaterThan(0);
    // A second slot spawning: its first frame records, so this frame's sum is slot 0's alone.
    const both = step(0.84, true, 2);
    expect(total(both) / one).toBeCloseTo((0.86 ** 2 - 0.84 ** 2) / (0.88 ** 2 - 0.86 ** 2), 2);
  });

  it('framesFrom keeps the slide sums and refuses ones that do not fit', () => {
    const f = frame([{ bin: 0, count: 1, a2: 0.01 }]);
    f.slide = Float32Array.from({ length: SLIDE_FIELDS * 4 }, (_, i) => i / 10);
    const [back] = framesFrom(JSON.parse(JSON.stringify([{ ...f, counts: [...f.counts], a2: [...f.a2], top: [...f.top], slide: [...f.slide] }])));
    expect(back!.slide).toEqual(f.slide);
    expect(framesFrom([{ dt: f.dt, counts: [...f.counts], a2: [...f.a2], top: [] }])[0]!.slide).toBeUndefined();
    expect(() => framesFrom([{ dt: f.dt, counts: [...f.counts], a2: [...f.a2], top: [], slide: [1, 2, 3] }])).toThrow(/slide 3/);
  });
});

/** One frame of slide sums for sector 1: net power over the frame (A^2), the sliders' mean speed and metres slid a second. */
function slideFrame(net: number, speed = 0.5, slid = speed, impacts = 0): AudioFrame {
  const f = frame(impacts ? [{ bin: 0, count: 1, a2: impacts }] : []), s = new Float32Array(SLIDE_FIELDS * 4), q = SLIDE_FIELDS * 1;
  s[q] = net; if (net > 0) { s[q + 1] = net; s[q + 2] = net * speed; s[q + 3] = slid; }
  f.slide = s;
  return f;
}
function play(on: boolean, make: (k: number) => AudioFrame, frames = 60, m: SoundMaterial = pine, tail = 1, seed = 3) {
  const e = new CollapseEngine({ sampleRate: SR, seed, fullScale: 1e3 });
  e.setMaterial(0, m, 0.5);
  e.lowcut = 0;
  e.setSlide(on);
  const blocks = Math.ceil(((frames * FRAME) / SR + tail) * (SR / BLOCK)), L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), mono = new Float32Array(blocks * BLOCK);
  let k = 0, due = 0, energy = 0;
  for (let b = 0; b < blocks; b++) {
    if (k < frames && b * BLOCK >= due) { e.push(make(k++)); due += FRAME; }
    e.render(L, R);
    for (let i = 0; i < BLOCK; i++) { mono[b * BLOCK + i] = L[i]! + R[i]!; energy += L[i]! ** 2 + R[i]! ** 2; }
  }
  return { energy, mono, e };
}
const X = 0.01; // A^2 a frame

describe('scraping in the engine (A8b)', () => {
  it('off by default, and off it plays exactly as before with slide sums or without; on, frames without them play the same too', () => {
    expect(new CollapseEngine({ sampleRate: SR }).slide).toBe(false);
    const hits = (k: number, slide: boolean) => { const f = k % 6 === 0 ? frame([{ bin: 2, count: 3, a2: 0.2 }]) : frame([]); if (slide) f.slide = slideFrame(X).slide!; return f; };
    const base = play(false, (k) => hits(k, false)).mono;
    expect(play(false, (k) => hits(k, true)).mono).toEqual(base);
    expect(play(true, (k) => hits(k, false)).mono).toEqual(base);
    expect(play(true, (k) => hits(k, true)).mono).not.toEqual(base);
  });

  it('plays the power it is given: twice the power +3 dB, scrapeDb and levelDb dB for dB, energy gained silent', () => {
    const at = (net: number, m: SoundMaterial = pine) => play(true, () => slideFrame(net), 60, m).energy;
    const one = at(X);
    expect(one).toBeGreaterThan(0);
    expect(db(at(2 * X) / one)).toBeCloseTo(3.01, 1);
    expect(db(at(X, { ...pine, scrapeDb: SCRAPE_DB - 10 }) / one)).toBeCloseTo(-10, 1);
    expect(db(at(X, { ...pine, scrapeDb: SCRAPE_DB + 6 }) / one)).toBeCloseTo(6, 1);
    // levelDb sets an impact's A, so its energy by levelDb dB, and the slide's with it (not twice over).
    const hit = (m: SoundMaterial) => play(false, () => frame([{ bin: 0, count: 1, a2: X }]), 60, m).energy;
    const lv = { ...pine, levelDb: -7 };
    expect(db(hit(lv) / hit(pine))).toBeCloseTo(-7, 1);
    expect(db(at(X, lv) / one)).toBeCloseTo(-7, 1);
    expect(at(-X)).toBe(0);
    expect(play(true, () => slideFrame(0)).energy).toBe(0);
  });

  it('crackles: grains, one per scrapePulse slid, impulsive and gated, not a steady hiss', () => {
    // 0.5 m slid a second for 2 s: 200 grains expected (Poisson).
    const r = play(true, () => slideFrame(X, 0.5, 0.5), 120, pine, 0.2);
    const want = (0.5 / SCRAPE_PULSE) * ((120 * FRAME) / SR);
    expect(Math.abs(r.e.grains - want)).toBeLessThan(4 * Math.sqrt(want));
    // Twice the metres slid, twice the grains.
    const r2 = play(true, () => slideFrame(X, 0.5, 1), 120, pine, 0.2);
    expect(r2.e.grains / r.e.grains).toBeCloseTo(2, 0);
    // Impulsive: kurtosis far above noise's 3 (white noise through the same path would be 3).
    const x = r.mono.subarray(4800, 4800 + 72000);
    let m2 = 0, m4 = 0;
    for (const v of x) { m2 += v * v; m4 += v ** 4; }
    m2 /= x.length; m4 /= x.length;
    expect(m4 / (m2 * m2)).toBeGreaterThan(20);
    // Gated: 20 ms windows spread over > 10 dB between the loud and the quiet (the stick-slip gate's on and off).
    const w = 960, e = Array.from({ length: Math.floor(x.length / w) }, (_, i) => { let s = 0; for (let j = 0; j < w; j++) s += x[i * w + j]! ** 2; return s + 1e-30; }).sort((a, b) => a - b);
    expect(db(e[Math.floor(e.length * 0.9)]! / e[Math.floor(e.length * 0.1)]!)).toBeGreaterThan(10);
  });

  it('scrapeRing rings the modes with a share of it, the same energy', () => {
    const crackle = play(true, () => slideFrame(X), 60, pine).energy, ring = play(true, () => slideFrame(X), 60, { ...pine, scrapeRing: 1 });
    expect(ring.energy).toBeGreaterThan(0);
    expect(ring.e.grains).toBe(0);
    expect(Math.abs(db(ring.energy / crackle))).toBeLessThan(6);
  });

  it('against impacts of the same energy (bin 0), scrapeDb 0 reads -21 dB (rubber) to +7 dB (pine): the reference is the modes alone', () => {
    const real = soundMaterials('real'), rows: Record<string, number> = {};
    for (const [name, m] of Object.entries(real)) {
      if (!m) continue;
      const s = play(true, () => slideFrame(X), 60, { ...m, scrapeDb: 0 }).energy, h = play(false, () => frame([{ bin: 0, count: 1, a2: X }]), 60, m).energy;
      rows[name] = Math.round(db(s / h)) + 0; // + 0: no -0
    }
    expect(rows).toEqual({ pine: 7, acrylic: -3, stone: -6, plaster: -2, iron: -8, ice: -2, rubber: -21, steel: 0 });
  });
});
