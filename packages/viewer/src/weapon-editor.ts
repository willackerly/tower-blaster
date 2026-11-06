// The weapon editor (roadmap C12, docs/design/weapon-editor.md): a WeaponSpec as a form, the
// canonical JSON beside it (edits flow both ways), a side view of its flight (@tb/weapons
// previewWeapon: the weapon's own runtime), and what one shot costs against the device tier's
// caps. Apply hands the weapon to the projectile panel, which fires it from then on (weapon.def
// in the URL), and is refused while the weapon has an error or is over the tier.
//
// The model is @tb/weapons edit.ts (pure draft -> draft edits). This file only draws it: a field
// edit updates the draft and everything derived from it in place, keeping the focus; a structural
// edit (a rule, action, child or kind added, removed or switched) draws the form again.
import {
  actionKind, addAction, addAnyTrigger, addChild, addRule, BLAST_FIELDS, type Draft, getAt, type GrenadeWorld, issuesAt, type KeyPath, munitionKeys,
  munitionList, type NumberField, previewWeapon, removeChild, renameChild, setActionKind, setAt, setTriggerKind, SHELL_FIELDS, SPLIT_FIELDS, SPLIT_PATTERNS,
  tierIssues, tierOf, TRIGGER_FIELDS, TRIGGER_KINDS, triggerKind, validateWeapon, type ActionKind, type TriggerKind, WEAPON_LIMITS, WEAPON_TIER_CAPS,
  type WeaponIssue, weaponLoad, type WeaponPreview, type WeaponSpec, type WeaponTier, writeWeapon,
} from '@tb/weapons';
import type { Vec3 } from '@tb/engine-api';
import { escapeHtml } from './html.ts';

/** The world a spec is written in (spec.ts: the viewer's cube units at scale 1, 60 Hz): the side view's. */
export const CUBE_WORLD: GrenadeWorld = { dt: 1 / 60, substeps: 1, gravity: [0, -9.81, 0], groundY: 0 };

/** The side view's launch: the spec's own shell (the game rack's), from 1.5 units up, at `pitch` degrees and `speed` units/s. */
export function sidePreview(spec: WeaponSpec, pitch: number, speed: number): WeaponPreview {
  const a = (pitch * Math.PI) / 180;
  return previewWeapon(spec, { shape: spec.shell.shape, density: spec.shell.density, pos: [0, 1.5, 0], vel: [speed * Math.cos(a), speed * Math.sin(a), 0] }, CUBE_WORLD);
}

const TRACK_COLOURS = ['#e8ebf2', '#f5b169', '#f2e36b'];
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/**
 * The side view as SVG: distance along the launch heading across, height up, fitted to the flight; each
 * munition's track (the shell white, children orange, grandchildren yellow; dashed from where it first
 * touches the ground, where the preview holds it still), its split as a dot, each blast as its sphere's
 * outline. Points across the heading (a ring's spread) are drawn where they fall on the plane.
 */
export function arcSvg(p: WeaponPreview, width = 380, height = 170): string {
  const origin = p.tracks[0]?.points[0] ?? [0, 0, 0];
  const v1 = p.tracks[0]?.points[1] ?? origin;
  const hx = v1[0] - origin[0], hz = v1[2] - origin[2], hl = Math.hypot(hx, hz) || 1;
  const along = (q: Vec3) => ((q[0] - origin[0]) * hx + (q[2] - origin[2]) * hz) / hl;
  let x0 = 0, x1 = 1, y1 = 1;
  for (const t of p.tracks) for (const q of t.points) { const x = along(q); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, q[1]); }
  for (const b of p.blasts) { const x = along(b.centre); x0 = Math.min(x0, x - b.radius); x1 = Math.max(x1, x + b.radius); y1 = Math.max(y1, b.centre[1] + b.radius); }
  const pad = 10, span = Math.max((x1 - x0) / (width - 2 * pad), y1 / (height - 2 * pad)), s = 1 / span;
  const X = (x: number) => pad + (x - x0) * s, Y = (y: number) => height - pad - y * s;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="side view of the weapon's flight">`];
  out.push(`<line x1="0" y1="${Y(0).toFixed(1)}" x2="${width}" y2="${Y(0).toFixed(1)}" stroke="#3a4459" stroke-width="1"/>`);
  for (const b of p.blasts) out.push(`<circle class="blast" cx="${X(along(b.centre)).toFixed(1)}" cy="${Y(b.centre[1]).toFixed(1)}" r="${(b.radius * s).toFixed(1)}" fill="rgba(216,105,63,0.10)" stroke="#d8693f" stroke-width="0.8"/>`);
  p.tracks.forEach((t) => {
    const depth = t.path ? t.path.split('.').length : 0, colour = TRACK_COLOURS[depth] ?? TRACK_COLOURS[2]!;
    const cut = t.contact === null ? t.points.length : Math.min(t.points.length, t.contact - t.start + 1);
    const pts = (a: number, b: number) => t.points.slice(a, b).map((q) => `${X(along(q)).toFixed(1)},${Y(q[1]).toFixed(1)}`).join(' ');
    out.push(`<polyline class="track" data-path="${escapeHtml(t.path)}" points="${pts(0, cut)}" fill="none" stroke="${colour}" stroke-width="${depth ? 1 : 1.6}"/>`);
    if (cut < t.points.length) out.push(`<polyline points="${pts(cut - 1, t.points.length)}" fill="none" stroke="${colour}" stroke-width="1" stroke-dasharray="3 3"/>`);
    if (t.end === 'split') { const q = t.points[t.points.length - 1]!; out.push(`<circle class="split" cx="${X(along(q)).toFixed(1)}" cy="${Y(q[1]).toFixed(1)}" r="3" fill="${colour}"/>`); }
  });
  const bar = 10 ** Math.floor(Math.log10(Math.max(1e-6, (x1 - x0) / 4)));
  out.push(`<line x1="${pad}" y1="${height - 3}" x2="${(pad + bar * s).toFixed(1)}" y2="${height - 3}" stroke="#9aa3b8"/><text x="${(pad + bar * s + 4).toFixed(1)}" y="${height - 1}" fill="#9aa3b8" font-size="9">${bar} units</text>`);
  out.push('</svg>');
  return out.join('');
}

/** One line on what the side view shows: splits, blasts and when, how far it reaches. */
export function previewSummary(p: WeaponPreview, dt = CUBE_WORLD.dt): string {
  const splits = p.tracks.filter((t) => t.end === 'split');
  const parts: string[] = [];
  if (splits.length) parts.push(`splits at ${splits.map((t) => `${fmt((t.start + t.points.length - 1) * dt)} s`).slice(0, 3).join(', ')}${splits.length > 3 ? '…' : ''}`);
  if (p.blasts.length) {
    const t0 = p.blasts[0]!.step * dt, t1 = p.blasts[p.blasts.length - 1]!.step * dt;
    parts.push(`${p.blasts.length} blast${p.blasts.length === 1 ? '' : 's'} ${t0 === t1 ? `at ${fmt(t0)} s` : `from ${fmt(t0)} to ${fmt(t1)} s`}`);
  } else parts.push('no blast');
  const open = p.tracks.filter((t) => t.end === 'open').length;
  if (open) parts.push(`${open} still there after ${fmt(p.steps * dt)} s`);
  return parts.join('; ');
}

/** The load of one shot against the tier's caps: three bars, red where it is over. */
export function budgetHtml(spec: WeaponSpec, tier: WeaponTier): string {
  const load = weaponLoad(spec), cap = WEAPON_TIER_CAPS[tier], needs = tierOf(spec);
  const row = (k: 'bodies' | 'blasts' | 'grenades', label: string) => {
    const f = load[k] / cap[k], over = load[k] > cap[k] * 1.01;
    return `<div class="bud${over ? ' over' : ''}" data-k="${k}"><span>${label}</span><span class="bar"><span style="width:${Math.min(100, f * 100).toFixed(1)}%"></span></span><span>${Number.isInteger(load[k]) ? load[k] : fmt(load[k])} / ${cap[k]}</span></div>`;
  };
  return `${row('bodies', 'bodies')}${row('blasts', 'blasts')}${row('grenades', 'energy (grenades)')}<div class="muted small">a shot on this device (tier ${tier}); ${needs ? `fits ${needs}${needs === 'low' ? ' and up' : needs === 'mid' ? ' and high' : ' only'}` : 'over every tier'}</div>`;
}

export interface WeaponEditorHooks {
  /** The tier whose caps Apply must respect. */
  tier(): WeaponTier;
  /** Fire this weapon from now on (the projectile panel offers it under its name); a string says why it was not taken. */
  apply(spec: WeaponSpec): string | void;
  /** Download this weapon's file. */
  download(spec: WeaponSpec): void;
  /** The editor was closed (or opened). */
  toggled?(open: boolean): void;
  /** The draft changed: its spec when valid, for the scene preview. */
  changed?(spec: WeaponSpec | null): void;
}

export interface WeaponEditor {
  open(spec: WeaponSpec): void;
  close(): void;
  readonly isOpen: boolean;
  /** The draft as it stands and its spec when it has no error (tests). */
  readonly draft: Draft;
  readonly spec: WeaponSpec | null;
}

const pathAttr = (p: KeyPath) => escapeHtml(JSON.stringify(p));
const num = (v: unknown) => (typeof v === 'number' ? String(v) : '');

function numberField(f: NumberField, base: KeyPath, d: Draft): string {
  // Array entries (a box's half extents, the launch speed range) are keyed by index.
  const p = [...base, /^\d+$/.test(f.key) ? Number(f.key) : f.key], v = getAt(d, p);
  const hint = f.optional ? ` placeholder="${escapeHtml(f.fallback ?? '')}"` : '';
  return `<label class="f"><span>${escapeHtml(f.label)}${f.unit ? ` <i>${escapeHtml(f.unit)}</i>` : ''}</span><input type="number" data-path="${pathAttr(p)}" value="${num(v)}" step="${f.int ? 1 : 'any'}" min="${f.range[0]}" max="${f.range[1]}"${hint}></label><div class="iss" data-for="${pathAttr(p)}"></div>`;
}

function kindSelect<K extends string>(kinds: readonly K[], cur: K | null, attrs: string): string {
  return `<select ${attrs}>${kinds.map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${k}</option>`).join('')}</select>`;
}

const TRIGGER_WORDS: Record<TriggerKind, string> = { after: 'after a time', near: 'near something', apex: 'at the top of its arc', then: 'one, then another', any: 'whichever first' };

function triggerHtml(d: Draft, p: KeyPath, depth: number): string {
  const t = getAt(d, p), k = triggerKind(t);
  const head = `<div class="trig" data-depth="${depth}"><label class="f"><span>when</span>${kindSelect(TRIGGER_KINDS, k, `data-act="trigger" data-path="${pathAttr(p)}"`)}</label><div class="muted small">${k ? TRIGGER_WORDS[k] : 'pick a trigger'}</div><div class="iss" data-for="${pathAttr(p)}"></div>`;
  let body = '';
  if (k === 'after') body = TRIGGER_FIELDS.after.map((f) => numberField(f, p, d)).join('');
  else if (k === 'near') {
    const g = getAt(d, [...p, 'ground']);
    body = TRIGGER_FIELDS.near.map((f) => numberField(f, p, d)).join('') + `<label class="f"><span>the ground counts</span><select data-path="${pathAttr([...p, 'ground'])}" data-type="bool"><option value=""${g === undefined ? ' selected' : ''}>yes (default)</option><option value="false"${g === false ? ' selected' : ''}>no</option></select></label>`;
  } else if (k === 'then') body = [0, 1].map((i) => triggerHtml(d, [...p, 'then', i], depth + 1)).join('');
  else if (k === 'any') {
    const xs = getAt(d, [...p, 'any']);
    const n = Array.isArray(xs) ? xs.length : 0;
    body = Array.from({ length: n }, (_, i) => `${triggerHtml(d, [...p, 'any', i], depth + 1)}${n > 1 ? `<button type="button" class="x" data-act="del" data-path="${pathAttr([...p, 'any', i])}" title="remove this trigger">×</button>` : ''}`).join('')
      + `<button type="button" class="add" data-act="addAny" data-path="${pathAttr(p)}">+ trigger</button>`;
  }
  return `${head}${body}</div>`;
}

function actionHtml(d: Draft, mun: string, p: KeyPath): string {
  const a = getAt(d, p), k = actionKind(a);
  let body = '';
  if (k === 'blast') body = BLAST_FIELDS.map((f) => numberField(f, [...p, 'blast'], d)).join('');
  else if (k === 'split') {
    const sp = [...p, 'split'], c = getAt(d, [...munitionKeys(mun), 'children']), names = c && typeof c === 'object' ? Object.keys(c) : [];
    const child = getAt(d, [...sp, 'child']), pat = getAt(d, [...sp, 'pattern']);
    body = `<label class="f"><span>child</span><select data-path="${pathAttr([...sp, 'child'])}">${names.length ? '' : '<option value="">(add a child)</option>'}${names.map((n) => `<option value="${escapeHtml(n)}"${n === child ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></label><div class="iss" data-for="${pathAttr([...sp, 'child'])}"></div>`
      + `<label class="f"><span>pattern</span><select data-path="${pathAttr([...sp, 'pattern'])}"><option value=""${pat === undefined ? ' selected' : ''}>sphere (default)</option>${SPLIT_PATTERNS.map((x) => `<option value="${x}"${x === pat ? ' selected' : ''}>${x}</option>`).join('')}</select></label>`
      + SPLIT_FIELDS.map((f) => numberField(f, sp, d)).join('');
  } else if (k === 'remove') body = '<div class="muted small">the munition is spent</div>';
  return `<div class="act"><label class="f"><span>do</span>${kindSelect(['blast', 'split', 'remove'] as const, k, `data-act="action" data-mun="${escapeHtml(mun)}" data-path="${pathAttr(p)}"`)}<button type="button" class="x" data-act="del" data-path="${pathAttr(p)}" title="remove this action">×</button></label><div class="iss" data-for="${pathAttr(p)}"></div>${body}</div>`;
}

function munitionHtml(d: Draft, mun: string): string {
  const base = munitionKeys(mun), sh = [...base, 'shell'], shape = getAt(d, [...sh, 'shape']) as { kind?: string } | undefined;
  const kind = shape?.kind === 'box' ? 'box' : 'sphere';
  const L = WEAPON_LIMITS;
  const size = kind === 'sphere'
    ? numberField({ key: 'radius', label: 'radius', unit: 'units', range: L.radius, optional: false }, [...sh, 'shape'], d)
    : [0, 1, 2].map((i) => numberField({ key: String(i), label: `half ${'xyz'[i]}`, unit: 'units', range: L.half, optional: false }, [...sh, 'shape', 'half'], d)).join('');
  const root = !mun;
  const speed = root ? [0, 1].map((i) => numberField({ key: String(i), label: i ? 'launch speed max' : 'launch speed min', unit: 'units/s', range: L.speed, optional: false }, [...sh, 'speed'], d)).join('') : '';
  const rules = getAt(d, [...base, 'rules']);
  const n = Array.isArray(rules) ? rules.length : 0;
  const ruleHtml = Array.from({ length: n }, (_, ri) => {
    const rp = [...base, 'rules', ri], acts = getAt(d, [...rp, 'do']), na = Array.isArray(acts) ? acts.length : 0;
    return `<fieldset class="rule"><legend>rule ${ri + 1} <button type="button" class="x" data-act="del" data-path="${pathAttr(rp)}" title="remove this rule">×</button></legend><div class="iss" data-for="${pathAttr(rp)}"></div>${triggerHtml(d, [...rp, 'when'], 0)}${Array.from({ length: na }, (_, ai) => actionHtml(d, mun, [...rp, 'do', ai])).join('')}<div class="buttons">${(['blast', 'split', 'remove'] as const).map((k) => `<button type="button" class="add" data-act="addAction" data-mun="${escapeHtml(mun)}" data-rule="${ri}" data-kind="${k}">+ ${k}</button>`).join('')}</div></fieldset>`;
  }).join('');
  const name = mun.split('.').pop() ?? '';
  const rename = mun ? `<label class="f"><span>child name</span><input type="text" name="childName" value="${escapeHtml(name)}" data-mun="${escapeHtml(mun)}"></label><div class="iss" data-for="${pathAttr(base)}"></div>` : '';
  return `${rename}<div class="h">Shell</div>`
    + `<label class="f"><span>shape</span>${kindSelect(['sphere', 'box'] as const, kind, `data-act="shape" data-path="${pathAttr([...sh, 'shape'])}"`)}</label><div class="iss" data-for="${pathAttr([...sh, 'shape'])}"></div>`
    + size + SHELL_FIELDS.map((f) => numberField(f, sh, d)).join('') + speed
    + `<div class="h">Rules</div><div class="iss" data-for="${pathAttr([...base, 'rules'])}"></div>${ruleHtml}<button type="button" class="add" data-act="addRule" data-mun="${escapeHtml(mun)}">+ rule</button>`;
}

/** The editor in `root` (a panel element; it fills it). */
export function mountWeaponEditor(root: HTMLElement, hooks: WeaponEditorHooks): WeaponEditor {
  root.innerHTML = `
    <div class="we-head"><b>Weapon editor</b><label class="f"><span>name</span><input type="text" data-path='["name"]' name="name"></label><button type="button" data-act="close" title="close">×</button></div>
    <div class="we-body">
      <div class="we-form">
        <div class="tree"></div>
        <div class="mun"></div>
      </div>
      <div class="we-side">
        <div class="h">Flight (side view; the spec's own shell)</div>
        <div class="arc"></div>
        <label class="f"><span>pitch <i>°</i></span><input type="range" name="pitch" min="0" max="85" value="35"></label>
        <label class="f"><span>speed <i>units/s</i></span><input type="range" name="speed" min="0" max="100" value="50"></label>
        <div class="arc-out muted small"></div>
        <div class="h">Cost of a shot</div>
        <div class="budget"></div>
        <div class="h">JSON</div>
        <textarea name="json" spellcheck="false" rows="12"></textarea>
        <div class="json-out small"></div>
        <div class="issues small"></div>
        <div class="buttons"><button type="button" data-act="apply">Fire this weapon</button><button type="button" data-act="download">Download</button></div>
        <div class="apply-out small"></div>
      </div>
    </div>`;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const tree = q<HTMLElement>('.tree'), munBox = q<HTMLElement>('.mun'), arc = q<HTMLElement>('.arc'), arcOut = q<HTMLElement>('.arc-out');
  const budget = q<HTMLElement>('.budget'), json = q<HTMLTextAreaElement>('textarea[name=json]'), jsonOut = q<HTMLElement>('.json-out');
  const issuesBox = q<HTMLElement>('.issues'), applyBtn = q<HTMLButtonElement>('button[data-act=apply]'), applyOut = q<HTMLElement>('.apply-out');
  const pitch = q<HTMLInputElement>('input[name=pitch]'), speed = q<HTMLInputElement>('input[name=speed]');
  let draft: Draft = {}, spec: WeaponSpec | null = null, issues: WeaponIssue[] = [], selected = '', isOpen = false;

  function drawForm() {
    const list = munitionList(draft);
    if (!list.some((m) => m.path === selected)) selected = '';
    tree.innerHTML = list.map((m) => `<button type="button" class="node${m.path === selected ? ' on' : ''}" data-act="select" data-mun="${escapeHtml(m.path)}" style="margin-left:${(m.depth - 1) * 14}px">${escapeHtml(m.path ? m.path.split('.').pop()! : 'shell')}</button>`).join('')
      + `<button type="button" class="add" data-act="addChild" data-mun="${escapeHtml(selected)}"${selected.split('.').length >= 2 ? ' disabled' : ''}>+ child of ${escapeHtml(selected ? selected.split('.').pop()! : 'shell')}</button>`
      + (selected ? `<button type="button" class="x" data-act="delChild" data-mun="${escapeHtml(selected)}">remove ${escapeHtml(selected.split('.').pop()!)}</button>` : '');
    munBox.innerHTML = munitionHtml(draft, selected);
    q<HTMLInputElement>('input[name=name]').value = typeof draft.name === 'string' ? draft.name : '';
  }

  /** Everything derived from the draft: validity, issues by field, JSON (unless it is what is being typed), the flight, the budget. */
  function derive(fromJson = false) {
    const v = validateWeapon(draft);
    spec = v.spec;
    issues = v.issues;
    for (const el of root.querySelectorAll<HTMLElement>('.iss')) {
      const here = issuesAt(issues, JSON.parse(el.dataset.for!) as KeyPath);
      el.textContent = here.map((i) => i.message).join('; ');
      el.classList.toggle('warn', here.some((i) => i.level === 'error'));
    }
    if (!fromJson) json.value = spec ? writeWeapon(spec) : JSON.stringify(draft, null, 2);
    const tier = hooks.tier(), over = spec ? tierIssues(spec, tier) : [];
    const shown = [...issues, ...over];
    issuesBox.innerHTML = shown.map((i) => `<div class="${i.level === 'error' ? 'warn' : 'muted'}">${escapeHtml(i.path || 'weapon')}: ${escapeHtml(i.message)}</div>`).join('');
    applyBtn.disabled = !spec || over.length > 0;
    applyOut.textContent = !spec ? 'fix the errors to fire it' : over.length ? `over the ${tier} tier's caps: this device would refuse it` : '';
    if (spec) {
      const [lo, hi] = spec.shell.speed ?? [0, 50];
      speed.min = String(lo);
      speed.max = String(Math.max(hi, lo + 1));
      const s = Math.min(Math.max(Number(speed.value), lo), hi);
      speed.value = String(s);
      let p: WeaponPreview | null = null;
      try { p = sidePreview(spec, Number(pitch.value), s); } catch (e) { arcOut.textContent = `preview: ${e instanceof Error ? e.message : String(e)}`; }
      if (p) { arc.innerHTML = arcSvg(p); arcOut.textContent = `at ${fmt(s)} units/s: ${previewSummary(p)}`; }
      budget.innerHTML = budgetHtml(spec, tier);
    } else {
      arcOut.textContent = 'no flight while the weapon has errors';
      budget.innerHTML = '';
    }
    hooks.changed?.(spec);
  }

  const structural = (next: Draft | null) => {
    if (!next) return;
    draft = next;
    drawForm();
    derive();
  };

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (el === json) {
      let v: unknown;
      try { v = JSON.parse(json.value); } catch (err) { jsonOut.textContent = `not JSON: ${err instanceof Error ? err.message : String(err)}`; jsonOut.className = 'json-out small warn'; return; }
      if (typeof v !== 'object' || v === null || Array.isArray(v)) { jsonOut.textContent = 'a weapon is a JSON object'; jsonOut.className = 'json-out small warn'; return; }
      jsonOut.textContent = '';
      draft = v as Draft;
      drawForm();
      derive(true);
      return;
    }
    if (el === pitch || el === speed) { derive(); return; }
    if (el.getAttribute('name') === 'childName' || el.dataset.act) return;
    const raw = el.dataset.path;
    if (!raw || el.tagName === 'SELECT') return;
    const path = JSON.parse(raw) as KeyPath;
    const value = el.value === '' ? undefined : el.type === 'number' ? Number(el.value) : el.value;
    draft = setAt(draft, path, value);
    derive();
  });
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.getAttribute('name') === 'childName') {
      const mun = el.dataset.mun!, parent = mun.split('.').slice(0, -1).join('.'), from = mun.split('.').pop()!;
      const next = renameChild(draft, parent, from, el.value);
      if (next) { selected = parent ? `${parent}.${el.value}` : el.value; structural(next); } else el.value = from;
      return;
    }
    if (el.tagName !== 'SELECT' || !el.dataset.path) return;
    const path = JSON.parse(el.dataset.path) as KeyPath;
    if (el.dataset.act === 'trigger') return structural(setTriggerKind(draft, path, el.value as TriggerKind));
    if (el.dataset.act === 'action') return structural(setActionKind(draft, el.dataset.mun ?? '', path, el.value as ActionKind));
    if (el.dataset.act === 'shape') return structural(setAt(draft, path, el.value === 'box' ? { kind: 'box', half: [0.25, 0.25, 0.25] } : { kind: 'sphere', radius: 0.25 }));
    const value = el.value === '' ? undefined : el.dataset.type === 'bool' ? el.value === 'true' : el.value;
    draft = setAt(draft, path, value);
    derive();
  });
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]');
    if (!el) return;
    const act = el.dataset.act!, mun = el.dataset.mun ?? '';
    const path = el.dataset.path ? (JSON.parse(el.dataset.path) as KeyPath) : [];
    switch (act) {
      case 'close': return close();
      case 'select': selected = mun; drawForm(); derive(); return;
      case 'addRule': return structural(addRule(draft, mun));
      case 'addAction': return structural(addAction(draft, mun, Number(el.dataset.rule), el.dataset.kind as ActionKind));
      case 'addAny': return structural(addAnyTrigger(draft, path));
      case 'del': return structural(setAt(draft, path, undefined));
      case 'addChild': {
        const r = addChild(draft, mun);
        if (r) { selected = r.path; structural(r.draft); }
        return;
      }
      case 'delChild': {
        const parent = mun.split('.').slice(0, -1).join('.');
        selected = parent;
        return structural(removeChild(draft, parent, mun.split('.').pop()!));
      }
      case 'apply': {
        if (!spec || tierIssues(spec, hooks.tier()).length) return;
        const why = hooks.apply(spec);
        applyOut.textContent = why ? why : `firing ${spec.name ?? 'custom'} from now on`;
        applyOut.classList.toggle('warn', !!why);
        return;
      }
      case 'download': if (spec) hooks.download(spec); return;
    }
  });

  function open(s: WeaponSpec) {
    draft = JSON.parse(JSON.stringify(s)) as Draft;
    selected = '';
    root.hidden = false;
    isOpen = true;
    drawForm();
    derive();
    hooks.toggled?.(true);
  }
  function close() {
    root.hidden = true;
    isOpen = false;
    hooks.toggled?.(false);
  }
  root.hidden = true;
  return {
    open, close,
    get isOpen() { return isOpen; },
    get draft() { return draft; },
    get spec() { return spec; },
  };
}

/** The editor's styles (the panel's look: index.html's .panel), installed once. */
export const WEAPON_EDITOR_CSS = `
  #weapon-editor { position: fixed; top: 10px; right: 10px; width: min(760px, calc(100vw - 20px)); max-height: calc(100vh - 20px); overflow-y: auto; z-index: 5; font-size: 12px; }
  #weapon-editor .we-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  #weapon-editor .we-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  @media (max-width: 640px) { #weapon-editor .we-body { grid-template-columns: minmax(0, 1fr); } }
  #weapon-editor .h { color: #9aa3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 6px; }
  #weapon-editor .f { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 2px 0; }
  #weapon-editor .f i { color: #9aa3b8; font-style: normal; }
  #weapon-editor input[type=number], #weapon-editor input[type=text], #weapon-editor select { font: inherit; width: 110px; box-sizing: border-box; padding: 2px 5px; border: 1px solid #3a4459; border-radius: 4px; background: #1b2030; color: #e8ebf2; }
  #weapon-editor input[type=range] { width: 140px; }
  #weapon-editor textarea { width: 100%; box-sizing: border-box; font: 11px ui-monospace, Menlo, monospace; background: #1b2030; color: #e8ebf2; border: 1px solid #3a4459; border-radius: 4px; }
  #weapon-editor fieldset.rule { border: 1px solid #3a4459; border-radius: 6px; margin: 6px 0; padding: 4px 8px; }
  #weapon-editor .trig[data-depth="1"], #weapon-editor .trig[data-depth="2"], #weapon-editor .trig[data-depth="3"] { border-left: 2px solid #3a4459; padding-left: 8px; }
  #weapon-editor .act { border-top: 1px dashed #3a4459; margin-top: 4px; padding-top: 4px; }
  #weapon-editor .tree { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; margin-bottom: 6px; }
  #weapon-editor button { font: inherit; padding: 3px 8px; border: 0; border-radius: 5px; background: #d8693f; color: #fff; cursor: pointer; }
  #weapon-editor button.node { background: #2b3242; }
  #weapon-editor button.node.on { background: #4a5878; }
  #weapon-editor button.add { background: #2b3242; color: #e8ebf2; }
  #weapon-editor button.x { background: transparent; color: #9aa3b8; padding: 0 4px; }
  #weapon-editor button:disabled { background: #2b3242; color: #6b7486; cursor: default; }
  #weapon-editor .buttons { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  #weapon-editor .iss:empty { display: none; }
  #weapon-editor .iss, #weapon-editor .muted { color: #9aa3b8; }
  #weapon-editor .warn { color: #f5b169; }
  #weapon-editor .small { font-size: 11px; }
  #weapon-editor .arc svg { width: 100%; height: auto; background: #10141d; border-radius: 4px; }
  #weapon-editor .bud { display: grid; grid-template-columns: 110px 1fr 70px; gap: 6px; align-items: center; }
  #weapon-editor .bud .bar { height: 6px; background: #2b3242; border-radius: 3px; overflow: hidden; }
  #weapon-editor .bud .bar span { display: block; height: 100%; background: #6fbf8a; }
  #weapon-editor .bud.over .bar span { background: #e0603a; }
  #weapon-editor .bud.over { color: #f5b169; }
`;
