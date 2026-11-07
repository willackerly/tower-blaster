// Aftershock's quake shot without an engine (M7, docs/game/aftershock.md; quake.ts): text and records round
// trip and refuse what is off the dial, the field events are the engine-api quake with the level's gravity
// restored exactly, the energy is its formula, the level's dial and budget refuse, and the level grammar
// (pinned parts, the quake objective, the standing heritage rule) compiles and validates as documented.
import { describe, expect, it } from 'vitest';
import { FIELD_QUANTUM, onFieldGrid, quakeEvents } from '@tb/engine-api';
import {
  AFTERSHOCK_LEVELS, castStars, checkShot, checkStars, compileLevel, decodeRecord, encodeRecord, energyFired, GRAVITY, HERITAGE_MOVE, heritageFallen, type LevelDef, levelById, movingMass, naiveQuake, objectiveMet, type OutcomeFacts, outcomeScore,
  outcomeTally, QUAKE, QUAKE_DEFAULTS, quakeEnergy, quakeCandidate, quakeInputs, quakeRefusal, quakeRulesOf, quakeSteps, type QuakeShot, readShots, type Reductions, roundLeverage, Session, type Shot, validateLevel, writeShots,
} from '../src/index.ts';

const level = (over: Partial<LevelDef> = {}): LevelDef => ({
  id: 'AQ', name: 'quake', version: 1, world: 0, lot: { min: [-10, -10], max: [10, 10] }, crownLine: 1.5, objective: { kind: 'quake' }, par: 1,
  rack: [QUAKE], launcher: { radius: 12, y: 1, dropY: 10 }, scoring: 'outcome', heritage: 'standing',
  parts: [
    { kind: 'block', at: [-3, 0, 0], size: [1, 5, 1], material: 'plaster' }, // 0-4: condemned column
    { kind: 'block', at: [-3, 5, 0], size: [1, 1, 1], material: 'plaster', role: 'crown' }, // 5
    { kind: 'block', at: [3, 0, 0], size: [1, 2, 1], material: 'plaster' }, // 6-7: protected column
    { kind: 'block', at: [3, 2, 0], size: [1, 1, 1], material: 'plaster', role: 'heritage' }, // 8
    { kind: 'block', at: [0, 0, 4], size: [3, 1, 1], material: 'stone', pinned: true }, // 9-11: a pinned plinth
    { kind: 'block', at: [1, 1, 4], size: [1, 1, 1], material: 'plaster' }, // 12: on the plinth
  ],
  ...over,
});
const q = (peak: number, hz: number, sec: number, axis = 0): QuakeShot => ({ ammo: 'quake', peak, hz, sec, axis });

describe('quake shots', () => {
  it('text: peak, hz, sec, axis after the name; reads back what it wrote', () => {
    const line: Shot[] = [q(30, 10, 40, 0), { ...q(25, 5, 15, 90), after: 0 }];
    expect(writeShots(line)).toBe('quake.30.10.40.0_quake.25.5.15.90@0');
    expect(readShots(writeShots(line))).toEqual(line);
  });

  it('text and checkShot refuse fields off the dial and the wrong field count', () => {
    expect(() => readShots('quake.30.10.40')).toThrow(/4 fields/);
    expect(() => checkShot(q(0, 10, 40))).toThrow(/peak/);
    expect(() => checkShot(q(101, 10, 40))).toThrow(/peak/);
    expect(() => checkShot(q(30, 1, 40))).toThrow(/hz/);
    expect(() => checkShot(q(30, 10, 201))).toThrow(/sec/);
    expect(() => checkShot(q(30, 10, 40, 180))).toThrow(/axis/);
    expect(() => checkShot({ ...q(30, 10, 40), peak: 30.5 })).toThrow(/peak/);
  });

  it('records: code 7 and four varints; the rest decode as before', () => {
    const r = { v: 1 as const, level: 'AQ', levelHash: 'x', engine: 'ref', inputs: [{ step: 300, shot: q(45, 13, 25, 135) as Shot }, { step: 900, shot: { ammo: 'marble', az: 1, y: 2, yaw: -3, pitch: 40, power: 9 } as Shot }] };
    expect(decodeRecord(encodeRecord(r))).toEqual(r);
  });
});

describe('quake input and energy', () => {
  const c = compileLevel(level());

  it('a quake level compiles its gravity onto the field grid; any other level keeps -9.81 exactly', () => {
    expect(c.scene.gravity.every(onFieldGrid)).toBe(true);
    expect(Math.abs(c.scene.gravity[1] + GRAVITY)).toBeLessThanOrEqual(FIELD_QUANTUM / 2);
    expect(compileLevel(level({ rack: ['marble'], quake: undefined })).scene.gravity).toEqual([0, -GRAVITY, 0]);
  });

  it('the field events are engine-api quakeEvents from the shot, gravity restored exactly at its last step', () => {
    const shot = q(35, 8, 30, 60), ev = quakeInputs(c, shot, 300);
    expect(ev).toEqual(quakeEvents({ step: 300, seconds: 3, dt: 1 / 60, peak: 0.35, hz: 0.8, azimuth: Math.PI / 3 }, c.scene.gravity));
    expect(quakeSteps(shot, c.scene.dt)).toBe(180);
    expect(ev.at(-1)).toEqual({ step: 480, kind: 'field', gravity: c.scene.gravity });
    expect(ev.every((e) => e.step >= 300 && e.step <= 480)).toBe(true);
    // Along 60 degrees: x and z in the ratio cos : sin.
    const peak = ev.reduce((a, e) => (Math.abs(e.gravity![0]) > Math.abs(a.gravity![0]) ? e : a));
    expect(peak.gravity![2] / peak.gravity![0]).toBeCloseTo(Math.tan(Math.PI / 3), 2);
  });

  it('energy is M (A g)^2 T / (12 pi^2 f) over the moving mass: pinned bodies are not shaken', () => {
    const M = movingMass(c);
    let all = 0;
    for (let i = 0; i < c.meta.n; i++) all += c.meta.mass[i]!;
    expect(M).toBeCloseTo(all - 3 * c.meta.mass[9]!, 9);
    const e = quakeEnergy(c, q(30, 10, 40));
    expect(e).toBeCloseTo((M * (0.3 * GRAVITY) ** 2 * 4) / (12 * Math.PI ** 2 * 1), 9);
    expect(quakeEnergy(c, q(30, 10, 80))).toBeCloseTo(2 * e, 9);
    expect(quakeEnergy(c, q(15, 10, 40))).toBeCloseTo(e / 4, 9);
    expect(quakeEnergy(c, q(30, 20, 40))).toBeCloseTo(e / 2, 9);
  });

  it('the dial and the budget refuse; the naive quake is the dial at its brute end', () => {
    expect(quakeRulesOf(c.def)).toEqual({ peakMax: QUAKE_DEFAULTS.peakMax, hz: [...QUAKE_DEFAULTS.hz], sec: [...QUAKE_DEFAULTS.sec], axisStep: QUAKE_DEFAULTS.axisStep });
    expect(quakeRefusal(c, q(30, 10, 40))).toBeNull();
    expect(quakeRefusal(c, q(81, 10, 40))).toMatch(/over the level's 80%/);
    expect(quakeRefusal(c, q(30, 31, 40))).toMatch(/outside/);
    const budget = quakeEnergy(c, q(30, 10, 40));
    const b = compileLevel(level({ quake: { budget, peakMax: 50, hz: [5, 20], sec: [10, 60] } }));
    expect(quakeRefusal(b, q(30, 10, 40))).toBeNull();
    expect(quakeRefusal(b, q(31, 10, 40))).toMatch(/budget/);
    expect(quakeRefusal(b, q(40, 20, 40))).toBeNull(); // twice the frequency buys sqrt 2 the peak
    expect(naiveQuake(b)).toEqual(q(50, 5, 60, 0));
    const s = new Session(b);
    expect(() => s.fire(q(31, 10, 40), 0)).toThrow(/budget/);
    const { feedback } = s.fire(q(30, 10, 40), 0);
    expect(feedback).toEqual([{ t: 'fired', step: 0, ammo: QUAKE, body: -1, ke: budget }]);
  });
});

describe('quake level grammar', () => {
  it('pinned parts compile pinned bodies, need no support, and keep the hash of levels without them', () => {
    const c = compileLevel(level());
    expect(c.scene.bodies.map((b) => b.pinned === true)).toEqual([false, false, false, false, false, false, false, false, false, true, true, true, false]);
    expect(validateLevel(c)).toEqual([]);
    const floating = compileLevel(level({ parts: [...level().parts, { kind: 'block', at: [6, 3, 6], size: [1, 1, 1], material: 'stone', pinned: true }] }));
    expect(validateLevel(floating).filter((i) => i.code === 'unsupported')).toEqual([]);
    const plain = level({ rack: ['marble'], quake: undefined, objective: { kind: 'crowns' }, heritage: undefined });
    plain.parts = plain.parts.slice(0, 4);
    const before = { ...plain, parts: plain.parts.map((p) => ({ ...p })) };
    expect(compileLevel(plain).hash).toBe(compileLevel(before).hash);
  });

  it('validation names a pinned crown, quake rules without a quake, a quake level with Bounce, and a quake objective with nothing to spare', () => {
    const pinnedCrown = level();
    pinnedCrown.parts[1] = { kind: 'block', at: [-3, 5, 0], size: [1, 1, 1], material: 'plaster', role: 'crown', pinned: true };
    expect(validateLevel(compileLevel(pinnedCrown)).map((i) => i.message)).toContainEqual(expect.stringMatching(/crown and pinned/));
    expect(validateLevel(compileLevel(level({ rack: ['marble'], quake: { peakMax: 40 } }))).map((i) => i.message)).toContainEqual(expect.stringMatching(/quake rules, and its rack holds no quake/));
    expect(validateLevel(compileLevel(level({ physics: { bounce: 0.3 } }))).map((i) => i.message)).toContainEqual(expect.stringMatching(/without Bounce/));
    const noHeritage = level();
    noHeritage.parts[3] = { kind: 'block', at: [3, 2, 0], size: [1, 1, 1], material: 'plaster' };
    expect(validateLevel(compileLevel(noHeritage)).map((i) => i.message)).toContainEqual(expect.stringMatching(/quake objective needs/));
    expect(() => compileLevel(level({ quake: { hz: [20, 10] } }))).toThrow(/above/);
    expect(() => compileLevel(level({ heritage: 'swaying' as 'pose' }))).toThrow(/pose or standing/);
  });

  it('the quake objective: every crown down and no heritage broken', () => {
    const c = compileLevel(level()), red = {} as Reductions;
    expect(objectiveMet(c, { red, crownsTotal: 1, collapse: 0, heritage: 0 }, 'outcome')).toBe(true);
    expect(objectiveMet(c, { red, crownsTotal: 1, collapse: 0, heritage: 1 }, 'outcome')).toBe(false);
    expect(objectiveMet(c, { red, crownsTotal: 0, collapse: 0, heritage: 0 }, 'outcome')).toBe(false);
  });

  it('heritageFallen: dropped or tilted counts, sideways travel does not', () => {
    const c = compileLevel(level()), h = c.frame.unit, home: [number, number, number] = [1, 2, 3], up: [number, number, number, number] = [0, 0, 0, 1];
    expect(heritageFallen(c, [9, 2, -4], up, home)).toBe(false);
    expect(heritageFallen(c, [1, 2 - 0.9 * HERITAGE_MOVE * h, 3], up, home)).toBe(false);
    expect(heritageFallen(c, [1, 2 - 1.1 * HERITAGE_MOVE * h, 3], up, home)).toBe(true);
    const t = (20 * Math.PI) / 360;
    expect(heritageFallen(c, home, [Math.sin(t), 0, 0, Math.cos(t)], home)).toBe(true);
  });
});

describe('quake scoring', () => {
  const facts = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
    met: true, collapse: 0.6, leverage: 40, comboMax: 2, hasCrowns: true, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 2, skylineRatio: 0.5, pulled: 0, quake: true, energy: 300, ...over,
  });

  it('the tally: objective, condemned down and heritage broken; no collapse or leverage line to pay for the protected towers falling', () => {
    expect(outcomeTally(facts())).toEqual([{ label: 'Objective', value: 1000 }, { label: 'Condemned', value: 1000 }]);
    expect(outcomeTally(facts({ met: false, crownsDown: 1, heritageBroken: 1, collapse: 0.9, leverage: 400 }))).toEqual([{ label: 'Condemned', value: 500 }, { label: 'Heritage', value: -500 }]);
  });

  it('stars on energy: lower is better, the objective first, the third star only with the heritage whole', () => {
    const cast = checkStars({ metric: 'energy', t2: 400, t3: 250, best: 209 });
    expect(() => checkStars({ metric: 'energy', t2: 250, t3: 400 })).toThrow(/easier/);
    const star = (f: Partial<OutcomeFacts>) => outcomeScore(facts(f), cast).stars;
    expect([star({ energy: 500 }), star({ energy: 400 }), star({ energy: 250 }), star({ energy: 120 }), star({ met: false, energy: 120 })]).toEqual([1, 2, 3, 3, 0]);
    const broken = outcomeScore(facts({ energy: 200, heritageBroken: 1 }), cast);
    expect([broken.stars, broken.heritageStarsLost]).toEqual([2, 1]);
    expect(outcomeScore(facts({ energy: 200 }), cast).outcome.beatBot).toBe(true);
    // Uncast, a quake level's metric is energy.
    expect(outcomeScore(facts(), undefined).outcome.metric).toBe('energy');
  });

  it('energy fired is what leverage divides by; a session reports the quake it fired', () => {
    const shots = [{ ke: 3, yield: 2, dPE_mJ: 10_000 }, { ke: 5, yield: 0, dPE_mJ: 0 }];
    expect(energyFired(shots)).toBe(10);
    expect(roundLeverage(shots)).toBeCloseTo(1, 9);
    const c = compileLevel(level()), s = new Session(c);
    s.fire(q(30, 10, 40), 0);
    expect(s.outcomeFacts().energy).toBe(0); // nothing closed yet: the fired shot counts once it settles
    expect(s.outcomeFacts().quake).toBe(true);
  });
});

describe('the shipped Aftershock levels', () => {
  const SITE: Record<string, string> = { A1: 'QC-1', A2: 'QC-3', A3: 'QC-2', A4: 'QC-4', A5: 'QC-5' };

  it('are the gated sites exactly, valid, with energy stars cast against their own hash and a budget the brute end is over', () => {
    expect(AFTERSHOCK_LEVELS.map((l) => l.id)).toEqual(Object.keys(SITE));
    for (const l of AFTERSHOCK_LEVELS) {
      const c = compileLevel(l), site = compileLevel(quakeCandidate(SITE[l.id]!));
      expect(validateLevel(c).filter((i) => !i.warning)).toEqual([]);
      // The physics the gate judged: the same bodies, gravity and steps; only the id, name, budget and stars differ.
      expect({ ...c.scene, id: '' }).toEqual({ ...site.scene, id: '' });
      expect(castStars(c)).toBe(l.stars);
      const s = l.stars!;
      expect(s.metric).toBe('energy');
      expect(s.t3).toBeLessThanOrEqual(s.t2);
      expect(s.best!).toBeLessThanOrEqual(s.t3);
      const budget = l.quake!.budget!;
      expect(budget).toBeGreaterThanOrEqual(s.t2);
      expect(quakeRefusal(c, naiveQuake(c))).toMatch(/budget/);
      expect(levelById(l.id)).toBe(l);
    }
  });
});

describe('the shipped levels\' aces', () => {
  it('each ace is the cast\'s best quake: its energy is the stars\' best, inside the budget and the third star', () => {
    for (const l of AFTERSHOCK_LEVELS) {
      const c = compileLevel(l), ace = l.solutions!.ace![0]! as QuakeShot;
      expect(quakeEnergy(c, ace)).toBeCloseTo(l.stars!.best!, 6);
      expect(quakeRefusal(c, ace)).toBeNull();
    }
  });
});
