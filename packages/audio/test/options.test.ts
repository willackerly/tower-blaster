import { describe, expect, it } from 'vitest';
import { BLOCK, CollapseHost, DEFAULT_SOUND, DV_EDGES, FULL_SCALE, type HostStats, modes, parseSoundOptions, SOUND_KNOBS, SOUND_MATERIALS, STATS_EVERY, tunedMaterial, writeSoundOptions } from '@tb/audio';

describe('sound options', () => {
  it('are off with defaults when the URL says nothing, and round-trip what differs', () => {
    expect(parseSoundOptions(new URLSearchParams())).toEqual(DEFAULT_SOUND);
    expect(DEFAULT_SOUND.on).toBe(false);
    const o = parseSoundOptions(new URLSearchParams('snd=1&snd.mat=pine&snd.volume=-6&snd.pitch=-5&snd.voices=0'));
    expect(o).toEqual({ ...DEFAULT_SOUND, on: true, material: 'pine', volume: -6, pitch: -5, voices: 0 });
    const q = new URLSearchParams();
    writeSoundOptions(o, q);
    expect(q.toString()).toBe('snd=1&snd.mat=pine&snd.volume=-6&snd.pitch=-5&snd.voices=0');
    expect(parseSoundOptions(q)).toEqual(o);
    const none = new URLSearchParams();
    writeSoundOptions(DEFAULT_SOUND, none);
    expect(none.toString()).toBe('');
  });

  it('refuse what is out of range, not a number or not a material', () => {
    expect(() => parseSoundOptions(new URLSearchParams('snd=2'))).toThrow(/snd must be/);
    expect(() => parseSoundOptions(new URLSearchParams('snd.mat=glass'))).toThrow(/snd.mat/);
    expect(() => parseSoundOptions(new URLSearchParams('snd.volume=99'))).toThrow(/snd.volume/);
    expect(() => parseSoundOptions(new URLSearchParams('snd.damping='))).toThrow(/snd.damping/);
    expect(() => parseSoundOptions(new URLSearchParams('snd.voices=2.5'))).toThrow(/whole/);
    for (const [k, r] of Object.entries(SOUND_KNOBS)) expect(r.def >= r.min && r.def <= r.max, k).toBe(true);
  });

  it('knobs at their defaults leave a material as it is; pitch +12 doubles every mode of every model', () => {
    const knobs = { ring: 0, click: 0, damping: 1, pitch: 0, spread: 1 };
    for (const m of Object.values(SOUND_MATERIALS)) {
      expect(tunedMaterial(m, knobs)).toEqual(m);
      // Every mode an octave up (those pushed past the 18 kHz cut are gone).
      const up = [...modes(tunedMaterial(m, { ...knobs, pitch: 12 }), 0.5).freq].sort((a, b) => a - b);
      const want = [...modes(m, 0.5).freq].map((f) => 2 * f).filter((f) => f < 18000).sort((a, b) => a - b);
      expect(up.length).toBe(want.length);
      up.forEach((f, k) => expect(f / want[k]!).toBeCloseTo(1, 9));
    }
    const t = tunedMaterial(SOUND_MATERIALS.pine, { ring: 3, click: -2, damping: 2, pitch: 0, spread: 2 });
    expect([t.ringDb, t.clickDb, t.eta, t.jitter]).toEqual([3, -2, 0.02, 0.06]);
    const base = modes(SOUND_MATERIALS.pine), damped = modes(t);
    expect(damped.tau[0]! / base.tau[0]!).toBeCloseTo(0.5, 9);
  });
});

describe('CollapseHost (the worklet minus WebAudio)', () => {
  const frame = (count: number) => {
    const cells = DV_EDGES.length * 4, counts = new Float32Array(cells), a2 = new Float32Array(cells);
    counts[3 * 4 + 1] = count; a2[3 * 4 + 1] = count * 0.1;
    return { dt: 1 / 60, materials: 1, sectors: 4, counts, a2, top: new Float32Array(0) };
  };

  it('plays the frames it is sent and reports them', () => {
    const stats: HostStats[] = [];
    const h = new CollapseHost(48000, (s) => stats.push(s));
    h.onMessage({ type: 'material', slot: 0, material: SOUND_MATERIALS.pine, edge: 1 });
    h.onMessage({ type: 'frame', frame: frame(40) });
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    for (let b = 0; b < STATS_EVERY; b++) h.render(L, R);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ type: 'stats', frames: 1, impacts: 40, blocks: STATS_EVERY, overflow: 0 });
    expect(stats[0]!.peak).toBeGreaterThan(0);
  });

  it('gain sets full scale, 0 mutes, and a bad gain is refused', () => {
    const h = new CollapseHost(48000);
    h.onMessage({ type: 'gain', gain: 2 });
    expect(h.engine.fullScale).toBe(FULL_SCALE / 2);
    expect(h.engine.muted).toBe(false);
    h.onMessage({ type: 'gain', gain: 0 });
    expect(h.engine.muted).toBe(true);
    h.onMessage({ type: 'gain', gain: 1, muted: true });
    expect(h.engine.muted).toBe(true);
    expect(() => h.onMessage({ type: 'gain', gain: -1 })).toThrow(/gain/);
  });
});
