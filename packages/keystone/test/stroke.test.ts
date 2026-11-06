// The stroke brush (C9, stroke.ts): dominoes at exactly the set pitch along a
// line and a curve, each facing along the path, from a smoothed pointer path,
// and a run part compiling to those dominoes.
import { describe, expect, it } from 'vitest';
import { compileLevel, DOMINO_HALF, DOMINO_PITCH, headingQuat, type LevelDef, type P2, pathLength, runCentres, runPoses, smoothStroke, validateLevel } from '@tb/keystone';

/** A circular arc of radius r about (0, 0) from angle a0 to a1 (radians, measured from +z toward +x), as a fine polyline. */
function arc(r: number, a0: number, a1: number, n = 720): P2[] {
  return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [r * Math.sin(a), r * Math.cos(a)] as P2; });
}
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('stroke brush spacing', () => {
  it('a straight path: dominoes every pitch from its start, as many as fit', () => {
    const c = runCentres([[0, 0], [0, 10]], 1.2);
    expect(c.length).toBe(Math.floor(10 / 1.2) + 1);
    c.forEach((p, i) => { expect(p[0]).toBe(0); expect(p[1]).toBeCloseTo(1.2 * i, 12); });
    const poses = runPoses([[0, 0], [0, 10]], 1.2);
    expect(poses.every((p) => p.heading === 0)).toBe(true);
    expect(runCentres([[0, 0]], 1)).toEqual([[0, 0]]);
    expect(runCentres([], 1)).toEqual([]);
    expect(() => runCentres([[0, 0], [1, 0]], 0)).toThrow(/pitch/);
  });

  it('a curve: neighbours exactly the pitch apart, each facing along the path (tangent within 0.2 deg)', () => {
    for (const r of [3, 5, 8].map((x) => x * 2)) {
      // A half turn of radius r domino heights (2 h each), as X1's curves.
      const path = arc(r, -Math.PI / 2, Math.PI / 2);
      const poses = runPoses(path, DOMINO_PITCH);
      expect(poses.length).toBeGreaterThan(Math.floor((Math.PI * r) / DOMINO_PITCH * 0.98));
      for (let i = 1; i < poses.length; i++) expect(dist([poses[i]!.x, poses[i]!.z], [poses[i - 1]!.x, poses[i - 1]!.z])).toBeCloseTo(DOMINO_PITCH, 9);
      for (const [i, p] of poses.entries()) {
        // On the circle (the polyline's chords sag at most r (1 - cos(pi / 720)) under it), facing its tangent.
        expect(Math.hypot(p.x, p.z)).toBeGreaterThan(r * Math.cos(Math.PI / 720) - 1e-12);
        expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(r + 1e-12);
        if (i === 0 || i === poses.length - 1) continue; // the ends face their one neighbour
        const a = Math.atan2(p.x, p.z), tangent = a + Math.PI / 2;
        const err = Math.atan2(Math.sin(p.heading - tangent), Math.cos(p.heading - tangent));
        expect(Math.abs(err)).toBeLessThan((0.2 * Math.PI) / 180);
      }
    }
  });

  it('spaces by straight-line distance, so the arc between neighbours is a little longer than the pitch', () => {
    const r = 4, path = arc(r, 0, Math.PI, 4000), poses = runPoses(path, 2);
    const step = 2 * r * Math.asin(2 / (2 * r)); // the arc a chord of 2 subtends
    expect(poses.length).toBe(Math.floor(pathLength(path) / step + 1e-6) + 1);
  });

  it('smoothing keeps the ends, drops jitter under minStep, cuts corners and rounds to 1e-3', () => {
    const raw: P2[] = [[0, 0], [0.01, 0.02], [0, 1], [1, 1], [1.00004, 1.0000004]];
    const s = smoothStroke(raw);
    expect(s[0]).toEqual([0, 0]);
    expect(s.at(-1)).toEqual([1, 1]);
    expect(s.some(([x, z]) => x === 0 && z === 1)).toBe(false); // the corner is cut
    expect(s.every(([x, z]) => Number.isInteger(Math.round(x * 1000)) && Math.abs(x * 1000 - Math.round(x * 1000)) < 1e-9 && Math.abs(z * 1000 - Math.round(z * 1000)) < 1e-9)).toBe(true);
    expect(smoothStroke([[2, 3]])).toEqual([[2, 3]]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('run part', () => {
  const base: LevelDef = {
    id: 'RUN', name: 'run', version: 1, world: 0, lot: { min: [-12, -12], max: [12, 12] }, crownLine: 1, objective: { kind: 'crowns' }, par: 1,
    rack: ['marble'], launcher: { radius: 14, y: 1, dropY: 8 }, parts: [],
  };
  const path = arc(10, -Math.PI / 2, Math.PI / 2, 200).map(([x, z]) => [Number(x.toFixed(3)), Number(z.toFixed(3))] as P2);

  it('compiles to the brush\'s dominoes, standing on the ground, turned to their headings, omits left out', () => {
    const def: LevelDef = { ...base, parts: [{ kind: 'run', path, pitch: DOMINO_PITCH, half: [...DOMINO_HALF], material: 'plaster', omit: [2] }] };
    const c = compileLevel(def), poses = runPoses(path, DOMINO_PITCH), h = 0.5;
    expect(c.meta.n).toBe(poses.length - 1);
    const kept = poses.filter((_, i) => i !== 2);
    c.scene.bodies.forEach((b, i) => {
      expect(b.pos).toEqual([kept[i]!.x * h, DOMINO_HALF[1] * h, kept[i]!.z * h]);
      expect(b.rot).toEqual(headingQuat(kept[i]!.heading));
      expect(b.shape).toEqual({ kind: 'box', half: DOMINO_HALF.map((x) => x * h) });
    });
    // The curve's neighbours' AABBs cross, but as turned boxes they are apart: no overlap issue.
    expect(validateLevel(c).filter((i) => i.code === 'overlap')).toEqual([]);
    // Pushed into each other (pitch under the thickness), they are flagged.
    const tight = compileLevel({ ...def, parts: [{ kind: 'run', path, pitch: 0.2, half: [...DOMINO_HALF], material: 'plaster' }] });
    expect(validateLevel(tight).filter((i) => i.code === 'overlap').length).toBeGreaterThan(10);
  });

  it('a run joins the level hash by its bodies; a level without one hashes as before', () => {
    const def: LevelDef = { ...base, parts: [{ kind: 'run', path, pitch: DOMINO_PITCH, half: [...DOMINO_HALF], material: 'plaster' }] };
    const a = compileLevel(def).hash;
    expect(compileLevel(JSON.parse(JSON.stringify(def)) as LevelDef).hash).toBe(a);
    expect(compileLevel({ ...def, parts: [{ kind: 'run', path, pitch: 1.3, half: [...DOMINO_HALF], material: 'plaster' }] }).hash).not.toBe(a);
  });
});
