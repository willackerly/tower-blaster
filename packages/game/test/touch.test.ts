import { describe, expect, it } from 'vitest';
import { MIN_SPAN, TouchGestures, touchFace, touchMode } from '../src/touch.ts';

describe('touch mode', () => {
  it('reads ?touch=auto|1|0 and refuses anything else', () => {
    expect(touchMode(new URLSearchParams(''))).toBe('auto');
    expect(touchMode(new URLSearchParams('touch=auto'))).toBe('auto');
    expect(touchMode(new URLSearchParams('touch=1'))).toBe('on');
    expect(touchMode(new URLSearchParams('touch=0'))).toBe('off');
    expect(() => touchMode(new URLSearchParams('touch=yes'))).toThrow(/touch must be/);
  });
  it('auto starts from the primary pointer and then follows the last one put down', () => {
    expect(touchFace('auto', true, null)).toBe(true);
    expect(touchFace('auto', false, null)).toBe(false);
    expect(touchFace('auto', false, 'touch')).toBe(true);
    expect(touchFace('auto', true, 'mouse')).toBe(false);
    expect(touchFace('auto', true, 'pen')).toBe(false);
    expect(touchFace('on', false, 'mouse')).toBe(true);
    expect(touchFace('off', true, 'touch')).toBe(false);
  });
});

describe('touch gestures', () => {
  it('one finger aims where it is, follows the drag, and fires where it lifts', () => {
    const g = new TouchGestures();
    expect(g.start(1, 100, 200)).toEqual([{ t: 'aim', x: 100, y: 200 }]);
    expect(g.state).toBe('aim');
    expect(g.move(1, 110, 190)).toEqual([{ t: 'aim', x: 110, y: 190 }]);
    expect(g.end(1, 112, 188)).toEqual([{ t: 'fire', x: 112, y: 188 }]);
    expect(g.state).toBe('idle');
    // A tap is a short one: down and up in place.
    expect(g.start(2, 50, 50)).toEqual([{ t: 'aim', x: 50, y: 50 }]);
    expect(g.end(2, 50, 50)).toEqual([{ t: 'fire', x: 50, y: 50 }]);
  });

  it('a second finger cancels the aim; nothing fires as the two lift, in either order', () => {
    for (const order of [[1, 2], [2, 1]]) {
      const g = new TouchGestures();
      g.start(1, 100, 100);
      expect(g.start(2, 200, 100)).toEqual([{ t: 'cancel' }]);
      expect(g.state).toBe('camera');
      expect(g.end(order[0]!, 0, 0)).toEqual([]);
      expect(g.state).toBe('spent');
      // The finger left behind neither aims nor fires.
      expect(g.move(order[1]!, 150, 150)).toEqual([]);
      expect(g.end(order[1]!, 150, 150)).toEqual([]);
      expect(g.state).toBe('idle');
    }
  });

  it('two fingers orbit by their midpoint and zoom by their spread', () => {
    const g = new TouchGestures();
    g.start(1, 100, 300);
    g.start(2, 200, 300);
    // Both move right 30 px, one event per finger as a browser sends them: the midpoint moves 30
    // and the spread ends where it began (the zoom in between is undone: its ratios telescope).
    const pan = [...g.move(1, 130, 300), ...g.move(2, 230, 300)];
    expect(pan.reduce((s, a) => s + (a.t === 'orbit' ? a.dx : 0), 0)).toBe(30);
    expect(pan.reduce((s, a) => s + (a.t === 'orbit' ? a.dy : 0), 0)).toBe(0);
    expect(pan.reduce((p, a) => p * (a.t === 'zoom' ? a.ratio : 1), 1)).toBeCloseTo(1, 12);
    // Spread from 100 to 200 symmetrically, one finger at a time: the distance halves over the two
    // moves, and the midpoint's out-and-back orbits cancel.
    const acts = [...g.move(1, 80, 300), ...g.move(2, 280, 300)];
    const zoom = acts.flatMap((a) => (a.t === 'zoom' ? [a.ratio] : []));
    const orbitX = acts.reduce((s, a) => s + (a.t === 'orbit' ? a.dx : 0), 0);
    expect(zoom.length).toBe(2);
    expect(zoom[0]! * zoom[1]!).toBeCloseTo(0.5, 12);
    expect(orbitX).toBe(0);
  });

  it('the zooms over a pinch multiply to the spread ratio, and the orbits sum to the midpoint travel', () => {
    const g = new TouchGestures();
    g.start(7, 100, 400);
    g.start(9, 300, 400);
    let ratio = 1, dx = 0, dy = 0;
    for (let k = 1; k <= 10; k++) {
      for (const a of [...g.move(7, 100 + 4 * k, 400 - 3 * k), ...g.move(9, 300 - 6 * k, 400 - 3 * k)]) {
        if (a.t === 'zoom') ratio *= a.ratio;
        if (a.t === 'orbit') { dx += a.dx; dy += a.dy; }
      }
    }
    // Spread 200 -> 100: distance doubles. Midpoint (200, 400) -> (190, 370).
    expect(ratio).toBeCloseTo(2, 12);
    expect(dx).toBeCloseTo(-10, 12);
    expect(dy).toBeCloseTo(-30, 12);
  });

  it('fingers too close together do not zoom (no divide by a vanishing spread)', () => {
    const g = new TouchGestures();
    g.start(1, 100, 100);
    g.start(2, 100 + MIN_SPAN / 2, 100);
    for (const a of g.move(2, 100 + MIN_SPAN / 4, 100)) expect(a.t).not.toBe('zoom');
    // Once they part past MIN_SPAN the zoom picks up from there, not from the tiny spread.
    expect(g.move(2, 100 + 2 * MIN_SPAN, 100).filter((a) => a.t === 'zoom')).toEqual([]);
    const z = g.move(2, 100 + 4 * MIN_SPAN, 100).find((a) => a.t === 'zoom');
    expect(z).toEqual({ t: 'zoom', ratio: 0.5 });
  });

  it('a third finger is ignored, and the browser taking the touch never fires', () => {
    const g = new TouchGestures();
    g.start(1, 0, 0);
    g.start(2, 100, 0);
    expect(g.start(3, 50, 50)).toEqual([]);
    expect(g.move(3, 60, 60)).toEqual([]);
    expect(g.fingers).toBe(3);
    g.end(3, 0, 0);
    expect(g.state).toBe('camera');
    const h = new TouchGestures();
    h.start(4, 10, 10);
    expect(h.cancel(4)).toEqual([{ t: 'cancel' }]);
    expect(h.state).toBe('idle');
    // Events for fingers it never saw do nothing.
    expect(h.move(5, 1, 1)).toEqual([]);
    expect(h.end(5, 1, 1)).toEqual([]);
  });
});
