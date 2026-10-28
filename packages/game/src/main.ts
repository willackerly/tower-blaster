// The game page: Keystone (playKeystone, play.ts) on the GPU solver, or Rapier
// with ?engine=rapier, in the maquette look. ?level=L2 starts on another level,
// ?look= and real.* change the look, ?keystone.hitstop=1 and ?keystone.slowmo=1
// turn on pace juice, ?offscreen=1 (tests) draws only for captures.
import { LEVELS } from '@tb/keystone';
import { createDevice } from '@tb/gpu';
import { HAZY_DAY, lookByName, parseRealOptions, Renderer, SnapshotSource } from '@tb/render';
import { engineKind } from './engines.ts';
import { paceFeel } from './pacing.ts';
import { type GameHandle, newGameHandle, playKeystone } from './play.ts';
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
  const offscreen = q.get('offscreen') === '1';
  const id = (q.get('level') ?? LEVELS[0]!.id).toUpperCase();
  const start = LEVELS.findIndex((l) => l.id === id);
  if (start < 0) throw new Error(`unknown level ${id}; known: ${LEVELS.map((l) => l.id).join(', ')}`);
  const engine = engineKind(q.get('engine'));
  const feel = paceFeel(q);
  handle.feel = feel;
  handle.engine = engine;

  const { device } = await createDevice({ timestamps: false });
  const renderer = new Renderer(device, offscreen ? { size: [640, 400] } : { canvas });
  const source = new SnapshotSource(device);
  renderer.setSource(source);
  // The maquette look by default: tints read true on its pale albedo (?look=candy for the rainbow;
  // ?look=real with real.* knobs, parseRealOptions in @tb/render).
  renderer.look = lookByName(q.get('look') ?? '', parseRealOptions(q), HAZY_DAY);
  device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));

  await playKeystone({
    canvas, offscreen, device, renderer, source, hud: $('hud'), banner: $('banner'), result: $('result'),
    levels: LEVELS, start, engine, feel, fail,
    hooks: { loaded: (c) => { if (!offscreen) history.replaceState(null, '', `?level=${c.def.id}`); } },
  }, handle);
}

main().catch(fail);
