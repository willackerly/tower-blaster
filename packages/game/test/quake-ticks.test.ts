// Each tower's marks on the quake dial (quake-ticks.ts, PT25): uplift on Strength (a column of n cubes lifts at
// 1/n g), the rocking frequency on Frequency (Housner's p = sqrt(3 g / 4 R)), from the geometry alone.
import { describe, expect, it } from 'vitest';
import { A1, A2, A3, compileLevel } from '@tb/keystone';
import { columnUnder, towerTicks } from '../src/quake-ticks.ts';
import { dialStart, quakePanelHtml, seismogram, tickStrip } from '../src/quake-panel.ts';

describe('the towers\' marks on the quake dial', () => {
  it('a column of n cubes lifts at 1/n g along x or z, sqrt 2 / n corner-on; its rocking frequency is Housner\'s', () => {
    const c = compileLevel(A1), g = Math.hypot(...c.scene.gravity), u = c.frame.unit;
    for (const axis of [0, 90]) {
      for (const t of towerTicks(c, axis)) {
        const n = columnUnder(c, t.body).length;
        expect(t.uplift).toBeCloseTo(1 / n, 9);
        const R = (u * Math.hypot(1, n)) / 2;
        expect(t.rockHz).toBeCloseTo(Math.sqrt((3 * g) / (4 * R)) / (2 * Math.PI), 9);
      }
    }
    // Shaken corner-on, a square column tips about a corner: its lever is the half-diagonal, sqrt 2 longer.
    for (const t of towerTicks(c, 45)) expect(t.uplift).toBeCloseTo(Math.SQRT2 / columnUnder(c, t.body).length, 9);
    // A1: col8 C, col4 P, col7 C, col3 P (aftershock.md); the slender condemned columns lift first.
    expect(towerTicks(c, 0).map((t) => [t.role, columnUnder(c, t.body).length])).toEqual([['condemned', 8], ['protected', 4], ['condemned', 7], ['protected', 3]]);
  });

  it('the size lever: Big Brother\'s slab tower lifts with its columns, and rocks slower', () => {
    const [a, slab, b] = towerTicks(compileLevel(A2), 0);
    expect(slab!.role).toBe('protected');
    expect(slab!.uplift).toBeCloseTo(a!.uplift, 9);
    expect(slab!.uplift).toBeCloseTo(b!.uplift, 9);
    expect(slab!.rockHz).toBeLessThan(0.75 * a!.rockHz);
  });

  it('the axis lever: Cross Grain\'s rod walls lift early shaken across their rods, late along them', () => {
    const c = compileLevel(A3), along = towerTicks(c, 0), across = towerTicks(c, 90);
    for (const [i, t] of along.entries()) {
      const lo = Math.min(t.uplift, across[i]!.uplift), hi = Math.max(t.uplift, across[i]!.uplift);
      expect(hi / lo).toBeGreaterThan(2);
    }
    // The ace is at 90 degrees: across the condemned walls' rods, along the protected ones'.
    for (const t of across) expect(t.role === 'condemned' ? t.uplift < 0.25 : t.uplift > 0.4).toBe(true);
  });

  it('the panel draws one mark a tower on Strength and on Frequency, and the dial\'s caret', () => {
    const c = compileLevel(A1), d = dialStart(c), html = quakePanelHtml(c, d, 0, seismogram(c, { ammo: 'quake', ...d }, 50), true);
    for (const f of ['peak', 'hz']) {
      const strip = html.match(new RegExp(`<svg class="qticks" data-ticks="${f}"[^]*?</svg>`))![0];
      expect(strip.match(/class="tc"/g)).toHaveLength(2);
      expect(strip.match(/class="tp"/g)).toHaveLength(2);
      expect(strip).toContain('class="tv"');
    }
    // Strength is linear from 0 to the dial's top: a 1/8 g uplift on an 0.8 g dial sits at 15.6% of the strip.
    expect(tickStrip('peak', [{ body: 0, role: 'condemned', uplift: 0.125, rockHz: 0.3 }], 40, [0, 80])).toContain('x1="9.4"');
    // Frequency is a log scale over the range: 0.3 Hz at the left end of 0.3..3 Hz, 0.95 Hz half way, the caret at 3 Hz on the right.
    const hz = tickStrip('hz', [{ body: 0, role: 'protected', uplift: 0.2, rockHz: 0.3 }, { body: 1, role: 'protected', uplift: 0.2, rockHz: 0.3 * Math.sqrt(10) }], 30, [3, 30]);
    expect(hz).toContain('x1="0.0"');
    expect(hz).toContain('x1="30.0"');
    expect(hz).toContain('M60.0 6');
    // The marks are not text: a dial value still reads as itself.
    expect(html.match(/data-q="hz"[^>]*>([^<]*)</)![1]).toBe(`${(d.hz / 10).toFixed(1)} Hz`);
  });
});
