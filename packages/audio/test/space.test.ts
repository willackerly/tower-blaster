// Space (A8a): with it on, a bank sector plays at the mean pan of the impacts it got (not at its fixed
// centre), and the room hears each impact through a send of (distance / dref)^law (capped): in the hall (law 1)
// the dry sound falls 6 dB a doubling while the reverb holds; outdoors (law 0.5) the scatter gains 3 dB a
// doubling on the dry sound. Early reflections follow geometry, d / (d + extra path). Off, and frames without
// the space sums, play as before A8a.
import { describe, expect, it } from 'vitest';
import { type AudioFrame, BLOCK, CollapseEngine, CollapseHost, makeRoom, panGains, ROOM_PRESETS, type RoomParams, SPACE_CAP, SPACE_DREF, SPACE_FIELDS, sectorOf, TOP_FIELDS } from '@tb/audio';
import { db, FRAME, frame, pine, SR } from './helpers.ts';

/** One frame of n impacts at speed change dv, all at one pan and distance: bank only, or with them on top (voices). */
function at(pan: number, dist: number, opts: { n?: number; dv?: number; top?: boolean; space?: boolean } = {}): AudioFrame {
  const n = opts.n ?? 40, dv = opts.dv ?? 1.4, A = dv / dist, s = sectorOf(pan, 4);
  const f = frame([{ bin: 2, sector: s, count: n, a2: n * A * A }], opts.top ? [[dv, dist, pan, 0, 0.3]] : []);
  if (opts.space !== false) {
    const sp = new Float32Array(SPACE_FIELDS * 4);
    sp[SPACE_FIELDS * s] = n * A * A; sp[SPACE_FIELDS * s + 1] = n * A * A * pan; sp[SPACE_FIELDS * s + 2] = n * A * A * dist;
    f.space = sp;
  }
  return f;
}

/** Render a stream of frames (one every FRAME samples for `frames`, then a tail); L and R energy and the outputs. */
function play(e: CollapseEngine, make: (k: number) => AudioFrame, frames: number, tail = 1.5) {
  const blocks = Math.ceil(((frames * FRAME) / SR + tail) * (SR / BLOCK)), L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const outL = new Float32Array(blocks * BLOCK), outR = new Float32Array(blocks * BLOCK);
  let k = 0, due = 0, eL = 0, eR = 0;
  for (let b = 0; b < blocks; b++) {
    if (k < frames && b * BLOCK >= due) { e.push(make(k++)); due += FRAME; }
    e.render(L, R);
    outL.set(L, b * BLOCK); outR.set(R, b * BLOCK);
    for (let i = 0; i < BLOCK; i++) { eL += L[i]! ** 2; eR += R[i]! ** 2; }
  }
  return { eL, eR, outL, outR };
}

const make = (space: boolean, room: 'off' | 'outdoor' | 'hall' = 'off', seed = 3) => {
  const e = new CollapseEngine({ sampleRate: SR, seed, fullScale: 1e4 });
  e.setMaterial(0, pine);
  e.setSpace(space);
  e.setRoom(room);
  e.lowcut = 0;
  return e;
};
const lr = (r: { eL: number; eR: number }) => db(r.eR / r.eL);
const want = (pan: number) => { const [l, r] = panGains(pan); return 20 * Math.log10(r / l); };

describe('space (A8a)', () => {
  it.each([-0.9, -0.55, -0.1, 0.02, 0.3, 0.7, 0.9])('a bank sector plays at its impacts\' pan, %s (the fixed centre misses)', (pan) => {
    const on = play(make(true), () => at(pan, 8), 12), off = play(make(false), () => at(pan, 8), 12);
    expect(Math.abs(lr(on) - want(pan))).toBeLessThan(0.5);
    // Before A8a: the sector's centre (-0.75, -0.25, 0.25, 0.75), up to 3.5 dB from where the impacts are.
    const centre = -1 + (2 * sectorOf(pan, 4) + 1) / 4;
    expect(Math.abs(lr(off) - want(centre))).toBeLessThan(0.05);
    if (pan === 0.02) expect(Math.abs(lr(off) - want(pan))).toBeGreaterThan(3);
  });

  it('a ringing sector glides to a new pan (no step), a silent one takes it at once', () => {
    // Pan 0.05 for 15 frames, then 0.45 (both in sector 2): the gain moves over ~SPACE_TAU, with no jump.
    const e = make(true), r = play(e, (k) => at(k < 15 ? 0.05 : 0.45, 8), 30, 0.5);
    const ratio = (a: number, b: number) => { let l = 0, q = 0; for (let i = a; i < b; i++) { l += r.outL[i]! ** 2; q += r.outR[i]! ** 2; } return db(q / l); };
    const switchAt = Math.round((15 * FRAME + 0.03 * SR) / BLOCK) * BLOCK; // + the engine's latency
    expect(Math.abs(ratio(BLOCK, switchAt - 2 * BLOCK) - want(0.05))).toBeLessThan(0.5);
    expect(Math.abs(ratio(switchAt + 0.3 * SR, switchAt + 0.5 * SR) - want(0.45))).toBeLessThan(0.5);
    // Smooth: no block-to-block jump in the right/left balance bigger than a ramp over SPACE_TAU allows.
    let worst = 0, prev = NaN;
    for (let b = 1; b < r.outL.length / BLOCK; b++) {
      let l = 0, q = 0; for (let i = b * BLOCK; i < (b + 1) * BLOCK; i++) { l += r.outL[i]! ** 2; q += r.outR[i]! ** 2; }
      if (!(l > 1e-20)) continue;
      const x = db(q / l);
      if (Number.isFinite(prev)) worst = Math.max(worst, Math.abs(x - prev));
      prev = x;
    }
    expect(worst).toBeLessThan(0.6);
  });

  /** Dry and wet energy (dB) of a stream at distance d through a room (tuned: one path only, or one early tap). */
  const wetAt = (d: number, top: boolean, room: 'outdoor' | 'hall', tune: Partial<RoomParams>) => {
    const dry = play(make(true, 'off'), () => at(0.1, d, { top }), 8);
    const e = make(true, room); e.setRoom(room, 1, tune);
    const wet = play(e, () => at(0.1, d, { top }), 8);
    let w = 0; for (let i = 0; i < dry.outL.length; i++) w += (wet.outL[i]! - dry.outL[i]!) ** 2 + (wet.outR[i]! - dry.outR[i]!) ** 2;
    return { dry: db(dry.eL + dry.eR), wet: db(w) };
  };
  const LATE_ONLY: Partial<RoomParams> = { early: [] };

  it.each([false, true])("the hall's reverb holds over distance while the dry sound falls 6 dB a doubling (voices: %s)", (top) => {
    const ref = wetAt(SPACE_DREF, top, 'hall', LATE_ONLY);
    for (const d of [2.5, 5, 20, 40, 64]) {
      const x = wetAt(d, top, 'hall', LATE_ONLY);
      expect(Math.abs(x.wet - ref.wet)).toBeLessThan(1);
      expect(x.dry - ref.dry).toBeCloseTo(-20 * Math.log10(d / SPACE_DREF), 1);
    }
    // Capped: at 500 m the send is SPACE_CAP, not 50.
    expect(wetAt(500, top, 'hall', LATE_ONLY).wet - ref.wet).toBeCloseTo(20 * Math.log10(SPACE_CAP / 50), 0);
  });

  it("outdoors the scatter's law is 0.5: against the dry sound it grows 3 dB a doubling, not 6", () => {
    expect(ROOM_PRESETS.outdoor.distanceLaw).toBe(0.5);
    expect(ROOM_PRESETS.hall.distanceLaw ?? 1).toBe(1);
    const ref = wetAt(SPACE_DREF, false, 'outdoor', LATE_ONLY);
    for (const d of [5, 20, 40]) {
      const x = wetAt(d, false, 'outdoor', LATE_ONLY);
      expect(x.wet - x.dry - (ref.wet - ref.dry)).toBeCloseTo(10 * Math.log10(d / SPACE_DREF), 0);
    }
  });

  it.each(['hall', 'outdoor'] as const)('an early reflection follows geometry, d / (d + extra path), whatever the law (%s)', (room) => {
    // One tap, 0.1 s late (34.3 m more path); no late part. Against the dry sound it should rise by
    // 20 log10(d (dref + p) / (dref (d + p))): 5.2 dB at 40 m, where the send alone would add 12.
    const p = 0.1 * 343, tune: Partial<RoomParams> = { early: [[0.1, 1, 20000, 0]], lateDb: -300 };
    const ref = wetAt(SPACE_DREF, false, room, tune);
    for (const d of [5, 20, 40, 98]) {
      const x = wetAt(d, false, room, tune), want = 20 * Math.log10((d * (SPACE_DREF + p)) / (SPACE_DREF * (d + p)));
      expect(Math.abs(x.wet - x.dry - (ref.wet - ref.dry) - want)).toBeLessThan(0.5);
    }
    const r = makeRoom(room, SR)!;
    expect(r.law).toBe(room === 'hall' ? 1 : 0.5);
  });

  it('at dref with the space sums, or without them, the room sounds as before A8a', () => {
    for (const space of [true, false]) {
      const a = play(make(false, 'outdoor'), () => at(-0.25, SPACE_DREF, { space }), 8);
      const b = play(make(true, 'outdoor'), () => at(-0.25, SPACE_DREF, { space }), 8);
      let d = 0, e = 0; for (let i = 0; i < a.outL.length; i++) { d += (a.outL[i]! - b.outL[i]!) ** 2; e += a.outL[i]! ** 2; }
      expect(d / e).toBeLessThan(1e-9);
    }
  });

  it('off ignores the space sums bit for bit; the host takes space messages', () => {
    const a = play(make(false, 'hall'), () => at(0.3, 30), 6), b = play(make(false, 'hall'), () => at(0.3, 30, { space: false }), 6);
    expect(b.outL).toEqual(a.outL); expect(b.outR).toEqual(a.outR);
    const host = new CollapseHost(SR);
    expect(host.engine.space).toBe(false);
    host.onMessage({ type: 'space', on: true });
    expect(host.engine.space).toBe(true);
    expect(() => host.engine.setSpace(true, 0)).toThrow(/positive/);
    expect(TOP_FIELDS).toBe(5);
  });
});
