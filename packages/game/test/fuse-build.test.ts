// Fuse & Fold's domino fuses in the game (M5b, docs/game/fuse-and-fold.md, "Domino fuses"): a fuse level opens on the
// domino brush, a stroke from near a lane's head to near its socket snaps to both, the build panel reports each lane's
// dominoes, burn and firing order, there is no timeline to set, and the slot offers Light the fuses.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import { compileLevel, FUSE_LEVELS, fuseCandidate, fuseLanes, type LevelDef, outcomeScore } from '@tb/keystone';
import { EditController } from '../src/index.ts';
import { fusesHtml } from '../src/edit-panel.ts';
import { panelTimeline } from '../src/fuse-timeline.ts';
import { LIGHT_BUTTON, slotAction } from '../src/hud.ts';
import { failReason, hudProfile } from '../src/mode-ui.ts';

const def: LevelDef = fuseCandidate('FD-1'), c = compileLevel(def), h = c.frame.unit, lanes = fuseLanes(c);
/** Straight down onto (x, z) in h. */
const at = (x: number, z: number) => ({ origin: [x * h, 20, z * h] as Vec3, dir: [0, -1, 0] as Vec3 });

/** Strokes from (x0, z0) to (x1, z1) in h, in `n` pointer moves. */
function stroke(e: EditController, a: [number, number], b: [number, number], n = 16): boolean {
  e.down(at(...a));
  for (let i = 1; i <= n; i++) e.move(at(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
  return e.up();
}

describe('building a domino fuse', () => {
  it('opens on the brush, every lane unlaid', () => {
    const e = new EditController(def);
    expect(e.tool).toBe('brush');
    expect(e.lanes).toHaveLength(2);
    expect(e.laneReport()).toEqual([0, 1].map((lane) => ({ lane, dominoes: 0, reaches: false, seconds: null })));
    expect(fusesHtml(e)).toMatch(/Lane 1<\/b> <span class="warn">no fuse: its row stands/);
  });

  it('a stroke drawn a little off the head and short of the socket snaps to both and lays the straight fuse', () => {
    const e = new EditController(def), l = lanes[0]!;
    expect(stroke(e, [l.head[0] + 0.8, l.head[1] - 0.5], [l.end[0] - 0.6, l.end[1] - l.dir[1] * 1.4])).toBe(true);
    const run = e.play().parts.at(-1)!;
    expect(run.kind === 'run' && run.path[0]).toEqual(l.head);
    expect(run.kind === 'run' && run.path.at(-1)).toEqual(l.end);
    const r = e.laneReport();
    expect(r[0]).toMatchObject({ dominoes: l.straight, reaches: true });
    expect(r[0]!.seconds!).toBeGreaterThan(3);
    expect(r[0]!.seconds!).toBeLessThan(6);
    expect(r[1]!.dominoes).toBe(0);
  });

  it('with snapping off (Alt) the stroke is laid as drawn and its lane reads unlaid', () => {
    const e = new EditController(def), l = lanes[0]!;
    e.down(at(l.head[0] + 0.8, l.head[1]));
    for (let i = 1; i <= 16; i++) e.move(at(l.head[0] + 0.8, l.head[1] + ((l.end[1] - l.head[1]) * i) / 16), { alt: true });
    expect(e.up()).toBe(true);
    expect(e.laneReport()[0]!.dominoes).toBe(0);
  });

  it('a lane with a longer fuse fires later, and the panel says which goes first', () => {
    const e = new EditController(def), [w, east] = lanes as [typeof lanes[0], typeof lanes[0]];
    stroke(e, w.head, w.end);
    // East's fuse swings out 3 h and back: longer than straight.
    const mid: [number, number] = [east.head[0] + 3, (east.head[1] + east.end[1]) / 2];
    e.down(at(...east.head));
    for (let i = 1; i <= 12; i++) e.move(at(east.head[0] + ((mid[0] - east.head[0]) * i) / 12, east.head[1] + ((mid[1] - east.head[1]) * i) / 12));
    for (let i = 1; i <= 12; i++) e.move(at(mid[0] + ((east.end[0] - mid[0]) * i) / 12, mid[1] + ((east.end[1] - mid[1]) * i) / 12));
    expect(e.up()).toBe(true);
    const [a, b] = e.laneReport() as [ReturnType<EditController['laneReport']>[0], ReturnType<EditController['laneReport']>[0]];
    expect(b.reaches).toBe(true);
    expect(b.dominoes).toBeGreaterThan(a.dominoes);
    expect(b.seconds!).toBeGreaterThan(a.seconds!);
    const html = fusesHtml(e);
    expect(html).toMatch(/Lane 1<\/b> 12 dominoes · [\d.]+ s · fires 1st/);
    expect(html).toMatch(/Lane 2<\/b> \d+ dominoes · [\d.]+ s · fires 2nd/);
  });

  it('other build levels show no lanes', () => {
    const t = new EditController({ ...FUSE_LEVELS[0]!, build: { budget: 10, brush: true } });
    expect(t.lanes).toEqual([]);
    expect(fusesHtml(t)).toBe('');
  });
});

describe('firing a fuse level', () => {
  it('has no timeline (the fuses are the delays) and its slot lights the fuses', () => {
    expect(panelTimeline(c)).toBeNull();
    expect(panelTimeline(compileLevel(FUSE_LEVELS[0]!))).not.toBeNull();
    expect(slotAction({ level: def, opener: true, canBank: false, canSkip: false, skipping: false })).toBe('light');
    expect(slotAction({ level: FUSE_LEVELS[0]!, opener: true, canBank: false, canSkip: false, skipping: false })).toBe('opener');
    expect(LIGHT_BUTTON).toMatch(/data-act="opener"/);
  });

  it('its HUD profile keeps the opener (Light the fuses is the start), unlike a timeline fold level', () => {
    expect(hudProfile(def)).toMatchObject({ mode: 'fuse', opener: true, start: 'Light the fuses', aim: false, chips: false });
    expect(hudProfile(FUSE_LEVELS[0]!)).toMatchObject({ mode: 'fuse', opener: false, start: 'Plunger' });
    expect(slotAction({ level: def, opener: true, canBank: false, canSkip: false, skipping: false, profile: hudProfile(def) })).toBe('light');
  });

  it('a misfire is the card\'s reason: a fuse that never reached its socket', () => {
    const score = outcomeScore({ met: false, collapse: 0.8, leverage: 1, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0, spill: 0, misfires: 2 }, undefined);
    const facts = { crownsDown: 0, crownsTotal: 0, heritageBroken: 0, heritageTotal: 4, collapse: 0.8, spill: 0, misfires: 2 };
    expect(failReason(def, score, facts)).toBe('2 columns never cut: a fuse did not reach its socket');
    expect(failReason(def, score, { ...facts, misfires: 0, collapse: 0.3 })).toBe('30% folded, 60% needed');
  });
});
