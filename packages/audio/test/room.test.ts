// Room sound (A5): the room processor's response is what its parameters say (reverb times by octave,
// path energies, decorrelated sides), it costs nothing when idle, and 'off' leaves the engine bit for bit.
import { describe, expect, it } from 'vitest';
import { BLOCK, CollapseEngine, CollapseHost, HF_REF, lineLengths, loopFilter, makeRoom, pathEnergies, ROOM_PRESETS, ROOMS, roomOf, type RoomVerb, SOUND_MATERIALS } from '@tb/audio';
import { frame } from './helpers.ts';

const SR = 48000;

/** The wet impulse response (the dry impulse taken out), seconds long, left and right. */
function impulse(r: RoomVerb, seconds: number): [Float64Array, Float64Array] {
  const n = Math.ceil((seconds * SR) / BLOCK) * BLOCK, wl = new Float64Array(n), wr = new Float64Array(n);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let t = 0; t < n; t += BLOCK) {
    L.fill(0); R.fill(0);
    if (t === 0) { L[0] = 1; R[0] = 1; }
    r.process(L, R);
    for (let i = 0; i < BLOCK; i++) { wl[t + i] = L[i]! - (t + i === 0 ? 1 : 0); wr[t + i] = R[i]! - (t + i === 0 ? 1 : 0); }
  }
  return [wl, wr];
}

/** One octave around f (a 4th-order band-pass: an RBJ biquad twice). */
function octave(x: Float64Array, f: number): Float64Array {
  const w = (2 * Math.PI * f) / SR, al = Math.sin(w) / (2 * Math.SQRT2), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i]!, r = b0 * v + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = r; o[i] = r; }
    y = o;
  }
  return y;
}

/** RT60 from Schroeder's backward integral: twice the time from -5 to -35 dB (T30). */
function rt60(x: Float64Array): number {
  const e = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) { acc += x[i]! ** 2; e[i] = acc; }
  let a = 0;
  while (a < x.length && e[a]! > e[0]! * 10 ** -0.5) a++;
  let b = a;
  while (b < x.length && e[b]! > e[0]! * 10 ** -3.5) b++;
  return (2 * (b - a)) / SR;
}

const energy = (x: Float64Array, from = 0, to = x.length) => { let e = 0; for (let i = from; i < to; i++) e += x[i]! ** 2; return e; };

describe('room sound (A5)', () => {
  it('builds its parts as specified: prime, distinct delay lines in range; loop filters with the asked gains', () => {
    const n = lineLengths(0.043, 0.107, SR);
    expect(new Set(n).size).toBe(8);
    for (const k of n) {
      expect(k).toBeGreaterThanOrEqual(Math.round(0.043 * SR));
      expect(k).toBeLessThan(0.107 * SR * 1.01);
      for (let d = 2; d * d <= k; d++) expect(k % d).not.toBe(0);
    }
    const w = (2 * Math.PI * HF_REF) / SR;
    for (const [gDc, gHf] of [[0.99, 0.95], [0.9, 0.5], [0.999, 0.99]] as const) {
      const { a, b } = loopFilter(gDc, gHf, w);
      expect(b / (1 - a)).toBeCloseTo(gDc, 12); // DC gain
      expect(Math.sqrt((b * b) / (1 - 2 * a * Math.cos(w) + a * a))).toBeCloseTo(gHf, 9); // gain at HF_REF
    }
    expect(loopFilter(0.9, 0.95, w)).toEqual({ a: 0, b: 0.9 }); // brighter than DC asked: flat
  });

  it("decays at the preset's reverb times, octave by octave", () => {
    for (const room of ['hall', 'outdoor'] as const) {
      const p = ROOM_PRESETS[room], r = makeRoom(room, SR)!;
      r.gEarly = 0; // the late part alone
      const [wl] = impulse(r, 1.5 * p.rt60 + 0.5), late = wl.slice(Math.ceil((p.preDelay + 0.05) * SR));
      // rt60 holds at low frequencies; the one-pole loop filters tilt it down smoothly to rtHigh at 8 kHz.
      const lo = rt60(octave(late, 250)) / p.rt60;
      expect(lo, `${room} 250 Hz`).toBeGreaterThan(0.9);
      expect(lo, `${room} 250 Hz`).toBeLessThan(1.1);
      const t = [250, 500, 1000, 2000, 4000, 8000].map((f) => rt60(octave(late, f)));
      for (let k = 1; k < t.length; k++) expect(t[k]!, `${room} octave ${k}`).toBeLessThan(t[k - 1]! * 1.05);
      // The 8 kHz octave spans 5.7-11 kHz, so it reads a little longer than rtHigh, which is set at 8 kHz exactly.
      const hi = rt60(octave(late, 8000)) / p.rtHigh;
      expect(hi, `${room} 8 kHz`).toBeGreaterThan(0.95);
      expect(hi, `${room} 8 kHz`).toBeLessThan(1.3);
    }
  });

  it('carries the energies it is set to, with decorrelated sides; size scales its times', () => {
    for (const room of ['hall', 'outdoor'] as const) {
      const p = ROOM_PRESETS[room];
      // Path by path: each scaled to its energy against the dry impulse's (1 a channel).
      for (const path of ['early', 'late'] as const) {
        const r = makeRoom(room, SR)!;
        if (path === 'early') r.gLate = 0; else r.gEarly = 0;
        const [wl, wr] = impulse(r, 1.5 * p.rt60 + 0.8);
        const db = 10 * Math.log10((energy(wl) + energy(wr)) / 2);
        expect(db, `${room} ${path}`).toBeCloseTo(path === 'early' ? p.earlyDb : p.lateDb, 1);
        if (path === 'late') {
          let c = 0;
          for (let i = 0; i < wl.length; i++) c += wl[i]! * wr[i]!;
          expect(Math.abs(c / Math.sqrt(energy(wl) * energy(wr))), `${room} L/R correlation`).toBeLessThan(0.2);
        }
      }
      // Nothing before the first reflection or the late part's pre-delay.
      const [wl, wr] = impulse(makeRoom(room, SR)!, 0.2);
      const first = Math.min(p.preDelay, ...p.early.map((e) => e[0])) * SR;
      expect(energy(wl, 0, Math.floor(first)) + energy(wr, 0, Math.floor(first))).toBe(0);
    }
    // A hall twice the size: twice the reverb time.
    const r2 = makeRoom('hall', SR, 2)!;
    r2.gEarly = 0;
    const [w2] = impulse(r2, 2 * 1.5 * ROOM_PRESETS.hall.rt60 + 1);
    expect(rt60(octave(w2.slice(Math.ceil(0.2 * SR)), 500)) / (2 * ROOM_PRESETS.hall.rt60)).toBeCloseTo(1, 1);
    // A room with no reflections listed is silent on that path.
    const bare = roomOf({ ...ROOM_PRESETS.outdoor, early: [] }, SR);
    expect(bare.gEarly).toBe(0);
    expect(pathEnergies({ ...ROOM_PRESETS.outdoor, early: [] }, SR)[0]).toBe(0);
  });

  it('idles once its tail is over, and starts again on new input', () => {
    const r = makeRoom('outdoor', SR)!;
    expect(r.idle).toBe(true); // nothing heard yet
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    L[0] = 1; R[0] = 1;
    r.process(L, R);
    expect(r.idle).toBe(false);
    let blocks = 1, first = 0, end = 0;
    while (!r.idle && blocks < 10000) {
      L.fill(0); R.fill(0); r.process(L, R); blocks++;
      let p = 0;
      for (let i = 0; i < BLOCK; i++) p = Math.max(p, Math.abs(L[i]!), Math.abs(R[i]!));
      if (blocks < 100) first = Math.max(first, p); else end = Math.max(end, p);
      if (!r.idle && (blocks + 20) * BLOCK < r.tail) end = 0; // only the last 20 blocks before it idles
    }
    expect(blocks * BLOCK).toBeGreaterThan(r.tail); // it idles only after its tail
    expect(blocks * BLOCK).toBeLessThan(r.tail + 3 * BLOCK);
    expect(end / first).toBeLessThan(1e-5); // by then the tail is over 100 dB down
    // Idle: input passes through untouched.
    const x = Float32Array.from({ length: BLOCK }, (_, i) => (i === 5 ? 1e-7 : 0));
    const y = x.slice();
    r.process(y, y.slice());
    expect(Array.from(y)).toEqual(Array.from(x));
    L.fill(0); R.fill(0); L[0] = 0.5; R[0] = 0.5;
    r.process(L, R);
    expect(r.idle).toBe(false);
  });

  it("off leaves the engine bit for bit; a room adds its tail; the host takes 'room' messages", () => {
    const play = (room?: 'off' | 'hall') => {
      const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: 30 });
      e.setMaterial(0, SOUND_MATERIALS.stone, 0.5);
      if (room) e.setRoom(room);
      const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), out: number[] = [];
      e.push(frame([{ bin: 2, sector: 1, count: 3, a2: 3 }]));
      for (let b = 0; b < 300; b++) { e.render(L, R); out.push(...L); }
      return { out, e };
    };
    const dry = play().out, off = play('off').out, hall = play('hall');
    expect(off).toEqual(dry);
    expect(hall.e.room).toBe('hall:1');
    const tailFrom = 200 * BLOCK; // 0.53 s on: the dry hits have rung out, the hall has not
    const e = (x: number[]) => x.slice(tailFrom).reduce((s, v) => s + v * v, 0);
    expect(e(hall.out)).toBeGreaterThan(100 * e(dry));
    expect(() => new CollapseEngine({ sampleRate: SR }).setRoom('cave' as never)).toThrow(/room must be one of/);
    const host = new CollapseHost(SR);
    host.onMessage({ type: 'room', room: 'outdoor' });
    expect(host.engine.room).toBe('outdoor:1');
    host.onMessage({ type: 'room', room: 'hall', size: 0.5 });
    expect(host.engine.room).toBe('hall:0.5');
    host.onMessage({ type: 'room', room: 'off' });
    expect(host.engine.room).toBe('off');
    expect(ROOMS).toEqual(['off', 'outdoor', 'hall']);
  });
});
