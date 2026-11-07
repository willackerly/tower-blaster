// The quake designer (quake-panel.ts) without a page: the dial starts on the level's stops and steps within the
// level's range, the seismogram is the field events the engine gets, the compass turns with the camera, and the
// panel shows the energy against the budget and refuses Start over it.
import { describe, expect, it } from 'vitest';
import { A2, A3, BuildSession, compileLevel, type LevelDef, quakeCandidate, quakeEnergy, retrofitCandidate } from '@tb/keystone';
import { axisOnScreen, dialShot, dialStart, dialStep, dialStops, dialText, quakePanelHtml, seismogram } from '../src/quake-panel.ts';
import { hudHtml, type HudState } from '../src/hud.ts';

const shock = compileLevel(quakeCandidate('QC-4'));
const capped = (over: LevelDef['quake']) => compileLevel({ ...quakeCandidate('QC-4'), quake: over });

describe('quake dial', () => {
  it('starts at 0.3 g, 1 Hz, 3 s along x, snapped to the level', () => {
    expect(dialStart(shock)).toEqual({ peak: 30, hz: 10, sec: 30, axis: 0 });
    expect(dialStart(capped({ peakMax: 20, hz: [3, 8], sec: [5, 20] }))).toEqual({ peak: 20, hz: 8, sec: 20, axis: 0 });
    expect(dialText(dialStart(shock))).toEqual({ peak: '0.30 g', hz: '1.0 Hz', sec: '3.0 s', axis: '0°' });
  });

  it('opens on the level\'s seed where it has one (PT25: QuakeRules.start), on the old start where not', () => {
    expect(dialStart(compileLevel(A2))).toEqual({ peak: 35, hz: 8, sec: 20, axis: 0 });
    expect(dialStart(compileLevel(A3))).toEqual({ peak: 30, hz: 10, sec: 30, axis: 0 });
  });

  it('steps along the stops inside the range, holds at its ends, and wraps the axis', () => {
    expect(dialStops(shock, 'hz')).toEqual([3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]);
    expect(dialStops(capped({ sec: [7, 33] }), 'sec')).toEqual([7, 10, 15, 20, 30, 33]);
    let d = dialStart(shock);
    for (let i = 0; i < 20; i++) d = dialStep(shock, d, 'peak', 1);
    expect(d.peak).toBe(80);
    for (let i = 0; i < 30; i++) d = dialStep(shock, d, 'peak', -1);
    expect(d.peak).toBe(5);
    expect(dialStep(capped({ peakMax: 72 }), { ...d, peak: 70 }, 'peak', 1).peak).toBe(72);
    expect(dialStep(shock, { ...d, peak: 33 }, 'peak', -1).peak).toBe(30);
    expect(dialStep(shock, { ...d, hz: 3 }, 'hz', -1).hz).toBe(3);
    expect(dialStep(shock, { ...d, sec: 15 }, 'sec', 1).sec).toBe(20);
    expect(dialStep(shock, { ...d, axis: 165 }, 'axis', 1).axis).toBe(0);
    expect(dialStep(shock, { ...d, axis: 0 }, 'axis', -1).axis).toBe(165);
  });
});

describe('quake panel', () => {
  it('the seismogram is the side load the field events carry: zero at both ends, peaking at the dial strength', () => {
    const shot = dialShot({ peak: 50, hz: 10, sec: 15, axis: 60 }), trace = seismogram(shock, shot, 200);
    expect(trace).toHaveLength(200);
    expect(trace[0]).toBe(0);
    expect(trace.at(-1)).toBeCloseTo(0, 3);
    const top = Math.max(...trace.map(Math.abs));
    expect(top).toBeGreaterThan(0.4);
    expect(top).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it('the compass turns with the camera: the axis is drawn at its azimuth plus the yaw', () => {
    expect(axisOnScreen(0, 0)).toBe(0);
    expect(axisOnScreen(90, -Math.PI / 2)).toBeCloseTo(0, 12);
    const html = quakePanelHtml(shock, dialStart(shock), Math.PI / 2, [0, 0.1, 0], true);
    // At yaw 90 degrees an x axis shows vertical on screen: the arrow's ends share an x.
    const [, x1, , x2] = /x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)"/.exec(html)!;
    expect(x1).toBe(x2);
  });

  it('shows the energy against the budget, refusing Start over it, and stands in for power and height in the HUD', () => {
    const d = { peak: 50, hz: 10, sec: 15, axis: 0 }, e = quakeEnergy(shock, dialShot(d));
    const roomy = capped({ budget: 2 * e }), tight = capped({ budget: e / 2 });
    expect(quakePanelHtml(roomy, d, 0, [], true)).toMatch(/of a \d+ J budget/);
    expect(quakePanelHtml(roomy, d, 0, [], true)).not.toMatch(/quake-go" disabled/);
    const over = quakePanelHtml(tight, d, 0, [], true);
    expect(over).toMatch(/over the \d+ J budget/);
    expect(over).toMatch(/quake-go" disabled/);
    expect(quakePanelHtml(roomy, d, 0, [], false)).toMatch(/quake-go" disabled/);
    // Without a budget the bar is measured against the dial's brute end.
    expect(quakePanelHtml(shock, d, 0, [], true)).toMatch(/strongest, slowest, longest quake/);
    const s: HudState = {
      level: shock.def, strokes: 0, crownsDown: 0, crownsTotal: 2, heritageBroken: 0, heritageTotal: 2, power: 100, launch: 3, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null,
      chips: [{ ammo: 'quake', key: '1', left: 1, total: 1, selected: true }], quake: '<div class="quake-panel">Q</div>',
    };
    const hud = hudHtml(s);
    expect(hud).toContain('quake-panel');
    expect(hud).not.toMatch(/Power|Height/);
    expect(hud).toContain('Condemned down');
  });
});

describe('a retrofit\'s quake panel (quake.fixed, M7b)', () => {
  const retro = compileLevel(retrofitCandidate('RC-1')), fixed = { peak: 30, hz: 10, sec: 10, axis: 0 };

  it('the dial is the level\'s quake and does not move', () => {
    expect(dialStart(retro)).toEqual(fixed);
    for (const f of ['peak', 'hz', 'sec', 'axis'] as const) for (const k of [1, -1] as const) expect(dialStep(retro, fixed, f, k)).toEqual(fixed);
  });

  it('shows the quake without dial buttons, what was placed against the budget, and Start', () => {
    const html = quakePanelHtml(retro, fixed, 0, [], true);
    expect(html).toContain('quake-panel fixed');
    expect(html).not.toMatch(/class="qd"/);
    expect(html).toMatch(/<b>0 \/ 200<\/b> braced/);
    expect(html).toMatch(/quake-go"><kbd>Enter/);
    expect(html).toMatch(/0\.30 g[\s\S]*1\.0 Hz[\s\S]*1\.0 s[\s\S]*0°/);
    // A pier of three placed through the build tool, on open ground left of the first column.
    const s = new BuildSession(retro.def), p = s.pitch * s.h;
    expect(s.place(s.ghost({ body: -1, point: [-0.5 * p, 0, 0.5 * p], normal: [0, 1, 0], t: 0 }, { item: 'pier3', yaw: 0, tip: 0 }))).toBe(true);
    expect(quakePanelHtml(compileLevel(s.def()), fixed, 0, [], true)).toMatch(/<b>3 \/ 200<\/b> braced/);
  });
});
