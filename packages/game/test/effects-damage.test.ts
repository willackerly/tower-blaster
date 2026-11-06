// Effects follow the damage (PT2): the spark emitter's rule (@tb/render sparkBucketReference, the GPU's
// twin) fed the impacts a real shot makes. Each step of a Rapier session on L1 (as the game page builds
// it) gives the detector's events: every body whose speed changed by more than dvMin since the last step
// (its strength, and whether it is a ball, TAG_BALL); one step a frame at 60 Hz. A marble well wide of
// the tower (it moves nothing) must spawn at most a tenth of what the par cannonball or a grenade on the
// tower spawns, under the damage rule. (The playtest's dud, L2's marble off the lintel, sparked in full under
// the classic rule because the ball's own impact and the game's contact burst both counted at the ball's
// speed change: about 700 sparks on Rapier, against about 190 now, all from blocks it jostled.)
// Also the game's fired-body looks (scene.ts firedKind, ramFx, spentFx, rolePaint) and the feel keys.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { TAG_BALL } from '@tb/engine-api';
import { compileLevel, Driver, L1, B2, playShots, type LevelDef, type Shot } from '@tb/keystone';
import { CLASSIC_SPARKS, DEFAULT_SPARKS, MATERIAL, sparkBucketReference, type Impact, type SparkParams } from '@tb/render';
import { driverOptions } from '../src/engines.ts';
import { DEFAULT_FEEL, paceFeel, writePaceFeel } from '../src/pacing.ts';
import { BOMB_FX, firedKind, ramFx, rolePaint, SPENT_GREY, SPENT_MIX, spentFx, TINT } from '../src/scene.ts';

const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const par = L1.solutions!.par![0]! as Extract<Shot, { az: number }>;

/** The detector's events of every step of `shots` on `def` (Rapier, the page's driver options), one frame per step. */
async function shotImpacts(def: LevelDef, shots: Shot[], dvMin: number) {
  const d = new Driver(new RapierEngine(), compileLevel(def), driverOptions('rapier'));
  await d.reset();
  let prev = new Float64Array(0);
  const frames: { events: Impact[]; dt: number }[] = [];
  let ballEvents = 0, blockEvents = 0;
  await playShots(d, shots, 0, {
    bank: false,
    perStep: (dr) => {
      const s = dr.snapshot, n = s.count, events: Impact[] = [];
      for (let i = 0; i < Math.min(n, prev.length / 3); i++) {
        const dv = Math.hypot(s.linVel[3 * i]! - prev[3 * i]!, s.linVel[3 * i + 1]! - prev[3 * i + 1]!, s.linVel[3 * i + 2]! - prev[3 * i + 2]!);
        if (dv <= dvMin) continue;
        const ball = dr.bodies[i]?.tag === TAG_BALL;
        if (ball) ballEvents++; else blockEvents++;
        events.push({ pos: [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!], dir: [0, 1, 0], strength: Math.fround(dv), packed: (i & 0xffffff) | ((ball ? MATERIAL.ball : 0) << 28) });
      }
      frames.push({ events, dt: 1 / 60 });
      prev = Float64Array.from(s.linVel.subarray(0, 3 * n));
      return [];
    },
  });
  return { frames, ballEvents, blockEvents, collapse: d.session.outcomes[0]?.dPE_mJ ?? 0 };
}

const sparks = (f: Awaited<ReturnType<typeof shotImpacts>>, p: SparkParams) => sparkBucketReference(f.frames, p).total;

describe('a dud sparks a puff, a hit in full (the emitter fed real impacts)', () => {
  it('a marble that moves nothing spawns at most a tenth of a par cannonball or a grenade on L1', async () => {
    const dud = await shotImpacts(L1, [miss], DEFAULT_SPARKS.dvMin);
    const hit = await shotImpacts(L1, [par], DEFAULT_SPARKS.dvMin);
    const armed: LevelDef = { ...L1, rack: [...L1.rack, 'w-grenade'] };
    const blast = await shotImpacts(armed, [{ ...par, ammo: 'w-grenade' }], DEFAULT_SPARKS.dvMin);
    expect(dud.blockEvents).toBe(0); // it moved nothing hard enough to spark
    expect(dud.ballEvents).toBeGreaterThan(0); // its own landing and bounces
    expect(hit.blockEvents).toBeGreaterThan(20);
    expect(blast.blockEvents).toBeGreaterThan(20);
    const [d, h, b] = [dud, hit, blast].map((x) => sparks(x, DEFAULT_SPARKS)) as [number, number, number];
    console.log(`L1 sparks, damage rule: miss ${d}, par cannonball ${h}, grenade ${b}; classic: ${[dud, hit, blast].map((x) => sparks(x, CLASSIC_SPARKS)).join(', ')}`);
    expect(d).toBeGreaterThan(0); // a puff, not nothing
    expect(d).toBeLessThanOrEqual(dud.ballEvents * DEFAULT_SPARKS.ballSparks);
    expect(10 * d).toBeLessThanOrEqual(h);
    expect(10 * d).toBeLessThanOrEqual(b);
  }, 120_000);
});

describe("fired bodies' looks (PT19)", () => {
  it('a weapon that never goes off is a ram, one that does a bomb, the rest balls', () => {
    expect(firedKind(B2, 'w-ram')).toBe('ram');
    expect(firedKind(B2, 'w-bomb')).toBe('bomb');
    expect(firedKind(L1, 'w-grenade')).toBe('bomb');
    expect(firedKind(L1, 'marble')).toBe('ball');
    expect(firedKind(L1, 'cannonball')).toBe('ball');
    expect(ramFx('painted')).toMatchObject({ paint: true, band: true });
    expect(ramFx('painted')!.matte).toBeUndefined(); // not a bomb's iron
    expect(ramFx('plain')).toBeNull();
    expect(Math.max(...ramFx()!.tint!)).toBeGreaterThan(5 * Math.max(...BOMB_FX.tint)); // far from the bombs' near-black
  });

  it('spent ammo fades toward a dull grey, matte, keeping its band; live it is unchanged', () => {
    const paint = { tint: [0.6, 0.02, 0.03] as [number, number, number], paint: true, band: true };
    expect(spentFx(paint, 0)).toEqual({ ...paint, matte: false });
    const done = spentFx(paint, 1);
    expect(done.matte).toBe(true);
    expect(done.band).toBe(true);
    done.tint!.forEach((x, i) => expect(x).toBeCloseTo(paint.tint[i]! + (SPENT_GREY[i]! - paint.tint[i]!) * SPENT_MIX, 9));
    expect(spentFx(paint, 7)).toEqual(done); // clamped
    // A plain ball (the look's own) fades from white.
    spentFx(null, 1).tint!.forEach((x, i) => expect(x).toBeCloseTo(1 + (SPENT_GREY[i]! - 1) * SPENT_MIX, 9));
  });

  it('damage style: cracked heritage flashes teal and stays teal; classic flashes it white and an undo kept it glowing', () => {
    const d = rolePaint('damage'), c = rolePaint('classic');
    expect(d.heritageFlash.emissive).toBeLessThanOrEqual(0.25);
    expect(d.heritageKept).toEqual({ tint: TINT.heritage });
    expect(d.crownKept).toEqual({ tint: TINT.crown });
    expect(c.heritageFlash.emissive).toBe(1);
    expect(c.heritageKept).toEqual({ tint: TINT.heritage, emissive: 1 });
  });

  it('keystone.fx and keystone.spent read and write back; defaults damage and on', () => {
    expect([DEFAULT_FEEL.fx, DEFAULT_FEEL.spent]).toEqual(['damage', true]);
    const f = paceFeel(new URLSearchParams('keystone.fx=classic&keystone.spent=0'));
    expect([f.fx, f.spent]).toEqual(['classic', false]);
    const q = new URLSearchParams();
    writePaceFeel(f, q);
    expect([q.get('keystone.fx'), q.get('keystone.spent')]).toEqual(['classic', '0']);
    const back = new URLSearchParams();
    writePaceFeel(DEFAULT_FEEL, back);
    expect(back.toString()).toBe('');
    expect(() => paceFeel(new URLSearchParams('keystone.fx=loud'))).toThrow(/keystone.fx must be damage or classic/);
  });
});
