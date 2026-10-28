// The par and dev panel's rendering (dev-panel.ts devHtml): what it shows and
// which actions it offers in each state; the page's actions are e2e-dev.test.ts.
import { describe, expect, it } from 'vitest';
import { L1, type Shot, type ShotOutcome, writeShots } from '@tb/keystone';
import { type DevView, devHtml } from '../src/index.ts';

const par = L1.solutions!.par as Shot[];
const outcome: ShotOutcome = { ke: 1, dPE_mJ: 2500, leverage: 0.5, crownsDown: 3, crownsTotal: 3, heritageNew: 1, displaced: 0, outOfLot: 0, spawnStep: 10, settleStep: 250 };
const base: DevView = { level: L1, line: { from: 'par', shots: par }, attempt: [], outcomes: [], score: null, running: false, busy: false, status: '', warn: false };
const enabled = (html: string) => [...html.matchAll(/<button type="button" name="(\w+)"( disabled)?/g)].filter((m) => !m[2]).map((m) => m[1]);

describe('the dev panel\'s view', () => {
  it('offers Play with a line, and Replay check and Keep only for a settled attempt with no action under way', () => {
    expect(enabled(devHtml(base))).toEqual(['play']);
    expect(devHtml(base)).toContain(`par line, 1 shot: <code>${writeShots(par)}</code>`);
    expect(devHtml(base)).toContain('no shots fired yet');
    const settled = { ...base, attempt: par, outcomes: [outcome] };
    expect(enabled(devHtml(settled))).toEqual(['play', 'check', 'keep']);
    expect(enabled(devHtml({ ...settled, busy: true }))).toEqual([]);
    expect(enabled(devHtml({ ...settled, outcomes: [], running: true }))).toEqual(['play']);
    expect(enabled(devHtml({ ...base, line: null }))).toEqual([]);
    expect(devHtml({ ...base, line: null })).toContain('no line');
  });

  it('shows each settled shot\'s outcome, a row in flight, and the status', () => {
    const html = devHtml({ ...base, attempt: [par[0]!, par[0]!], outcomes: [outcome], status: 'replay differs: <x>', warn: true });
    expect(html).toContain('<tr><td>1</td><td>cannonball</td><td>×0.50</td><td>2.5</td><td>3/3</td><td>1</td><td>240</td></tr>');
    expect(html).toContain('<tr><td>2</td><td>cannonball</td><td>…</td>');
    expect(html).toContain('<div class="out warn">replay differs: &#60;x&#62;</div>');
  });
});
