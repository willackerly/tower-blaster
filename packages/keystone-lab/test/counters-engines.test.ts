// Agent playtest PT12: round 1 showed B1 at "Down 16%" over a standing wall and T-I3 at "Down 85%, Crowns 9/9"
// with its crowns up, both at "+25 steps" on Rapier. The counters were right: Rapier steps on the CPU while
// SwiftShader takes many frames to draw, so the harness captured the scene at step 25 and read a HUD some
// 150 steps on (the playtest runner now holds physics while it captures: GameHandle.hold). Here the counters
// at step 25, read straight off each engine, agree: nothing is down yet on Rapier or on the f64 reference.
// Past the first impact the engines' own collisions part (Rapier's contacts are not AVBD's), which is physics,
// not the HUD: T-I3 reads D 0.17 on Rapier and 0.05 on the reference at step 60.
import { describe, expect, it } from 'vitest';
import { B1, compileLevel, Driver, findLevel, type LevelDef, type Shot } from '@tb/keystone';
import { type LabEngineKind, makeEngine } from '../src/engines.ts';

async function at(def: LevelDef, shot: Shot, kind: LabEngineKind, steps: number) {
  const c = compileLevel(def), d = new Driver(makeEngine({ kind }), c);
  try {
    await d.reset();
    d.fire(shot);
    for (let k = 0; k < steps && d.session.phase === 'running'; k++) await d.step();
    return { phase: d.session.phase, d: d.session.liveCollapse, crowns: d.session.crownLive.reduce((a, x) => a + x, 0) };
  } finally {
    d.engine.dispose();
  }
}

describe('HUD counters at the round-1 frames (PT12)', () => {
  it('T-I3, first shot, step 25: Down 0% and no crown down on Rapier and on the reference', async () => {
    const shot: Shot = { ammo: 'cannonball', az: 108, y: 40, yaw: 127, pitch: -450, power: 100 };
    const t = findLevel('T-I3')!;
    for (const kind of ['rapier', 'ref'] as const) expect(await at(t, shot, kind, 25), kind).toEqual({ phase: 'running', d: 0, crowns: 0 });
  }, 120_000);
  it('B1, the opener, step 25 on Rapier: the wall reads Down 0%', async () => {
    const shot = (B1.solutions?.ace?.[0] ?? B1.solutions?.par?.[0]) as Shot;
    expect(await at(B1, shot, 'rapier', 25)).toEqual({ phase: 'running', d: 0, crowns: 0 });
  }, 120_000);
});
