// The agent playtest's plan (G9b, plan.ts): it covers every level and mode the
// brief names at the form factors it names, its novice clicks are seeded, and
// its file names and contact sheets are well formed. The browser run itself is
// `pnpm playtest:agent` (minutes to an hour on SwiftShader), not a CI test.
import { describe, expect, it } from 'vitest';
import { AFTERSHOCK_LEVELS, BIG_LEVELS, DUELS, FUSE_LEVELS, LEVELS, MASON_LEVELS, RUBE_LEVELS, TRIAL_LEVELS, UNDERCUT_LEVELS, WAVE_LEVELS } from '@tb/keystone';
import { agentPlan, frameName, lineOf, NOT_ON_PAGE, noviceAim, rng, sheetGrid, spiral, VIEWPORTS, withLook } from '../src/agent/plan.ts';

const plan = agentPlan();
const played = (id: string) => plan.filter((s) => s.level === id && (s.script.kind === 'play' || s.script.kind === 'freeze'));

describe('agent playtest plan', () => {
  it('plays every rated level (B, L, U) at desktop and phone, and every trial on the desktop with its phone view', () => {
    for (const l of [...BIG_LEVELS, ...LEVELS, ...UNDERCUT_LEVELS]) {
      const vps = new Set(played(l.id).flatMap((s) => s.viewports));
      expect([l.id, vps.has('desktop'), vps.has('phone')]).toEqual([l.id, true, true]);
    }
    for (const l of TRIAL_LEVELS) {
      expect(played(l.id).some((s) => s.viewports.includes('desktop'))).toBe(true);
      expect(plan.some((s) => s.level === l.id && s.viewports.includes('phone'))).toBe(true);
    }
  });

  it('plays the recorded line of every level that has one', () => {
    for (const l of [...BIG_LEVELS, ...LEVELS, ...UNDERCUT_LEVELS].filter((x) => x.solutions?.par ?? x.solutions?.ace)) {
      const s = plan.find((x) => x.id === `${l.id}-line`);
      expect(s?.script).toEqual({ kind: 'play', policy: 'line', shots: lineOf(l).length });
    }
  });

  it('covers every mode of the brief: door, Bullet Time, every Siege Table, the looks, ice in the real look, touch turned sideways, undo and retry', () => {
    const modes = new Set(plan.map((s) => s.mode));
    for (const m of ['door', 'level', 'trial', 'ice', 'bullet-time', 'siege-table', 'look', 'touch']) expect(modes.has(m)).toBe(true);
    for (const d of DUELS) expect(plan.find((s) => s.id === `duel-${d.id}`)?.viewports).toEqual(['desktop', 'phone']);
    expect(plan.filter((s) => s.script.kind === 'freeze').map((s) => s.search)).toEqual(['?level=B1&keystone.freeze=3', '?level=L5&keystone.freeze=2']);
    expect(plan.filter((s) => s.mode === 'ice' && s.search.includes('look=real')).map((s) => s.level)).toEqual(['T-I1', 'T-I2', 'T-I3']);
    expect(plan.some((s) => s.script.kind === 'play' && s.script.undo && s.script.retry)).toBe(true);
    expect(plan.find((s) => s.id === 'door')?.viewports).toEqual(['desktop', 'phone', 'phone-landscape']);
  });

  it('plays the chamber levels, Undercut and the duels on the GPU solver (Rapier sleeps: far shots settle in the air); the big levels on Rapier', () => {
    for (const l of [...LEVELS, ...UNDERCUT_LEVELS]) for (const s of played(l.id).filter((x) => !x.search.includes('freeze=3'))) expect([s.id, s.engine]).toEqual([s.id, 'gpu']);
    for (const s of plan.filter((x) => x.mode === 'siege-table')) expect(s.engine).toBe('gpu');
    for (const l of BIG_LEVELS) for (const s of played(l.id)) expect([s.id, s.engine]).toEqual([s.id, undefined]);
  });

  it('round 2: every new-mode level on the GPU solver, a first visit at all three form factors, and its verb or recorded line on the desktop', () => {
    for (const l of [...FUSE_LEVELS, ...AFTERSHOCK_LEVELS, ...RUBE_LEVELS]) {
      const novice = plan.find((s) => s.id === `${l.id}-novice`);
      expect([l.id, novice?.viewports, novice?.engine, novice?.script]).toEqual([l.id, ['desktop', 'phone', 'phone-landscape'], 'gpu', { kind: 'play', policy: 'novice', shots: 1 }]);
    }
    // Wavefront (on main since #265): a first visit at all three, two shots where the rack has them (W5's push, then its live pull).
    for (const l of WAVE_LEVELS) expect([l.id, plan.find((s) => s.id === `${l.id}-novice`)?.engine, plan.find((s) => s.id === `${l.id}-novice`)?.script]).toEqual([l.id, 'gpu', { kind: 'play', policy: 'novice', shots: Math.min(l.rack.length, 2) }]);
    for (const l of FUSE_LEVELS) expect(plan.find((s) => s.id === `${l.id}-sweep`)?.script).toEqual({ kind: 'play', policy: 'sweep', shots: 1 });
    for (const l of [...AFTERSHOCK_LEVELS, ...RUBE_LEVELS]) expect([l.id, plan.find((s) => s.id === `${l.id}-line`)?.script]).toEqual([l.id, { kind: 'play', policy: 'line', shots: 1 }]);
    // Mason's Trial is not on the game page yet (?level=MT1 is refused): not played, and listed as such.
    for (const l of MASON_LEVELS) expect(plan.some((s) => s.level === l.id)).toBe(false);
    expect(NOT_ON_PAGE.mason).toEqual(MASON_LEVELS.map((l) => l.id));
    expect(new Set(plan.filter((s) => s.engine === 'gpu').map((s) => s.mode))).toEqual(new Set(['level', 'bullet-time', 'siege-table', 'look', 'fuse', 'aftershock', 'rube', 'wave']));
  });

  it('has unique, file-safe ids and only known viewports', () => {
    const ids = plan.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of plan) {
      expect(s.id).toMatch(/^[A-Za-z0-9-]+$/);
      for (const v of s.viewports) expect(VIEWPORTS[v]).toBeDefined();
      expect(s.search.startsWith('?')).toBe(true);
    }
  });
});

describe('novice clicks', () => {
  it('the first is the middle of the screen, a little low; later ones are seeded jitter within the spread', () => {
    expect(noviceAim(0, 1)).toEqual([0, -0.05]);
    expect(noviceAim(3, 1)).toEqual(noviceAim(3, 1));
    expect(noviceAim(3, 1)).not.toEqual(noviceAim(3, 2));
    for (let k = 1; k < 50; k++) {
      const [x, y] = noviceAim(k, 7);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.18);
      expect(Math.abs(y + 0.05)).toBeLessThanOrEqual(0.18);
    }
  });
  it('rng is mulberry32: in [0, 1) and repeatable', () => {
    const a = rng(42), b = rng(42), xs = Array.from({ length: 1000 }, a);
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, b));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
  it('the spiral starts at the middle and walks out ring by ring', () => {
    const s = spiral(3, 0.1);
    expect(s[0]).toEqual([0, -0.05]);
    expect(s.length).toBe(1 + 8 + 16 + 24);
    const r = (p: [number, number]) => Math.hypot(p[0], p[1] + 0.05);
    for (let i = 1; i < s.length; i++) expect(r(s[i]!)).toBeGreaterThanOrEqual(r(s[i - 1]!) - 1e-9);
  });
});

describe('captures', () => {
  it('names frames <scenario>-<viewport>-<nn>-<what>.png, file-safe', () => {
    expect(frameName('B1-novice', 'phone', 3, 'Shot 1 +20 steps')).toBe('B1-novice-phone-03-shot-1-20-steps.png');
    expect(frameName('door', 'desktop', 0, 'How to play!')).toBe('door-desktop-00-how-to-play.png');
  });
  it('lays a contact sheet out at most 2,000 px wide, portrait frames narrower', () => {
    expect(sheetGrid(4, 1280, 800)).toEqual({ cols: 3, rows: 2, cellW: 640, cellH: 400 });
    expect(sheetGrid(9, 390, 844)).toEqual({ cols: 6, rows: 2, cellW: 300, cellH: 649 });
    expect(sheetGrid(1, 1280, 800).cols).toBe(1);
  });
});

describe('--look (a look review: the same scenarios in another look)', () => {
  it('sets the look, replacing one the scenario names and keeping the rest of its search', () => {
    expect(withLook('?level=L3', 'real')).toBe('?level=L3&look=real');
    expect(withLook('?level=B2&look=candy', 'hazy')).toBe('?level=B2&look=hazy');
    expect(new URLSearchParams(withLook('?level=B1&keystone.freeze=3', 'real')).get('keystone.freeze')).toBe('3');
  });
});
