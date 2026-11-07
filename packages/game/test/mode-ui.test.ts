// Each mode's own HUD and result card (mode-ui.ts; agent playtest round 2, PT23 and PT27). Pure functions, no browser.
import { describe, expect, it } from 'vitest';
import { AFTERSHOCK_LEVELS, compileLevel, FUSE_LEVELS, L1, L3, type LevelDef, levelScore, type LevelScore, outcomeScore, type OutcomeFacts, type RackItem, RUBE_LEVELS, SERIES, type ShotOutcome } from '@tb/keystone';
import { openerFor } from '../src/door.ts';
import { GO_BUTTON, hudHtml, type HudState, OPENER_BUTTON, rackChips, resultHtml, RUN_BUTTON, slotAction, tallyHtml, TOUCH_HELP, TOUCH_LOOK } from '../src/hud.ts';
import { type CardFacts, cardModel, failReason, heritageFails, hudProfile, playMode } from '../src/mode-ui.ts';
import { helpHtml } from '../src/ui.ts';

const ALL = SERIES.flat();
const [A1, F1, RL1] = [AFTERSHOCK_LEVELS[0]!, FUSE_LEVELS[0]!, RUBE_LEVELS[0]!];
const shot = (o: Partial<ShotOutcome>): ShotOutcome => ({ ke: 1000, yield: 0, dPE_mJ: 0, leverage: 0, crownsDown: 0, crownsTotal: 0, heritageNew: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 0, ...o });
const facts = (o: Partial<CardFacts> = {}): CardFacts => ({ crownsDown: 0, crownsTotal: 2, heritageBroken: 0, heritageTotal: 1, collapse: 0.2, ...o });
const outcome = (def: LevelDef, o: Partial<OutcomeFacts>) => outcomeScore({ met: false, collapse: 0.2, leverage: 3, comboMax: 0, hasCrowns: true, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0, ...o }, undefined);

/** The HUD a level shows under its mode's profile, at `strokes`, with `left` of its rack unfired (none: spent, nothing selected). */
function hud(def: LevelDef, strokes: number, left: readonly RackItem[] = def.rack, opts: Partial<HudState> = {}): string {
  const sel = left.length ? left[0]! : null;
  return hudHtml({
    level: def, strokes, crownsDown: 0, crownsTotal: 2, heritageBroken: 0, heritageTotal: 1, chips: rackChips(def.rack, left, sel), power: 100, launch: 4,
    leverage: { round: 2, shot: 1 }, phase: strokes ? 'running' : 'aiming', reachable: null, profile: hudProfile(def), ...opts,
  });
}

describe('which mode a level is', () => {
  it('every series level has a mode: Fuse & Fold, Aftershock and Rube Lab their own, the rest aimed shots', () => {
    for (const d of ALL) {
      const want = d.rube ? 'rube' : d.objective.kind === 'quake' ? 'quake' : d.objective.kind === 'fold' ? 'fuse' : 'shot';
      expect(playMode(d), d.id).toBe(want);
    }
    expect(FUSE_LEVELS.map(playMode)).toEqual(FUSE_LEVELS.map(() => 'fuse'));
    expect(AFTERSHOCK_LEVELS.map(playMode)).toEqual(AFTERSHOCK_LEVELS.map(() => 'quake'));
    expect(RUBE_LEVELS.map(playMode)).toEqual(RUBE_LEVELS.map(() => 'rube'));
  });
  it('the projectile modes keep every row; the new modes have one start verb each and no projectile rows', () => {
    expect(hudProfile(L1)).toEqual({ mode: 'shot', aim: true, chips: true, fire: true, leverage: true, opener: true, start: null });
    for (const d of [F1, A1, RL1]) expect([d.id, hudProfile(d).aim, hudProfile(d).chips, hudProfile(d).fire, typeof hudProfile(d).start]).toEqual([d.id, false, false, false, 'string']);
  });
});

describe("each new mode's HUD (PT23)", () => {
  it('no Power or Height row, no rack chip and no fire hint in Fuse & Fold, Aftershock and Rube Lab, before, during and after the shot', () => {
    for (const d of [...FUSE_LEVELS, ...AFTERSHOCK_LEVELS, ...RUBE_LEVELS]) {
      for (const [strokes, left] of [[0, d.rack], [1, []]] as const) {
        const html = hud(d, strokes, left);
        expect(html, `${d.id} at ${strokes}`).not.toMatch(/Power|Height|data-act="ammo"|data-act="power"|data-act="launch"/);
        expect(html, d.id).not.toMatch(/lift: fire|click: fire/);
      }
      expect(hud(d, 0)).toContain(`<div class="tch-hint">${TOUCH_LOOK}</div>`);
    }
    // Under keystone.modeui=0 a spent quake rack fell back to the Power and Height rows (the playtest's A1 frames).
    expect(hud(A1, 1, [], { profile: undefined })).toMatch(/Power/);
    // An aimed level keeps its rows and its fire hint.
    expect(hud(L1, 0)).toMatch(/Power[\s\S]*Height/);
    expect(hud(L1, 0)).toContain(TOUCH_HELP);
  });
  it("Aftershock's HUD offers no opener: the quake's Start is its one start (and the opener was its ace)", () => {
    const s = { level: A1, opener: true, profile: hudProfile(A1) };
    expect(slotAction(s)).toBeNull();
    expect(hud(A1, 0, A1.rack, { opener: true })).not.toContain(OPENER_BUTTON);
    expect(slotAction({ ...s, profile: undefined })).toBe('opener');
    expect(slotAction({ level: L1, opener: true, profile: hudProfile(L1) })).toBe('opener');
  });
  it('no level hands over its whole answer as the opener: never the only shot of a one-shot ace', () => {
    const one = (d: LevelDef) => (d.solutions?.ace?.length === 1 ? JSON.stringify(d.solutions.ace[0]) : null);
    const checked = ALL.filter((d) => one(d) !== null);
    expect(checked.map((d) => d.id)).toEqual(expect.arrayContaining(AFTERSHOCK_LEVELS.map((d) => d.id)));
    for (const d of ALL) {
      const op = openerFor(d, 0, '1', false);
      if (one(d) !== null) expect(op === null ? null : JSON.stringify(op), d.id).not.toBe(one(d));
    }
    // A multi-shot ace still opens with its first shot.
    const multi = ALL.find((d) => (d.solutions?.ace?.length ?? 0) > 1 && !d.solutions?.opener);
    if (multi) expect(openerFor(multi, 0, '1', false)).toEqual(multi.solutions!.ace![0]);
  });
  it('Rube Lab: one Run (the HUD says Run, and offers it only when not building), and the parts par the card reads', () => {
    expect(hud(RL1, 0, RL1.rack, { opener: true })).toContain(RUN_BUTTON);
    expect(hud(RL1, 0, RL1.rack, { opener: true, profile: undefined })).toContain(GO_BUTTON);
    const html = hud(RL1, 0);
    expect(html).toContain(`Parts par ${RL1.build!.par}`);
    expect(html).not.toMatch(/Par 1|Stroke|Leverage/);
    expect(html).toMatch(/<span>Bell<\/span><span class="fit"><span class="crowns">not rung/);
    expect(hud(RL1, 1, [], { crownsDown: 1, crownsTotal: 1 })).toMatch(/class="crowns ok">rung ✓/);
  });
  it('the help line hides "click: fire" in a mode with nothing to fire, and the touch line has a wording of its own', () => {
    const h = helpHtml(false), all = helpHtml(true);
    expect(h).toContain('<span class="h-fire">click: fire · </span>');
    expect(all).toContain('<span class="h-fire">hover: aim · click: fire · </span>');
    expect(h).toContain(`<span class="h-fire">${TOUCH_HELP}</span><span class="h-look">${TOUCH_LOOK}</span>`);
  });
  it('the HUD keeps one size through a new mode\'s round: the same rows before the shot and after it', () => {
    const rows = (h: string) => [...h.matchAll(/<div class="row[^"]*"/g)].length;
    for (const d of [F1, A1, RL1]) expect(rows(hud(d, 1, [])), d.id).toBe(rows(hud(d, 0, d.rack, { quake: undefined })));
  });
});

describe("each mode's result card (PT27)", () => {
  const card = (def: LevelDef, score: LevelScore, f: CardFacts) => resultHtml(def, score, 1, false, false, '', false, { facts: f });
  it('Rube Lab: the bell and the parts against par, no strokes, leverage, Brute, combo or total; HUD and card par agree', () => {
    for (const d of RUBE_LEVELS) {
      const par = d.build!.par!;
      const won = levelScore(d, [shot({ dPE_mJ: 1e9, leverage: 0.4 })], true, 40, par);
      const html = card(d, won, facts({ crownsDown: 1, crownsTotal: 1 }));
      expect(html, d.id).not.toMatch(/Leverage|leverage|Brute|Strokes|Combo|Total|Gold/);
      expect(html).toMatch(/<span>Bell<\/span><span class="ok">rung ✓/);
      expect(html).toContain(`<span>Parts</span><span class="">${par} / par ${par}</span>`);
      expect(html).toContain(`<div class="sub">parts ${par} / par ${par}</div>`);
      // The HUD names the same par.
      expect(hud(d, 0)).toContain(`Parts par ${par}`);
      const lost = card(d, levelScore(d, [shot({})], false, 40, par), facts({ crownsTotal: 1 }));
      expect(lost).toMatch(/class="stamp s-notrung"[^>]*>NOT RUNG/);
      expect(lost).toContain('<div class="reason bad">The bell did not ring: change the build and Run again</div>');
    }
  });
  it('Aftershock: stamped on the condemned and the heritage, not on how much came down; no leverage', () => {
    const won = outcome(A1, { met: true, collapse: 0.09, quake: true, crownsDown: 2, energy: 151 });
    expect(won.stamp).toBe('9% DOWN');
    const html = card(A1, won, facts({ crownsDown: 2, energy: 151, collapse: 0.09 }));
    expect(html).toMatch(/>2\/2 CONDEMNED · HERITAGE SAFE</);
    expect(html).not.toMatch(/% DOWN|% down|Leverage|leverage|Brute/);
    expect(html).toContain('<div class="sub">1 quake · energy 151 J</div>');
    expect(tallyHtml(A1, won, null, { facts: facts({ crownsDown: 2 }) })).toContain('2/2 CONDEMNED · HERITAGE SAFE');
    // A quake that broke the heritage: HERITAGE LOST in red, and why.
    const broke = outcome(A1, { quake: true, crownsDown: 2, heritageBroken: 1 });
    const bad = card(A1, broke, facts({ crownsDown: 2, heritageBroken: 1 }));
    expect(bad).toMatch(/class="stamp s-heritagelost"[^>]*>HERITAGE LOST/);
    expect(bad).toContain('1 heritage block broken: the objective spares them all');
    // One that left a condemned tower up says so and what to try.
    expect(card(A1, outcome(A1, { quake: true, crownsDown: 1 }), facts({ crownsDown: 1 }))).toContain('1 of 2 condemned towers still standing: try a stronger or longer quake, or another axis');
  });
  it('Fuse & Fold: folded, the spill and a reason in the fold\'s own measure', () => {
    const o = F1.objective as { kind: 'fold'; min: number; spillMax: number };
    const short = outcome(F1, { collapse: 0.24, spill: 0, leverage: 12.4 });
    const html = card(F1, short, facts({ collapse: 0.24, spill: 0 }));
    expect(html).toMatch(/1 shot · 24% folded · leverage ×12\.4[^<]*· spill 0%/);
    expect(html).toContain(`24% folded, ${Math.floor(100 * o.min)}% needed`);
    expect(html).toMatch(/>INCOMPLETE</);
    const spilt = card(F1, outcome(F1, { collapse: 0.9, spill: 0.3 }), facts({ collapse: 0.9, spill: 0.3 }));
    expect(spilt).toContain(`30% spilled out of the lot, at most ${Math.floor(100 * o.spillMax)}% allowed`);
  });
  it('every failed card on every series level says why, in its objective\'s measure', () => {
    for (const d of ALL) {
      const c = compileLevel(d);
      const score: LevelScore = { lines: [], total: 0, stars: 0, stamp: 'INCOMPLETE', leverage: 0 };
      const f = facts({ crownsTotal: c.meta.crowns.length, heritageTotal: c.meta.heritage.length });
      const r = cardModel(d, score, f, { sub: '', stamp: score.stamp }).reason;
      expect(r, d.id).toBeTruthy();
      expect(card(d, score, f), d.id).toContain('<div class="reason bad">');
    }
  });
  it('HERITAGE LOST only where a broken heritage fails the objective; elsewhere heritage costs stars, as before', () => {
    expect(new Set(ALL.filter((d) => heritageFails(d.objective)).map(playMode))).toEqual(new Set(['quake', 'fuse']));
    // L3: heritage cracked on a failed par round is not why it failed.
    const failed = levelScore(L3, [shot({ heritageNew: 1 })], false, 40);
    const html = card(L3, failed, facts({ crownsDown: 1, crownsTotal: 3, heritageBroken: 1 }));
    expect(html).not.toContain('HERITAGE LOST');
    expect(html).toContain('2 of 3 crowns still standing');
    expect(failReason(L3, failed, facts({ crownsDown: 3, crownsTotal: 3 }))).toBe('0 of 3 crowns still standing: bring them all down');
  });
  it('a round with a star has no reason line; keystone.modeui=0 and a card without facts are the card as before', () => {
    const won = levelScore(L1, [shot({ dPE_mJ: 1e9, crownsDown: 4, crownsTotal: 4 })], true, 40);
    expect(card(L1, won, facts())).not.toContain('class="reason');
    const rl = levelScore(RL1, [shot({ dPE_mJ: 1e9 })], true, 40, 2);
    const old = resultHtml(RL1, rl, 1, false);
    expect(resultHtml(RL1, rl, 1, false, false, '', false, { facts: facts(), modeUi: false })).toBe(old);
    expect(old).toMatch(/Strokes[\s\S]*Total/);
  });
});
