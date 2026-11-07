import { describe, expect, it } from 'vitest';
import { B1, B2, compileLevel, levelGoldLine, L1, L2, L3, L4, L5, levelScore, outcomeScore, RL1, type ShotOutcome, U3, W3, W5 } from '@tb/keystone';
import { HOW_TO_PLAY } from '../src/door.ts';
import { GAME_HELP, GAME_KEYS, HELP_BUDGET, helpHtml, TOUCH_HELP } from '../src/ui.ts';
import { CUT_HINT, PULL_HINT, BANK_BUTTON, BANK_QUIET, SKIP_BUTTON, esc, freezeButton, POWER_STEP, fmtLeverage, fmtPoints, goldHtml, hudHtml, keepRow, LEVERAGE_MEANS, leverageRow, meterHtml, meterTicks, nextSelection, objectiveText, rackChips, resultHtml, starsText, slotAction, tallyHtml, touchActs } from '../src/hud.ts';

describe('rack', () => {
  it('groups by kind in first-seen order with counts and keys', () => {
    expect(rackChips(['cannonball', 'cannonball', 'marble', 'marble'], ['cannonball', 'marble', 'marble'], 'marble')).toEqual([
      { ammo: 'cannonball', key: '1', total: 2, left: 1, selected: false },
      { ammo: 'marble', key: '2', total: 2, left: 2, selected: true },
    ]);
  });
  it('keeps the selection while ammo is left, else moves to the first kind left', () => {
    const rack = ['marble', 'marble', 'cannonball'] as const;
    expect(nextSelection(rack, ['marble', 'cannonball'], 'marble')).toBe('marble');
    expect(nextSelection(rack, ['cannonball'], 'marble')).toBe('cannonball');
    expect(nextSelection(rack, [], 'marble')).toBeNull();
    expect(nextSelection(rack, rack, null)).toBe('marble');
  });
});

describe('formatting', () => {
  it('leverage, stars, points and escaping', () => {
    expect([0.123, 4.5, 12.34, 150.2].map(fmtLeverage)).toEqual(['×0.12', '×4.50', '×12.3', '×150']);
    expect([0, 2, 3].map(starsText)).toEqual(['☆☆☆', '★★☆', '★★★']);
    expect(fmtPoints(-1000)).toBe('−1,000');
    expect(fmtPoints(12345)).toBe('12,345');
    expect(esc('<a href="x">&</a>')).toBe('&#60;a href=&#34;x&#34;&#62;&#38;&#60;/a&#62;');
  });
  it('the HUD hides the power bar for an anvil and flags an unreachable aim', () => {
    const base = { level: L2, strokes: 0, crownsDown: 1, crownsTotal: 6, heritageBroken: 0, heritageTotal: 36, power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null };
    const marble = hudHtml({ ...base, chips: rackChips(L2.rack, L2.rack, 'marble') });
    expect(marble).toMatch(/L2 · Lintel/);
    expect(marble).toMatch(/1 \/ 6/);
    expect(marble).toMatch(/intact/);
    expect(marble).toMatch(/width:60%/);
    expect(hudHtml({ ...base, chips: [{ ammo: 'drop', key: '1', left: 1, total: 1, selected: true }] })).not.toMatch(/Power/);
    expect(hudHtml({ ...base, chips: [], reachable: false })).toMatch(/Out of reach/);
  });
  it('chips are tap buttons carrying their key, and the power bar has minus and plus buttons for touch', () => {
    const base = { level: L2, strokes: 0, crownsDown: 0, crownsTotal: 6, heritageBroken: 0, heritageTotal: 36, power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null };
    const html = hudHtml({ ...base, chips: rackChips(L2.rack, L2.rack, 'marble') });
    const chips = [...html.matchAll(/<button class="chip([^"]*)" data-act="ammo" data-arg="(\d)">/g)].map((m) => [m[2], m[1]]);
    expect(chips).toEqual([['1', ' on'], ['2', '']]);
    expect(html).toContain(`data-act="power" data-arg="-${POWER_STEP}"`);
    expect(html).toContain(`data-act="power" data-arg="${POWER_STEP}"`);
    // Shown only on a touch screen (GAME_CSS's .kg-tch); the keys stay for a keyboard.
    expect(html).toMatch(/class="pw kg-tch"/);
    expect(html).toMatch(/Power <kbd>Q<\/kbd><kbd>E<\/kbd>/);
    expect(hudHtml({ ...base, chips: rackChips(['drop'], ['drop'], 'drop') })).not.toContain('data-act="power"');
    // The Height row (keys W and S, launcher buttons on touch): for a launched item, never for an anvil or a pull.
    const tall = hudHtml({ ...base, launch: 6, chips: rackChips(L2.rack, L2.rack, 'marble') });
    expect(tall).toMatch(/Height <kbd>W<\/kbd><kbd>S<\/kbd>/);
    expect(tall).toContain('<b class="launch">6.0 m</b>');
    expect(tall).toContain('data-act="launch" data-arg="-1"');
    expect(tall).toContain('data-act="launch" data-arg="1"');
    expect(html).not.toContain('data-act="launch"');
    expect(hudHtml({ ...base, launch: 6, chips: rackChips(['drop'], ['drop'], 'drop') })).not.toContain('data-act="launch"');
    expect(hudHtml({ ...base, launch: 6, chips: rackChips(U3.rack, U3.rack, 'pull') })).not.toContain('data-act="launch"');
    // A plunger aims at nothing: neither row.
    const plunger = hudHtml({ ...base, launch: 6, chips: rackChips(['plunger'], ['plunger'], 'plunger') });
    expect(plunger).not.toMatch(/Power|Height/);
    const opener = hudHtml({ ...base, chips: [], opener: true });
    expect(opener).toMatch(/<span class="kg-desk">or aim and click<\/span><span class="kg-tch">or drag and lift<\/span>/);
  });
  it('a hold level (Undercut Hollow) shows the share pulled and asks to keep the crown up', () => {
    const base = { level: U3, strokes: 2, crownsDown: 0, crownsTotal: 1, heritageBroken: 0, heritageTotal: 0, power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null, chips: rackChips(U3.rack, U3.rack.slice(2), 'pull') };
    const html = hudHtml({ ...base, collapse: 0.01, pulled: 0.0655 });
    expect(html).toMatch(/Pulled <b class="down">6%<\/b>/);
    expect(html).not.toMatch(/Down </);
    expect(html).toMatch(/keep the crown up/);
  });
  it('a pull chip is labelled Pull, has no power bar, and a refused pull says why instead of out of reach', () => {
    const base = { level: L2, strokes: 0, crownsDown: 0, crownsTotal: 6, heritageBroken: 0, heritageTotal: 36, power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null };
    const chips = rackChips(['pull', 'pull', 'marble'], ['pull', 'marble'], 'pull');
    const html = hudHtml({ ...base, chips });
    expect(html).toMatch(/Pull <b>1<\/b>\/2/);
    expect(html).not.toMatch(/Power/);
    const refused = hudHtml({ ...base, chips, reachable: false, pullRefused: true });
    expect(refused).toMatch(/Crowns, heritage and fixed beams stay/);
    expect(refused).not.toMatch(/Out of reach/);
    // Hovered only: a neutral hint. Refused on a click or tap: red.
    expect(refused).toMatch(/<div class="hint small pull-hint">/);
    expect(refused).not.toMatch(/class="bad[^"]*pull-hint/);
    expect(hudHtml({ ...base, chips, reachable: false, pullRefused: 'tapped' })).toMatch(/<div class="bad small pull-hint">/);
  });
  it('a hold level (keep the crown up) says whether its crown stands, with no crown counter', () => {
    const base = { level: U3, strokes: 1, crownsDown: 0, crownsTotal: 1, heritageBroken: 0, heritageTotal: 0, power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null, chips: rackChips(U3.rack, U3.rack, 'pull') };
    expect(U3.objective.kind).toBe('hold');
    const up = hudHtml(base);
    expect(up).toMatch(/<span>Crown<\/span><span class="keep ok">standing ✓<\/span>/);
    expect(up).not.toMatch(/\d+ \/ 1/);
    expect(up).not.toMatch(/class="crowns"/);
    expect(hudHtml({ ...base, crownsDown: 1 })).toMatch(/class="keep bad">fallen</);
    expect(keepRow(1, 3)).toMatch(/1 of 3 fallen/);
    expect(keepRow(0, 2)).toMatch(/all standing/);
    expect(keepRow(0, 0)).toBe('');
    // A crowns level keeps its counter.
    expect(hudHtml({ ...base, level: L2, crownsTotal: 6 })).toMatch(/class="crowns">0 \/ 6</);
  });
  it('the result card lists every score line in order, then the total, stamp and stars', () => {
    const shot = { ke: 1000, yield: 0, dPE_mJ: 2_000_000, leverage: 2, crownsDown: 4, crownsTotal: 4, heritageNew: 0, displaced: 30, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 100 };
    const score = levelScore(L1, [shot], true, 40);
    const html = resultHtml(L1, score, 1, true);
    const labels = [...html.matchAll(/<div class="line[^"]*"[^>]*><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual([...score.lines.map((l) => l.label), 'Total']);
    expect(html).toMatch(/>PAR</);
    expect(html).toContain(starsText(score.stars));
    expect(html).toMatch(/data-act="next"/);
    expect(resultHtml(L1, score, 1, false)).not.toMatch(/data-act="next"/);
    // ×2.00 on L1 (gold line ×0.71): Clean, from the line up to 3x it (levelTier).
    expect(html).toContain('leverage ×2.00 (Clean)');
  });
  it('a par level\'s card shows the gold-leverage badge earned, or once cleared the line to reach; outcome levels and misses show none', () => {
    const shot = (dPE_mJ: number) => ({ ke: 1000, yield: 0, dPE_mJ, leverage: 0, crownsDown: 4, crownsTotal: 4, heritageNew: 0, displaced: 30, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 100 });
    const gold = levelScore(L1, [shot(1e6 * L1.lGold!)], true, 40), short = levelScore(L1, [shot(1e6 * L1.lGold! / 2)], true, 40);
    expect([gold.stars, gold.gold, short.stars, short.gold]).toEqual([3, true, 3, false]); // one shot is three stars either way
    expect(goldHtml(L1, gold)).toMatch(/class="gold got".*Gold leverage \(×0\.71 or more\)/);
    expect(goldHtml(L1, short)).toMatch(/class="gold".*Gold leverage at ×0\.71/);
    expect(resultHtml(L1, short, 1, true)).toContain('Gold leverage at');
    expect(goldHtml(L1, levelScore(L1, [shot(0)], false, 40))).toBe('');
    expect(goldHtml(B1, { lines: [], total: 0, stars: 3, stamp: 'X', leverage: 99 })).toBe('');
  });
  it('before the score, the card tallies: name, strokes and par, and the actions, no score lines or stamp', () => {
    const html = resultHtml(L1, null, 1, true);
    expect(html).toContain(L1.name);
    expect(html).toMatch(/1 stroke · par 1/);
    expect(html).toMatch(/tallying/);
    expect(html).toMatch(/data-act="retry"/);
    expect(html).toMatch(/data-act="next"/);
    expect(html).not.toMatch(/class="stamp|Total/);
  });
  it('an outcome level: shots, how much is down, the objective with a check once met, and Bank while possible', () => {
    const def = { ...L2, scoring: 'outcome' as const, objective: { kind: 'collapse' as const, min: 0.4 } };
    const base = { level: def, strokes: 1, crownsDown: 0, crownsTotal: 0, heritageBroken: 0, heritageTotal: 0, power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null, chips: [] };
    const html = hudHtml({ ...base, collapse: 0.374, met: false, canBank: true });
    expect(html).toMatch(/Shot 1/);
    expect(html).toMatch(/37%/);
    expect(html).toMatch(/bring 40% down</);
    // Before the objective is met, Bank is the quiet outline (PT18: banking then ends the level with no star); once met, the primary.
    expect(html).toContain(BANK_QUIET);
    expect(html).not.toContain(BANK_BUTTON);
    expect(hudHtml({ ...base, collapse: 0.5, met: true, canBank: true })).toContain(BANK_BUTTON);
    expect(BANK_QUIET).toMatch(/class="bank quiet"/);
    expect(html).not.toMatch(/Par|Crowns/);
    expect(hudHtml({ ...base, collapse: 0.5, met: true, canBank: false })).toMatch(/bring 40% down ✓/);
    expect(hudHtml({ ...base, collapse: 0.5, met: true, canBank: false })).not.toContain('data-act="bank"');
    // Par levels never show Bank.
    expect(hudHtml({ ...base, level: L2, canBank: true })).not.toContain('data-act="bank"');
    expect(objectiveText({ kind: 'crowns' })).toBe('fell every crown');
    expect(objectiveText({ kind: 'skyline', maxH: 3 })).toBe('skyline under 3 h');
  });
  it('Skip (PT6): the button while a shot can be skipped, a note while it skips, nothing otherwise, on any level', () => {
    const base = { level: L2, strokes: 1, crownsDown: 0, crownsTotal: 2, heritageBroken: 0, heritageTotal: 0, power: 60, leverage: { round: 0, shot: 0 }, phase: 'running', reachable: null, chips: [] };
    expect(hudHtml({ ...base, canSkip: true })).toContain(SKIP_BUTTON);
    expect(hudHtml({ ...base, canSkip: false, skipping: true })).toMatch(/skipping to the settle/);
    expect(hudHtml({ ...base, canSkip: false, skipping: true })).not.toContain('data-act="skip"');
    expect(hudHtml({ ...base, phase: 'aiming' })).not.toMatch(/data-act="skip"|skipping/);
  });
  it('Bullet Time: freezes left of the level\'s, Freeze while a shot can be frozen, Resume and FROZEN while it is', () => {
    const def = { ...L1, freeze: 2 };
    const base = { level: def, strokes: 1, crownsDown: 0, crownsTotal: 4, heritageBroken: 0, heritageTotal: 0, power: 60, leverage: { round: 0, shot: 0 }, phase: 'running', reachable: null, chips: [], pace: '×0.8' };
    const can = hudHtml({ ...base, freezes: { left: 2, total: 2, frozen: false, can: true } });
    expect(can).toMatch(/Freezes<\/span><span class="">2 \/ 2/);
    expect(can).toContain(freezeButton(false));
    expect(can).toMatch(/<kbd>T<\/kbd> Freeze/);
    expect(can).toMatch(/×0\.8/);
    const frozen = hudHtml({ ...base, freezes: { left: 2, total: 2, frozen: true, can: false } });
    expect(frozen).toContain(freezeButton(true));
    expect(frozen).toMatch(/<kbd>T<\/kbd> Resume/);
    expect(frozen).toMatch(/>FROZEN</);
    expect(frozen).not.toMatch(/×0\.8/); // the world stands still: no slow-motion tag
    const spent = hudHtml({ ...base, freezes: { left: 0, total: 2, frozen: false, can: false } });
    expect(spent).toMatch(/class="spent">0 \/ 2/);
    expect(spent).not.toContain('data-act="freeze"');
    // A level without a budget shows no freezes at all.
    expect(hudHtml({ ...base, level: L1 })).not.toMatch(/Freezes|data-act="freeze"/);
  });
  it('an outcome result card: shots without par, how much came down, and the outcome stamp', () => {
    const def = { ...L1, scoring: 'outcome' as const };
    const score = outcomeScore({ met: true, collapse: 0.62, leverage: 1, comboMax: 4, hasCrowns: true, rackLeft: 3, heritageBroken: 0, outOfLot: 0, crownsDown: 4, skylineRatio: 0.3, pulled: 0 }, undefined);
    const html = resultHtml(def, score, 1, false);
    expect(html).toMatch(/1 shot · 62% down · leverage/);
    expect(html).not.toMatch(/par/);
    expect(html).toMatch(/>62% DOWN</);
    expect(html).toMatch(/Rack left/);
  });
});

describe('playtest polish (U5, U6)', () => {
  const b1 = compileLevel(B1);
  const base = { level: B1, crownsDown: 0, crownsTotal: 0, heritageBroken: 0, heritageTotal: 0, power: 100, leverage: { round: 2.5, shot: 2.5 }, phase: 'aiming', reachable: null, chips: rackChips(B1.rack, B1.rack, 'w-bomb'), collapse: 0.55 };
  it('the Down bar ticks every star threshold in collapse: B1 has the objective and its cast T2 and T3', () => {
    expect(meterTicks(b1)).toEqual([{ at: B1.objective.kind === 'collapse' ? B1.objective.min : NaN, stars: 1 }, { at: B1.stars!.t2, stars: 2 }, { at: B1.stars!.t3, stars: 3 }]);
    // A custom run has no cast stars (castStars), so only the objective's tick; a star by points (B2) or a par level has none.
    expect(meterTicks(compileLevel({ ...B1, custom: true })).map((t) => t.stars)).toEqual([1]);
    expect(meterTicks(compileLevel(B2))).toEqual([]);
    expect(meterTicks(compileLevel(L1))).toEqual([]);
  });
  it('the bar fills to D and lights the ticks it has reached; no ticks, no bar', () => {
    const html = hudHtml({ ...base, strokes: 1, ticks: meterTicks(b1) });
    expect(html).toMatch(/class="meter"/);
    expect(html).toMatch(/<i style="width:55\.0%">/);
    expect([...html.matchAll(/class="tick( obj)?( got)?"/g)].map((m) => [Boolean(m[1]), Boolean(m[2])])).toEqual([[true, true], [false, false], [false, false]]);
    expect([...html.matchAll(/<b>(★+)<\/b>/g)].map((m) => m[1])).toEqual(['★', '★★', '★★★']);
    expect(meterHtml(1.7, meterTicks(b1), 'down')).toMatch(/width:100\.0%/);
    expect(hudHtml({ ...base, strokes: 1, ticks: [] })).not.toMatch(/class="meter"/);
    expect(hudHtml({ ...base, strokes: 1 })).toMatch(/Down <b class="down">55%<\/b>/);
  });
  it('Leverage shows only once a shot is in; before, its row keeps its place hidden (lev pre)', () => {
    expect(hudHtml({ ...base, strokes: 0 })).toMatch(/class="row lev pre" title="[^"]*"><span>Leverage<\/span><span>×0\.00/);
    expect(hudHtml({ ...base, strokes: 1 })).toMatch(/class="row lev" title="[^"]*"><span>Leverage<\/span><span>×2\.50/);
  });
  it('touch screens get Undo and Restart icons, disabled until a shot is in', () => {
    expect(hudHtml({ ...base, strokes: 0 })).toContain(touchActs(0));
    expect(touchActs(0)).toMatch(/disabled.*disabled/);
    const html = hudHtml({ ...base, strokes: 1 });
    expect(html).toContain(touchActs(1));
    expect(touchActs(1)).not.toMatch(/disabled/);
    expect([...touchActs(1).matchAll(/<button data-act="(\w+)" class="ico kg-tch" title="([^"]+)" aria-label="\2"/g)].map((m) => [m[1], m[2]])).toEqual([['undo', 'Undo shot'], ['restart', 'Restart']]);
  });
  it('the result card offers Undo shot (key U) after a shot, before Retry', () => {
    const score = levelScore(L1, [{ ke: 1000, yield: 0, dPE_mJ: 2_000_000, leverage: 2, crownsDown: 4, crownsTotal: 4, heritageNew: 0, displaced: 30, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 100 }], true, 40);
    const html = resultHtml(L1, score, 1, true, false, '', true);
    expect([...html.matchAll(/data-act="(\w+)"/g)].map((m) => m[1])).toEqual(['undo', 'retry', 'next']);
    expect(resultHtml(L1, score, 1, true)).not.toMatch(/undo/);
  });
  it('the hint line fits its budget and names undo, restart and where the rest are; ? shows every key', () => {
    const text = (h: string) => h.replace(/<[^>]+>/g, '');
    expect(text(GAME_HELP).length).toBeLessThanOrEqual(HELP_BUDGET);
    // Desktop and touch hints are separate spans; CSS shows one of them.
    const span = (h: string, cls: string) => text(h.match(new RegExp(`<span class="${cls}">(.*?)</span>(?=<span|$)`))?.[1] ?? '');
    expect(span(helpHtml(false), 'kg-desk')).toBe(text(GAME_HELP));
    expect(span(helpHtml(false), 'kg-tch')).toBe(TOUCH_HELP);
    expect(span(helpHtml(true), 'kg-tch')).toBe(TOUCH_HELP);
    for (const k of ['U', 'R', '?']) expect(GAME_HELP).toContain(`<kbd>${k}</kbd>`);
    expect(text(GAME_KEYS).length).toBeGreaterThan(HELP_BUDGET);
    for (const k of ['Q', 'E', 'W', 'S', 'Space', 'B', 'F', 'U', 'R', 'N', 'P', 'M']) expect(GAME_KEYS).toContain(`<kbd>${k}</kbd>`);
    expect(helpHtml(true)).toContain('data-act="keys"');
  });
});

describe('scores and leverage add up (PT9, PT16)', () => {
  const shot = (o: Partial<ShotOutcome>): ShotOutcome => ({ ke: 1000, yield: 0, dPE_mJ: 0, leverage: 0, crownsDown: 0, crownsTotal: 0, heritageNew: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 0, ...o });
  it('the HUD row shows the round\'s leverage (the card\'s figure), and this shot\'s beside it from the second shot', () => {
    expect(leverageRow(1, { round: 6.24, shot: 6.24 })).toMatch(/<span>Leverage<\/span><span>×6\.24 <span class="small shot held">/);
    // At one shot the two figures are the same, so the shot's is held (hidden, keeping the row's width for the docked HUD).
    expect(leverageRow(1, { round: 6.24, shot: 6.24 })).toMatch(/<span class="small shot held">this shot ×0\.00<\/span>/);
    const two = leverageRow(2, { round: 3.12, shot: 6.24 });
    expect(two).toMatch(/<span>×3\.12 <span class="small shot">this shot ×6\.24<\/span><\/span>/);
    expect(two).toContain(`title="${esc(LEVERAGE_MEANS)}`);
  });
  it('no card names a round Brute beside an earned gold badge (L1 to L5, any leverage and strokes)', () => {
    for (const d of [L1, L2, L3, L4, L5]) for (const k of [0.3, 0.99, 1, 2, 4, 9]) for (let s = 1; s <= d.par + 1; s++) {
      const score = levelScore(d, Array.from({ length: s }, () => shot({ dPE_mJ: 1e6 * k * levelGoldLine(d)! })), true, 40);
      const html = resultHtml(d, score, s, false);
      if (html.includes('class="gold got"')) expect(html).not.toContain('(Brute)');
      expect(html).toMatch(/\((Brute|Clean|Elegant|Keystone)\)/);
    }
  });
  it('an outcome level without a gold line names no tier', () => {
    const score = outcomeScore({ met: true, collapse: 0.5, leverage: 0.13, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0 }, undefined);
    const html = resultHtml(B1, score, 2, false);
    expect(html).toContain('leverage ×0.13</div>');
    expect(html).not.toMatch(/Brute|Clean/);
  });
  it('heritage is its own red line with the stars it cost, and the total never shows negative', () => {
    const score = levelScore(L3, [shot({ dPE_mJ: 1e5, heritageNew: 9 }), shot({ dPE_mJ: 1e5 })], true, 40);
    expect(score.lines.reduce((a, l) => a + l.value, 0)).toBeLessThan(0);
    const html = resultHtml(L3, score, 2, false);
    expect(html).toMatch(/<div class="line bad"[^>]*><span>Heritage<\/span><span class="bad">−4,500<\/span>/);
    expect(html).toMatch(/<span>Total<\/span><span>0<\/span>/);
    expect(html).toContain('Heritage cracked: 1 star lost');
    expect(resultHtml(L3, levelScore(L3, [shot({ dPE_mJ: 1e9 })], true, 40), 1, false)).not.toMatch(/star lost|class="line bad"/);
  });
  it('a Rube Lab card shows the parts used against the parts par, stamped on parts, with no gold', () => {
    const at = (spent: number, heritage = 0) => levelScore(RL1, [shot({ dPE_mJ: 1e9, heritageNew: heritage })], true, 40, spent);
    const par = at(2), over = at(3);
    expect([par.stars, par.stamp, par.gold, par.parts]).toEqual([3, 'PARTS PAR', undefined, { used: 2, par: 2 }]);
    expect([over.stars, over.stamp, at(4).stars]).toEqual([2, '+1 PARTS', 1]);
    expect([at(9).stars, at(2, 1).stars, at(2, 1).heritageStarsLost, at(9, 1).stars]).toEqual([1, 2, 1, 1]);
    expect(levelScore(RL1, [shot({})], false, 40, 2)).toMatchObject({ stars: 0, stamp: 'INCOMPLETE' });
    const html = resultHtml(RL1, par, 1, false);
    expect(html).toContain('<div class="sub">parts 2 / par 2 · leverage');
    expect(html).not.toContain('stroke');
    // Other par levels keep their strokes line and gold.
    expect(levelScore(L5, [shot({ dPE_mJ: 1e9 })], true, 40, 7).parts).toBeUndefined();
  });
  it('a Bullet Time card shows the freezes used', () => {
    const score = levelScore({ ...L5, freeze: 2 }, [shot({ cut: true }), shot({ dPE_mJ: 1e7 })], true, 40);
    expect(resultHtml(L5, score, 2, false)).toContain('2 strokes · par 1 · leverage ×5.00 (Clean) · freezes used 1/2');
    expect(score.stamp).toBe('PAR');
  });
  it('How to play says what leverage is and that a score never goes below 0', () => {
    const text = HOW_TO_PLAY.join(' ');
    expect(text).toContain(LEVERAGE_MEANS);
    expect(text).toMatch(/never goes below 0/);
  });
});

// Agent playtest 2 (G9c) on Wavefront's Steer and Cut levels: par levels judged on collapse with no crowns.
describe('Wavefront HUD', () => {
  const at = (level: typeof W3, extra: object = {}) => hudHtml({ level, strokes: 0, crownsDown: 0, crownsTotal: 0, heritageBroken: 0, heritageTotal: 0, chips: [], power: 60, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null, ...extra });
  it('shows Down against the collapse objective, and no crown row on a level without crowns', () => {
    const html = at(W3, { collapse: 0.12 });
    expect(html).not.toMatch(/Crowns/);
    expect(html).toMatch(/Down <b class="down">12%<\/b>/);
    expect(html).toMatch(/bring 16% down/);
    expect(at(W3, { collapse: 0.2, met: true })).toMatch(/bring 16% down ✓/);
  });
  it('a refused pull on a Cut level says the cut rule while aiming, the crown rule while the wave runs', () => {
    expect(at(W5, { pullRefused: true })).toContain(CUT_HINT);
    expect(at(W5, { pullRefused: true, phase: 'running' })).toContain(PULL_HINT);
    expect(at(W3, { pullRefused: true })).toContain(PULL_HINT);
  });
});
