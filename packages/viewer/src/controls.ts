// The viewer's control panel: the scene (scenario or level, its params, seed, cube size, substeps,
// Bounce, and for a level the rules it plays by), rebuilt on demand, and the projectile and the look, applied as soon as a field
// changes; and the whole setup saved to or loaded from a JSON file (scene-file.ts). The panel
// only proposes configs; main.ts decides how to apply them (live, or by reset).
import { parseSpec } from '@tb/bench';
import { type Env, ENVS, type Ground, GROUNDS, linearToSrgb, LOOKS, REAL_DEFAULTS, REAL_KNOBS, type RealKnob, type RealOptions, srgbToLinear, type Stone, STONES, type V3 } from '@tb/render';
import type { PaceFeel } from '@tb/game';
import { AVBD_ITERATIONS, compileLevel, LEVELS, PRESETTLE_STEPS } from '@tb/keystone';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import { type CameraPose, type Framing, FRAMING_LIMITS } from './camera.ts';
import { escapeHtml } from './html.ts';
import { levelIssues, levelJson, parseLevelDef } from './level-file.ts';
import { autoSubsteps, AVBD_ENGINES, bounceOn, checkKeystone, DEFAULT_BOUNCE, DEFAULT_CONFIG, defaultLook, defaultPresettle, keystoneEngine, levelDef, MAX_PRESETTLE, MAX_SUBSTEPS, type Rules, SCALE_LIMITS, type ViewerConfig, withOption } from './params.ts';
import { blastWeight, checkBlast } from '@tb/engine-api';
import { DEFAULT_GRENADE, FUSES, GRENADE_LIMITS, type GrenadeSpec } from '@tb/weapons';
import { GRENADE_BLAST_KEYS, GRENADE_NUMBERS, parseProjectile, type Projectile, projectileMass } from './projectile.ts';
import { parseSceneFile, sceneFile, sceneFileName } from './scene-file.ts';

/** Readable names for scenario params; the rest show their key. */
export const PARAM_LABELS: Record<string, string> = {
  towers: 'buildings', W: 'width (cubes)', D: 'depth (cubes)', H: 'height (cubes)', F: 'footprint (cubes)',
  N: 'cubes in total', street: 'street (m)', vary: 'height variation 0-1', gap: 'gap (m)', C: 'base (cubes)',
  depth: 'depth (cubes)', running: 'running bond', holeW: 'hole width', holeH: 'hole height', holeY: 'hole row',
  deg: 'lean (deg)', floors: 'floors', bays: 'bays', bay: 'bay (m)', stretch: 'spacing x', offset: 'offset (m)', ratio: 'top mass x',
  radius: 'ball radius (m)', speed: 'ball speed (m/s)', massRatio: 'ball mass x', fireStep: 'fire at step',
};

export interface ControlsHooks {
  config(): ViewerConfig;
  /** Load this scene (the R reset path). */
  rebuild(next: ViewerConfig): void;
  /** Fire this from now on. */
  setProjectile(p: Projectile): void;
  /** Draw with this look from now on (real: the real look's knobs that differ from REAL_DEFAULTS). */
  setLook(look: string, real: Partial<RealOptions>): void;
  /** Frame the scene this way from now on (and re-frame it now). */
  setView(view: Framing): void;
  /** Where the camera is now (saved as where the scene starts); null: framed afresh (Keystone frames its level). */
  camera(): CameraPose | null;
  /** Switch to this config, loaded from a file named name. */
  load(next: ViewerConfig, name: string): void;
}

/** The grenade's fields in the panel: label and step, by URL key (grenade.<key>). */
export const GRENADE_FIELDS: Record<(typeof GRENADE_NUMBERS)[number] | (typeof GRENADE_BLAST_KEYS)[number], [string, string]> = {
  delay: ['fuse delay (s)', 'any'], prox: ['proximity (m)', 'any'], arm: ['arms after (s)', 'any'],
  radius: ['blast radius (m)', 'any'], impulse: ['impulse (N·s/m²)', 'any'], core: ['flat core (x radius)', 'any'], falloff: ['falloff power', '1'],
  maxDv: ['max kick (m/s)', 'any'], maxSpeed: ['speed cap (m/s)', 'any'],
};

/** What a grenade's blast does to a scene cube (1 kg, 1 m) at a few distances, at scale 1. */
export function grenadeSummary(g: GrenadeSpec): string {
  const b = checkBlast({ centre: [0, 0, 0], ...g.blast });
  const kick = (d: number) => (d < b.radius ? Math.min(b.maxDv, b.impulse * blastWeight(b, d) * 1.5) : 0);
  const at = [1, 0.5 * b.radius, 0.8 * b.radius].map((d) => +d.toPrecision(2));
  return `a cube at ${at.map((d) => `${d} m gets ${kick(d).toPrecision(2)}`).join(', ')} m/s`;
}

/** Linear albedo to a colour input's #rrggbb (sRGB) and back, to 3 decimals. */
export const albedoHex = (c: V3) => `#${c.map((x) => Math.round(255 * linearToSrgb(Math.min(Math.max(x, 0), 1))).toString(16).padStart(2, '0')).join('')}`;
export const hexAlbedo = (h: string): V3 => [1, 3, 5].map((i) => Math.round(1000 * srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255)) / 1000) as V3;

/** The real look's options from panel values: only what differs from REAL_DEFAULTS, so the URL stays short. */
export function realOverrides(values: Record<RealKnob, number>, groundHex: string, choices: Partial<Pick<RealOptions, 'stone' | 'groundMaterial' | 'env'>> = {}): Partial<RealOptions> {
  const o: Partial<RealOptions> = {};
  for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) {
    const v = values[key], k = REAL_KNOBS[key];
    if (!Number.isFinite(v) || v < k.min || v > k.max) throw new Error(`${k.label} must be from ${k.min} to ${k.max}`);
    if (v !== REAL_DEFAULTS[key]) o[key] = v;
  }
  if (groundHex.toLowerCase() !== albedoHex(REAL_DEFAULTS.groundAlbedo)) o.groundAlbedo = hexAlbedo(groundHex);
  for (const k of ['stone', 'groundMaterial', 'env'] as const) if (choices[k] !== undefined && choices[k] !== REAL_DEFAULTS[k]) (o as Record<string, unknown>)[k] = choices[k];
  return o;
}

/** The panel's Bounce: restitution on or off (the engine option), and the e every surface then gets (ViewerConfig.bounce). */
export interface BounceChoice { on: boolean; e: number }

/** The panel's rules for a level, and Keystone's pace juice (ViewerConfig.rules, feel). */
export interface RulesChoice { rules: Rules; feel: PaceFeel }

/**
 * A config under Keystone's rules: the level's own physics and stepping (scale, substeps,
 * presettle, sleep, the free loop, no autofire) and the game's engine of the same kind (an
 * avbd-gpu spec's options dropped: the game sets its own), as the game plays it; throws when the
 * engine has no game counterpart (keystoneEngine).
 */
export function underKeystone(c: ViewerConfig, feel: PaceFeel): ViewerConfig {
  const { loop, pipeline, maxSteps } = DEFAULT_CONFIG;
  const name = parseSpec(c.engine).name, engine = name === 'avbd-gpu' || name === 'rapier' ? name : c.engine;
  const next: ViewerConfig = { ...c, rules: 'keystone', feel, engine, scale: 1, substeps: 1, presettle: PRESETTLE_STEPS, sleep: null, autofire: 0, loop, pipeline, maxSteps, camera: null };
  checkKeystone(next);
  return next;
}

/** The look under other rules: a look left at its rules' default (no look key in the URL) becomes the new rules' default, as editing the URL's rules would. */
const lookFor = (c: ViewerConfig, rules: Rules) => (c.look === defaultLook(c.rules) ? defaultLook(rules) : c.look);

/** The scene picker's value for a Keystone level (scenarios are their own id). */
export const levelChoice = (id: string) => `level:${id}`;
/** The scene picker's value for the level of your own the config holds (ViewerConfig.customLevel). */
export const CUSTOM_LEVEL = 'custom';

/** The level a picker value names: a built-in one, the config's own (CUSTOM_LEVEL), or null for a scenario; throws on an unknown one. */
function pickedLevel(c: ViewerConfig, choice: string) {
  if (choice === CUSTOM_LEVEL) {
    if (!c.customLevel) throw new Error('no level of your own is loaded');
    return { def: c.customLevel, custom: true };
  }
  if (!choice.startsWith('level:')) return null;
  const def = levelDef(choice.slice(6));
  if (!def) throw new Error(`unknown level ${choice.slice(6)}`);
  return { def, custom: false };
}

/** The config that loads def, a level of your own, fresh: its presettle, framed afresh. */
export const withCustomLevel = (c: ViewerConfig, def: ViewerConfig['customLevel'] & object): ViewerConfig => ({ ...c, level: def.id, customLevel: def, presettle: defaultPresettle(def.id), camera: null });

/**
 * The scene a set of form values describes, or why it can't be built. Builds it
 * (cheap next to an engine init) so the panel can show the body count before a rebuild.
 * Bounce on sets the engine option restitution=true, off removes it (an AVBD engine's
 * only; the spec is left as it is when the switch does not change). scenario is the
 * picker's value: a scenario id, or levelChoice(id) for a level, whose params and seed
 * are then ignored (the config keeps its own). presettle undefined: the new scene's default.
 */
export function proposeScene(c: ViewerConfig, scenario: string, params: Record<string, number | boolean>, seed: number, scale = c.scale, substeps = c.substeps,
  bounce: BounceChoice = { on: bounceOn(c.engine), e: c.bounce }, presettle?: number, rules: RulesChoice = { rules: c.rules, feel: c.feel }):
  { ok: true; config: ViewerConfig; bodies: number } | { ok: false; error: string } {
  try {
    const picked = pickedLevel(c, scenario);
    const level = picked?.def.id ?? null;
    // Keystone's rules: the level as the game plays it, whatever the world fields say (the panel hides them).
    if (picked && rules.rules === 'keystone') {
      // A line of shots is the level's it was made on: another level drops it.
      const same = level === c.level && (picked.custom ? picked.def === c.customLevel : !c.customLevel);
      const next = underKeystone({ ...c, level, customLevel: picked.custom ? picked.def : null, shots: same ? c.shots : null, look: lookFor(c, 'keystone') }, rules.feel);
      return { ok: true, config: next, bodies: compileLevel(picked.def).scene.bodies.length };
    }
    // Rules are a level's: anything else is the sandbox.
    c = { ...c, rules: 'sandbox', feel: { hitStop: false, slowMo: false }, shots: null, look: lookFor(c, 'sandbox') };
    const settle = presettle ?? defaultPresettle(level);
    if (!Number.isInteger(settle) || settle < 0 || settle > MAX_PRESETTLE) throw new Error(`settle steps must be a whole number from 0 to ${MAX_PRESETTLE}`);
    if (picked) {
      // A level is the whole scene: the config's scenario, params and seed stay for when the picker goes back to one,
      // and a level of your own stays loaded (picked again from the picker) until another one replaces it.
      checkWorld(scale, substeps);
      const { okE, engine } = bounceChoice(c, bounce);
      const next: ViewerConfig = { ...c, level, customLevel: picked.custom ? picked.def : null, scale, substeps, presettle: settle, camera: null, engine, bounce: okE ? bounce.e : c.bounce };
      return { ok: true, config: next, bodies: compileLevel(picked.def).scene.bodies.length };
    }
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
    checkWorld(scale, substeps);
    const { okE, engine } = bounceChoice(c, bounce);
    // A rebuilt scene is framed afresh: a start camera chosen for the old one need not fit it.
    const next: ViewerConfig = { ...c, level: null, customLevel: null, scenario, params, seed, scale, substeps, presettle: settle, camera: null, engine, bounce: okE ? bounce.e : c.bounce };
    return { ok: true, config: next, bodies: buildScenario(scenario, params, seed).bodies.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function checkWorld(scale: number, substeps: number) {
  if (!(scale >= SCALE_LIMITS[0] && scale <= SCALE_LIMITS[1])) throw new Error(`cube edge must be from ${SCALE_LIMITS[0]} to ${SCALE_LIMITS[1]} m`);
  if (!Number.isInteger(substeps) || substeps < 1 || substeps > MAX_SUBSTEPS) throw new Error(`substeps must be a whole number from 1 to ${MAX_SUBSTEPS}`);
}

/** Bounce's switch as an engine spec, and whether its e is usable; throws when Bounce is asked of an engine without it. */
function bounceChoice(c: ViewerConfig, bounce: BounceChoice): { okE: boolean; engine: string } {
  // e is checked only while Bounce is on (its field is hidden off); off, a bad e keeps the config's.
  const okE = bounce.e >= 0 && bounce.e <= 1;
  if (bounce.on && !okE) throw new Error('bounce e must be from 0 to 1');
  const name = parseSpec(c.engine).name;
  if (bounce.on && !AVBD_ENGINES.has(name)) throw new Error(`bounce needs an AVBD engine (GPU AVBD or avbd-ref), not ${name}`);
  return { okE, engine: bounce.on === bounceOn(c.engine) ? c.engine : withOption(c.engine, 'restitution', bounce.on || undefined) };
}

/** The scene picker's value for a config. */
const sceneChoice = (c: ViewerConfig) => (c.customLevel ? CUSTOM_LEVEL : c.level ? levelChoice(c.level) : c.scenario);

/** Save text as a file through a temporary link; returns the file name. */
function download(text: string, name: string): string {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return name;
}

/** The scene line under the form: bodies, what the cube size and substeps do to the physics, and the bounce's e while Bounce is on (null: off). */
export function sceneSummary(bodies: number, scale: number, substeps: number, bounce: number | null = null): string {
  const parts = [`${bodies.toLocaleString()} bodies`];
  if (scale !== 1) parts.push(`${+(1 / scale).toFixed(2)} g in cube units, ${+(1 / Math.sqrt(scale)).toFixed(2)}x as fast`);
  if (substeps !== 1) parts.push(`${substeps}x physics cost`);
  if (bounce !== null) parts.push(`bouncing at e ${bounce}`);
  return parts.join(', ');
}

/** The framing panel's values as a Framing, or why not. */
export const VIEW_FIELDS: { [K in keyof Framing]: string } = { pitch: 'camera pitch (deg)', fit: 'camera distance (x fit)', fov: 'field of view (deg)' };
export function framingFrom(values: Record<keyof Framing, number>): Framing {
  for (const k of Object.keys(VIEW_FIELDS) as (keyof Framing)[]) {
    const [lo, hi] = FRAMING_LIMITS[k];
    if (!(values[k] >= lo && values[k] <= hi)) throw new Error(`${VIEW_FIELDS[k]} must be from ${lo} to ${hi}`);
  }
  return { pitch: values.pitch, fit: values.fit, fov: values.fov };
}

const field = (name: string, label: string, value: number | boolean | string, attrs = '') =>
  typeof value === 'boolean'
    ? `<label class="f"><span>${escapeHtml(label)}</span><input type="checkbox" name="${name}"${value ? ' checked' : ''}></label>`
    : `<label class="f"><span>${escapeHtml(label)}</span><input type="number" name="${name}" value="${escapeHtml(String(value))}" ${attrs}></label>`;

export function mountControls(root: HTMLElement, hooks: ControlsHooks): { refresh(): void } {
  root.innerHTML = `
    <summary>Scene and projectile</summary>
    <form id="scene-form">
      <div class="h">Scene</div>
      <label class="f"><span>scenario</span><select name="scenario"><optgroup label="Scenarios">${Object.values(SCENARIOS).map((s) => `<option value="${s.id}">${s.id} ${escapeHtml(s.title)}</option>`).join('')}</optgroup><optgroup label="Keystone levels">${LEVELS.map((l) => `<option value="${levelChoice(l.id)}">${l.id} ${escapeHtml(l.name)}</option>`).join('')}</optgroup><optgroup label="Your level" class="custom"><option value="${CUSTOM_LEVEL}"></option></optgroup></select></label>
      <div class="params"></div>
      <div class="rules">
        <label class="f"><span>rules</span><select name="rules"><option value="sandbox">sandbox</option><option value="keystone">Keystone (the game)</option></select></label>
        <div class="feel">${field('hitstop', 'hit-stop on contact', false)}${field('slowmo', 'slow motion as crowns fall', false)}</div>
      </div>
      <div class="seed">${field('seed', 'seed', 1, 'step="1"')}</div>
      <div class="world">
        ${field('presettle', 'settle steps before start', 0, `step="1" min="0" max="${MAX_PRESETTLE}"`)}
        ${field('scale', 'cube edge (m)', 1, `step="any" min="${SCALE_LIMITS[0]}" max="${SCALE_LIMITS[1]}"`)}
        ${field('substeps', 'physics substeps', 1, `step="1" min="1" max="${MAX_SUBSTEPS}"`)}
        ${field('bounce', 'bounce', false)}
        <div class="bounce">${field('bounceE', 'bounce e (0-1)', DEFAULT_BOUNCE, 'step="any" min="0" max="1"')}</div>
      </div>
      <div class="out muted"></div>
      <div class="issues warn small"></div>
      <button type="submit">Rebuild scene</button>
    </form>
    <div id="level-file" class="buttons"><button type="button" name="levelDownload">Download level</button><button type="button" name="levelLoad">Load level…</button><input type="file" name="levelFile" accept=".json,application/json" hidden></div>
    <form id="proj-form">
      <div class="h">Projectile</div>
      <label class="f"><span>shape</span><select name="shape"><option value="ball">ball</option><option value="cube">cube</option></select></label>
      ${field('size', 'size (m)', 0, 'step="0.1" min="0.1" max="20"')}
      ${field('mass', 'mass (kg)', '', 'step="any" min="0.01"')}
      ${field('speed', 'speed (m/s)', 0, 'step="1" min="0" max="500"')}
      <label class="f"><span>weapon</span><select name="weapon"><option value="">none</option><option value="grenade">grenade</option></select></label>
      <div class="grenade">
        <label class="f"><span>fuse</span><select name="grenade.fuse">${FUSES.map((f) => `<option value="${f}"${f === DEFAULT_GRENADE.fuse ? ' selected' : ''}>${f === 'proxTimer' ? 'proximity, then delay' : f === 'prox' ? 'proximity' : 'timer'}</option>`).join('')}</select></label>
        ${field('grenade.ground', 'ground sets it off', DEFAULT_GRENADE.ground)}
        ${(Object.entries(GRENADE_FIELDS) as [keyof typeof GRENADE_FIELDS, [string, string]][]).map(([k, [label, step]]) => field(`grenade.${k}`, label, k in DEFAULT_GRENADE.blast ? DEFAULT_GRENADE.blast[k as keyof typeof DEFAULT_GRENADE.blast] : DEFAULT_GRENADE[k as (typeof GRENADE_NUMBERS)[number]], `step="${step}" min="${GRENADE_LIMITS[k][0]}" max="${GRENADE_LIMITS[k][1]}"`)).join('')}
      </div>
      <div class="out muted"></div>
    </form>
    <form id="look-form">
      <div class="h">Look</div>
      <label class="f"><span>look</span><select name="look">${Object.keys(LOOKS).map((l) => `<option value="${l}">${l}</option>`).join('')}</select></label>
      <div class="real">
        <label class="f"><span>stone</span><select name="stone">${STONES.map((st) => `<option value="${st}">${st}</option>`).join('')}</select></label>
        <label class="f"><span>setting</span><select name="env">${ENVS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></label>
        <label class="f"><span>ground</span><select name="groundMaterial">${GROUNDS.map((g) => `<option value="${g}">${g}</option>`).join('')}</select></label>
        ${(Object.entries(REAL_KNOBS) as [RealKnob, (typeof REAL_KNOBS)[RealKnob]][]).map(([key, k]) => field(key, k.label, REAL_DEFAULTS[key], `step="${k.step}" min="${k.min}" max="${k.max}"`)).join('')}
        <label class="f"><span>ground albedo</span><input type="color" name="ground" value="${albedoHex(REAL_DEFAULTS.groundAlbedo)}"></label>
      </div>
      <div class="out muted"></div>
    </form>
    <form id="view-form">
      <div class="h">Camera</div>
      ${(Object.keys(VIEW_FIELDS) as (keyof Framing)[]).map((k) => field(k, VIEW_FIELDS[k], 0, `step="any" min="${FRAMING_LIMITS[k][0]}" max="${FRAMING_LIMITS[k][1]}"`)).join('')}
      <div class="out muted"></div>
    </form>
    <form id="file-form">
      <div class="h">Configuration</div>
      <label class="f"><span>name</span><input type="text" name="name" placeholder="optional" maxlength="120"></label>
      <div class="buttons"><button type="submit">Download</button><button type="button" name="load">Load…</button></div>
      <input type="file" name="file" accept=".json,application/json" hidden>
      <div class="starts muted">start over: <a href="./" title="the default scene (default-scene.ts), what the viewer opens with">default scene</a> · <a href="./?defaults=factory" title="the built-in setup, without the default scene">factory setup</a></div>
      <div class="out muted"></div>
    </form>`;
  const sceneForm = root.querySelector<HTMLFormElement>('#scene-form')!;
  const projForm = root.querySelector<HTMLFormElement>('#proj-form')!;
  const paramsBox = sceneForm.querySelector<HTMLElement>('.params')!;
  const sceneOut = sceneForm.querySelector<HTMLElement>('.out')!;
  const projOut = projForm.querySelector<HTMLElement>('.out')!;
  const lookForm = root.querySelector<HTMLFormElement>('#look-form')!;
  const realBox = lookForm.querySelector<HTMLElement>('.real')!;
  const lookOut = lookForm.querySelector<HTMLElement>('.out')!;
  const input = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const rebuildButton = sceneForm.querySelector<HTMLButtonElement>('button')!;
  const viewForm = root.querySelector<HTMLFormElement>('#view-form')!;
  const viewOut = viewForm.querySelector<HTMLElement>('.out')!;
  const bounceBox = input(sceneForm, 'bounce') as HTMLInputElement;
  const bounceEBox = sceneForm.querySelector<HTMLElement>('.bounce')!;

  const seedBox = sceneForm.querySelector<HTMLElement>('.seed')!;
  const rulesBox = sceneForm.querySelector<HTMLElement>('.rules')!;
  const feelBox = sceneForm.querySelector<HTMLElement>('.feel')!;
  const worldBox = sceneForm.querySelector<HTMLElement>('.world')!;
  const issuesBox = sceneForm.querySelector<HTMLElement>('.issues')!;
  const customGroup = sceneForm.querySelector<HTMLOptGroupElement>('optgroup.custom')!;
  // Outside the scene form, so Rebuild stays its only button.
  const levelBox = root.querySelector<HTMLElement>('#level-file')!;
  const levelDownload = levelBox.querySelector<HTMLButtonElement>('button[name=levelDownload]')!;
  const levelPicker = levelBox.querySelector<HTMLInputElement>('input[name=levelFile]')!;

  /** Param fields for a scenario: the config's values when it is the current one, else its defaults. A level has none: a line about it instead. */
  function showParams(scenario: string) {
    const c = hooks.config();
    let picked: ReturnType<typeof pickedLevel> = null;
    try { picked = pickedLevel(c, scenario); } catch { /* checkScene says why */ }
    seedBox.hidden = picked !== null;
    levelDownload.hidden = picked === null;
    // Rules are a level's; under Keystone's the world fields are the level's own.
    rulesBox.hidden = picked === null;
    const keystone = picked !== null && input(sceneForm, 'rules').value === 'keystone';
    feelBox.hidden = !keystone;
    worldBox.hidden = keystone;
    issuesBox.textContent = '';
    if (picked) {
      const d = picked.def;
      paramsBox.innerHTML = `<div class="muted">${escapeHtml(d.name)}: ${d.objective.kind === 'crowns' ? 'fell the crowns' : 'bring the skyline down'}, par ${d.par}, rack ${escapeHtml(d.rack.join(', '))}</div>`;
      // A level with issues still loads (seeing it fail is the point); they are listed here.
      const issues = levelIssues(d);
      issuesBox.textContent = issues instanceof Error ? issues.message : issues.map((i) => `${i.code}: ${i.message}`).join('\n');
      return;
    }
    const values = { ...SCENARIOS[scenario]!.defaults, ...(scenario === c.scenario ? c.params : {}) };
    paramsBox.innerHTML = Object.entries(values).map(([k, v]) => field(`param.${k}`, PARAM_LABELS[k] ?? k, v, 'step="any"')).join('');
  }

  function sceneProposal() {
    const scenario = input(sceneForm, 'scenario').value;
    const params: Record<string, number | boolean> = {};
    for (const el of paramsBox.querySelectorAll('input')) {
      params[el.name.slice(6)] = el.type === 'checkbox' ? el.checked : el.value === '' ? NaN : Number(el.value);
    }
    const bounce = { on: bounceBox.checked, e: input(sceneForm, 'bounceE').value === '' ? NaN : Number(input(sceneForm, 'bounceE').value) };
    const presettle = input(sceneForm, 'presettle').value === '' ? NaN : Number(input(sceneForm, 'presettle').value);
    const rules: RulesChoice = { rules: input(sceneForm, 'rules').value as Rules, feel: { hitStop: (input(sceneForm, 'hitstop') as HTMLInputElement).checked, slowMo: (input(sceneForm, 'slowmo') as HTMLInputElement).checked } };
    return proposeScene(hooks.config(), scenario, params, Number(input(sceneForm, 'seed').value), Number(input(sceneForm, 'scale').value), Number(input(sceneForm, 'substeps').value), bounce, presettle, rules);
  }

  function checkScene() {
    bounceEBox.hidden = !bounceBox.checked;
    const p = sceneProposal();
    sceneOut.textContent = !p.ok ? p.error : p.config.rules === 'keystone'
      ? `${p.bodies.toLocaleString()} bodies, by Keystone's rules on ${keystoneEngine(p.config.engine) === 'gpu' ? `the GPU solver (${AVBD_ITERATIONS} iterations, gapSlop)` : 'Rapier'}`
      : sceneSummary(p.bodies, p.config.scale, p.config.substeps, bounceOn(p.config.engine) ? p.config.bounce : null);
    sceneOut.classList.toggle('warn', !p.ok);
    rebuildButton.disabled = !p.ok;
  }

  const grenadeBox = projForm.querySelector<HTMLElement>('.grenade')!;
  function projectile(): Projectile {
    const q = new URLSearchParams();
    q.set('proj', input(projForm, 'shape').value);
    for (const k of ['size', 'mass', 'speed']) q.set(`proj.${k}`, input(projForm, k).value);
    const weapon = input(projForm, 'weapon').value;
    grenadeBox.hidden = weapon !== 'grenade';
    if (weapon) {
      q.set('proj.weapon', weapon);
      q.set('grenade.fuse', input(projForm, 'grenade.fuse').value);
      q.set('grenade.ground', (input(projForm, 'grenade.ground') as HTMLInputElement).checked ? '1' : '0');
      for (const k of Object.keys(GRENADE_FIELDS)) q.set(`grenade.${k}`, input(projForm, `grenade.${k}`).value);
    }
    return parseProjectile(q);
  }

  function showMass(p: Projectile) {
    const m = projectileMass(p);
    (input(projForm, 'mass') as HTMLInputElement).placeholder = `auto ${m.toPrecision(3)}`;
    projOut.textContent = `${m.toPrecision(3)} kg, ${(m * p.speed).toPrecision(3)} kg·m/s (a cube is 1 kg)${p.grenade ? `; ${grenadeSummary(p.grenade)}` : ''}`;
    projOut.classList.remove('warn');
  }

  // A new cube size brings its own substeps (autoSubsteps); set them after to override.
  input(sceneForm, 'scale').addEventListener('input', () => {
    const s = Number(input(sceneForm, 'scale').value);
    if (s >= SCALE_LIMITS[0] && s <= SCALE_LIMITS[1]) input(sceneForm, 'substeps').value = String(autoSubsteps(s));
  });
  // A new scene brings its own settle steps and cube size (a level's are the game's); set them after to override.
  input(sceneForm, 'scenario').addEventListener('change', () => {
    const v = input(sceneForm, 'scenario').value, level = v.startsWith('level:') || v === CUSTOM_LEVEL ? v : null;
    input(sceneForm, 'presettle').value = String(defaultPresettle(level));
    showParams(v);
    checkScene();
  });
  input(sceneForm, 'rules').addEventListener('change', () => showParams(input(sceneForm, 'scenario').value));
  sceneForm.addEventListener('input', checkScene);
  // Level JSON: the picked level (built-in or your own) as a file to edit, and an edited one loaded back as your own.
  levelDownload.addEventListener('click', () => {
    let picked: ReturnType<typeof pickedLevel> = null;
    try { picked = pickedLevel(hooks.config(), input(sceneForm, 'scenario').value); } catch { return; }
    if (!picked) return;
    download(levelJson(picked.def), sceneFileName(picked.def.id, picked.def.id).replace(/\.json$/, '.level.json'));
  });
  levelBox.querySelector<HTMLButtonElement>('button[name=levelLoad]')!.addEventListener('click', () => levelPicker.click());
  levelPicker.addEventListener('change', async () => {
    const f = levelPicker.files?.[0];
    levelPicker.value = '';
    if (!f) return;
    try {
      let v: unknown;
      try { v = JSON.parse(await f.text()); } catch { throw new Error('not a JSON file'); }
      hooks.rebuild(withCustomLevel(hooks.config(), parseLevelDef(v)));
    } catch (e) {
      sceneOut.textContent = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
      sceneOut.classList.add('warn');
    }
  });
  sceneForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = sceneProposal();
    if (p.ok) hooks.rebuild(p.config);
  });
  projForm.addEventListener('submit', (e) => e.preventDefault());
  projForm.addEventListener('change', () => {
    try {
      const p = projectile();
      showMass(p);
      hooks.setProjectile(p);
    } catch (e) {
      projOut.textContent = e instanceof Error ? e.message : String(e);
      projOut.classList.add('warn');
    }
  });

  function applyLook() {
    const look = input(lookForm, 'look').value;
    realBox.hidden = look !== 'real';
    try {
      const values = Object.fromEntries((Object.keys(REAL_KNOBS) as RealKnob[]).map((k) => [k, Number(input(lookForm, k).value)])) as Record<RealKnob, number>;
      hooks.setLook(look, realOverrides(values, input(lookForm, 'ground').value, { stone: input(lookForm, 'stone').value as Stone, groundMaterial: input(lookForm, 'groundMaterial').value as Ground, env: input(lookForm, 'env').value as Env }));
      lookOut.textContent = look === 'real' ? 'sun azimuth: clockwise from -z; visibility: 10 hazy, 40 clear, 150 crisp' : '';
      lookOut.classList.remove('warn');
    } catch (e) {
      lookOut.textContent = e instanceof Error ? e.message : String(e);
      lookOut.classList.add('warn');
    }
  }
  lookForm.addEventListener('submit', (e) => e.preventDefault());
  lookForm.addEventListener('input', applyLook);

  // Framing: applied live (the camera jumps to it); R and Rebuild frame the same way.
  viewForm.addEventListener('submit', (e) => e.preventDefault());
  viewForm.addEventListener('input', () => {
    try {
      hooks.setView(framingFrom(Object.fromEntries((Object.keys(VIEW_FIELDS) as (keyof Framing)[]).map((k) => [k, Number(input(viewForm, k).value)])) as Record<keyof Framing, number>));
      viewOut.textContent = 'where R and Rebuild put the camera; drag to orbit';
      viewOut.classList.remove('warn');
    } catch (e) {
      viewOut.textContent = e instanceof Error ? e.message : String(e);
      viewOut.classList.add('warn');
    }
  });

  // Download: the current config and camera as JSON. Load: a file picked here, applied by main.ts.
  const fileForm = root.querySelector<HTMLFormElement>('#file-form')!;
  const fileOut = fileForm.querySelector<HTMLElement>('.out')!;
  const picker = input(fileForm, 'file') as HTMLInputElement;
  const say = (text: string, warn = false) => { fileOut.textContent = text; fileOut.classList.toggle('warn', warn); };
  fileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = hooks.config(), name = input(fileForm, 'name').value;
    const file = sceneFile(c, name, hooks.camera());
    const saved = download(`${JSON.stringify(file, null, 2)}\n`, sceneFileName(name, c.level ?? c.scenario));
    say(`Saved ${saved}`);
  });
  fileForm.querySelector<HTMLButtonElement>('button[name=load]')!.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const f = picker.files?.[0];
    picker.value = ''; // the same file again is a new pick
    if (!f) return;
    try {
      const { config, name } = parseSceneFile(await f.text());
      input(fileForm, 'name').value = name;
      say(`Loaded ${name || f.name}`);
      hooks.load(config, name || f.name);
    } catch (e) {
      say(`${f.name}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  });

  /** Shows the current config (after a load or a URL change). */
  function refresh() {
    const c = hooks.config();
    customGroup.hidden = !c.customLevel;
    customGroup.firstElementChild!.textContent = c.customLevel ? `${c.customLevel.id} ${c.customLevel.name} (yours)` : '';
    input(sceneForm, 'scenario').value = sceneChoice(c);
    input(sceneForm, 'rules').value = c.rules;
    (input(sceneForm, 'hitstop') as HTMLInputElement).checked = c.feel.hitStop;
    (input(sceneForm, 'slowmo') as HTMLInputElement).checked = c.feel.slowMo;
    input(sceneForm, 'seed').value = String(c.seed);
    input(sceneForm, 'presettle').value = String(c.presettle);
    input(sceneForm, 'scale').value = String(c.scale);
    input(sceneForm, 'substeps').value = String(c.substeps);
    // Bounce is the AVBD engines' restitution switch; the others keep it off.
    bounceBox.checked = bounceOn(c.engine);
    bounceBox.disabled = !AVBD_ENGINES.has(parseSpec(c.engine).name);
    bounceBox.title = bounceBox.disabled ? 'restitution: GPU AVBD or avbd-ref engines only' : 'restitution: every body and the ground bounce at e (Rebuild to apply)';
    input(sceneForm, 'bounceE').value = String(c.bounce);
    showParams(sceneChoice(c));
    checkScene();
    const p = c.projectile;
    input(projForm, 'shape').value = p.shape;
    input(projForm, 'size').value = String(p.size);
    input(projForm, 'mass').value = p.mass === null ? '' : String(p.mass);
    input(projForm, 'speed').value = String(p.speed);
    // The grenade's fields keep their values while the weapon is off, so switching it back on restores them.
    input(projForm, 'weapon').value = p.weapon ?? '';
    grenadeBox.hidden = p.weapon !== 'grenade';
    const g = p.grenade;
    if (g) {
      input(projForm, 'grenade.fuse').value = g.fuse;
      (input(projForm, 'grenade.ground') as HTMLInputElement).checked = g.ground;
      for (const k of GRENADE_NUMBERS) input(projForm, `grenade.${k}`).value = String(g[k]);
      for (const k of GRENADE_BLAST_KEYS) input(projForm, `grenade.${k}`).value = String(g.blast[k]);
    }
    showMass(p);
    input(lookForm, 'look').value = c.look;
    realBox.hidden = c.look !== 'real';
    const real = { ...REAL_DEFAULTS, ...c.real };
    for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) input(lookForm, key).value = String(real[key]);
    input(lookForm, 'ground').value = albedoHex(real.groundAlbedo);
    input(lookForm, 'stone').value = real.stone;
    input(lookForm, 'groundMaterial').value = real.groundMaterial;
    input(lookForm, 'env').value = real.env;
    for (const k of Object.keys(VIEW_FIELDS) as (keyof Framing)[]) input(viewForm, k).value = String(c.view[k]);
    // Under Keystone's rules the rack fires and the game frames its level: the projectile and the framing wait for the sandbox.
    // (style, not hidden: the panel's CSS sets a form's display.)
    projForm.style.display = viewForm.style.display = c.rules === 'keystone' ? 'none' : '';
  }
  // Open or closed as the viewer last left it; open by default on a wide screen.
  const OPEN_KEY = 'tb.viewer.controls.open';
  try {
    const saved = localStorage.getItem(OPEN_KEY);
    (root as HTMLDetailsElement).open = saved === null ? innerWidth > 640 : saved === '1';
  } catch { (root as HTMLDetailsElement).open = innerWidth > 640; }
  root.addEventListener('toggle', () => { try { localStorage.setItem(OPEN_KEY, (root as HTMLDetailsElement).open ? '1' : '0'); } catch { /* storage blocked */ } });
  refresh();
  return { refresh };
}
