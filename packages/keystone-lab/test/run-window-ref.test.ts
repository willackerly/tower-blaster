// A wave level's run window (LevelDef.runWindow, roadmap C22) on the AVBD reference at Keystone's settings: a domino
// line whose wave takes longer than the 30 s settle cap. With a 60 s window the shot runs past 30 s to the front's
// death and the crown at the end falls inside it. The same level without a window is cut short with the wave still
// running and the crown standing: under v4 (outcome levels' default) at about 1 s, since a front of one or two moving
// dominoes is within settle v2's stragglers allowance; under v1 (par levels') at its 10 s cap. The reference does not sleep, so the line is solved awake
// from end to end: big dominoes (h = 2 m, 4 m tall, about 2.4 a second) keep the body count, and the test's time, low.
import { describe, expect, it } from 'vitest';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, Driver, type LevelDef, SETTLE_CAP, SETTLE_CAP_V2, type SettleRule, type Shot } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

const K = 76;
/** K dominoes along +z (pitch 1.2 h), the last a crown; one cue push from behind the first. */
const line = (runWindow?: number, settle?: SettleRule): LevelDef => ({
  id: 'RWREF', name: 'run window on the reference', version: 1, world: 0, unit: 2, gap: 0, lot: { min: [-3, -3], max: [3, Math.ceil(K * 1.2) + 3] }, crownLine: 0.6,
  objective: { kind: 'crowns' }, par: 1, rack: ['cue'], launcher: { radius: 12, y: 1, dropY: 8 }, scoring: 'outcome',
  ...(settle ? { settle } : {}), ...(runWindow !== undefined ? { runWindow } : {}),
  parts: [
    { kind: 'run', path: [[0, 0], [0, (K - 2) * 1.2]], pitch: 1.2, half: [0.5, 1, 0.15], material: 'plaster' },
    { kind: 'piece', at: [0, 1, (K - 1) * 1.2], half: [0.5, 1, 0.15], material: 'plaster', role: 'crown' },
  ],
  physics: { presettle: 30 },
} as LevelDef);
/** The cue's tip 0.1 h behind the first domino's back face, 1.5 h up, pushing +z, slowest. */
const PUSH: Shot = { ammo: 'cue', x: 0, y: 6, z: -1, dir: 2, power: 0 };

async function play(def: LevelDef) {
  const c = compileLevel(def), d = new Driver(new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP }), c);
  await d.reset();
  const start = d.snapshotStep;
  d.fire(PUSH);
  let settledAt = -1;
  while (d.session.phase === 'running') for (const f of await d.step()) if (f.t === 'settled') settledAt = f.step;
  d.engine.dispose();
  return { n: c.meta.n, seconds: (settledAt - start) / 60, crowns: d.session.outcomes.at(-1)!.crownsDown, phase: d.session.phase };
}

describe('run window on the reference', () => {
  it(`a ${K}-domino wave runs past 30 s to its end with a 60 s window; without one it is cut short with the crown standing`, async () => {
    const w = await play(line(60));
    console.log(`run window 60 s: ${w.n} bodies, settled at ${w.seconds.toFixed(1)} s, crowns down ${w.crowns}`);
    expect(w.n).toBe(K);
    expect(w.seconds).toBeGreaterThan(SETTLE_CAP_V2 / 60);
    expect(w.seconds).toBeLessThan(60);
    expect(w.crowns).toBe(1);
    for (const rule of ['v4', 'v1'] as const) {
      const cut = await play(line(undefined, rule));
      console.log(`no window (${rule}): settled at ${cut.seconds.toFixed(1)} s, crowns down ${cut.crowns}`);
      expect(cut.seconds).toBeLessThanOrEqual(rule === 'v1' ? SETTLE_CAP / 60 : SETTLE_CAP_V2 / 60);
      expect(cut.crowns).toBe(0);
    }
  }, 600_000);
});
