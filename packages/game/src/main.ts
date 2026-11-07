// The game page: Keystone (playKeystone, play.ts) on the GPU solver, or Rapier
// with ?engine=rapier, in the maquette look. A bare URL opens the slice (B1, then B2
// and B3); ?level=L2 starts on another level (L1 to L5: the chamber levels, par),
// ?keystone.rack= gives it another rack, ?look= and real.* change the look, ?blast=0 hides blasts (blast.* tune them), ?keystone.hitstop=1 and ?keystone.slowmo=1
// turn on pace juice, ?keystone.sound=synth plays impacts as the old pentatonic voices and
// ?keystone.impacts=-6 sets the collision sound's level (dB), ?keystone.shots= plays a line once loaded, ?offscreen=1
// (tests; or =WxH at that size) draws only for captures. The keys are params.ts's, which the viewer
// reads too under rules=keystone, so the same link opens in either page.
// The front door (door.ts, docs/game/front-door.md) opens over a bare URL
// (?door=auto|1|0); ?keystone.preaim, ?progress, ?sound, ?sharp, ?quality are its keys.
import { DUELS, duelLevel, duelLevelId, lotSheetOf, type Player, type Shot, shownGoals } from '@tb/keystone';
import { createDevice } from '@tb/gpu';
import { lookByName, parseBlastOptions, parseIceOptions, parseRealOptions, Renderer, SnapshotSource } from '@tb/render';
import { installDoor, type DoorPage } from './door-page.ts';
import { doorDuels, doorMode, doorOnLoad, duelsOnDoor, openerFor, preaimMode, seriesForward } from './door.ts';
import { buildOption, GAME_SERIES, loadOptions, lookName, onEngine, parseGameParams, weaponTierOf, withRules } from './params.ts';
import { browserKeyValue, memoryKeyValue, type ProgressStore, progressStore } from './progress.ts';
import { bankAfterLine, type SessionFacts, sessionFile, sessionFileName } from './session-file.ts';
import { feelFromSettings, settingFeel, type Settings, SettingsStore, settingUrlKeys } from './settings.ts';
import { knobsFor, type QualityState, tierFor } from './quality.ts';
import { probeQuality } from './quality-probe.ts';
import { NO_WEBGPU_HTML, webgpuMissing } from './support.ts';
import { type GameHandle, newGameHandle, playKeystone, playLine } from './play.ts';
import { helpHtml, installGameStyles } from './ui.ts';
import { goalsMode, sheetMode, sheetOpenAtLoad } from './lot-hud.ts';
import { layoutOf } from './layout.ts';
import { touchMode } from './touch.ts';

declare global { interface Window { __game: GameHandle; __progress: ProgressStore; __door: DoorPage } }

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('c') as HTMLCanvasElement, errorEl = $('error');
const handle = newGameHandle();
window.__game = handle;
installGameStyles();
// The hint line; ? (or its button) shows every key, and again goes back.
const help = $('help');
let allKeys = false;
const showHelp = (all: boolean) => { allKeys = all; help.innerHTML = helpHtml(all); };
showHelp(false);
help.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')?.dataset.act === 'keys') showHelp(!allKeys); });
addEventListener('keydown', (e) => { if (e.key === '?' && !(e.target instanceof HTMLInputElement)) showHelp(!allKeys); });

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  handle.status = 'error';
  handle.error = msg;
  errorEl.style.display = 'block';
  // A browser without WebGPU gets an explanation and what to use instead, not a raw error.
  if (webgpuMissing(msg)) errorEl.innerHTML = NO_WEBGPU_HTML;
  else errorEl.textContent = `Error: ${msg}`;
  console.error(e);
}

async function main() {
  const q = new URLSearchParams(location.search);
  const { level, rack, rules, engine, feel, shots, offscreen, offscreenSize, sound, impactsDb, duel, weaponTier } = parseGameParams(q);
  // Best plays and settings kept in the browser (?progress=off: this visit only); custom runs are not recorded.
  // A setting's URL key (look, sound, sharp) wins over the stored one for the visit (settings.ts).
  const progress = progressStore(q);
  window.__progress = progress;
  const settings = new SettingsStore(q.get('progress') === 'off' ? memoryKeyValue() : browserKeyValue() ?? memoryKeyValue(), q);
  const look = lookName(settings.current.look);
  // Each setting's say over feel (settings.ts feelFromSettings): the camera motions, rapid fire, a duel's turn view
  // and hand-over card, launch height, stone marks, each field unless the URL's key says it. One object, read live
  // by the game (each option's module, ./options, says when a change shows).
  feelFromSettings(feel, q, settings.current);
  // A duel is one shot per turn, so it never fires mid-shot whatever the Rapid fire setting says.
  if (duel) feel.rapid = false;
  // Where the HUD and the result card sit (layout.ts): the URL's keystone.hud / card / carddelay where they say, else the Layout setting.
  // One object, read live by the game; the HUD's kg-dock class docks it on a phone (ui.ts DOCK_CSS).
  const layout = layoutOf(q, settings.current.layout);
  const applyLayout = () => $('hud').classList.toggle('kg-dock', layout.hud === 'dock');
  applyLayout();
  const door = doorMode(q), preaim = preaimMode(q), bank = bankAfterLine(q), goals = goalsMode(q), sheetAt = sheetMode(q);
  // ?keystone.rack replaces the opening level's rack (its def, so retry keeps it); other levels keep their own.
  // The rule overrides (keystone.scoring, keystone.autobank, physics) apply to every level; stars cast on
  // another engine do not apply (onEngine).
  // Every built-in level is loadable (the door lists them all; a pick loads in place, no page reload); N, P and
  // Next walk the opening level's series (the big levels, the chamber levels, Undercut's or the trials).
  const all = GAME_SERIES.flat(), seriesIdx = GAME_SERIES.flatMap((s, k) => s.map(() => k));
  const start = all.findIndex((l) => l.id === level.id);
  const levels = all.map((l, i) => onEngine(i === start ? level : withRules(l, rules), engine));
  /** Level def's index in its own series (the pre-aimed opener is the series' first level's). */
  const inSeries = (id: string) => { const i = all.findIndex((l) => l.id === id); return i - seriesIdx.indexOf(seriesIdx[i]!); };
  // A duel (?duel=D1) plays its two levels instead (first player first, then the rematch's); the door keeps the series.
  const played = duel ? ([0, 1] as Player[]).map((f) => withRules(duelLevel(duel, f), rules)) : levels;
  /** Opens the game page anew on a level or a duel, keeping the visit's other keys (look, engine, settings). */
  const navigate = (key: 'level' | 'duel', id: string) => {
    const u = new URLSearchParams(location.search);
    for (const k of ['level', 'duel', 'keystone.shots', 'keystone.rack', 'keystone.bank', 'door']) u.delete(k);
    u.set(key, id);
    location.search = `?${u}`;
  };
  handle.feel = feel;
  handle.engine = engine;

  const { device, adapter } = await createDevice({ timestamps: false });
  const adapterName = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ');
  // The playtest build names its commit in build.json (packages/playtest); a dev server has none.
  let build = '';
  void fetch('build.json').then((r) => (r.ok ? r.json() : null)).then((b: { commit?: string } | null) => { build = b?.commit ?? ''; }).catch(() => {});
  // The quality tier (quality.ts, docs/game/quality-tiers.md): the probe measures this device before the
  // renderer and the first level load (it warms the device's pipeline cache for them). An offscreen page
  // (tests) runs it only when the URL says quality=auto, and otherwise keeps high, as before tiers.
  let probe: QualityState['probe'] = null, probeFailed = false;
  if (!offscreen || q.get('quality') === 'auto') {
    try { probe = await probeQuality(device, adapter, offscreen ? offscreenSize[0] : canvas.clientWidth, offscreen ? offscreenSize[1] : canvas.clientHeight, offscreen ? 1 : devicePixelRatio); }
    catch (e) { probeFailed = true; console.warn('quality probe failed:', e); }
  }
  const renderer = new Renderer(device, offscreen ? { size: offscreenSize } : { canvas });
  const source = new SnapshotSource(device);
  renderer.setSource(source);
  // The tier's knobs: the canvas's resolution (under Sharpness too), the renderer's toggles, and which frames
  // are drawn (unless the URL's keystone.frames says). Again whenever Quality or Sharpness changes on the door.
  const urlFrames = q.has('keystone.frames') ? feel.frames : null;
  const applyQuality = (st: Settings) => {
    const { tier, reason } = tierFor(st.quality, probe, probeFailed), knobs = knobsFor(tier, st.sharp, urlFrames);
    handle.maxDpr = knobs.maxDpr;
    renderer.toggles = { ...renderer.toggles, shadow: knobs.shadow, ao: knobs.ao, sparks: knobs.sparks };
    feel.frames = knobs.frames;
    handle.quality = { setting: st.quality, tier, reason, probed: probe?.tier ?? null, probe, knobs };
  };
  applyQuality(settings.current);
  // The maquette look by default: tints read true on its pale albedo (?look=candy for the rainbow;
  // ?look=real with real.* knobs, parseRealOptions in @tb/render).
  renderer.look = lookByName(look, parseRealOptions(q));
  // A blast's fireball, shell and light: on unless ?blast=0; blast.<knob> tunes them (parseBlastOptions in @tb/render).
  const blastOptions = parseBlastOptions(q);
  renderer.toggles.blasts = blastOptions.on;
  renderer.blasts.config = blastOptions.params;
  // Ice blocks (a level's ice material): ice.<knob> tunes how they are drawn (parseIceOptions in @tb/render).
  renderer.ice.params = parseIceOptions(q);
  // The front door (?door=auto|1|0): over the level loading behind it, so its first shot is a click away.
  const front = installDoor({
    root: $('door'), menu: $('menu'), levels, start: duel ? duelLevelId(duel, 0) : level.id, handle, progress, settings,
    // The Two players section (?duels=0 hides it): a table opens as ?duel=<id>; while one plays, a level opens as ?level=<id>.
    duels: duelsOnDoor(q) ? doorDuels(DUELS, duel?.id ?? null) : [],
    openDuel: (id) => navigate('duel', id),
    ...(duel ? { openLevel: (id: string) => navigate('level', id) } : {}),
    applied: (st: Settings, changed) => {
      if (changed === 'look') renderer.look = lookByName(lookName(st.look), parseRealOptions(q));
      if (changed === 'sound') handle.setMuted(!st.sound);
      if (changed === 'sharp' || changed === 'quality') applyQuality(st);
      Object.assign(feel, settingFeel(changed, feel, new URLSearchParams(), st[changed]));
      if (changed === 'rapid' && duel) feel.rapid = false;
      if (changed === 'marks') handle.refreshMarks();
      if (changed === 'layout') { Object.assign(layout, layoutOf(new URLSearchParams(), st.layout)); applyLayout(); }
      // The setting now says it: the URL keys that set it for this visit go.
      const u = new URLSearchParams(location.search), keys = settingUrlKeys(changed);
      if (keys.some((k) => u.has(k))) { for (const k of keys) u.delete(k); history.replaceState(null, '', `?${u}`); }
    },
  });
  window.__door = front;
  if (doorOnLoad(door, q)) front.show();
  device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));

  let shown = duel ? duelLevelId(duel, 0) : level.id;
  // How this attempt's round ended, for Save session. Its shots are the session's (after an undo, the kept ones and those since).
  let ended: SessionFacts | null = null, banked = false;
  await playKeystone({
    canvas, offscreen, offscreenSize, device, renderer, source, hud: $('hud'), banner: $('banner'), result: $('result'),
    levels: played, start: duel ? 0 : start, ...(duel ? {} : { series: seriesIdx, seriesForward: (i: number) => seriesForward(seriesIdx, i, levels) }),
    layout, onLevels: () => front.show(), engine, feel, weaponTier: () => weaponTierOf(weaponTier, handle.quality?.tier), fail, sound, impactsDb, muted: !settings.current.sound, touch: touchMode(q), ...loadOptions(q), ...buildOption(q),
    ...(duel ? { duel } : {}),
    // The pre-aimed opener (?keystone.preaim): by default the series' first level, until it has a record here.
    // The level's lot sheet (?keystone.goals=shown|all|off): proven goals by default, with the ones met on earlier plays marked.
    lotSheet: (c) => {
      const sheet = goals === 'off' ? undefined : lotSheetOf(c.def.id);
      if (!sheet) return null;
      const shown = shownGoals(sheet, goals === 'all');
      const best = progress.best(c.def.id, c.hash);
      return shown.length || sheet.grades ? { sheet, goals: shown, before: best?.goals ?? [], open: sheetOpenAtLoad(sheetAt, (best?.stars ?? 0) > 0) } : null;
    },
    opener: (c) => duel ? null : openerFor(c.def, inSeries(c.def.id), preaim, progress.best(c.def.id, c.hash) !== null),
    hooks: {
      // The URL follows the level, keeping the other keys; a line and a rack are the level's they were made for.
      loaded: (c) => {
        ended = null;
        banked = false;
        if (c.def.id === shown || duel) return;
        shown = c.def.id;
        const u = new URLSearchParams(location.search);
        u.set('level', c.def.id);
        u.delete('keystone.shots');
        u.delete('keystone.bank');
        // The override stays the opening level's: shown with it, gone from the others.
        if (rack && c.def.id === level.id) u.set('keystone.rack', rack.join(','));
        else u.delete('keystone.rack');
        history.replaceState(null, '', `?${u}`);
      },
      banked: () => { banked = true; },
      ended: (c, score, d) => {
        if (!c.def.custom) progress.record(c.def.id, c.hash, score, undefined, handle.goals.filter((g) => g.met).map((g) => g.id));
        const shots: Shot[] = d.session.inputs.map((x) => ({ ...x.shot }));
        ended = { level: c.def.id, hash: c.hash, custom: Boolean(c.def.custom), engine, adapter: adapterName, shots, banked, score };
      },
    },
    // The result card's Save session: the round as a file (session-file.ts) with its replay link.
    onSave: () => {
      if (!ended || !ended.shots.length) return;
      const file = sessionFile({ ...ended, build }, location.href);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`${JSON.stringify(file, null, 1)}\n`], { type: 'application/json' }));
      a.download = sessionFileName(file);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    },
  }, handle);
  // A level picked at the door while the first was still loading.
  const picked = front.takePending();
  if (picked) await handle.load(picked);
  // A link with a line plays it once, on the attempt the page opened with.
  if (shots) {
    const r = await playLine(handle, shots, true);
    if (!r.ok) console.warn(`keystone.shots: ${r.message}`);
    // A saved session that banked: bank once the line has settled, if the round is still open.
    else if (bank && handle.result === null && !handle.bank()) console.warn('keystone.bank: the level could not bank after the line');
  }
}

main().catch(fail);
