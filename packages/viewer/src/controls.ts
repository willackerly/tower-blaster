// The viewer's control panel: the scene (scenario or level, its params, seed, cube size, substeps,
// Bounce, and the rules it plays by: a scenario under Keystone's is a level), rebuilt on demand, and the projectile and the look, applied as soon as a field
// changes; and the whole setup saved to or loaded from a JSON file (scene-file.ts). The panel
// only proposes configs; main.ts decides how to apply them (live, or by reset).
import { checkSound, SOUND_KNOBS, SOUND_MATERIAL_NAMES, SOUND_SETS, type SoundKnob, type SoundOptions } from '@tb/audio';
import { parseSpec } from '@tb/bench';
import { type Env, ENVS, type Ground, GROUNDS, TONE_MAPS, type ToneMap, linearToSrgb, LOOKS, REAL_DEFAULTS, REAL_KNOBS, type RealKnob, type RealOptions, srgbToLinear, type Stone, STONES, type V3 } from '@tb/render';
import { type BallStyle, checkPaceFeel, DEFAULT_BUDGET_MS, DEFAULT_FEEL, DEFAULT_UNDO_MB, MAX_UNDO_MB, type FrameMode, type LaunchMode, objectiveText, type PaceFeel } from '@tb/game';
import { AUTO_LEVEL, AVBD_ITERATIONS, BIG_LEVELS, compileLevel, freezeProblem, LEVELS, MAX_FREEZE, PRESETTLE_STEPS, scenarioLevel, TRIAL_LEVELS, UNDERCUT_LEVELS } from '@tb/keystone';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import { type CameraPose, type Framing, FRAMING_LIMITS } from './camera.ts';
import { escapeHtml } from './html.ts';
import { levelIssues, levelJson, parseLevelDef } from './level-file.ts';
import { autoSubsteps, AVBD_ENGINES, blockDensityOf, bounceOn, carriedFraming, checkKeystone, DEFAULT_BOUNCE, DEFAULT_CONFIG, defaultLook, defaultPresettle, firedSpeed, keystoneEngine, levelDef, MAX_PRESETTLE, MAX_SUBSTEPS, type Rules, SCALE_LIMITS, type ViewerConfig, withOption } from './params.ts';
import { blastWeight, checkBlast } from '@tb/engine-api';
import { BUILTIN_WEAPONS, checkWeapon, DEFAULT_GRENADE, FUSES, GRENADE_LIMITS, type GrenadeSpec, isPreset, PRESET_NAMES, PROJECTILE_PRESETS, validateWeapon, weaponBudget, type WeaponSpec, writeWeapon } from '@tb/weapons';
import { DEFAULT_PROJECTILE, encodeWeaponParam, GRENADE_BLAST_KEYS, GRENADE_NUMBERS, parseProjectile, presetProjectile, type Projectile, projectileMass, WEAPONS, weaponName, worldProjectile } from './projectile.ts';
import { parseSceneFile, sceneFile, sceneFileName } from './scene-file.ts';
import { autoSoundMaterial } from './sound-config.ts';

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
  /** Draw blasts (fireball, shell out to the blast radius, light) or not, from now on. */
  setBlast(on: boolean): void;
  /** Play collision sound this way from now on. */
  setSound(o: SoundOptions): void;
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

/** What the scene's blocks might be made of, kg/m^3 (the panel's suggestions for Projectile.blockDensity). */
export const BLOCK_MATERIALS: readonly [string, number][] = [['stone', 2400], ['brick', 1900], ['oak', 700], ['pine', 450], ['cardboard', 100], ['foam', 30]];

const kg = (m: number) => (m >= 1000 ? `${(m / 1000).toPrecision(3)} t` : `${m.toPrecision(3)} kg`);
const times = (x: number) => (x >= 100 ? Number(x.toPrecision(3)).toLocaleString('en-US') : x.toPrecision(3));

/**
 * What the panel says the projectile is in c's world: a real thing's mass against a block's
 * (a cube of the scene's edge, scale m, at blockDensity: the ratio physics sees), a ball's or cube's
 * against a scene cube's 1 kg; and the launch speed when the engine caps it (firedSpeed).
 */
export function projectileSummary(p: Projectile, c: ViewerConfig): string {
  const m = projectileMass(p);
  const w = worldProjectile(p, c.scale, blockDensityOf({ ...c, projectile: p }));
  const fired = firedSpeed({ ...c, projectile: p }, w), capped = fired < w.speed;
  const speed = p.speed * (fired / w.speed);
  let out: string;
  if (p.preset) {
    const block = blockDensityOf({ ...c, projectile: p }) * c.scale ** 3, r = m / block;
    out = `${kg(m)}, ${r >= 1 ? `${times(r)}x` : `1/${times(1 / r)} of`} a ${+c.scale.toPrecision(3)} m cube of block (${kg(block)})`;
  } else out = `${m.toPrecision(3)} kg (a cube is 1 kg)`;
  out += `, ${times(m * speed)} kg·m/s`;
  if (capped) out += `; launched at ${speed.toPrecision(3)} m/s, the fastest this engine sees at this cube size (more substeps raise it)`;
  return out;
}

/** Linear albedo to a colour input's #rrggbb (sRGB) and back, to 3 decimals. */
export const albedoHex = (c: V3) => `#${c.map((x) => Math.round(255 * linearToSrgb(Math.min(Math.max(x, 0), 1))).toString(16).padStart(2, '0')).join('')}`;
export const hexAlbedo = (h: string): V3 => [1, 3, 5].map((i) => Math.round(1000 * srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255)) / 1000) as V3;

/** The real look's options from panel values: only what differs from REAL_DEFAULTS, so the URL stays short. */
export function realOverrides(values: Record<RealKnob, number>, groundHex: string, choices: Partial<Pick<RealOptions, 'stone' | 'groundMaterial' | 'env' | 'toneMap'>> = {}): Partial<RealOptions> {
  const o: Partial<RealOptions> = {};
  for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) {
    const v = values[key], k = REAL_KNOBS[key];
    if (!Number.isFinite(v) || v < k.min || v > k.max) throw new Error(`${k.label} must be from ${k.min} to ${k.max}`);
    if (v !== REAL_DEFAULTS[key]) o[key] = v;
  }
  if (groundHex.toLowerCase() !== albedoHex(REAL_DEFAULTS.groundAlbedo)) o.groundAlbedo = hexAlbedo(groundHex);
  for (const k of ['stone', 'groundMaterial', 'env', 'toneMap'] as const) if (choices[k] !== undefined && choices[k] !== REAL_DEFAULTS[k]) (o as Record<string, unknown>)[k] = choices[k];
  return o;
}

/** The panel's Bounce: restitution on or off (the engine option), and the e every surface then gets (ViewerConfig.bounce). */
export interface BounceChoice { on: boolean; e: number }

/** The panel's rules for a level, and Keystone's pace juice (ViewerConfig.rules, feel). */
export interface RulesChoice {
  rules: Rules;
  feel: PaceFeel;
  /**
   * Bullet Time's freeze budget under Keystone's rules (the panel's freezes box, URL key
   * keystone.freeze, LevelDef.freeze): a number makes a custom run with that many; NaN (the box
   * left empty) plays the level's own. Absent: the config's, unchanged.
   */
  freeze?: number;
}

/** The game's rule overrides with the panel's freeze budget (RulesChoice.freeze); throws on a bad one. */
function withFreeze(k: ViewerConfig['keystone'], freeze: number | undefined): ViewerConfig['keystone'] {
  if (freeze === undefined) return k;
  const { freeze: _, ...rest } = k;
  if (Number.isNaN(freeze)) return rest;
  const why = freezeProblem(freeze);
  if (why) throw new Error(why);
  return { ...rest, freeze };
}

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
    if (rules.rules === 'keystone') checkPaceFeel(rules.feel);
    if (picked && rules.rules === 'keystone') {
      // A line of shots and a rack are the level's they were given for: another level drops them.
      const same = level === c.level && (picked.custom ? picked.def === c.customLevel : !c.customLevel);
      const next = underKeystone({ ...c, level, customLevel: picked.custom ? picked.def : null, shots: same ? c.shots : null, rack: same ? c.rack : null, look: lookFor(c, 'keystone'), keystone: withFreeze(c.keystone, rules.freeze) }, rules.feel);
      return { ok: true, config: next, bodies: compileLevel(picked.def).scene.bodies.length };
    }
    // A scenario under Keystone's rules is a level (scenarioLevel): its params and seed build it, the rest is the game's.
    if (rules.rules === 'keystone') {
      if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
      const def = scenarioLevel(scenario, params, seed);
      const same = !c.level && c.scenario === scenario && c.seed === seed && JSON.stringify(c.params) === JSON.stringify(params);
      const next = underKeystone({ ...c, level: null, customLevel: null, scenario, params, seed, shots: same ? c.shots : null, rack: same ? c.rack : null, look: lookFor(c, 'keystone'), keystone: withFreeze(c.keystone, rules.freeze) }, rules.feel);
      return { ok: true, config: next, bodies: compileLevel(def).scene.bodies.length };
    }
    // Anything else is the sandbox.
    c = { ...c, rules: 'sandbox', feel: { ...DEFAULT_FEEL }, shots: null, look: lookFor(c, 'sandbox') };
    const settle = presettle ?? defaultPresettle(level);
    if (!Number.isInteger(settle) || settle < 0 || settle > MAX_PRESETTLE) throw new Error(`settle steps must be a whole number from 0 to ${MAX_PRESETTLE}`);
    if (picked) {
      // A level is the whole scene: the config's scenario, params and seed stay for when the picker goes back to one,
      // and a level of your own stays loaded (picked again from the picker) until another one replaces it.
      checkWorld(scale, substeps);
      const { okE, engine } = bounceChoice(c, bounce);
      const next: ViewerConfig = { ...c, level, customLevel: picked.custom ? picked.def : null, rack: null, scale, substeps, presettle: settle, camera: null, engine, bounce: okE ? bounce.e : c.bounce, view: carriedFraming(c.view, c, { scenario: c.scenario, level }) };
      return { ok: true, config: next, bodies: compileLevel(picked.def).scene.bodies.length };
    }
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
    checkWorld(scale, substeps);
    const { okE, engine } = bounceChoice(c, bounce);
    // A rebuilt scene is framed afresh: a start camera chosen for the old one need not fit it.
    const next: ViewerConfig = { ...c, level: null, customLevel: null, rack: null, scenario, params, seed, scale, substeps, presettle: settle, camera: null, engine, bounce: okE ? bounce.e : c.bounce, view: carriedFraming(c.view, c, { scenario, level: null }) };
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

/** A weapon spec's line under the projectile form: what one shot can spawn and set off, and the validator's warnings. */
export function weaponSummary(spec: WeaponSpec): string {
  const b = weaponBudget(spec), blasts = b.blasts.reduce((a, x) => a + x.count, 0);
  const warns = validateWeapon(spec).issues.filter((i) => i.level === 'warn').map((i) => `${i.code} at ${i.path}`);
  return [`${weaponName(spec)}: up to ${b.bodies} bodies and ${blasts} blast${blasts === 1 ? '' : 's'} a shot`, ...warns].join('; ');
}

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
export const VIEW_FIELDS: { [K in keyof Framing]: string } = { pitch: 'camera pitch (deg)', fit: 'camera distance (x fit)', fov: 'field of view (deg)', yaw: 'camera side (yaw, deg)', eye: 'eye height (m; 0: orbit, else from the ground)' };
export function framingFrom(values: Record<keyof Framing, number>): Framing {
  for (const k of Object.keys(VIEW_FIELDS) as (keyof Framing)[]) {
    const [lo, hi] = FRAMING_LIMITS[k];
    if (!(values[k] >= lo && values[k] <= hi)) throw new Error(`${VIEW_FIELDS[k]} must be from ${lo} to ${hi}`);
  }
  return { pitch: values.pitch, fit: values.fit, fov: values.fov, yaw: values.yaw, eye: values.eye };
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
      <label class="f"><span>scenario</span><select name="scenario"><optgroup label="Scenarios">${Object.values(SCENARIOS).map((s) => `<option value="${s.id}">${s.id} ${escapeHtml(s.title)}</option>`).join('')}</optgroup><optgroup label="Keystone levels">${LEVELS.map((l) => `<option value="${levelChoice(l.id)}">${l.id} ${escapeHtml(l.name)}</option>`).join('')}</optgroup><optgroup label="Big levels">${BIG_LEVELS.map((l) => `<option value="${levelChoice(l.id)}">${l.id} ${escapeHtml(l.name)}</option>`).join('')}</optgroup><optgroup label="Undercut levels">${UNDERCUT_LEVELS.map((l) => `<option value="${levelChoice(l.id)}">${l.id} ${escapeHtml(l.name)}</option>`).join('')}</optgroup><optgroup label="Trials (unrated)">${TRIAL_LEVELS.map((l) => `<option value="${levelChoice(l.id)}">${l.id} ${escapeHtml(l.name)}</option>`).join('')}</optgroup><optgroup label="Your level" class="custom"><option value="${CUSTOM_LEVEL}"></option></optgroup></select></label>
      <div class="params"></div>
      <div class="rules">
        <label class="f"><span>rules</span><select name="rules"><option value="sandbox">sandbox</option><option value="keystone">Keystone (the game)</option></select></label>
        <div class="feel">${field('hitstop', 'hit-stop on contact', false)}${field('slowmo', 'slow motion as crowns fall', false)}${field('budget', 'physics budget, ms per 1/60 s (0: no valve)', DEFAULT_BUDGET_MS, 'step="any" min="0" max="1000"')}${field('tailskip', 'fast-forward the tail of a shot', true)}${field('follow', 'camera follows the collapse', false)}${field('shake', 'camera shakes on hits', false)}${field('rapid', 'rapid fire: shoot before the last shot settles', true)}${field('undo', 'undo memory, MB (0: undo replays the shots)', DEFAULT_UNDO_MB, `step="1" min="0" max="${MAX_UNDO_MB}"`)}${field('freeze', 'freezes, Bullet Time (empty: the level\'s own)', '', `step="1" min="0" max="${MAX_FREEZE}" placeholder="level's"`)}<label class="f"><span>frames drawn</span><select name="frames"><option value="all">every frame</option><option value="half">half on a fast display</option><option value="auto">half while physics is behind</option></select></label><label class="f"><span>launch height (keys W, S move it)</span><select name="launch"><option value="high">high: over the structure's top</option><option value="level">the level's own launcher</option></select></label><label class="f"><span>fired balls</span><select name="balls"><option value="painted">painted, banded</option><option value="plain">plain: the look's</option></select></label>${field('marks', 'stone marks: crosshair on crowns, shield on what to keep, crown on a crown to hold', true)}${field('pullanim', 'pulls slide out, a ghost where they stood', true)}${field('frozenlook', 'Bullet Time: frozen look (cold grade and rim, label, sparks held and thinned)', true)}</div>
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
      <label class="f"><span>throw</span><select name="shape"><option value="ball">ball</option><option value="cube">cube</option><optgroup label="real things">${PRESET_NAMES.map((n) => `<option value="${n}">${escapeHtml(PROJECTILE_PRESETS[n].label)}</option>`).join('')}</optgroup></select></label>
      ${field('size', 'size (m)', 0, 'step="any" min="0.1" max="20"')}
      ${field('mass', 'mass (kg)', '', 'step="any" min="0.01"')}
      ${field('speed', 'speed (m/s)', 0, 'step="1" min="0" max="500"')}
      ${field('restitution', 'bounce e (Bounce on)', '', 'step="any" min="0" max="1" placeholder="scene e"')}
      ${field('friction', 'friction', '', 'step="any" min="0" max="2" placeholder="0.5"')}
      ${field('blockDensity', 'blocks are (kg/m³)', '', 'step="any" min="1" max="30000" list="block-densities"')}
      <datalist id="block-densities">${BLOCK_MATERIALS.map(([name, d]) => `<option value="${d}" label="${name}"></option>`).join('')}</datalist>
      <label class="f"><span>weapon</span><select name="weapon"><option value="">none</option>${WEAPONS.map((w) => `<option value="${w}">${w}</option>`).join('')}<option value="" data-custom hidden></option></select></label>
      <div class="spec buttons"><button type="button" name="weaponDownload">Download weapon</button><button type="button" name="weaponLoad">Load weapon…</button><input type="file" name="weaponFile" accept=".json,application/json" hidden></div>
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
      ${field('blast', 'blasts: fireball, ring at the reach, light', true)}
      <div class="real">
        <label class="f"><span>stone</span><select name="stone">${STONES.map((st) => `<option value="${st}">${st}</option>`).join('')}</select></label>
        <label class="f"><span>setting</span><select name="env">${ENVS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></label>
        <label class="f"><span>ground</span><select name="groundMaterial">${GROUNDS.map((g) => `<option value="${g}">${g}</option>`).join('')}</select></label>
        <label class="f"><span>tone map</span><select name="toneMap">${TONE_MAPS.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></label>
        ${(Object.entries(REAL_KNOBS) as [RealKnob, (typeof REAL_KNOBS)[RealKnob]][]).map(([key, k]) => field(key, k.label, REAL_DEFAULTS[key], `step="${k.step}" min="${k.min}" max="${k.max}"`)).join('')}
        <label class="f"><span>ground albedo</span><input type="color" name="ground" value="${albedoHex(REAL_DEFAULTS.groundAlbedo)}"></label>
      </div>
      <div class="out muted"></div>
    </form>
    <form id="sound-form">
      <div class="h">Sound</div>
      ${field('on', 'collision sound', false)}
      <div class="sound">
        <label class="f"><span>material</span><select name="material"><option value="auto">auto</option>${SOUND_MATERIAL_NAMES.map((m) => `<option value="${m}">${m}</option>`).join('')}</select></label>
        <label class="f"><span>materials</span><select name="set">${SOUND_SETS.map((m) => `<option value="${m}">${m}</option>`).join('')}</select></label>
        ${(Object.entries(SOUND_KNOBS) as [SoundKnob, (typeof SOUND_KNOBS)[SoundKnob]][]).map(([key, k]) => field(key, k.label, k.def, `step="${k.step}" min="${k.min}" max="${k.max}"`)).join('')}
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
    // Under Keystone's rules the world fields are the level's own; a scenario plays as a level (scenarioLevel).
    const keystone = input(sceneForm, 'rules').value === 'keystone';
    feelBox.hidden = !keystone;
    worldBox.hidden = keystone;
    issuesBox.textContent = '';
    if (picked) {
      const d = picked.def;
      paramsBox.innerHTML = `<div class="muted">${escapeHtml(d.name)}: ${escapeHtml(objectiveText(d.objective))}, par ${d.par}, rack ${escapeHtml(d.rack.join(', '))}</div>`;
      // A level with issues still loads (seeing it fail is the point); they are listed here.
      const issues = levelIssues(d);
      issuesBox.textContent = issues instanceof Error ? issues.message : issues.map((i) => `${i.code}: ${i.message}`).join('\n');
      return;
    }
    const values = { ...SCENARIOS[scenario]!.defaults, ...(scenario === c.scenario ? c.params : {}) };
    // Under Keystone's rules a scenario is an automatic level (scenarioLevel): what it asks, above its params.
    const auto = keystone ? `<div class="muted">as a level: ${escapeHtml(objectiveText({ kind: 'collapse', min: AUTO_LEVEL.objective }))}, rack ${escapeHtml(AUTO_LEVEL.rack.join(', '))}, no roles (a level file can add them)</div>` : '';
    paramsBox.innerHTML = auto + Object.entries(values).map(([k, v]) => field(`param.${k}`, PARAM_LABELS[k] ?? k, v, 'step="any"')).join('');
  }

  function sceneProposal() {
    const scenario = input(sceneForm, 'scenario').value;
    const params: Record<string, number | boolean> = {};
    for (const el of paramsBox.querySelectorAll('input')) {
      params[el.name.slice(6)] = el.type === 'checkbox' ? el.checked : el.value === '' ? NaN : Number(el.value);
    }
    const bounce = { on: bounceBox.checked, e: input(sceneForm, 'bounceE').value === '' ? NaN : Number(input(sceneForm, 'bounceE').value) };
    const presettle = input(sceneForm, 'presettle').value === '' ? NaN : Number(input(sceneForm, 'presettle').value);
    const rules: RulesChoice = { rules: input(sceneForm, 'rules').value as Rules, feel: {
      hitStop: (input(sceneForm, 'hitstop') as HTMLInputElement).checked, slowMo: (input(sceneForm, 'slowmo') as HTMLInputElement).checked,
      budgetMs: input(sceneForm, 'budget').value === '' ? NaN : Number(input(sceneForm, 'budget').value), tailSkip: (input(sceneForm, 'tailskip') as HTMLInputElement).checked,
      follow: (input(sceneForm, 'follow') as HTMLInputElement).checked, shake: (input(sceneForm, 'shake') as HTMLInputElement).checked, frames: input(sceneForm, 'frames').value as FrameMode,
      rapid: (input(sceneForm, 'rapid') as HTMLInputElement).checked,
      // A duel's aids (the game page's Siege Table): the viewer plays no duels, so they ride along as the URL says.
      turnView: hooks.config().feel.turnView, arcs: hooks.config().feel.arcs,
      undoMB: input(sceneForm, 'undo').value === '' ? NaN : Number(input(sceneForm, 'undo').value),
      launch: input(sceneForm, 'launch').value as LaunchMode, balls: input(sceneForm, 'balls').value as BallStyle,
      marks: (input(sceneForm, 'marks') as HTMLInputElement).checked,
      pullAnim: (input(sceneForm, 'pullanim') as HTMLInputElement).checked, frozenLook: (input(sceneForm, 'frozenlook') as HTMLInputElement).checked,
    }, freeze: input(sceneForm, 'freeze').value === '' ? NaN : Number(input(sceneForm, 'freeze').value) };
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
  const specBox = projForm.querySelector<HTMLElement>('.spec')!;
  const weaponPicker = specBox.querySelector<HTMLInputElement>('input[name=weaponFile]')!;
  const downloadWeapon = specBox.querySelector<HTMLButtonElement>('button[name=weaponDownload]')!;
  const customOption = projForm.querySelector<HTMLOptionElement>('option[data-custom]')!;
  // A weapon of your own (loaded, or from the link's weapon.def): offered in the picker under its name.
  let custom: WeaponSpec | null = null;
  function offerCustom(spec: WeaponSpec | null) {
    custom = spec;
    customOption.hidden = !spec;
    customOption.value = customOption.textContent = spec ? weaponName(spec) : '';
  }
  /** The spec a weapon name picks: your own under its name, else the built-in. */
  const specOf = (name: string): WeaponSpec | null => (custom && weaponName(custom) === name ? custom : (BUILTIN_WEAPONS[name] ?? null));
  function projectile(): Projectile {
    const q = new URLSearchParams();
    q.set('proj', input(projForm, 'shape').value);
    for (const k of ['size', 'mass', 'speed', 'restitution', 'friction', 'blockDensity']) q.set(`proj.${k}`, input(projForm, k).value);
    const weapon = input(projForm, 'weapon').value;
    grenadeBox.hidden = weapon !== 'grenade';
    specBox.hidden = weapon === 'grenade';
    downloadWeapon.disabled = !specOf(weapon);
    if (weapon && weapon !== 'grenade') {
      q.set('proj.weapon', weapon);
      const spec = specOf(weapon);
      if (spec && spec !== BUILTIN_WEAPONS[weapon]) q.set('weapon.def', encodeWeaponParam(spec));
    } else if (weapon) {
      q.set('proj.weapon', weapon);
      q.set('grenade.fuse', input(projForm, 'grenade.fuse').value);
      q.set('grenade.ground', (input(projForm, 'grenade.ground') as HTMLInputElement).checked ? '1' : '0');
      for (const k of Object.keys(GRENADE_FIELDS)) q.set(`grenade.${k}`, input(projForm, `grenade.${k}`).value);
    }
    return parseProjectile(q);
  }

  function showMass(p: Projectile) {
    const c = hooks.config(), m = projectileMass(p);
    (input(projForm, 'mass') as HTMLInputElement).placeholder = `auto ${m.toPrecision(3)}`;
    (input(projForm, 'blockDensity') as HTMLInputElement).placeholder = `auto ${blockDensityOf({ ...c, projectile: { ...p, blockDensity: undefined } })}`;
    projOut.textContent = [projectileSummary(p, c), p.grenade ? grenadeSummary(p.grenade) : '', p.spec ? weaponSummary(p.spec) : ''].filter(Boolean).join('; ');
    projOut.classList.remove('warn');
  }
  // A new thing to throw brings its own size, speed, bounce and friction (a real thing's, or the ball's); set them after to override.
  input(projForm, 'shape').addEventListener('change', () => {
    const kind = input(projForm, 'shape').value;
    const p = isPreset(kind) ? presetProjectile(kind) : DEFAULT_PROJECTILE;
    for (const k of ['size', 'speed'] as const) input(projForm, k).value = String(p[k]);
    for (const k of ['mass', 'restitution', 'friction'] as const) input(projForm, k).value = p[k] == null ? '' : String(p[k]);
  });

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
  // Weapon JSON: the picked spec as a file to edit, and an edited one loaded back as your own (validateWeapon's issues listed if it is refused).
  downloadWeapon.addEventListener('click', () => {
    const spec = specOf(input(projForm, 'weapon').value);
    if (spec) download(`${writeWeapon(spec)}\n`, `${weaponName(spec)}.weapon.json`);
  });
  specBox.querySelector<HTMLButtonElement>('button[name=weaponLoad]')!.addEventListener('click', () => weaponPicker.click());
  weaponPicker.addEventListener('change', async () => {
    const f = weaponPicker.files?.[0];
    weaponPicker.value = '';
    if (!f) return;
    try {
      let v: unknown;
      try { v = JSON.parse(await f.text()); } catch { throw new Error('not a JSON file'); }
      const spec = checkWeapon(v);
      offerCustom(spec);
      input(projForm, 'weapon').value = weaponName(spec);
      const p = projectile();
      showMass(p);
      hooks.setProjectile(p);
    } catch (e) {
      projOut.textContent = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
      projOut.classList.add('warn');
    }
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
      hooks.setLook(look, realOverrides(values, input(lookForm, 'ground').value, { stone: input(lookForm, 'stone').value as Stone, groundMaterial: input(lookForm, 'groundMaterial').value as Ground, env: input(lookForm, 'env').value as Env, toneMap: input(lookForm, 'toneMap').value as ToneMap }));
      lookOut.textContent = look === 'real' ? 'sun azimuth: clockwise from -z; visibility: 10 hazy, 40 clear, 150 crisp' : '';
      lookOut.classList.remove('warn');
      soundNote(); // auto's material follows the look
    } catch (e) {
      lookOut.textContent = e instanceof Error ? e.message : String(e);
      lookOut.classList.add('warn');
    }
  }
  lookForm.addEventListener('submit', (e) => e.preventDefault());
  lookForm.addEventListener('input', (e) => {
    if ((e.target as HTMLInputElement | null)?.name === 'blast') hooks.setBlast((e.target as HTMLInputElement).checked);
    else applyLook();
  });

  // Sound: applied live; auto picks the material from the scene and the look.
  const soundForm = root.querySelector<HTMLFormElement>('#sound-form')!;
  const soundBox = soundForm.querySelector<HTMLElement>('.sound')!;
  const soundOut = soundForm.querySelector<HTMLElement>('.out')!;
  const soundNote = () => {
    const c = hooks.config();
    soundOut.textContent = c.sound.on ? `${c.sound.material === 'auto' ? `auto: ${autoSoundMaterial(c)}` : c.sound.material}; the browser starts sound at your first click` : '';
    soundOut.classList.remove('warn');
  };
  soundForm.addEventListener('submit', (e) => e.preventDefault());
  soundForm.addEventListener('input', () => {
    const on = (input(soundForm, 'on') as HTMLInputElement).checked;
    soundBox.hidden = !on;
    try {
      const o = { on, material: input(soundForm, 'material').value, set: input(soundForm, 'set').value, ...Object.fromEntries((Object.keys(SOUND_KNOBS) as SoundKnob[]).map((k) => [k, input(soundForm, k).value === '' ? NaN : Number(input(soundForm, k).value)])) } as SoundOptions;
      hooks.setSound(checkSound(o));
      soundNote();
    } catch (e) {
      soundOut.textContent = e instanceof Error ? e.message : String(e);
      soundOut.classList.add('warn');
    }
  });

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
    input(sceneForm, 'budget').value = String(c.feel.budgetMs);
    (input(sceneForm, 'tailskip') as HTMLInputElement).checked = c.feel.tailSkip;
    (input(sceneForm, 'follow') as HTMLInputElement).checked = c.feel.follow;
    (input(sceneForm, 'shake') as HTMLInputElement).checked = c.feel.shake;
    (input(sceneForm, 'rapid') as HTMLInputElement).checked = c.feel.rapid;
    input(sceneForm, 'undo').value = String(c.feel.undoMB);
    input(sceneForm, 'freeze').value = c.keystone.freeze === undefined ? '' : String(c.keystone.freeze);
    input(sceneForm, 'frames').value = c.feel.frames;
    input(sceneForm, 'launch').value = c.feel.launch;
    input(sceneForm, 'balls').value = c.feel.balls;
    (input(sceneForm, 'marks') as HTMLInputElement).checked = c.feel.marks;
    (input(sceneForm, 'pullanim') as HTMLInputElement).checked = c.feel.pullAnim;
    (input(sceneForm, 'frozenlook') as HTMLInputElement).checked = c.feel.frozenLook;
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
    input(projForm, 'shape').value = p.preset ?? p.shape;
    input(projForm, 'size').value = String(p.size);
    input(projForm, 'mass').value = p.mass === null ? '' : String(p.mass);
    input(projForm, 'speed').value = String(p.speed);
    for (const k of ['restitution', 'friction', 'blockDensity'] as const) input(projForm, k).value = p[k] === undefined ? '' : String(p[k]);
    // The grenade's fields keep their values while the weapon is off, so switching it back on restores them.
    if (p.spec && p.weapon && BUILTIN_WEAPONS[p.weapon] !== p.spec && (!BUILTIN_WEAPONS[p.weapon] || writeWeapon(BUILTIN_WEAPONS[p.weapon]!) !== writeWeapon(p.spec))) offerCustom(p.spec);
    input(projForm, 'weapon').value = p.weapon ?? '';
    grenadeBox.hidden = p.weapon !== 'grenade';
    specBox.hidden = p.weapon === 'grenade';
    downloadWeapon.disabled = !p.spec;
    const g = p.grenade;
    if (g) {
      input(projForm, 'grenade.fuse').value = g.fuse;
      (input(projForm, 'grenade.ground') as HTMLInputElement).checked = g.ground;
      for (const k of GRENADE_NUMBERS) input(projForm, `grenade.${k}`).value = String(g[k]);
      for (const k of GRENADE_BLAST_KEYS) input(projForm, `grenade.${k}`).value = String(g.blast[k]);
    }
    showMass(p);
    input(lookForm, 'look').value = c.look;
    (input(lookForm, 'blast') as HTMLInputElement).checked = c.blast.on;
    realBox.hidden = c.look !== 'real';
    const real = { ...REAL_DEFAULTS, ...c.real };
    for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) input(lookForm, key).value = String(real[key]);
    input(lookForm, 'ground').value = albedoHex(real.groundAlbedo);
    input(lookForm, 'stone').value = real.stone;
    input(lookForm, 'groundMaterial').value = real.groundMaterial;
    input(lookForm, 'env').value = real.env;
    input(lookForm, 'toneMap').value = real.toneMap;
    for (const k of Object.keys(VIEW_FIELDS) as (keyof Framing)[]) input(viewForm, k).value = String(c.view[k]);
    // Under Keystone's rules the rack fires and the game frames its level: the projectile and the framing wait for the sandbox,
    // and so does the sound, which the game's loop does not feed yet. (style, not hidden: the panel's CSS sets a form's display.)
    projForm.style.display = viewForm.style.display = soundForm.style.display = c.rules === 'keystone' ? 'none' : '';
    (input(soundForm, 'on') as HTMLInputElement).checked = c.sound.on;
    soundBox.hidden = !c.sound.on;
    input(soundForm, 'material').value = c.sound.material;
    input(soundForm, 'set').value = c.sound.set;
    for (const k of Object.keys(SOUND_KNOBS) as SoundKnob[]) input(soundForm, k).value = String(c.sound[k]);
    soundNote();
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
