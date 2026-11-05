// Touch controls (roadmap U4): what fingers on the game's canvas mean, as a
// pure state machine the page feeds pointer events into. One finger aims where
// it is and fires where it lifts (a tap is a short one); two fingers move the
// camera, the midpoint orbiting as a mouse drag does and the spread zooming as
// the wheel does; a second finger landing while one aims cancels that shot.
// The camera moves only on these gestures (the camera rule, #169). Mouse and
// pen keep the desktop controls (play.ts): hover aims, click fires, drag orbits.
// docs/game/touch-controls.md has the gesture map and the alternatives weighed.

/** ?touch=auto (default: on for a coarse pointer, then whatever the last pointer was), 1 (always) or 0 (never). */
export type TouchMode = 'auto' | 'on' | 'off';

export function touchMode(q: URLSearchParams): TouchMode {
  const v = q.get('touch');
  if (v === null || v === 'auto') return 'auto';
  if (v === '1') return 'on';
  if (v === '0') return 'off';
  throw new Error(`touch must be auto, 1 or 0: ${v}`);
}

/**
 * Whether the page shows its touch face (the HUD's buttons, the touch help) now: a fixed mode
 * says so; auto starts from the primary pointer (coarse: a phone or tablet) and then follows the
 * pointer last put down, so a laptop with a touch screen shows whichever the player is using.
 */
export function touchFace(mode: TouchMode, coarse: boolean, lastPointer: string | null): boolean {
  if (mode !== 'auto') return mode === 'on';
  if (lastPointer === 'touch') return true;
  if (lastPointer === 'mouse' || lastPointer === 'pen') return false;
  return coarse;
}

/** What a touch event asks of the game. Positions are client pixels; the page turns them into a ray. */
export type TouchAction =
  | { t: 'aim'; x: number; y: number }
  | { t: 'fire'; x: number; y: number }
  /** Drop the aim without firing (a second finger landed, or the browser took the touch). */
  | { t: 'cancel' }
  /** Orbit by a drag of (dx, dy) pixels, as a mouse drag does (orbitDrag). */
  | { t: 'orbit'; dx: number; dy: number }
  /** Multiply the camera distance by this (under 1: the fingers spread, so zoom in). */
  | { t: 'zoom'; ratio: number };

/**
 * idle: no finger down. aim: one finger aiming. camera: two fingers moving the camera.
 * spent: a camera gesture is ending (fingers still down): nothing aims or fires until every finger is up.
 */
export type GestureState = 'idle' | 'aim' | 'camera' | 'spent';

/** Spreads under this (px) are too close to read a pinch from: the zoom holds until they part. */
export const MIN_SPAN = 12;

type Pt = [number, number];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const span = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class TouchGestures {
  state: GestureState = 'idle';
  /** Every finger down, by pointer id. */
  private readonly down = new Map<number, Pt>();
  /** The aiming finger, or the camera's two (the first two down; a third is ignored). */
  private ids: number[] = [];
  private lastMid: Pt = [0, 0];
  private lastSpan = 0;

  /** Fingers down now. */
  get fingers(): number { return this.down.size; }

  start(id: number, x: number, y: number): TouchAction[] {
    this.down.set(id, [x, y]);
    if (this.state === 'idle') {
      this.state = 'aim';
      this.ids = [id];
      return [{ t: 'aim', x, y }];
    }
    if (this.state === 'aim') {
      // A second finger: this is a camera gesture, and the shot being aimed is called off.
      this.state = 'camera';
      this.ids = [this.ids[0]!, id];
      this.rebase();
      return [{ t: 'cancel' }];
    }
    return []; // a third finger, or one landing while a camera gesture ends: ignored
  }

  move(id: number, x: number, y: number): TouchAction[] {
    if (!this.down.has(id)) return [];
    this.down.set(id, [x, y]);
    if (this.state === 'aim' && id === this.ids[0]) return [{ t: 'aim', x, y }];
    if (this.state !== 'camera' || !this.ids.includes(id)) return [];
    const a = this.down.get(this.ids[0]!)!, b = this.down.get(this.ids[1]!)!;
    const m = mid(a, b), s = span(a, b), out: TouchAction[] = [];
    const dx = m[0] - this.lastMid[0], dy = m[1] - this.lastMid[1];
    if (dx !== 0 || dy !== 0) out.push({ t: 'orbit', dx, dy });
    if (this.lastSpan >= MIN_SPAN && s >= MIN_SPAN && s !== this.lastSpan) out.push({ t: 'zoom', ratio: this.lastSpan / s });
    this.lastMid = m;
    if (s >= MIN_SPAN || this.lastSpan < MIN_SPAN) this.lastSpan = s;
    return out;
  }

  /** A finger lifted: the aiming finger fires where it lifts. */
  end(id: number, x: number, y: number): TouchAction[] {
    return this.lift(id, x, y, true);
  }

  /** The browser took the touch (pointercancel): like a lift, but never fires. */
  cancel(id: number): TouchAction[] {
    return this.lift(id, 0, 0, false);
  }

  private lift(id: number, x: number, y: number, fires: boolean): TouchAction[] {
    if (!this.down.delete(id)) return [];
    if (this.state === 'aim' && id === this.ids[0]) {
      this.state = 'idle';
      this.ids = [];
      return [fires ? { t: 'fire', x, y } : { t: 'cancel' }];
    }
    if (this.state === 'camera' && this.ids.includes(id)) this.state = 'spent';
    if (this.down.size === 0) { this.state = 'idle'; this.ids = []; }
    return [];
  }

  private rebase() {
    const a = this.down.get(this.ids[0]!)!, b = this.down.get(this.ids[1]!)!;
    this.lastMid = mid(a, b);
    this.lastSpan = span(a, b);
  }
}
