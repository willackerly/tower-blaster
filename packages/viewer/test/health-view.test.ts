// The HUD's view of the engine's limits (health.ts), on hand-made EngineHealth.
import { describe, expect, it } from 'vitest';
import type { EngineHealth, EngineLimit } from '@tb/engine-api';
import { limitFix, limitFixLabel, limitsHtml } from '../src/health.ts';

const pairs = (l: Partial<EngineLimit> = {}): EngineLimit => ({ id: 'pairs', effect: 'physics', steps: 0, peak: 1234, room: 5632, message: 'pair buffer: fine', ...l });
const health = (...limits: EngineLimit[]): EngineHealth => ({ steps: 60, limits });

describe('HUD limits', () => {
  it('shows nothing for an engine without health() or before its first read', () => {
    expect(limitsHtml(null)).toBe('');
    expect(limitFix(null, 'rapier')).toBeNull();
    expect(limitFixLabel(null)).toBeNull();
  });

  it('shows each limit\'s peak against its room, muted, while no step hit it', () => {
    const h = health(pairs());
    expect(limitsHtml(h)).toBe(`<div class="row"><span>pair slots</span><span class="muted">${(1234).toLocaleString()} / ${(5632).toLocaleString()}</span></div>`);
    expect(limitFix(h, 'avbd-gpu')).toBeNull();
    expect(limitFixLabel(h)).toBeNull();
  });

  it('once a limit changed the physics: its row and sentence in red, and the spec and text of the button its fix rebuilds with', () => {
    const hit = pairs({ steps: 9, peak: 900, room: 352, message: 'contacts dropped on 9 of 60 steps: <b>', fix: { option: 'pairsPerBody', value: 8 } });
    const html = limitsHtml(health(hit));
    expect(html).toContain('<span class="bad">900 / 352</span>');
    expect(html).toContain('<div class="bad">contacts dropped on 9 of 60 steps: &#60;b&#62;</div>'); // escaped
    // The option is replaced in place; the spec's other options keep their order.
    expect(limitFix(health(hit), 'avbd-gpu:pairsPerBody=1,iterations=4')).toBe('avbd-gpu:pairsPerBody=8,iterations=4');
    expect(limitFixLabel(health(hit))).toBe('Rebuild with pairsPerBody=8');
    expect(html).not.toContain('<button'); // the button is its own element (main.ts)
    // The box test as the fix adds the option.
    expect(limitFix(health(pairs({ steps: 1, fix: { option: 'boxBroadphase', value: true } })), 'avbd-gpu')).toBe('avbd-gpu:boxBroadphase=true');
  });

  it('a hit with no fix gets its sentence and no button; a speed limit hit is amber, with no sentence', () => {
    const h = health(pairs({ steps: 3, message: 'no room on this device' }), pairs({ id: 'colors', effect: 'speed', steps: 5, message: 'slow' }));
    const html = limitsHtml(h);
    expect(html).toContain('<div class="bad">no room on this device</div>');
    expect(html).toContain('<span>colors</span><span class="warn">');
    expect(html).not.toContain('slow');
    expect([limitFix(h, 'avbd-gpu'), limitFixLabel(h)]).toEqual([null, null]);
  });
});
