// playLine (play.ts) against a stand-in for the page's handle: it fires each
// shot once the game is ready and stops, saying why, when the level changes,
// ends early, is retried mid-line, or a shot cannot be fired. The real page is
// e2e-line.test.ts.
import { describe, expect, it } from 'vitest';
import type { LevelScore, Shot } from '@tb/keystone';
import { type GameHandle, newGameHandle, playLine } from '../src/play.ts';

const marble: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 30 };
const line = [marble, marble];

/** A running level where each shot settles 5 ms after it is fired, and `after(n, h)` runs once shot n has settled. */
function page(after: (n: number, h: GameHandle) => void = () => {}) {
  const h = newGameHandle();
  const fired: Shot[] = [];
  let retries = 0;
  Object.assign(h, { status: 'running', level: 'L1', ready: true, strokes: 0 });
  h.fire = (s) => {
    if (!h.ready) return false;
    fired.push(s);
    h.strokes++;
    h.ready = false;
    setTimeout(() => { h.ready = true; after(h.strokes, h); }, 5);
    return true;
  };
  h.retry = async () => { retries++; h.strokes = 0; h.result = null; };
  return { h, fired, retries: () => retries };
}

describe('playLine', () => {
  it('fires every shot once ready, from a fresh attempt unless told the load\'s own is fresh', async () => {
    const p = page();
    expect(await playLine(p.h, line, true)).toEqual({ ok: true, fired: 2, message: 'played 2 shots; the level is still open' });
    expect(p.fired).toEqual(line);
    expect(p.retries()).toBe(0);
    const q = page(), seen: number[] = [];
    expect((await playLine(q.h, line, false, (n) => seen.push(n))).ok).toBe(true);
    expect(q.retries()).toBe(1);
    expect(seen).toEqual([1, 2]);
  });

  it('ends with the result when the last shot ends the level', async () => {
    const p = page((n, h) => { if (n === 2) h.result = { stamp: 'PAR', stars: 2 } as LevelScore; });
    expect(await playLine(p.h, line, true)).toEqual({ ok: true, fired: 2, message: 'played 2 shots: PAR, ★★☆' });
  });

  it('stops when the level ends early, changes, or is retried mid-line, or a shot cannot be fired', async () => {
    const ended = page((n, h) => { if (n === 1) h.result = { stamp: 'PAR', stars: 2 } as LevelScore; });
    expect(await playLine(ended.h, line, true)).toEqual({ ok: false, fired: 1, message: 'the level ended after 1 of 2 shots' });
    const moved = page((n, h) => { if (n === 1) h.level = 'L2'; });
    expect(await playLine(moved.h, line, true)).toEqual({ ok: false, fired: 1, message: 'stopped after 1 of 2 shots: the level changed' });
    expect(moved.fired.length).toBe(1);
    const retried = page((n, h) => { if (n === 1) h.strokes = 0; });
    expect(await playLine(retried.h, line, true)).toEqual({ ok: false, fired: 1, message: 'stopped after 1 of 2 shots: the attempt was restarted' });
    expect(retried.fired.length).toBe(1);
    const empty = page();
    empty.h.fire = () => false;
    expect(await playLine(empty.h, line, true)).toEqual({ ok: false, fired: 0, message: 'shot 1 (marble) could not be fired' });
  });
});
