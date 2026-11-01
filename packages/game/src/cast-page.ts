// The cast page (roadmap G5.1): plays lines of an outcome level for the star
// cast on this browser's GPU, each from the level's start on a fresh engine
// built as the game builds it (engines.ts makeEngine, driverOptions), so a
// cast plays exactly what the game plays on this device. pnpm keystone:cast
// --engine gpu drives it (keystone-lab cast-browser.ts): SwiftShader in CI,
// Metal with --channel chrome on a Mac. No rendering: physics only.
// ?engine=rapier plays on Rapier instead, for comparison.
import { type CastPlay, castPlay, compileLevel, type LevelDef, readShots } from '@tb/keystone';
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
}

declare global { interface Window { __cast: CastHandle } }

const log = document.getElementById('log')!;
const handle: CastHandle = { status: 'loading', adapter: '', software: false, engine: '', play: async () => { throw new Error('the cast page is not ready'); } };
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
  handle.status = 'ready';
  log.textContent = `${handle.adapter} (${kind}): ready`;
}

main().catch((e: unknown) => { handle.status = 'error'; handle.error = e instanceof Error ? e.message : String(e); log.textContent = `Error: ${handle.error}`; });
