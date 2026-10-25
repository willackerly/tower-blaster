import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { compileLevel, L1, L2, L4, shotToSpawn } from '@tb/keystone';
import { readStruct, RenderInstance } from '@tb/schema';
import { BEAD_RADIUS, TARGET_SCALE, easeOutBack, packScene, paletteFor, regrowDuration, regrowScale, SLOT } from '../src/scene.ts';

function atHome(c: ReturnType<typeof compileLevel>, extra: number[][] = []): Snapshot {
  const s = emptySnapshot(c.meta.n + extra.length);
  s.pos.set(c.meta.home);
  extra.forEach((p, k) => s.pos.set(p, 3 * (c.meta.n + k)));
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}
const read = (p: { data: ArrayBuffer }, slot: number) => readStruct(new DataView(p.data), RenderInstance, slot);

describe('palette', () => {
  it('crowns are gold, heritage celadon, then by material', () => {
    const c = compileLevel(L2);
    const slots = Array.from({ length: c.meta.n }, (_, i) => paletteFor(c, i));
    for (const i of c.meta.crowns) expect(slots[i]).toBe(SLOT.crown);
    for (const i of c.meta.heritage) expect(slots[i]).toBe(SLOT.heritage);
    const slab = c.scene.bodies.findIndex((b) => b.shape.kind === 'box' && b.shape.half[0] > 1);
    expect(slots[slab]).toBe(7); // stone lintel
    expect(slots[0]).toBe(5); // plaster
  });
});

describe('packScene', () => {
  it('draws structure and box ammo first, then sphere ammo and beads', () => {
    const c = compileLevel(L4);
    const drop = shotToSpawn(c.frame, { ammo: 'drop', x: 0, z: 0 }, 0).body;
    const marble = shotToSpawn(c.frame, { ammo: 'marble', az: 0, y: 8, yaw: 0, pitch: 0, power: 50 }, 0).body;
    const s = atHome(c, [[1, 2, 3], [4, 5, 6]]);
    const beads = Float64Array.from([0, 1, 0, 0, 2, 0, 0, 3, 0]);
    const p = packScene(s, c, [drop, marble], { beads });
    expect([p.boxes, p.spheres]).toEqual([c.meta.n + 1, 1 + 3]);
    const anvil = read(p, c.meta.n);
    expect(anvil.pos).toEqual([1, 2, 3]);
    expect(anvil.palette).toEqual([SLOT.ammo]);
    const ball = read(p, c.meta.n + 1);
    expect(ball.pos).toEqual([4, 5, 6]);
    expect(ball.shape).toEqual([1]);
    const [b0, b1, b2] = [2, 3, 4].map((k) => read(p, c.meta.n + k));
    expect(b0!.palette).toEqual([SLOT.bead]);
    expect(b0!.half![0]).toBeCloseTo(BEAD_RADIUS, 6);
    expect(b1!.half![0]).toBeLessThan(b0!.half![0]!);
    expect(b2!.half![0]).toBeCloseTo(BEAD_RADIUS * TARGET_SCALE, 6); // the aim point
    expect(read(packScene(s, c, [drop, marble], { beads, beadsReachable: false }), c.meta.n + 2).palette).toEqual([SLOT.beadOut]);
  });
  it('reuses the output buffer when it is big enough', () => {
    const c = compileLevel(L1), s = atHome(c);
    const a = packScene(s, c, []);
    expect(packScene(s, c, [], {}, a.data).data).toBe(a.data);
  });
});

describe('Regrow', () => {
  it('eases from 0 to 1 with a small overshoot', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 12);
    expect(easeOutBack(1)).toBe(1);
    const peak = Math.max(...Array.from({ length: 101 }, (_, k) => easeOutBack(k / 100)));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.15);
  });
  it('grows course by course and finishes on time', () => {
    const t = 0.1;
    expect(regrowScale(t, 0)).toBeGreaterThan(regrowScale(t, 1));
    expect(regrowScale(t, 1)).toBeGreaterThan(regrowScale(t, 5));
    expect(regrowScale(0, 0)).toBeCloseTo(0, 12);
    for (let k = 0; k < 12; k++) expect(regrowScale(regrowDuration(12), k)).toBe(1);
  });
  it('keeps each body on its base while it grows', () => {
    const c = compileLevel(L1), s = atHome(c);
    const p = packScene(s, c, [], { regrowT: 0.12 });
    for (const i of [0, 50, c.meta.n - 1]) {
      const r = read(p, i), half = c.meta.half[3 * i + 1]!;
      const bottom = r.pos![1]! - r.half![1]!;
      expect(bottom).toBeCloseTo(c.meta.home[3 * i + 1]! - half, 5);
    }
  });
});
