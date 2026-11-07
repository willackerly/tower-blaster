// Wavefront's Steer levels (M6, docs/game/wavefront.md) on Rapier, the fast CPU engine: each level's design comes
// out as designed, from anywhere on the upper two thirds of the starter a player hits (its corners too).
// - W3 Fall Line: a street pushed from a starter falls to its first wide gap (8, 3 or 4 towers), in order along the
//   push, the other streets standing; only the unbroken street clears in one stroke, and a push across the avenue
//   fells one tower.
// - W4 Avenue: bare, the wave dies at the avenue from either end; a relay slab built 3.5 to 6 h into it (of 9.7 h
//   between the towers) carries it the length of the street, both ways.
// - W5 Firebreak (Cut): pulling the second relay while the wave runs, up to 6 s after the push, saves the village
//   in par (3 stars); no pull or a pull at 8 s lets it fall (2 stars); pulling the first relay leaves too little
//   down to clear.
// The GPU plays W3's clean line, a W4 relay and W5's cut in wave-gpu-W*.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, Driver, type LevelDef, playShots, parStars, type Shot, validateLevel, W3, W3_STREETS, W4, W4_TOWERS, W5, W5_TOWERS, WAVE_LEVELS, type WaveResult, wavePlay } from '@tb/keystone';
import { build, ground } from '../src/rube.ts';
import { pushShot, starterPart, starterShot, towerFace, towerGroups } from '../src/wave.ts';

async function play(def: LevelDef, shot: (c: ReturnType<typeof compileLevel>) => Shot | Shot[]): Promise<WaveResult & { order: number[] }> {
  const c = compileLevel(def), e = new RapierEngine();
  try {
    const r = await wavePlay(e, c, [shot(c)].flat(), { groups: towerGroups(c), maxSteps: 6000, fell: 1 });
    return { ...r, order: r.fellAt.flatMap((t, k) => (t >= 0 ? [k] : [])).sort((a, b) => r.fellAt[a]! - r.fellAt[b]!) };
  } finally { e.dispose(); }
}

/** Tower indices (towerGroups order) of street s of W3, south to north. */
const w3Street = (s: number) => W3_STREETS[s]![1].map((_, k) => W3_STREETS.slice(0, s).reduce((a, [, zs]) => a + zs.length, 0) + k);
/** Hits on a starter's outer face: across it (h off its middle, the slab is 2.02 wide) and up it (of its height), over its upper two thirds. */
const HITS = [{ dx: 0, fy: 2 / 3 }, { dx: 0.9, fy: 0.95 }, { dx: -0.9, fy: 0.5 }];

describe('Wavefront levels on Rapier', () => {
  it('every level compiles clean and plays asleep in its window', () => {
    for (const l of WAVE_LEVELS.filter((d) => !d.rube)) { // the Steer and Cut levels; Lay levels are lay-levels.test.ts
      const k = compileLevel(l);
      expect(validateLevel(k).map((i) => i.code), l.id).toEqual([]);
      expect(l.runWindow).toBeGreaterThan(30);
      expect(k.scene.bodies.every((b) => b.pinned || b.asleep), l.id).toBe(true);
    }
  });

  // Street, the push, and the towers that fall (south to north indices along the street).
  const W3_LINES = [
    { name: 'west street north', s: 0, dir: 1 as const, falls: 8, cleared: true },
    { name: 'west street south', s: 0, dir: -1 as const, falls: 8, cleared: true },
    { name: 'middle street north', s: 1, dir: 1 as const, falls: 3, cleared: false },
    { name: 'middle street south', s: 1, dir: -1 as const, falls: 3, cleared: false },
    { name: 'east street north', s: 2, dir: 1 as const, falls: 2, cleared: false },
    { name: 'east street south', s: 2, dir: -1 as const, falls: 4, cleared: false },
  ];
  it.for(W3_LINES)('W3 $name: $falls towers fall in order, the rest stand', { timeout: 120_000 }, async (t) => {
    const x = W3_STREETS[t.s]![0], towers = w3Street(t.s), want = t.dir > 0 ? towers.slice(0, t.falls) : towers.slice(-t.falls).reverse();
    for (const hit of HITS) {
      const r = await play(W3, (c) => starterShot(c, starterPart(W3, x, t.dir), t.dir, hit.dx, hit.fy));
      console.log(`W3 ${t.name} (${hit.dx}, ${hit.fy.toFixed(2)}): ${r.cleared ? 'clear' : 'miss'}, D ${r.collapse.toFixed(3)}, order ${r.order.join(' ')}, settled ${r.settledSeconds.toFixed(1)} s, awake max ${r.awakeMax}`);
      expect(r.order, `${t.name} at ${hit.dx}, ${hit.fy}`).toEqual(want);
      expect(r.cleared).toBe(t.cleared);
    }
  });
  it('W3: a push across an avenue fells one tower', { timeout: 60_000 }, async () => {
    const r = await play(W3, (c) => pushShot(c, towerFace(c, W3, 0, [1, 0]), [1, 0]));
    expect(r.order).toEqual([0]);
    expect(r.cleared).toBe(false);
  });

  it('W4 bare: the wave dies at the avenue from either end', { timeout: 60_000 }, async () => {
    for (const dir of [1, -1] as const) {
      const r = await play(W4, (c) => starterShot(c, starterPart(W4, 0, dir), dir));
      expect(r.order).toEqual(dir > 0 ? [0, 1, 2] : [6, 5, 4, 3]);
      expect(r.cleared).toBe(false);
    }
  });
  // The avenue's south edge (the south street's last tower's north face) and the relay slab's thickness, h.
  const SOUTH = 9.5 * 1.02 + 0.5, RELAY = 1;
  it.for([3.5, 4, 4.5, 5, 5.5, 6])('W4 with a relay slab %f h into the avenue: the whole street falls, both ways', { timeout: 120_000 }, async (a) => {
    const b = build(W4, (s) => [{ place: 'relay', hit: ground(s, 1.02, SOUTH + a + RELAY / 2) }]);
    expect(b, 'the relay is placed').not.toBeNull();
    expect(b!.spent).toBe(16);
    // Placed about where it was asked: ground placement snaps to the lattice (a few hundredths of an h per cell).
    const relay = b!.def.parts.find((p) => p.kind === 'piece' && p.placed) as { at: number[] }, at = relay.at[2]! - RELAY / 2 - SOUTH;
    expect(Math.abs(at - a)).toBeLessThan(0.2);
    for (const dir of [1, -1] as const) {
      const r = await play(b!.def, (c) => starterShot(c, starterPart(b!.def, 0, dir), dir));
      console.log(`W4 relay at ${at.toFixed(2)} h ${dir > 0 ? 'north' : 'south'}: ${r.cleared ? 'clear' : 'miss'}, D ${r.collapse.toFixed(3)}, order ${r.order.join(' ')}`);
      expect(r.order).toEqual(dir > 0 ? W4_TOWERS.map((_, k) => k) : W4_TOWERS.map((_, k) => 6 - k));
      expect(r.cleared).toBe(true);
    }
  });

  // W5's relays are its last two bodies (the starter, then the relays in the street's order).
  const W5_LINES = [
    { name: 'no pull', pull: null, at: 0, falls: 8, cleared: true, heritage: true, stars: 2 },
    { name: 'the second relay pulled 1 s after the push', pull: 'R2', at: 60, falls: 6, cleared: true, heritage: false, stars: 3 },
    { name: 'the second relay pulled 5 s after the push', pull: 'R2', at: 300, falls: 6, cleared: true, heritage: false, stars: 3 },
    { name: 'the second relay pulled 10 s after the push (too late)', pull: 'R2', at: 600, falls: 8, cleared: true, heritage: true, stars: 2 },
    { name: 'the first relay pulled', pull: 'R1', at: 60, falls: 3, cleared: false, heritage: false, stars: 0 },
  ];
  it.for(W5_LINES)('W5 $name: $falls towers fall, $stars stars', { timeout: 120_000 }, async (t) => {
    const r = await play(W5, (c) => {
      const push = starterShot(c, starterPart(W5, 0, 1), 1), n = c.meta.n;
      return t.pull ? [push, { ammo: 'pull', body: t.pull === 'R1' ? n - 2 : n - 1, after: t.at }] : [push];
    });
    const strokes = t.pull ? 2 : 1;
    console.log(`W5 ${t.name}: ${r.phase}, D ${r.collapse.toFixed(3)}, heritage ${r.heritageBroken}, order ${r.order.join(' ')}`);
    expect(r.order).toEqual(W5_TOWERS.slice(0, t.falls).map((_, k) => k));
    expect(r.cleared).toBe(t.cleared);
    expect(r.heritageBroken > 0).toBe(t.heritage);
    expect(parStars(r.cleared, strokes, W5.par, r.heritageBroken)).toBe(t.stars);
  });
  // Agent playtest 2 (G9c): a push that missed left W5's round open with only a pull in the rack, which a Cut level
  // refuses while aiming, so no result came. The settle with nothing fireable left now ends the round, failed.
  it('W5: a push that misses ends the round at its settle, failed, with the pull unspent', { timeout: 120_000 }, async () => {
    const c = compileLevel(W5), e = new RapierEngine();
    try {
      const d = new Driver(e, c);
      await d.reset();
      // Into the ground 3 cells east of the street, clear of every tower and the starter.
      const miss = pushShot(c, [3 * c.frame.pitch * c.frame.unit, 0.3 * c.frame.unit, 2 * c.frame.pitch * c.frame.unit], [0, 1]);
      const r = await playShots(d, [miss], 0, { maxSteps: e.stepIndex + 6000, bank: false });
      expect(r.session.phase).toBe('failed');
      expect(r.session.rackLeft).toEqual(['pull']);
      expect(r.session.score?.stars).toBe(0);
    } finally { e.dispose(); }
  });
  // PT39 (agent playtest 2): no first visit started a wave. The teaching opener, fired untouched, pushes a starter
  // from two thirds up: W3's middle street falls to its gap (3 towers), W4's to the avenue (3), W5's whole street (8).
  it.for([['W3', 3], ['W4', 3], ['W5', 8]] as const)('%s: the teaching opener fired untouched starts the wave (%i towers)', { timeout: 120_000 }, async ([id, n]) => {
    const def = { W3, W4, W5 }[id];
    expect(def.solutions?.teach).toBe(true);
    const r = await play(def, () => def.solutions!.opener!);
    console.log(`${id} opener: ${r.order.length} towers in order ${r.order.join(' ')}, D ${r.collapse.toFixed(3)}`);
    expect(r.order.length).toBe(n);
    expect(r.order).toEqual([...r.order].sort((a, b) => a - b).slice(0, n));
  });
});
