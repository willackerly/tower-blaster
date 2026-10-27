// The viewer's control panel: the scene (scenario, its params, seed, cube size and substeps), rebuilt
// on demand, and the projectile and the look, applied as soon as a field changes; and the
// whole setup saved to or loaded from a JSON file (scene-file.ts). The panel
// only proposes configs; main.ts decides how to apply them (live, or by reset).
import { type Env, ENVS, type Ground, GROUNDS, linearToSrgb, LOOKS, REAL_DEFAULTS, REAL_KNOBS, type RealKnob, type RealOptions, srgbToLinear, type Stone, STONES, type V3 } from '@tb/render';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import type { CameraPose } from './camera.ts';
import { escapeHtml } from './html.ts';
import { autoSubsteps, MAX_SUBSTEPS, SCALE_LIMITS, type ViewerConfig } from './params.ts';
import { parseProjectile, type Projectile, projectileMass } from './projectile.ts';
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
  /** Where the camera is now (saved as where the scene starts). */
  camera(): CameraPose;
  /** Switch to this config, loaded from a file named name. */
  load(next: ViewerConfig, name: string): void;
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

/**
 * The scene a set of form values describes, or why it can't be built. Builds it
 * (cheap next to an engine init) so the panel can show the body count before a rebuild.
 */
export function proposeScene(c: ViewerConfig, scenario: string, params: Record<string, number | boolean>, seed: number, scale = c.scale, substeps = c.substeps):
  { ok: true; config: ViewerConfig; bodies: number } | { ok: false; error: string } {
  try {
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
    if (!(scale >= SCALE_LIMITS[0] && scale <= SCALE_LIMITS[1])) throw new Error(`cube edge must be from ${SCALE_LIMITS[0]} to ${SCALE_LIMITS[1]} m`);
    if (!Number.isInteger(substeps) || substeps < 1 || substeps > MAX_SUBSTEPS) throw new Error(`substeps must be a whole number from 1 to ${MAX_SUBSTEPS}`);
    // A rebuilt scene is framed afresh: a start camera chosen for the old one need not fit it.
    const next: ViewerConfig = { ...c, scenario, params, seed, scale, substeps, camera: null };
    return { ok: true, config: next, bodies: buildScenario(scenario, params, seed).bodies.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The scene line under the form: bodies, and what the cube size and substeps do to the physics. */
export function sceneSummary(bodies: number, scale: number, substeps: number): string {
  const parts = [`${bodies.toLocaleString()} bodies`];
  if (scale !== 1) parts.push(`${+(1 / scale).toFixed(2)} g in cube units, ${+(1 / Math.sqrt(scale)).toFixed(2)}x as fast`);
  if (substeps !== 1) parts.push(`${substeps}x physics cost`);
  return parts.join(', ');
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
      <label class="f"><span>scenario</span><select name="scenario">${Object.values(SCENARIOS).map((s) => `<option value="${s.id}">${s.id} ${escapeHtml(s.title)}</option>`).join('')}</select></label>
      <div class="params"></div>
      ${field('seed', 'seed', 1, 'step="1"')}
      ${field('scale', 'cube edge (m)', 1, `step="any" min="${SCALE_LIMITS[0]}" max="${SCALE_LIMITS[1]}"`)}
      ${field('substeps', 'physics substeps', 1, `step="1" min="1" max="${MAX_SUBSTEPS}"`)}
      <div class="out muted"></div>
      <button type="submit">Rebuild scene</button>
    </form>
    <form id="proj-form">
      <div class="h">Projectile</div>
      <label class="f"><span>shape</span><select name="shape"><option value="ball">ball</option><option value="cube">cube</option></select></label>
      ${field('size', 'size (m)', 0, 'step="0.1" min="0.1" max="20"')}
      ${field('mass', 'mass (kg)', '', 'step="any" min="0.01"')}
      ${field('speed', 'speed (m/s)', 0, 'step="1" min="0" max="500"')}
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
    <form id="file-form">
      <div class="h">Configuration</div>
      <label class="f"><span>name</span><input type="text" name="name" placeholder="optional" maxlength="120"></label>
      <div class="buttons"><button type="submit">Download</button><button type="button" name="load">Load…</button></div>
      <input type="file" name="file" accept=".json,application/json" hidden>
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

  /** Param fields for a scenario: the config's values when it is the current one, else its defaults. */
  function showParams(scenario: string) {
    const c = hooks.config();
    const values = { ...SCENARIOS[scenario]!.defaults, ...(scenario === c.scenario ? c.params : {}) };
    paramsBox.innerHTML = Object.entries(values).map(([k, v]) => field(`param.${k}`, PARAM_LABELS[k] ?? k, v, 'step="any"')).join('');
  }

  function sceneProposal() {
    const scenario = input(sceneForm, 'scenario').value;
    const params: Record<string, number | boolean> = {};
    for (const el of paramsBox.querySelectorAll('input')) {
      params[el.name.slice(6)] = el.type === 'checkbox' ? el.checked : el.value === '' ? NaN : Number(el.value);
    }
    return proposeScene(hooks.config(), scenario, params, Number(input(sceneForm, 'seed').value), Number(input(sceneForm, 'scale').value), Number(input(sceneForm, 'substeps').value));
  }

  function checkScene() {
    const p = sceneProposal();
    sceneOut.textContent = p.ok ? sceneSummary(p.bodies, p.config.scale, p.config.substeps) : p.error;
    sceneOut.classList.toggle('warn', !p.ok);
    rebuildButton.disabled = !p.ok;
  }

  function projectile(): Projectile {
    const q = new URLSearchParams();
    q.set('proj', input(projForm, 'shape').value);
    for (const k of ['size', 'mass', 'speed']) q.set(`proj.${k}`, input(projForm, k).value);
    return parseProjectile(q);
  }

  function showMass(p: Projectile) {
    const m = projectileMass(p);
    (input(projForm, 'mass') as HTMLInputElement).placeholder = `auto ${m.toPrecision(3)}`;
    projOut.textContent = `${m.toPrecision(3)} kg, ${(m * p.speed).toPrecision(3)} kg·m/s (a cube is 1 kg)`;
    projOut.classList.remove('warn');
  }

  // A new cube size brings its own substeps (autoSubsteps); set them after to override.
  input(sceneForm, 'scale').addEventListener('input', () => {
    const s = Number(input(sceneForm, 'scale').value);
    if (s >= SCALE_LIMITS[0] && s <= SCALE_LIMITS[1]) input(sceneForm, 'substeps').value = String(autoSubsteps(s));
  });
  input(sceneForm, 'scenario').addEventListener('change', () => { showParams(input(sceneForm, 'scenario').value); checkScene(); });
  sceneForm.addEventListener('input', checkScene);
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

  // Download: the current config and camera as JSON. Load: a file picked here, applied by main.ts.
  const fileForm = root.querySelector<HTMLFormElement>('#file-form')!;
  const fileOut = fileForm.querySelector<HTMLElement>('.out')!;
  const picker = input(fileForm, 'file') as HTMLInputElement;
  const say = (text: string, warn = false) => { fileOut.textContent = text; fileOut.classList.toggle('warn', warn); };
  fileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = hooks.config(), name = input(fileForm, 'name').value;
    const file = sceneFile(c, name, hooks.camera());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }));
    a.download = sceneFileName(name, c.scenario);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    say(`Saved ${a.download}`);
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
    input(sceneForm, 'scenario').value = c.scenario;
    input(sceneForm, 'seed').value = String(c.seed);
    input(sceneForm, 'scale').value = String(c.scale);
    input(sceneForm, 'substeps').value = String(c.substeps);
    showParams(c.scenario);
    checkScene();
    const p = c.projectile;
    input(projForm, 'shape').value = p.shape;
    input(projForm, 'size').value = String(p.size);
    input(projForm, 'mass').value = p.mass === null ? '' : String(p.mass);
    input(projForm, 'speed').value = String(p.speed);
    showMass(p);
    input(lookForm, 'look').value = c.look;
    realBox.hidden = c.look !== 'real';
    const real = { ...REAL_DEFAULTS, ...c.real };
    for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) input(lookForm, key).value = String(real[key]);
    input(lookForm, 'ground').value = albedoHex(real.groundAlbedo);
    input(lookForm, 'stone').value = real.stone;
    input(lookForm, 'groundMaterial').value = real.groundMaterial;
    input(lookForm, 'env').value = real.env;
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
