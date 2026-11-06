// The game page's URL keys (params.ts), which the viewer reads too under
// rules=keystone: defaults, accepted spellings, and refused values named.
import { describe, expect, it } from 'vitest';
import { B1, BIG_LEVELS, L1, L2, L3, seriesOf, type Shot, writeShots } from '@tb/keystone';
import { compileLevel } from '@tb/keystone';
import { DEFAULT_LEVEL, GAME_LOOK, levelRules, loadOptions, offscreenOf, onEngine, parseGameParams, weaponTierOf, withRules, writeLevelRules } from '../src/params.ts';
import { DEFAULT_FEEL } from '../src/pacing.ts';

const parse = (search: string) => parseGameParams(new URLSearchParams(search));
const par = L1.solutions!.par as Shot[];

describe('game URL keys', () => {
  it('a bare URL opens the slice\'s first level (B1) on the GPU solver in the maquette look, no juice and no line', () => {
    expect(parse('')).toEqual({ level: B1, rack: null, rules: {}, engine: 'gpu', feel: DEFAULT_FEEL, look: GAME_LOOK, shots: null, duel: null, offscreen: false, offscreenSize: [640, 400], weaponTier: null, sound: 'collapse', impactsDb: 0 });
    expect(DEFAULT_LEVEL).toBe('B1');
    expect(seriesOf(DEFAULT_LEVEL)).toBe(BIG_LEVELS);
    // The chamber levels stay one key away, with par scoring.
    expect(parse('?level=L1').level).toBe(L1);
    expect(parse('?level=L1').level.scoring ?? 'par').toBe('par');
    expect(GAME_LOOK).toBe('hazy');
  });

  it('reads every key, a level in any case and the viewer\'s name for the GPU solver, and leaves other keys alone', () => {
    expect(parse(`?level=l3&engine=rapier&keystone.hitstop=1&keystone.slowmo=0&look=real&real.sunElevation=6&offscreen=1&scenario=S4&cam=1,2,3,0,0,9`)).toEqual({
      level: L3, rack: null, rules: {}, engine: 'rapier', feel: { ...DEFAULT_FEEL, hitStop: true }, look: 'real', shots: null, duel: null, offscreen: true, offscreenSize: [640, 400], weaponTier: null, sound: 'collapse', impactsDb: 0,
    });
    expect(parse('?keystone.sound=synth&keystone.impacts=-6')).toMatchObject({ sound: 'synth', impactsDb: -6 });
    expect(parse('?keystone.sound=classic')).toMatchObject({ sound: 'classic' });
    expect(parse('?engine=avbd-gpu').engine).toBe('gpu');
    expect(parse('?engine=gpu').engine).toBe('gpu');
    expect(parse(`?level=L1&keystone.shots=${writeShots(par)}`).shots).toEqual(par);
  });

  it('keystone.rack replaces the level\'s rack, and a line may then fire the new items', () => {
    const line = 'p-wreckingball.360.8.0.200.100_w-grenade.360.8.0.300.80';
    const p = parse(`?level=L1&keystone.rack=p-wreckingball,w-grenade,marble&keystone.shots=${line}`);
    expect(p.rack).toEqual(['p-wreckingball', 'w-grenade', 'marble']);
    expect(p.level).toEqual({ ...L1, rack: ['p-wreckingball', 'w-grenade', 'marble'] });
    expect(p.shots!.map((s) => s.ammo)).toEqual(['p-wreckingball', 'w-grenade']);
    expect(parse('?level=L1').level).toBe(L1);
    // The line is checked against the new rack, not the level's own.
    expect(() => parse(`?level=L1&keystone.rack=marble&keystone.shots=${writeShots(par)}`)).toThrow(/fires 1 cannonball but L1's rack holds 0 \(rack: marble\)/);
  });

  it('keystone.rack can rack pulls, and a line of pulls plays from the link', () => {
    const p = parse('?level=L1&keystone.rack=pull,pull,marble&keystone.shots=pull.0_pull.12');
    expect(p.rack).toEqual(['pull', 'pull', 'marble']);
    expect(p.shots).toEqual([{ ammo: 'pull', body: 0 }, { ammo: 'pull', body: 12 }]);
    expect(() => parse('?level=L1&keystone.rack=pull&keystone.shots=pull.0_pull.1')).toThrow(/fires 2 pull but L1's rack holds 1/);
  });

  it('refuses a bad keystone.rack, naming the key', () => {
    expect(() => parse('?keystone.rack=')).toThrow(/keystone.rack must list 1 to 8 items \(and up to 24 pulls\)/);
    expect(() => parse(`?keystone.rack=${Array(9).fill('marble').join(',')}`)).toThrow(/keystone.rack must list 1 to 8 items \(and up to 24 pulls\)/);
    expect(() => parse('?keystone.rack=marble,nuke')).toThrow(/keystone.rack: nuke is not one of marble, cannonball/);
    expect(() => parse('?keystone.rack=marble,')).toThrow(/keystone.rack: an empty name is not one of/);
    expect(() => parse('?level=L1&keystone.rack=w-big')).toThrow(/keystone.rack: L1 has no weapons.big for w-big/);
  });

  it('keystone.tier sets the tier the rack\'s weapons must fit; absent, the device\'s quality tier, else high', () => {
    expect(parse('?level=L1').weaponTier).toBeNull();
    expect(weaponTierOf(parse('?level=L1').weaponTier)).toBe('high');
    expect(parse('?level=L1&keystone.tier=low').weaponTier).toBe('low');
    expect(weaponTierOf('mid')).toBe('mid');
    // The device's quality tier when the URL says nothing; the URL wins.
    expect(weaponTierOf(null, 'low')).toBe('low');
    expect(weaponTierOf('high', 'low')).toBe('high');
    expect(() => parse('?keystone.tier=huge')).toThrow(/keystone.tier must be one of low, mid, high: huge/);
  });

  it('opens a big level by id with its outcome scoring; a chamber level keeps par', () => {
    expect(parse('?level=b1').level).toBe(B1);
    expect(parse('?level=B1').level.scoring).toBe('outcome');
    expect(parse('?level=L2').level).toBe(L2);
    expect(parse('?level=L2').level.scoring ?? 'par').toBe('par');
  });

  it('refuses bad values, naming the key', () => {
    expect(() => parse('?level=L99')).toThrow(/unknown level L99; known: L1, L2, L3, L4, L5, B1, B2, B3/);
    expect(() => parse('?engine=physx')).toThrow(/unknown engine physx: use rapier or gpu/);
    expect(() => parse('?keystone.hitstop=yes')).toThrow(/keystone.hitstop must be 0 or 1: yes/);
    expect(() => parse('?keystone.slowmo=')).toThrow(/keystone.slowmo must be 0 or 1: $/);
    expect(() => parse('?keystone.sound=loud')).toThrow(/keystone.sound must be collapse, classic, synth: loud/);
    expect(() => parse('?keystone.impacts=30')).toThrow(/keystone.impacts \(dB\) must be from -40 to 20: 30/);
    expect(() => parse('?keystone.impacts=')).toThrow(/keystone.impacts/);
    expect(() => parse('?look=neon')).toThrow(/unknown look neon; known: candy, hazy, real/);
    expect(() => parse('?keystone.shots=')).toThrow(/keystone.shots is empty/);
    expect(() => parse('?level=L1&keystone.shots=drop.0.0')).toThrow(/fires 1 drop but L1's rack holds 0/);
    expect(() => parse('?keystone.shots=marble.0')).toThrow(/shot 1 .*marble takes 5 fields/);
  });
});

describe('offscreen key', () => {
  it('1 draws 640x400 offscreen, WxH that size (an agent playtest\'s phone or desktop); 0 or absent the page canvas', () => {
    expect(offscreenOf(null)).toEqual({ offscreen: false, offscreenSize: [640, 400] });
    expect(offscreenOf('0')).toEqual({ offscreen: false, offscreenSize: [640, 400] });
    expect(offscreenOf('1')).toEqual({ offscreen: true, offscreenSize: [640, 400] });
    expect(parse('?offscreen=390x844').offscreenSize).toEqual([390, 844]);
    expect(parse('?offscreen=1280x800')).toMatchObject({ offscreen: true, offscreenSize: [1280, 800] });
  });
  it('refuses anything else, naming the key', () => {
    for (const bad of ['', '2', 'x', '1280', '1280x', '63x400', '640x5000', '640X400', '-1x400']) expect(() => offscreenOf(bad)).toThrow(/^offscreen must be/);
  });
});

describe('rule overrides', () => {
  it('keystone.scoring and keystone.autobank make the level they name, with its own hash', () => {
    const p = parse('?level=L1&keystone.scoring=outcome&keystone.autobank=1');
    expect(p.rules).toEqual({ scoring: 'outcome', autobank: true });
    expect(p.level).toEqual({ ...L1, scoring: 'outcome', autobank: true, custom: true });
    expect(compileLevel(p.level).hash).not.toBe(compileLevel(L1).hash);
    // The defaults written out are the level itself.
    expect(compileLevel(parse('?level=L1&keystone.scoring=par&keystone.autobank=0').level).hash).toBe(compileLevel(L1).hash);
    expect(withRules(L1, {})).toBe(L1);
    expect(levelRules(new URLSearchParams('?keystone.autobank=0'))).toEqual({ autobank: false });
  });
  it('keystone.settle picks the settle rule: the scoring\'s own is the same level, the other a custom one', () => {
    const p = parse('?level=L1&keystone.settle=v2');
    expect(p.rules).toEqual({ settle: 'v2' });
    expect(p.level).toEqual({ ...L1, settle: 'v2', custom: true });
    expect(compileLevel(p.level).hash).not.toBe(compileLevel(L1).hash);
    expect(compileLevel(parse('?level=L1&keystone.settle=v1').level).hash).toBe(compileLevel(L1).hash);
    const q = new URLSearchParams();
    writeLevelRules({ settle: 'v1' }, q);
    expect(levelRules(q)).toEqual({ settle: 'v1' });
    expect(parse('?level=L1&keystone.settle=v3').rules).toEqual({ settle: 'v3' });
    expect(() => parse('?keystone.settle=v9')).toThrow(/keystone.settle must be v1 or v2 or v3: v9/);
  });
  it('keystone.freeze gives the player a freeze budget: a custom level with its own hash; refuses a bad one', () => {
    const p = parse('?level=L1&keystone.freeze=3');
    expect(p.rules).toEqual({ freeze: 3 });
    expect(p.level).toEqual({ ...L1, freeze: 3, custom: true });
    expect(compileLevel(p.level).hash).not.toBe(compileLevel(L1).hash);
    expect(parse('?level=L1&keystone.freeze=0').level.freeze).toBe(0);
    const q = new URLSearchParams();
    writeLevelRules({ freeze: 2 }, q);
    expect(q.toString()).toBe('keystone.freeze=2');
    expect(levelRules(q)).toEqual({ freeze: 2 });
    expect(() => parse('?keystone.freeze=10')).toThrow(/keystone.freeze must be a whole number from 0 to 9: 10/);
    expect(() => parse('?keystone.freeze=-1')).toThrow(/keystone.freeze must be a whole number from 0 to 9: -1/);
    expect(() => parse('?keystone.freeze=')).toThrow(/keystone.freeze must be a whole number from 0 to 9: $/);
  });
  it('the physics keys set the level\'s physics block; off turns Bounce off', () => {
    const p = parse('?level=L2&keystone.iterations=20&keystone.gapSlop=0&keystone.bounce=0.4');
    expect(p.level.physics).toEqual({ iterations: 20, gapSlop: 0, bounce: 0.4 });
    expect(p.level.custom).toBe(true);
    expect(parse('?keystone.bounce=off').level.physics).toEqual({ bounce: null });
    expect(() => parse('?keystone.iterations=0')).toThrow(/keystone.iterations: must be a whole number from 1 to 200: 0/);
    expect(() => parse('?keystone.iterations=')).toThrow(/keystone.iterations: must be a whole number/);
    expect(() => parse('?keystone.gapSlop=-1')).toThrow(/keystone.gapSlop: must be from 0 to 0.01 m/);
    expect(() => parse('?keystone.bounce=2')).toThrow(/keystone.bounce: must be from 0 to 1, or null for off/);
    expect(parse('?keystone.presettle=30').level.physics).toEqual({ presettle: 30 });
    expect(() => parse('?keystone.presettle=7000')).toThrow(/keystone.presettle: must be a whole number from 0 to 6000: 7000/);
    expect(parse('?keystone.pairsPerBody=2').level).toMatchObject({ custom: true, physics: { pairsPerBody: 2 } });
    for (const bad of ['0', '257', '2.5', '']) expect(() => parse(`?keystone.pairsPerBody=${bad}`), bad).toThrow(/keystone.pairsPerBody: must be a whole number from 1 to 256/);
    // GPU sleep: 1 or 0, written back the same way; with Bounce the level refuses it.
    expect(parse('?keystone.sleep=1').level).toMatchObject({ custom: true, physics: { sleep: true } });
    expect(parse('?keystone.sleep=0').level.physics).toEqual({ sleep: false });
    for (const bad of ['true', '2', '']) expect(() => parse(`?keystone.sleep=${bad}`), bad).toThrow(/keystone.sleep: must be true or false/);
    const q = new URLSearchParams();
    writeLevelRules({ physics: { sleep: true } }, q);
    expect(q.toString()).toBe('keystone.sleep=1');
    expect(levelRules(q)).toEqual({ physics: { sleep: true } });
    // The level the two make is refused where it is compiled (the game's load shows the message).
    expect(() => compileLevel(parse('?keystone.sleep=1&keystone.bounce=0.4').level)).toThrow(/physics.sleep does not go with bounce/);
  });
  it('a level cast on another engine plays as custom there', () => {
    const cast = { ...L1, stars: { metric: 'collapse' as const, t2: 0.2, t3: 0.4, engine: 'gpu' } };
    expect(onEngine(cast, 'gpu')).toBe(cast);
    expect(onEngine(cast, 'rapier').custom).toBe(true);
    expect(onEngine(L1, 'rapier')).toBe(L1);
  });
  it('refuses bad values, naming the key', () => {
    expect(() => parse('?keystone.scoring=golf')).toThrow(/keystone.scoring must be par or outcome: golf/);
    expect(() => parse('?keystone.autobank=yes')).toThrow(/keystone.autobank must be 0 or 1: yes/);
  });
});

describe('level start keys (loadOptions)', () => {
  const lo = (search: string) => loadOptions(new URLSearchParams(search));
  it('leaves the defaults to playKeystone when absent', () => {
    expect(lo('')).toEqual({});
  });
  it('reads keystone.loadpace (ms, 0 unpaced) and keystone.prefetch (aim or 1, card, 0)', () => {
    expect(lo('?keystone.loadpace=0')).toEqual({ loadPaceMs: 0 });
    expect(lo('?keystone.loadpace=12.5&keystone.prefetch=0')).toEqual({ loadPaceMs: 12.5, prefetch: 'off' });
    expect(lo('?keystone.prefetch=1')).toEqual({ prefetch: 'aim' });
    expect(lo('?keystone.prefetch=aim')).toEqual({ prefetch: 'aim' });
    expect(lo('?keystone.prefetch=card')).toEqual({ prefetch: 'card' });
    expect(lo('?keystone.retry=rebuild')).toEqual({ retry: 'rebuild' });
  });
  it('refuses bad values, naming the key', () => {
    expect(() => lo('?keystone.loadpace=')).toThrow(/keystone.loadpace must be from 0 to 1000 ms/);
    expect(() => lo('?keystone.loadpace=-1')).toThrow(/keystone.loadpace/);
    expect(() => lo('?keystone.loadpace=fast')).toThrow(/keystone.loadpace .*: fast/);
    expect(() => lo('?keystone.prefetch=yes')).toThrow(/keystone.prefetch must be aim \(or 1\), card or 0: yes/);
    expect(() => lo('?keystone.retry=fast')).toThrow(/keystone.retry must be checkpoint or rebuild: fast/);
  });
});
