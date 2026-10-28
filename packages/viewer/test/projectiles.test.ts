// Real things to throw (proj=<name>, @tb/weapons PROJECTILE_PRESETS): their URL keys and scene-file
// fields, the conversion to a world of any cube size and block material (the mass ratio is what
// physics sees), the launch-speed cap, Bounce, and the panel's line. Then on the reference engine:
// a beach ball, 1/9,650 of a stone cube, comes off a small tower without moving it or blowing up;
// a wrecking ball and the Raiders boulder knock it down.
import { describe, expect, it } from 'vitest';
import { makeEngine } from '@tb/bench';
import { volumeOf } from '@tb/engine-api';
import { PRESET_NAMES, PROJECTILE_PRESETS, presetMass, STONE_DENSITY } from '@tb/weapons';
import {
  blockDensityOf, DEFAULT_PROJECTILE, engineSpec, firedBody, launchSpeedCap, parseSceneFile, parseViewerConfig, presetProjectile,
  projectileBody, projectileSummary, sceneFile, scenarioEngineSpec, toSearch, type ViewerConfig, viewerScene, worldEngineSpec, worldProjectile,
} from '../src/index.ts';

const at = new Date(2026, 9, 28, 6, 0);
const roundTrip = (c: ViewerConfig) => parseSceneFile(JSON.stringify(sceneFile(c, 'x', null, at))).config;
/** The URL's projectile keys. */
const projKeys = (c: ViewerConfig) => [...new URLSearchParams(toSearch(c))].filter(([k]) => k.startsWith('proj')).map(([k, v]) => `${k}=${v}`).join('&');

describe('real things to throw', () => {
  it('proj=<name> fires it at its own size, speed, bounce and friction, and only proj=<name> goes back in the URL', () => {
    for (const name of PRESET_NAMES) {
      const c = parseViewerConfig(`?proj=${name}`), r = PROJECTILE_PRESETS[name];
      expect(c.projectile).toEqual({ shape: 'ball', size: r.diameter, mass: null, speed: r.speed, preset: name, restitution: r.restitution, friction: r.friction });
      expect(projKeys(c)).toBe(`proj=${name}`);
      expect(roundTrip(c).projectile).toEqual(c.projectile);
    }
  });

  it('overrides read and write back, in the URL and the scene file', () => {
    const c = parseViewerConfig('?proj=wreckingball&proj.size=1.2&proj.mass=5000&proj.speed=20&proj.restitution=0.3&proj.friction=0.9&proj.blockDensity=450');
    expect(c.projectile).toEqual({ shape: 'ball', size: 1.2, mass: 5000, speed: 20, preset: 'wreckingball', restitution: 0.3, friction: 0.9, blockDensity: 450 });
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(roundTrip(c).projectile).toEqual(c.projectile);
    // A field set back to the thing's own drops out of the URL.
    expect(projKeys(parseViewerConfig('?proj=beachball&proj.speed=15&proj.restitution=0.75'))).toBe('proj=beachball');
    // Ball and cube take the new keys too, and are otherwise as before.
    expect(parseViewerConfig('?proj=cube&proj.friction=1').projectile).toEqual({ ...DEFAULT_PROJECTILE, shape: 'cube', friction: 1 });
    expect(parseViewerConfig('').projectile).toEqual(DEFAULT_PROJECTILE);
  });

  it('refuses what it can not use, saying why', () => {
    const q = (s: string) => () => parseViewerConfig(`?${s}`);
    expect(q('proj=rocket')).toThrow(/proj must be one of ball, cube, beachball, basketball, bowlingball, cannonball, wreckingball, boulder: rocket/);
    expect(q('proj=beachball&proj.restitution=1.5')).toThrow(/proj.restitution must be a number from 0 to 1/);
    expect(q('proj.friction=-1')).toThrow(/proj.friction must be a number from 0 to 2/);
    expect(q('proj.blockDensity=0')).toThrow(/proj.blockDensity must be a number from 1 to 30000/);
    const f = structuredClone(sceneFile(parseViewerConfig('?proj=beachball'), 'x', null, at)) as Record<string, any>;
    f.projectile.preset = 'anvil';
    expect(() => parseSceneFile(JSON.stringify(f))).toThrow(/proj must be one of .*: anvil/);
    f.projectile.preset = 'beachball';
    f.projectile.colour = 1;
    expect(() => parseSceneFile(JSON.stringify(f))).toThrow(/projectile: unknown key colour/);
  });

  it('a block of density 1 is stone, pine in the Kapla tower, and a Keystone level\'s stone; proj.blockDensity says otherwise', () => {
    expect(blockDensityOf(parseViewerConfig(''))).toBe(STONE_DENSITY);
    expect(blockDensityOf(parseViewerConfig('?scenario=S15'))).toBe(450);
    expect(blockDensityOf(parseViewerConfig('?level=L1'))).toBeCloseTo(STONE_DENSITY / 625, 12);
    expect(blockDensityOf(parseViewerConfig('?scenario=S15&proj=boulder&proj.blockDensity=30'))).toBe(30);
  });

  it('in the world, a real thing keeps its real size, speed and mass ratio to a block, whatever the cube size', () => {
    for (const name of PRESET_NAMES) {
      const r = PROJECTILE_PRESETS[name];
      for (const [scale, blocks] of [[1, STONE_DENSITY], [0.25, STONE_DENSITY], [0.0234, 450], [2, 30]] as const) {
        const w = worldProjectile(presetProjectile(name), scale, blocks);
        expect(w.shape).toEqual({ kind: 'sphere', radius: r.diameter / 2 / scale });
        expect(w.speed).toBeCloseTo(r.speed / scale, 9);
        // Its mass in the scene's units over a unit cube's (density 1) is its real mass over a block cube's.
        expect(w.density * volumeOf(w.shape)).toBeCloseTo(presetMass(r) / (blocks * scale ** 3), 6);
        expect(w).toMatchObject({ restitution: r.restitution, friction: r.friction, colour: { natural: r.colour, candy: r.candy } });
      }
    }
    // A mass of your own sets its density at its size.
    const heavy = worldProjectile({ ...presetProjectile('beachball'), mass: 2400 * (Math.PI / 6) * 0.125 }, 1, STONE_DENSITY);
    expect(heavy.density).toBeCloseTo(1, 9);
  });

  it('ball and cube are what they were: cube units, froudeSpeed, density 8 unless a mass is set', () => {
    for (const scale of [1, 0.25]) {
      const w = worldProjectile(DEFAULT_PROJECTILE, scale, STONE_DENSITY);
      expect(w).toEqual({ shape: { kind: 'sphere', radius: 0.7 }, speed: 40 / Math.sqrt(scale), density: 8, restitution: 0.1, friction: 0.5, colour: null });
    }
    expect(projectileBody(DEFAULT_PROJECTILE, [0, 0, 0], [1, 0, 0])).toEqual({
      shape: { kind: 'sphere', radius: 0.7 }, pos: [2, 0, 0], rot: [0, 0, 0, 1], linVel: [40, 0, 0], angVel: [0, 0, 0], density: 8, friction: 0.5, restitution: 0.1, tag: expect.any(Number),
    });
  });

  it('a fired body is no faster than the AVBD broadphase sweeps (0.8 of maxSweep a step), on those engines only', () => {
    expect(launchSpeedCap(parseViewerConfig(''))).toBe(48);
    expect(launchSpeedCap(parseViewerConfig('?scenario=S15'))).toBe(48 * 7);
    expect(launchSpeedCap(parseViewerConfig('?engine=avbd-ref:maxSweep=0.5&substeps=2'))).toBe(48);
    expect(launchSpeedCap(parseViewerConfig('?engine=avbd-gpu:sweep=false'))).toBe(Infinity);
    expect(launchSpeedCap(parseViewerConfig('?engine=rapier'))).toBe(Infinity);
    // A beach ball at real Kapla size would go 641 units/s, 1.9 plank widths a step: capped at 336.
    const kapla = parseViewerConfig('?scenario=S15&proj=beachball');
    expect(firedBody(kapla, [0, 0, 0], [1, 0, 0]).body.linVel).toEqual([336, 0, 0]);
    // The default ball, in any world at its auto substeps, is under the cap (as it always went).
    for (const s of ['', '?scale=0.25', '?scenario=S15']) {
      const c = parseViewerConfig(s);
      expect(firedBody(c, [0, 0, 0], [1, 0, 0]).body.linVel[0]).toBeCloseTo(40 / Math.sqrt(c.scale), 9);
    }
  });

  it('with Bounce on, a thing with its own bounce keeps it; a plain ball takes the scene\'s e', () => {
    const on = '?engine=avbd-gpu:restitution=true&bounce.e=0.6';
    expect(firedBody(parseViewerConfig(`${on}&proj=beachball`), [0, 0, 0], [1, 0, 0]).body.restitution).toBe(0.75);
    expect(firedBody(parseViewerConfig(on), [0, 0, 0], [1, 0, 0]).body.restitution).toBe(0.6);
    expect(firedBody(parseViewerConfig(`${on}&proj.restitution=0.2`), [0, 0, 0], [1, 0, 0]).body.restitution).toBe(0.2);
    expect(firedBody(parseViewerConfig('?proj=beachball'), [0, 0, 0], [1, 0, 0])).toMatchObject({ body: { restitution: 0.75, friction: 0.6 }, colour: { natural: 0xe8473b, candy: 0xff6fb5 } });
  });

  it('the panel says what it weighs against a block, and when the engine caps its speed', () => {
    expect(projectileSummary(DEFAULT_PROJECTILE, parseViewerConfig(''))).toBe('11.5 kg (a cube is 1 kg), 460 kg·m/s');
    expect(projectileSummary(presetProjectile('beachball'), parseViewerConfig(''))).toBe('0.249 kg, 1/9,650 of a 1 m cube of block (2.40 t), 3.73 kg·m/s');
    expect(projectileSummary(presetProjectile('boulder'), parseViewerConfig(''))).toBe('425 t, 177x a 1 m cube of block (2.40 t), 3,400,000 kg·m/s');
    expect(projectileSummary(presetProjectile('beachball'), parseViewerConfig('?scenario=S15'))).toBe(
      '0.249 kg, 43.1x a 0.0234 m cube of block (0.00577 kg), 1.96 kg·m/s; launched at 7.86 m/s, the fastest this engine sees at this cube size (more substeps raise it)');
  });
});

describe('real things on the reference engine', () => {
  /** Fires the thing level at the middle of a 2x2x3 stone tower from 4 m off its face; after 2 s, how many blocks moved and how fast any went. */
  async function shoot(name: string) {
    const c = parseViewerConfig(`?scenario=S1&param.F=2&param.H=3&engine=avbd-ref&proj=${name}`);
    const scene = viewerScene(c);
    const engine = makeEngine(worldEngineSpec(engineSpec(scenarioEngineSpec(c.engine, c.scenario), c.projectile, c.scale), c.scale));
    await engine.init(scene);
    const minX = Math.min(...scene.bodies.map((b) => b.pos[0])) - 0.5;
    const r = PROJECTILE_PRESETS[name as keyof typeof PROJECTILE_PRESETS].diameter / 2;
    // worldBody starts it max(2, r + 1) along the ray.
    const { body } = firedBody(c, [minX - r - 4 - Math.max(2, r + 1), Math.max(r, 1.5), 0], [1, 0, 0]);
    engine.push([{ step: 0, kind: 'spawn', body }]);
    const n = scene.bodies.length;
    let fastest = 0, finite = true;
    for (let i = 0; i < 120; i++) {
      await engine.step();
      const s = await engine.snapshot();
      for (let j = 0; j < s.count; j++) {
        const v = Math.hypot(s.linVel[3 * j]!, s.linVel[3 * j + 1]!, s.linVel[3 * j + 2]!);
        finite &&= Number.isFinite(v) && Number.isFinite(s.pos[3 * j]!);
        if (j < n) fastest = Math.max(fastest, v);
      }
    }
    const s = await engine.snapshot();
    const moved = scene.bodies.filter((b, j) => Math.hypot(s.pos[3 * j]! - b.pos[0], s.pos[3 * j + 1]! - b.pos[1], s.pos[3 * j + 2]! - b.pos[2]) > 0.2).length;
    const ball = { x: s.pos[3 * n]!, y: s.pos[3 * n + 1]! };
    engine.dispose();
    return { finite, fastest, moved, n, ball, minX, r };
  }

  it('a beach ball comes off the tower, which does not notice it (a mass ratio of 1e-4, solved without blowing up)', async () => {
    const o = await shoot('beachball');
    expect(o.finite).toBe(true);
    expect(o.moved).toBe(0);
    expect(o.fastest).toBeLessThan(0.2);
    // It ends on the ground outside the tower, not in it.
    expect(o.ball.x).toBeLessThan(o.minX - o.r + 0.01);
    expect(o.ball.y).toBeCloseTo(o.r, 1);
  });

  it('a wrecking ball knocks blocks off; the Raiders boulder takes the whole tower', async () => {
    const w = await shoot('wreckingball');
    expect(w.finite).toBe(true);
    expect(w.moved).toBeGreaterThan(w.n / 3);
    const b = await shoot('boulder');
    expect(b.finite).toBe(true);
    expect(b.moved).toBe(b.n);
  });
});
