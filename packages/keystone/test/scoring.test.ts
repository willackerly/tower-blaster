// PT9 and PT16 (docs/game/agent-playtest-1.md, docs/game/scoring.md): one leverage definition read
// by the HUD, the card and the gold badge; tiers named from the level's gold line; totals never
// below 0; no stroke points on an incomplete round; heritage's lost stars; no solo tally in a duel;
// and Bullet Time's par (par plus freezes used, PT8's rule, folded in here). Synthetic body states:
// no engine.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import {
  B2, castStars, compileLevel, CpuObserver, HERITAGE_LOST, D1, DEFAULT_GOLD, duelLevel, type Feedback, floorTotal, freezesUsed, levelGoldLine, L1, L2, L3, L4, L5, type LevelDef, levelScore, levelTier,
  leverage, outcomeScore, type OutcomeFacts, parWithFreezes, refereedScore, roundLeverage, SETTLE_MIN, SETTLE_QUIET, Session, type Shot, type ShotOutcome, tier, tierAt, TIER_LINE,
} from '@tb/keystone';

const def: LevelDef = {
  id: 'S', name: 's', version: 1, world: 0, lot: { min: [-4, -4], max: [4, 4] }, crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'cannonball', 'marble'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [0, 0, 0], size: [1, 3, 1], material: 'plaster', courses: [{ k: 2, role: 'crown' }] },
    { kind: 'block', at: [2, 0, 0], size: [1, 1, 1], material: 'plaster', role: 'heritage' },
  ],
};
const marble: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 100 };
const cannon: Shot = { ...marble, ammo: 'cannonball' };

type Frame = (s: Snapshot) => void;
const still = (count: number): Frame[] => Array.from({ length: count }, () => (s: Snapshot) => { s.awake.fill(0); s.linVel.fill(0); });

/** A session on `d` over synthetic states, with the HUD's leverage read on every observed state. */
function rig(d: LevelDef, opts: { refereed?: boolean } = {}) {
  const c = compileLevel(d), n = c.meta.n, crown = c.meta.crowns[0]!, heritage = c.meta.heritage[0]!;
  const s = emptySnapshot(n + d.rack.length);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  const obs = new CpuObserver(c, s), se = new Session(c, undefined, opts);
  const hud: number[] = [];
  let step = 0;
  const feed = (frames: Frame[]): Feedback[] => frames.flatMap((f) => {
    f(s);
    const fb = se.observe(obs.observe(s, ++step, se.watchIdx));
    hud.push(se.roundLeverageNow());
    return fb;
  });
  const fire = (shot: Shot) => { const at = step + 1; se.fire(shot, at); obs.setBaseline(s, at); step = at; };
  /** A shot fired while one runs (Bullet Time's cut-in, rapid fire): cut on the last observed state. */
  const cutIn = (shot: Shot) => {
    const now = obs.peek(s, step, se.watchIdx), at = step + 1;
    se.fire({ ...shot, after: 1 }, at, n + se.outcomes.length + 1, now);
    obs.setBaseline(s, at);
    step = at;
  };
  // The crown falls below the line over a few states (a release to measure); the heritage block is knocked off its spot.
  const crownFalls: Frame[] = [0.9, 0.6, 0.25].map((y) => (w) => { w.awake[crown] = 1; w.linVel.set([0, -3, 0], 3 * crown); w.pos[3 * crown + 1] = y; });
  const crack: Frame = (w) => { w.pos[3 * heritage] = w.pos[3 * heritage]! + 0.5; };
  return { c, se, hud, feed, fire, cutIn, crownFalls, crack };
}

const settle = still(SETTLE_MIN + SETTLE_QUIET);
const shot = (o: Partial<ShotOutcome>): ShotOutcome => ({ ke: 1000, yield: 0, dPE_mJ: 0, leverage: 0, crownsDown: 0, crownsTotal: 0, heritageNew: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 0, ...o });
const facts = (o: Partial<OutcomeFacts>): OutcomeFacts => ({ met: true, collapse: 0.5, leverage: 1, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0, ...o });

describe('PT9: one leverage', () => {
  it('roundLeverage: one shot is its own leverage; several are released over fired, ke + yield, clamped at 0', () => {
    const a = shot({ ke: 1000, dPE_mJ: 6_000_000 }), b = shot({ ke: 500, yield: 1500, dPE_mJ: 1_000_000 }), c = shot({ ke: 1000, dPE_mJ: -9e6 });
    expect(roundLeverage([a])).toBe(leverage(a.dPE_mJ, a.ke));
    expect(roundLeverage([a, b])).toBeCloseTo(7000 / 3000, 12);
    expect(roundLeverage([c])).toBe(0);
    expect(roundLeverage([])).toBe(0);
    expect(levelScore(def, [a, b], true, 2).leverage).toBe(roundLeverage([a, b]));
  });

  it('the HUD\'s final leverage equals the card\'s: one shot', () => {
    const r = rig(def);
    r.fire(marble);
    const fb = r.feed([...r.crownFalls, ...settle]);
    expect(fb.at(-1)).toMatchObject({ t: 'levelEnd', cleared: true });
    expect(r.se.score!.leverage).toBeGreaterThan(0);
    expect(r.hud.at(-1)).toBe(r.se.score!.leverage);
    // While it ran, the HUD climbed with the release: the same function on the shot so far.
    expect(r.hud[0]).toBeLessThan(r.hud.at(-1)!);
  });

  it('the HUD\'s final leverage equals the card\'s: several shots (a miss, then the clear)', () => {
    const r = rig({ ...def, par: 2 });
    r.fire(marble);
    r.feed(settle);
    expect(r.se.phase).toBe('aiming');
    expect(r.hud.at(-1)).toBe(0);
    r.fire(cannon);
    r.feed([...r.crownFalls, ...settle]);
    expect(r.se.phase).toBe('cleared');
    const card = r.se.score!.leverage;
    expect(r.hud.at(-1)).toBe(card);
    // The round's, not the last shot's: the miss's energy counts against it.
    expect(card).toBeLessThan(r.se.outcomes[1]!.leverage);
    expect(r.se.liveLeverage).toBe(r.se.outcomes[1]!.leverage);
  });

  it('the HUD\'s final leverage equals the card\'s: a frozen cut-in (Bullet Time)', () => {
    const r = rig({ ...def, freeze: 1 });
    r.fire(marble);
    r.feed(r.crownFalls.slice(0, 1));
    r.cutIn(cannon);
    r.feed([...r.crownFalls.slice(1), ...settle]);
    expect(r.se.phase).toBe('cleared');
    expect(r.se.outcomes.map((o) => o.cut ?? false)).toEqual([true, false]);
    expect(r.hud.at(-1)).toBe(r.se.score!.leverage);
    expect(r.se.score!.leverage).toBe(roundLeverage(r.se.outcomes));
  });

  it('an outcome level\'s card (outcomeFacts) reads the same function', () => {
    const out: LevelDef = { ...def, id: 'SO', scoring: 'outcome', par: 3 };
    const r = rig(out);
    r.fire(marble);
    r.feed([...r.crownFalls, ...settle]);
    r.fire(cannon);
    r.feed(settle);
    r.se.bank(1000);
    expect(r.se.score!.leverage).toBe(roundLeverage(r.se.outcomes));
    expect(r.hud.at(-1)).toBe(r.se.score!.leverage);
  });

  it('tiers are named from the level\'s gold line: Clean at it, Elegant at 3x, Keystone at 8x', () => {
    expect([0.7, 0.71, 2.12, 2.13, 5.67, 5.68].map((L) => levelTier(L, L1))).toEqual([0, 1, 1, 2, 2, 3]);
    // L5's line is TIER_LINE: its tiers are the old absolute floors 5, 15, 40, and so is tier().
    expect(L5.lGold).toBe(TIER_LINE);
    expect([4.99, 5, 14.99, 15, 39.9, 40].map((L) => levelTier(L, L5))).toEqual([0, 1, 1, 2, 2, 3]);
    expect([4.99, 5, 14.99, 15, 39.9, 40].map(tier)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(tierAt(1, 1)).toBe(1);
    // A par level without a line uses DEFAULT_GOLD (as the badge does); an outcome level without one has no tiers.
    const { lGold: _g, ...bare } = L1;
    expect(levelGoldLine(bare)).toBe(DEFAULT_GOLD);
    expect(levelGoldLine({ ...bare, scoring: 'outcome' })).toBeNull();
    expect(levelTier(99, { ...bare, scoring: 'outcome' })).toBeNull();
  });

  it('no round earns the gold badge and is called Brute (L1 to L5, any leverage, strokes and heritage)', () => {
    for (const d of [L1, L2, L3, L4, L5]) {
      const line = levelGoldLine(d)!;
      for (const k of [0, 0.5, 0.99, 1, 1.01, 2, 3, 8, 20]) for (let s = 1; s <= d.par + 2; s++) for (const h of [0, 1]) {
        const shots = Array.from({ length: s }, (_, i) => shot({ ke: 1000, dPE_mJ: 1e6 * k * line, heritageNew: i === 0 ? h : 0 }));
        const score = levelScore(d, shots, true, 40);
        if (score.gold) expect(levelTier(score.leverage, d)).toBeGreaterThanOrEqual(1);
        // The converse: Clean or better in par with heritage intact is the badge.
        if (s <= d.par && h === 0 && levelTier(score.leverage, d)! >= 1) expect(score.gold).toBe(true);
      }
    }
  });

  it('a session names its in-flight tiers from the level\'s line: none where an outcome level has no line', () => {
    const lineless: LevelDef = { ...def, id: 'SO', scoring: 'outcome', par: 3 };
    const r = rig(lineless);
    r.fire(marble);
    expect(r.feed([...r.crownFalls, ...settle]).filter((f) => f.t === 'tier')).toEqual([]);
    const p = rig({ ...def, lGold: 1e-6 });
    p.fire(marble);
    const tiers = p.feed([...p.crownFalls, ...settle]).filter((f) => f.t === 'tier') as Extract<Feedback, { t: 'tier' }>[];
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers.at(-1)!.tier).toBe(3);
  });
});

describe('PT16: scores that add up', () => {
  it('totals are the lines\' sum floored at 0, par and outcome', () => {
    // B2's -15,361 shape: heavy heritage over little collapse; L3's -321: heritage over a weak clear.
    const broken = levelScore(def, [shot({ heritageNew: 30 })], false, 2);
    expect(broken.lines.reduce((a, l) => a + l.value, 0)).toBeLessThan(0);
    expect(broken.total).toBe(0);
    const out = outcomeScore(facts({ met: false, collapse: 0.05, heritageBroken: 31 }), undefined);
    expect(out.total).toBe(0);
    expect(out.lines.find((l) => l.label === 'Heritage')!.value).toBe(-15500);
    expect(floorTotal([{ label: 'a', value: 300 }, { label: 'b', value: -100 }])).toBe(200);
    // Any mix: never below 0, and the lines' sum whenever that is not.
    for (let k = 0; k < 200; k++) {
      const shots = Array.from({ length: 1 + (k % 4) }, (_, i) => shot({ dPE_mJ: ((k * 7919 + i * 104729) % 9000) * 1000 - 2e6, heritageNew: (k + i) % 3, crownsDown: (k + i) % 5 }));
      for (const cleared of [true, false]) {
        const sc = levelScore({ ...def, par: 2 }, shots, cleared, 2), sum = sc.lines.reduce((a, l) => a + l.value, 0);
        expect(sc.total).toBe(Math.max(0, sum));
      }
    }
  });

  it('no stroke points on an incomplete round: L4 missed with nothing hit totals 0', () => {
    const miss = levelScore(L4, [shot({ ke: 1000 })], false, 40);
    expect(miss.lines.find((l) => l.label === 'Strokes')!.value).toBe(0);
    expect(miss.total).toBe(0);
    expect(miss.stamp).toBe('INCOMPLETE');
    // A clear still earns them.
    expect(levelScore(L4, [shot({ ke: 1000 })], true, 40).lines.find((l) => l.label === 'Strokes')!.value).toBe(3000);
  });

  it('heritage shows the stars it cost: par one star; outcome one at every tier (PT28)', () => {
    const inPar = levelScore(def, [shot({ dPE_mJ: 1e6, heritageNew: 2 })], true, 2);
    expect([inPar.stars, inPar.heritageStarsLost]).toEqual([2, 1]);
    // Three over par is one star with or without heritage: nothing lost to it, no note.
    const late = levelScore(def, Array.from({ length: 4 }, () => shot({ heritageNew: 1 })), true, 2);
    expect([late.stars, late.heritageStarsLost]).toEqual([1, undefined]);
    expect(levelScore(def, [shot({ dPE_mJ: 1e6 })], true, 2).heritageStarsLost).toBeUndefined();
    const cast = { metric: 'collapse' as const, t2: 0.5, t3: 0.8 };
    expect(outcomeScore(facts({ collapse: 0.9, heritageBroken: 1 }), cast)).toMatchObject({ stars: 2, heritageStarsLost: 1 });
    expect(outcomeScore(facts({ collapse: 0.6, heritageBroken: 1 }), cast)).toMatchObject({ stars: 1, heritageStarsLost: 1 });
    expect(outcomeScore(facts({ collapse: 0.3, heritageBroken: 1 }), cast)).toMatchObject({ stars: 0, heritageStarsLost: 1 });
    expect(outcomeScore(facts({ met: false, heritageBroken: 1 }), cast).heritageStarsLost).toBeUndefined();
    expect(outcomeScore(facts({ collapse: 0.9 }), cast).heritageStarsLost).toBeUndefined();
  });

  it('a refereed round (a duel) ends with no solo tally', () => {
    const r = rig({ ...duelLevel(D1), parts: def.parts, crownLine: 2, lot: def.lot, launcher: def.launcher, rack: ['marble', 'cannonball'] }, { refereed: true });
    r.fire(marble);
    r.feed([...r.crownFalls, ...settle]);
    r.se.bank(1000);
    expect(r.se.score).toEqual(refereedScore(r.se.outcomes));
    expect(r.se.score).toMatchObject({ lines: [], total: 0, stars: 0, stamp: 'DUEL', refereed: true });
    // The same round unrefereed is tallied as an outcome level.
    const solo = rig({ ...duelLevel(D1), parts: def.parts, crownLine: 2, lot: def.lot, launcher: def.launcher, rack: ['marble', 'cannonball'] });
    solo.fire(marble);
    solo.feed([...solo.crownFalls, ...settle]);
    solo.se.bank(1000);
    expect(solo.se.score!.lines.length).toBeGreaterThan(0);
    expect(solo.se.score!.refereed).toBeUndefined();
  });
});

describe('Bullet Time par (PT8): par plus the freezes used', () => {
  const cut = (o: Partial<ShotOutcome> = {}) => shot({ cut: true, ...o });
  it('a cut-in that clears keeps par on a budget level; without a budget a cut is a stroke as before', () => {
    const shots = [cut(), shot({ dPE_mJ: 5e6, crownsDown: 1 })];
    const bt = levelScore({ ...def, freeze: 2 }, shots, true, 2), plain = levelScore(def, shots, true, 2);
    expect([freezesUsed({ ...def, freeze: 2 }, shots), parWithFreezes({ ...def, freeze: 2 }, shots)]).toEqual([1, 2]);
    expect([bt.stamp, bt.stars, bt.freezes]).toEqual(['PAR', 3, { used: 1, total: 2 }]);
    expect([plain.stamp, plain.stars, plain.freezes]).toEqual(['BOGEY', 2, undefined]);
    expect(freezesUsed(def, shots)).toBe(0);
    expect(bt.lines.find((l) => l.label === 'Strokes')!.value).toBe(3000);
  });
});

describe('PT28: heritage matters on the big levels', () => {
  // Agent playtest round 2 (docs/game/agent-playtest-2.md, B2-novice-desktop-07-result): crowns down, 18% of
  // the town down, 25 of the cathedral's 32 cubes broken (-12,500, total floored to 0), and yet a gold
  // "18% DOWN" stamp with one star. B2's own cast thresholds (stars.json, score metric: T2 770, T3 3,000).
  const cast = castStars(compileLevel(B2))!;
  const b2 = (o: Partial<OutcomeFacts>): OutcomeFacts => facts({ collapse: 0.18, leverage: 2, hasCrowns: true, comboMax: 4, crownsDown: 4, ...o });
  it('B2 has its cast stars, on the score metric', () => {
    expect(cast).toMatchObject({ metric: 'score', t2: 770, t3: 3000 });
  });
  it('the novice round (crowns down, 25 heritage broken) gets no star and no gold stamp', () => {
    const s = outcomeScore(b2({ heritageBroken: 25 }), cast, cast.metric);
    expect(s.total).toBe(0);
    expect(s).toMatchObject({ stars: 0, stamp: HERITAGE_LOST, heritageStarsLost: 1 });
    // The same round with the cathedral whole keeps its star and its gold stamp.
    const whole = outcomeScore(b2({ heritageBroken: 0 }), cast, cast.metric);
    expect([whole.stars, whole.stamp]).toEqual([2, '18% DOWN']);
  });
  it('one cracked cube costs a star at every tier and takes the gold stamp', () => {
    for (const collapse of [0.18, 0.5, 0.9]) {
      const whole = outcomeScore(b2({ collapse, rackLeft: 1 }), cast, cast.metric);
      const cracked = outcomeScore(b2({ collapse, rackLeft: 1, heritageBroken: 1 }), cast, cast.metric);
      expect(whole.stars).toBeGreaterThan(0);
      expect(cracked.stars).toBe(whole.stars - 1);
      expect(cracked.stamp).toBe(HERITAGE_LOST);
      expect(whole.stamp).not.toBe(HERITAGE_LOST);
    }
  });
  it('heritage never decides a round that missed its objective: INCOMPLETE stays', () => {
    expect(outcomeScore(b2({ met: false, heritageBroken: 3 }), cast, cast.metric)).toMatchObject({ stars: 0, stamp: 'INCOMPLETE' });
  });
});
