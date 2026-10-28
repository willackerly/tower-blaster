// The game page: Keystone (playKeystone, play.ts) on the GPU solver, or Rapier
// with ?engine=rapier, in the maquette look. ?level=L2 starts on another level,
// ?look= and real.* change the look, ?keystone.hitstop=1 and ?keystone.slowmo=1
// turn on pace juice, ?keystone.shots= plays a line once loaded, ?offscreen=1
// (tests) draws only for captures. The keys are params.ts's, which the viewer
// reads too under rules=keystone, so the same link opens in either page.
import { LEVELS } from '@tb/keystone';
import { createDevice } from '@tb/gpu';
import { lookByName, parseRealOptions, Renderer, SnapshotSource } from '@tb/render';
import { parseGameParams } from './params.ts';
import { type GameHandle, newGameHandle, playKeystone, playLine } from './play.ts';
import { GAME_HELP, installGameStyles } from './ui.ts';

declare global { interface Window { __game: GameHandle } }

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('c') as HTMLCanvasElement, errorEl = $('error');
const handle = newGameHandle();
window.__game = handle;
installGameStyles();
$('help').innerHTML = GAME_HELP;

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  handle.status = 'error';
  handle.error = msg;
  errorEl.style.display = 'block';
  errorEl.textContent = `Error: ${msg}`;
  console.error(e);
}

async function main() {
  const q = new URLSearchParams(location.search);
  const { level, engine, feel, look, shots, offscreen } = parseGameParams(q);
  const start = LEVELS.indexOf(level);
  handle.feel = feel;
  handle.engine = engine;

  const { device } = await createDevice({ timestamps: false });
  const renderer = new Renderer(device, offscreen ? { size: [640, 400] } : { canvas });
  const source = new SnapshotSource(device);
  renderer.setSource(source);
  // The maquette look by default: tints read true on its pale albedo (?look=candy for the rainbow;
  // ?look=real with real.* knobs, parseRealOptions in @tb/render).
  renderer.look = lookByName(look, parseRealOptions(q));
  device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));

  let shown = level.id;
  await playKeystone({
    canvas, offscreen, device, renderer, source, hud: $('hud'), banner: $('banner'), result: $('result'),
    levels: LEVELS, start, engine, feel, fail,
    hooks: {
      // The URL follows the level, keeping the other keys; a line is the level's it was made on.
      loaded: (c) => {
        if (c.def.id === shown) return;
        shown = c.def.id;
        const u = new URLSearchParams(location.search);
        u.set('level', c.def.id);
        u.delete('keystone.shots');
        history.replaceState(null, '', `?${u}`);
      },
    },
  }, handle);
  // A link with a line plays it once, on the attempt the page opened with.
  if (shots) {
    const r = await playLine(handle, shots, true);
    if (!r.ok) console.warn(`keystone.shots: ${r.message}`);
  }
}

main().catch(fail);
