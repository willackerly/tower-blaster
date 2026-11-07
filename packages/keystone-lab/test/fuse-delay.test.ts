// Fuse & Fold's domino fuses on the reference engine (M5b, docs/game/fuse-and-fold.md, "Domino fuses"): a fuse fires
// its socket's detonators when the wave arrives, and only then; its delay is its length over the front's speed, within
// 10% of X1's (0.90 to 0.96 sqrt(g H), H the domino's height), and of the game's estimate (fuseSteps) on a bend too;
// and a fuse level's session replays bit for bit, from its encoded record too. (A pipelined run ends one step after a
// serial one, on F1's timeline as on this build: 545 against 544 steps. Each driver replays itself: charges.test's check.)
import { describe, expect, it } from 'vitest';
import {
  compileLevel, decodeRecord, DOMINO_HALF, DOMINO_PITCH, Driver, encodeRecord, FUSE_SITES, fuseCandidate, fuseLanes, fuseSteps, GRAVITY, type LevelDef, PRESETTLE_STEPS,
  readShots, runSession, snapshotHash, writeShots,
} from '@tb/keystone';
import { makeEngine } from '../src/engines.ts';
import { built, firing, laneFuse } from '../src/fuse-gate.ts';

/** Plays a fuse level's Light shot until every detonator has cut its column: each lane's cut step (from the shot) and its socket's travel then. */
async function burn(def: LevelDef, limit = 900): Promise<{ cut: number[]; early: number }> {
  const c = compileLevel(def), lanes = fuseLanes(c), e = makeEngine({ kind: 'ref' }), d = new Driver(e, c), h = c.frame.unit;
  try {
    await d.reset();
    d.fire(firing(def));
    const shot = d.snapshotStep, cut = lanes.map(() => -1), home = c.meta.home;
    let early = 0;
    while (cut.includes(-1) && d.snapshotStep < shot + limit) {
      await d.step();
      const s = d.snapshot;
      lanes.forEach((l, k) => {
        const dx = s.pos[3 * l.socket]! - home[3 * l.socket]!, dz = s.pos[3 * l.socket + 2]! - home[3 * l.socket + 2]!, travel = Math.hypot(dx, dz) / h;
        const gone = l.hosts.filter((x) => d.session.cut.includes(x)).length;
        // A column cut while its socket is at rest is a detonator that did not wait for the wave.
        const v = Math.hypot(s.linVel[3 * l.socket]!, s.linVel[3 * l.socket + 1]!, s.linVel[3 * l.socket + 2]!), w = Math.hypot(s.angVel[3 * l.socket]!, s.angVel[3 * l.socket + 1]!, s.angVel[3 * l.socket + 2]!);
        if (gone && cut[k] === -1 && travel < 0.04 && v < 0.1 && w < 0.5) early++;
        if (gone === l.hosts.length && cut[k] === -1) cut[k] = d.snapshotStep - shot;
      });
    }
    return { cut, early };
  } finally { e.dispose(); }
}

const straight = (id: string) => built(fuseCandidate(id), { name: 'straight', fuses: fuseLanes(compileLevel(fuseCandidate(id))).map((l) => [l.head, l.end]) });

describe('domino fuses on the reference engine', () => {
  it('a straight fuse fires its socket when the wave arrives, at the front speed X1 measured', { timeout: 280_000 }, async () => {
    const a = await burn(straight('FD-1')), b = await burn(straight('FD-2'));
    for (const r of [a, b]) { expect(r.cut).not.toContain(-1); expect(r.early).toBe(0); }
    // Every lane of a site burns alike (the same straight fuse): within a step.
    for (const r of [a, b]) expect(Math.max(...r.cut) - Math.min(...r.cut)).toBeLessThanOrEqual(1);
    // FD-1's fuses are 12 dominoes, FD-2's 20: the 8 more are 8 hops.
    const nA = fuseLanes(compileLevel(fuseCandidate('FD-1')))[0]!.straight, nB = fuseLanes(compileLevel(fuseCandidate('FD-2')))[0]!.straight;
    const hop = (b.cut[0]! - a.cut[0]!) / (nB - nA), dt = 1 / 60, h = compileLevel(fuseCandidate('FD-1')).frame.unit;
    const v = (DOMINO_PITCH * h) / (hop * dt), H = 2 * DOMINO_HALF[1] * h, ratio = v / Math.sqrt(GRAVITY * H);
    // X1's band, 0.90 to 0.96, within 10%.
    expect(ratio).toBeGreaterThan(0.9 * 0.9);
    expect(ratio).toBeLessThan(0.96 * 1.1);
    // So a fuse's delay is its length over that speed, plus the lead's start: the game's estimate within 10%.
    for (const [r, n] of [[a, nA], [b, nB]] as const) {
      const est = fuseSteps([[0, 0], [0, n * DOMINO_PITCH - 0.6]]);
      expect(Math.abs(r.cut[0]! - est) / r.cut[0]!).toBeLessThan(0.1);
    }
  });

  it('a fuse with bends fires later than a straight one and on the estimate within 10%: the delay is the player\'s to lay', { timeout: 280_000 }, async () => {
    const lvl = fuseCandidate('FD-1'), lanes = FUSE_SITES['FD-1']!.fuse.lanes;
    const bent = laneFuse(lanes[1]!, 4, 1)!, game = fuseLanes(compileLevel(lvl));
    const r = await burn(built(lvl, { name: 'east +4', fuses: [[game[0]!.head, game[0]!.end], bent] }));
    expect(r.early).toBe(0);
    expect(r.cut[1]! - r.cut[0]!).toBeGreaterThan(30); // half a second or more
    for (const [k, path] of [[0, [game[0]!.head, game[0]!.end]], [1, bent]] as const) expect(Math.abs(r.cut[k]! - fuseSteps(path)) / r.cut[k]!).toBeLessThan(0.1);
  });

  it('a lane left unlaid never cuts its row (the detonators stand down; the round fails as a misfire)', { timeout: 280_000 }, async () => {
    const lvl = fuseCandidate('FD-1'), l = fuseLanes(compileLevel(lvl))[0]!;
    const r = await burn(built(lvl, { name: 'west only', fuses: [[l.head, l.end], null] }), 500);
    expect(r.cut[0]).toBeGreaterThan(0);
    expect(r.cut[1]).toBe(-1);
  });

  it('a fuse level replays bit for bit, and from its encoded record', { timeout: 280_000 }, async () => {
    const lvl = fuseCandidate('FD-1'), lanes = FUSE_SITES['FD-1']!.fuse.lanes, game = fuseLanes(compileLevel(lvl));
    const c = compileLevel(built(lvl, { name: 'east +4', fuses: [[game[0]!.head, game[0]!.end], laneFuse(lanes[1]!, 4, 1)!] }));
    const make = () => makeEngine({ kind: 'ref' }), line = [firing(c.def)];
    const a = await runSession(make(), c, line), b = await runSession(make(), c, line);
    expect(snapshotHash(b.snapshot)).toBe(snapshotHash(a.snapshot));
    expect(b.steps).toBe(a.steps);
    expect(a.steps).toBeGreaterThan(PRESETTLE_STEPS + 300);
    const rec = decodeRecord(encodeRecord({ v: 1, level: c.def.id, levelHash: c.hash, engine: 'ref', inputs: a.session.inputs }));
    const again = await runSession(make(), c, readShots(writeShots(rec.inputs.map((i) => i.shot))));
    expect(snapshotHash(again.snapshot)).toBe(snapshotHash(a.snapshot));
  });
});
