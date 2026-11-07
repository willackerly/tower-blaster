// Wavefront's Steer levels (M6, docs/game/wavefront.md) on Rapier, the fast CPU engine: the designed choices of
// each level come out as designed. W3 Fall Line: the north-west tower pushed east fells the north row and nothing
// else (clean clear); the south-east tower pushed north fells the east column (clears, breaks the heritage on the
// way); the middle row pushed east misses the crown. The reference engine agrees (docs/game/wavefront.md); the GPU
// plays the clean line in wave-gpu-W3.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, validateLevel, W3, WAVE_LEVELS } from '@tb/keystone';
import { partGroups, pushShot, towerFace } from '../src/wave.ts';

const c = compileLevel(W3), idx = (i: number, j: number) => i * 4 + j;
const line = (part: number, dir: [number, number]) => pushShot(c, towerFace(c, W3, part, dir), dir);

describe('Wavefront Steer levels on Rapier', () => {
  it('every level compiles clean and plays in its window, asleep', () => {
    for (const l of WAVE_LEVELS) {
      const k = compileLevel(l);
      expect(validateLevel(k).map((i) => i.code), l.id).toEqual([]);
      expect(l.runWindow).toBeGreaterThan(30);
      expect(k.scene.bodies.every((b) => b.pinned || b.asleep), l.id).toBe(true);
    }
  });
  it.for([
    { name: 'north row east', part: idx(0, 3), dir: [1, 0] as [number, number], cleared: true, heritage: 0, fell: [0, 1, 2, 3].map((i) => idx(i, 3)) },
    { name: 'east column north', part: idx(3, 0), dir: [0, 1] as [number, number], cleared: true, heritage: 4, fell: [0, 1, 2, 3].map((j) => idx(3, j)) },
    { name: 'middle row east', part: idx(0, 1), dir: [1, 0] as [number, number], cleared: false, heritage: 0, fell: [0, 1, 2, 3].map((i) => idx(i, 1)) },
  ])('W3 $name', { timeout: 120_000 }, async (t) => {
    const { wavePlay } = await import('@tb/keystone');
    const e = new RapierEngine();
    try {
      const r = await wavePlay(e, c, [line(t.part, t.dir)], { groups: partGroups(c), maxSteps: 4000, fell: 1 });
      console.log(`W3 ${t.name}: ${r.cleared ? 'clear' : 'miss'}, crowns ${r.crownsDown}/${r.crowns}, heritage ${r.heritageBroken}, settled ${r.settledSeconds.toFixed(1)} s, awake max ${r.awakeMax} mean ${r.awakeMean.toFixed(0)}, fell ${r.fellAt.join(' ')}`);
      expect(r.cleared).toBe(t.cleared);
      expect(r.heritageBroken).toBe(t.heritage);
      // The line falls end to end, in order along the push; every other tower stands.
      const times = t.fell.map((k) => r.fellAt[k]!);
      expect(times.every((x) => x >= 0), times.join(' ')).toBe(true);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const others = r.fellAt.filter((_, k) => !t.fell.includes(k));
      expect(others.filter((x) => x >= 0).length, others.join(' ')).toBe(0);
    } finally { e.dispose(); }
  });
});
