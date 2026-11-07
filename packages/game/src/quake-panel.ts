// Aftershock's quake designer (M7, docs/game/aftershock.md): the HUD block the player sets a quake on while the
// Quake chip is selected, in place of the power and height rows. Four dials (strength, frequency, duration, axis),
// each a row with minus and plus buttons and keys; a seismograph of the side load the towers will feel; a compass
// showing the axis as seen from the camera; and the quake's energy against the level's budget. Start (Enter) fires
// it. Pure: the dial and its HTML are functions of the level and the camera's yaw, so they are tested without a
// page. The camera never moves for a quake (Will, 2026-11-02): the ground shakes the towers, the view stays put.
import { type CompiledLevel, naiveQuake, placedCost, quakeEnergy, quakeInputs, quakeRefusal, quakeRulesOf, type QuakeShot } from '@tb/keystone';
import { esc } from './hud.ts';

/** The four dials, in QuakeShot's units: peak % g, hz 0.1 Hz, sec 0.1 s, axis degrees 0..179. */
export type QuakeDial = Pick<QuakeShot, 'peak' | 'hz' | 'sec' | 'axis'>;
export type DialField = keyof QuakeDial;

/** Strength steps by 5% g; frequency and duration walk these stops (QuakeShot units), kept to the level's range. */
export const PEAK_STEP = 5;
export const HZ_STOPS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40] as const;
export const SEC_STOPS = [5, 10, 15, 20, 30, 40, 60, 80, 120, 160, 200] as const;

/** The dial's keys: lower and raise each field (the axis turns by the level's axis step). */
export const DIAL_KEYS: Readonly<Record<DialField, [string, string]>> = { peak: ['q', 'e'], hz: ['a', 'd'], sec: ['z', 'x'], axis: ['c', 'v'] };

/** A field's stops on this level: the shared stops inside the level's range, and the range's own ends. */
export function dialStops(c: CompiledLevel, field: 'hz' | 'sec'): number[] {
  const r = quakeRulesOf(c.def)[field], all = field === 'hz' ? HZ_STOPS : SEC_STOPS;
  return [...new Set([r[0], ...all.filter((v) => v > r[0] && v < r[1]), r[1]])];
}

const nearest = (xs: readonly number[], v: number) => xs.reduce((a, x) => (Math.abs(x - v) < Math.abs(a - v) ? x : a));

/**
 * Where the dial starts on a level: a moderate quake, about 1 Hz for 3 s at 0.3 g along x, snapped to the level's
 * stops. Not a hint: the levels' answers sit elsewhere on the dial (docs/game/aftershock.md, "Levels").
 */
export function dialStart(c: CompiledLevel): QuakeDial {
  const r = quakeRulesOf(c.def);
  if (r.fixed) return { ...r.fixed };
  return { peak: Math.min(r.peakMax, 30), hz: nearest(dialStops(c, 'hz'), 10), sec: nearest(dialStops(c, 'sec'), 30), axis: 0 };
}

/** The dial with `field` moved one step in direction `dir` (-1 or +1), kept to the level's range. The axis wraps. */
export function dialStep(c: CompiledLevel, d: QuakeDial, field: DialField, dir: -1 | 1): QuakeDial {
  const r = quakeRulesOf(c.def);
  // A retrofit's quake is the level's (QuakeRules.fixed): the dial does not move.
  if (r.fixed) return d;
  switch (field) {
    case 'peak': {
      // To the next multiple of the step that way (a peak off the grid, from a line or a capped level, snaps on).
      const v = dir > 0 ? Math.floor(d.peak / PEAK_STEP) * PEAK_STEP + PEAK_STEP : Math.ceil(d.peak / PEAK_STEP) * PEAK_STEP - PEAK_STEP;
      return { ...d, peak: Math.max(Math.min(PEAK_STEP, r.peakMax), Math.min(r.peakMax, v)) };
    }
    case 'hz': case 'sec': {
      const xs = dialStops(c, field), i = xs.indexOf(nearest(xs, d[field]));
      return { ...d, [field]: xs[Math.max(0, Math.min(xs.length - 1, i + dir))]! };
    }
    case 'axis': return { ...d, axis: (((d.axis + dir * r.axisStep) % 180) + 180) % 180 };
  }
}

export const dialShot = (d: QuakeDial): QuakeShot => ({ ammo: 'quake', peak: d.peak, hz: d.hz, sec: d.sec, axis: d.axis });

/** The dial's fields as the player reads them: "0.30 g", "1.0 Hz", "3.0 s", "45°". */
export const dialText = (d: QuakeDial): Record<DialField, string> => ({ peak: `${(d.peak / 100).toFixed(2)} g`, hz: `${(d.hz / 10).toFixed(1)} Hz`, sec: `${(d.sec / 10).toFixed(1)} s`, axis: `${d.axis}°` });

/**
 * The seismograph: the side load along the axis, in g, at each step of the quake, read off the very field events
 * the engine will be given (quakeInputs), held between keys as the engine holds them. Returns `samples` values
 * spread over the quake, for the strip's polyline.
 */
export function seismogram(c: CompiledLevel, shot: QuakeShot, samples = 160): number[] {
  const ev = quakeInputs(c, shot, 0), g = c.scene.gravity, m = Math.hypot(g[0], g[1], g[2]);
  const n = ev.at(-1)?.step ?? 0, a = (shot.axis * Math.PI) / 180, ax = Math.cos(a), az = Math.sin(a);
  const out: number[] = [];
  let k = 0, side = 0;
  for (let i = 0; i < samples; i++) {
    const step = Math.round((i / (samples - 1)) * n);
    while (k < ev.length && ev[k]!.step <= step) { const v = ev[k]!.gravity!; side = ((v[0] - g[0]) * ax + (v[2] - g[2]) * az) / m; k++; }
    out.push(side);
  }
  return out;
}

/**
 * The axis as the camera sees it, an angle in the panel's SVG (x right, y down), radians. The camera at yaw y looks
 * along (-sin y, 0, -cos y) with screen right (cos y, 0, -sin y) (render camera.ts eyeOf); the axis (cos t, 0, sin t)
 * then points cos(t + y) right and sin(t + y) toward the viewer, which is down the screen.
 */
export const axisOnScreen = (axisDeg: number, yaw: number): number => (axisDeg * Math.PI) / 180 + yaw;

const f1 = (x: number) => x.toFixed(1);

/** The seismograph strip: a polyline of the side load, scaled to the dial's top strength. */
function stripSvg(trace: readonly number[], top: number): string {
  const w = 180, h = 40, mid = h / 2, s = (mid - 2) / Math.max(top, 1e-9);
  const pts = trace.map((v, i) => `${f1((i / Math.max(1, trace.length - 1)) * w)},${f1(mid - v * s)}`).join(' ');
  return `<svg class="seismo" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="seismograph"><line x1="0" y1="${mid}" x2="${w}" y2="${mid}" class="axis"/><polyline points="${pts}"/></svg>`;
}

/** The compass: a double-headed arrow along the axis as the camera sees it. */
function compassSvg(angle: number): string {
  const r = 13, c = 16, dx = Math.cos(angle) * r, dy = Math.sin(angle) * r;
  return `<svg class="compass" viewBox="0 0 32 32" width="32" height="32" aria-label="quake axis"><circle cx="${c}" cy="${c}" r="15"/><line x1="${f1(c - dx)}" y1="${f1(c - dy)}" x2="${f1(c + dx)}" y2="${f1(c + dy)}"/><circle class="tip" cx="${f1(c + dx)}" cy="${f1(c + dy)}" r="2.5"/><circle class="tip" cx="${f1(c - dx)}" cy="${f1(c - dy)}" r="2.5"/></svg>`;
}

const STEP_BUTTON = (field: DialField, dir: -1 | 1) => `<button class="qd" data-act="qdial" data-arg="${field}:${dir}" aria-label="${dir < 0 ? 'Less' : 'More'} ${field}">${dir < 0 ? '−' : '+'}</button>`;
const LABEL: Record<DialField, string> = { peak: 'Strength', hz: 'Frequency', sec: 'Duration', axis: 'Axis' };

/**
 * The quake designer's HUD block for dial `d` on level `c`, the camera at `yaw`: the four dial rows, the
 * seismograph, the energy meter (against the level's budget; without one, against the naive quake's energy, the
 * dial's brute end) and Start. `refused` greys Start and says why (quakeRefusal); `trace` is the seismogram, passed
 * in so the page computes it once per dial.
 */
export function quakePanelHtml(c: CompiledLevel, d: QuakeDial, yaw: number, trace: readonly number[], canStart: boolean): string {
  const shot = dialShot(d), r = quakeRulesOf(c.def), text = dialText(d), refused = quakeRefusal(c, shot);
  if (r.fixed) return fixedPanelHtml(c, d, yaw, trace, canStart && !refused);
  const row = (f: DialField, extra = '') => `<div class="row"><span>${LABEL[f]} <kbd>${DIAL_KEYS[f][0].toUpperCase()}</kbd><kbd>${DIAL_KEYS[f][1].toUpperCase()}</kbd></span><span class="power">${STEP_BUTTON(f, -1)}<b class="qv" data-q="${f}">${text[f]}</b>${extra}${STEP_BUTTON(f, 1)}</span></div>`;
  const e = quakeEnergy(c, shot), cap = r.budget ?? quakeEnergy(c, naiveQuake(c)), share = Math.min(1, e / cap), over = r.budget !== undefined && e > r.budget * (1 + 1e-9);
  const meter = `<span class="qe" title="${r.budget !== undefined ? `budget ${fmtJ(r.budget)}` : `the strongest, slowest, longest quake: ${fmtJ(cap)}`}"><span class="bar${over ? ' over' : ''}"><i style="width:${(100 * share).toFixed(1)}%"></i></span><b class="${over ? 'bad' : ''}">${fmtJ(e)}</b></span>`;
  const note = `<div class="small qnote ${over ? 'bad' : 'hint'}">${r.budget !== undefined ? `${over ? 'over the' : 'of a'} ${fmtJ(r.budget)} budget` : `the bar is the strongest, slowest, longest quake: ${fmtJ(cap)}`}${refused && !over ? ` · ${esc(refused)}` : ''}</div>`;
  const start = `<button data-act="quake" class="quake-go"${canStart && !refused ? '' : ' disabled'}><kbd>Enter</kbd> Start<span class="qlong"> the quake</span></button>`;
  // The foot: the seismograph, the energy meter and Start; on the docked phone HUD one line (ui.ts).
  return `<div class="quake-panel"><div class="qdials">${row('peak')}${row('hz')}${row('sec')}${row('axis', compassSvg(axisOnScreen(d.axis, yaw)))}</div>
    <div class="qfoot">${stripSvg(trace, r.peakMax / 100)}${meter}${start}</div>${note}</div>`;
}

/**
 * A retrofit's panel (QuakeRules.fixed, M7b): the level's quake read out (no dial buttons or keys: it is coming
 * whatever the player does), its seismograph, the bracing spent against the build budget, and Start.
 */
function fixedPanelHtml(c: CompiledLevel, d: QuakeDial, yaw: number, trace: readonly number[], canStart: boolean): string {
  const text = dialText(d), spent = placedCost(c.def), budget = c.def.build?.budget;
  const row = (f: DialField, extra = '') => `<div class="row"><span>${LABEL[f]}</span><span class="power"><b class="qv" data-q="${f}">${text[f]}</b>${extra}</span></div>`;
  const braced = `<span class="qe qbrace" title="what you placed, against the build budget"><b>${spent}${budget !== undefined ? ` / ${budget}` : ''}</b> braced</span>`;
  const start = `<button data-act="quake" class="quake-go"${canStart ? '' : ' disabled'}><kbd>Enter</kbd> Start<span class="qlong"> the quake</span></button>`;
  return `<div class="quake-panel fixed"><div class="qdials">${row('peak')}${row('hz')}${row('sec')}${row('axis', compassSvg(axisOnScreen(d.axis, yaw)))}</div>
    <div class="qfoot">${stripSvg(trace, d.peak / 100)}${braced}${start}</div><div class="small qnote hint">the level's quake: it is coming, brace for it</div></div>`;
}

/** Joules for the meter: "209 J", "14.3 kJ". */
export const fmtJ = (j: number) => (j >= 10_000 ? `${(j / 1000).toFixed(1)} kJ` : `${Math.round(j)} J`);
