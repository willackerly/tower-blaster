// The cast page (roadmap G5.1): plays lines of an outcome level for the star
// cast on this browser's GPU, each from the level's start on a fresh engine
// built as the game builds it (engines.ts makeEngine, driverOptions), so a
// cast plays exactly what the game plays on this device. pnpm keystone:cast
// --engine gpu drives it (keystone-lab cast-browser.ts): SwiftShader in CI,
// Metal with --channel chrome on a Mac. No rendering: physics only.
// ?engine=rapier plays on Rapier instead, for comparison.
import { type CastPlay, castPlay, compileLevel, type LevelDef, physicsOf, readShots, type RubeResult, rubePlay } from '@tb/keystone';
import { limitProblems } from '@tb/engine-api';
import { createDevice, isSoftwareAdapter } from '@tb/gpu';
import { driverOptions, engineKind, makeEngine } from './engines.ts';

export interface CastHandle {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** The GPU adapter as text (vendor, architecture, description), and whether it is a software one (SwiftShader). */
  adapter: string;
  software: boolean;
  engine: string;
  /** Each line (writeShots text) from the level's start on a fresh engine, in order; ms is each play's wall time. */
  play(level: LevelDef, lines: string[], maxSteps?: number): Promise<Array<CastPlay & { ms: number }>>;
  /**
   * The level at rest on a fresh engine: its pre-settle as the game runs it, then `steps` more with
   * nothing fired. Reports the most any structure body moved over those steps and how far the top
   * fell, in cells (h), with the engine's limit report; ms is the whole run's wall time.
   */
  rest(level: LevelDef, steps: number): Promise<RestReport>;
  /** A Rube Lab level (par scoring, one plunger: keystone rube-play.ts) as the game plays it, on a fresh engine. */
  rube(level: LevelDef): Promise<RubeResult & { ms: number }>;
}

export interface RestReport { presettle: number; steps: number; maxMove: number; topDrop: number; limits: string[]; ms: number }

declare global { interface Window { __cast: CastHandle } }

const log = document.getElementById('log')!;
const notReady = async (): Promise<never> => { throw new Error('the cast page is not ready'); };
const handle: CastHandle = { status: 'loading', adapter: '', software: false, engine: '', play: notReady, rest: notReady, rube: notReady };
window.__cast = handle;

async function main() {
  const kind = engineKind(new URLSearchParams(location.search).get('engine'));
  const { adapter, device } = await createDevice({ timestamps: false });
  device.lost.then((info) => { handle.status = 'error'; handle.error = `GPU device lost: ${info.message}`; });
  const info = adapter.info;
  handle.adapter = `${info.vendor} ${info.architecture} ${info.description}`.replace(/\s+/g, ' ').trim() || 'unknown';
  handle.software = isSoftwareAdapter(info);
  handle.engine = kind;
  let plays = 0;
  handle.play = async (level, lines, maxSteps) => {
    const c = compileLevel(level), out: Array<CastPlay & { ms: number }> = [];
    for (const text of lines) {
      const e = makeEngine(kind, c, device), t0 = performance.now();
      try {
        out.push({ ...(await castPlay(e, c, readShots(text), { ...driverOptions(kind), maxSteps })), ms: performance.now() - t0 });
      } finally { e.dispose(); }
      log.textContent = `${handle.adapter} (${kind}): ${++plays} plays; last ${text}`;
    }
    return out;
  };
  handle.rest = async (level, steps) => {
    const c = compileLevel(level), n = c.meta.n, h = c.frame.unit, presettle = physicsOf(level).presettle;
    const e = makeEngine(kind, c, device), t0 = performance.now();
    try {
      await e.init(c.scene);
      for (let i = 0; i < presettle; i++) await e.step();
      const a = Float32Array.from((await e.snapshot()).pos.subarray(0, 3 * n));
      for (let i = 0; i < steps; i++) await e.step();
      const b = (await e.snapshot()).pos;
      let maxMove = 0, topA = -Infinity, topB = -Infinity;
      for (let i = 0; i < n; i++) {
        maxMove = Math.max(maxMove, Math.hypot(b[3 * i]! - a[3 * i]!, b[3 * i + 1]! - a[3 * i + 1]!, b[3 * i + 2]! - a[3 * i + 2]!));
        topA = Math.max(topA, a[3 * i + 1]!);
        topB = Math.max(topB, b[3 * i + 1]!);
      }
      const limits = limitProblems(e.health ? await e.health() : null, e.info.name);
      return { presettle, steps, maxMove: maxMove / h, topDrop: (topA - topB) / h, limits, ms: performance.now() - t0 };
    } finally { e.dispose(); }
  };
  handle.rube = async (level) => {
    const c = compileLevel(level), e = makeEngine(kind, c, device), t0 = performance.now();
    try { return { ...(await rubePlay(e, c, driverOptions(kind))), ms: performance.now() - t0 }; } finally { e.dispose(); }
  };
  handle.status = 'ready';
  log.textContent = `${handle.adapter} (${kind}): ready`;
}

main().catch((e: unknown) => { handle.status = 'error'; handle.error = e instanceof Error ? e.message : String(e); log.textContent = `Error: ${handle.error}`; });
