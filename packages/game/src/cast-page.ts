// The cast page (roadmap G5.1): plays lines of an outcome level for the star
// cast on this browser's GPU, each from the level's start on a fresh engine
// built as the game builds it (engines.ts makeEngine, driverOptions), so a
// cast plays exactly what the game plays on this device. pnpm keystone:cast
// --engine gpu drives it (keystone-lab cast-browser.ts): SwiftShader in CI,
// Metal with --channel chrome on a Mac. No rendering: physics only.
// ?engine=rapier plays on Rapier instead, for comparison.
import { type CastPlay, castPlay, type CompiledLevel, compileLevel, type DuelDef, DUELS, duelLevel, type Player, judgeMason, type LevelDef, type MasonVerdict, nudgedLevel, physicsOf, readShots, type RubeResult, rubePlay, type WaveOptions, type WaveResult, wavePlay } from '@tb/keystone';
import { limitProblems } from '@tb/engine-api';
import { createDevice, isSoftwareAdapter } from '@tb/gpu';
import { driverOptions, engineKind, makeEngine, makeMasonEngine } from './engines.ts';
import { type DuelOutcome, duelOutcome, noviceDuel, type NoviceTurn, swappedOrder } from './duel-bot.ts';

export interface CastHandle {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** The GPU adapter as text (vendor, architecture, description), and whether it is a software one (SwiftShader). */
  adapter: string;
  software: boolean;
  engine: string;
  /**
   * Each line (writeShots text) from the level's start on a fresh engine, in order; ms is each play's wall time.
   * `nudges` (index-aligned, optional): each play's build nudge (keystone nudgedLevel; 0 the exact build).
   */
  play(level: LevelDef, lines: string[], maxSteps?: number, nudges?: readonly number[]): Promise<Array<CastPlay & { ms: number }>>;
  /**
   * The level at rest on a fresh engine: its pre-settle as the game runs it, then `steps` more with
   * nothing fired. Reports the most any structure body moved over those steps and how far the top
   * fell, in cells (h), with the engine's limit report; ms is the whole run's wall time. `settle` is
   * the pre-settle itself, from the authored poses: the most any body moved, and how many moved over
   * half a cell (a structure broken at load: an arch's bricks falling in, a heap).
   */
  rest(level: LevelDef, steps: number): Promise<RestReport>;
  /** A Rube Lab level (par scoring, one plunger: keystone rube-play.ts) as the game plays it, on a fresh engine. */
  rube(level: LevelDef): Promise<RubeResult & { ms: number }>;
  /** A Wavefront level (keystone wave-play.ts) played with one line (writeShots text) on a fresh engine, the wave metered. */
  wave(level: LevelDef, line: string, opts?: Pick<WaveOptions, 'groups' | 'fell' | 'maxSteps'>): Promise<WaveResult & { ms: number }>;
  /** A Mason level as built, judged in `worlds` (MasonDef worlds' indices) at once on a fresh engine (keystone judgeMason); limits as rest's. */
  mason(level: LevelDef, worlds: number[]): Promise<MasonVerdict & { limits: string[]; ms: number }>;
  /**
   * One novice Siege Table duel (duel-bot.ts noviceDuel: the agent playtest's bot) on a fresh engine built as the game
   * builds the table's level for `first`: PT5's balance on this engine (agent playtest round 2: the GPU solver).
   */
  duel(id: string, first: Player, seed: number, aspect?: number, opts?: DuelProbe): Promise<DuelOutcome & { ms: number; mirror: number; shots: DuelShot[] }>;
}

export interface RestReport { presettle: number; steps: number; maxMove: number; topDrop: number; settle: { maxMove: number; fell: number }; limits: string[]; ms: number }

declare global { interface Window { __cast: CastHandle } }

const log = document.getElementById('log')!;
const notReady = async (): Promise<never> => { throw new Error('the cast page is not ready'); };
/**
 * A probe duel (PT22): `turns` stops after that many shots; `swap` trades the sides' parts in the part list (duel-bot.ts
 * swappedOrder); `rivalOnly` aims only clicks on rival blocks (duel-bot.ts NoviceOptions); `def` plays that table
 * instead of the one named (a variant under test: the layout before PT22, say).
 */
export interface DuelProbe { turns?: number; swap?: boolean; rivalOnly?: boolean; def?: DuelDef }
/** One shot of a probe duel as it crosses to node: who fired, the referee's tally and the kings after it. */
export interface DuelShot { player: Player; rival: number; own: number; kingsDown: [boolean, boolean] }
const duelShot = (t: NoviceTurn): DuelShot => ({ player: t.player, rival: t.tally?.rival ?? 0, own: t.tally?.own ?? 0, kingsDown: t.kingsDown });

const handle: CastHandle = { status: 'loading', adapter: '', software: false, engine: '', play: notReady, rest: notReady, rube: notReady, wave: notReady, mason: notReady, duel: notReady };
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
  handle.play = async (level, lines, maxSteps, nudges) => {
    const exact = compileLevel(level), out: Array<CastPlay & { ms: number }> = [], built = new Map<number, CompiledLevel>();
    const buildOf = (n: number) => { if (!built.has(n)) built.set(n, nudgedLevel(exact, n)); return built.get(n)!; };
    for (const [k, text] of lines.entries()) {
      const c = buildOf(nudges?.[k] ?? 0);
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
      const home = c.meta.home;
      for (let i = 0; i < presettle; i++) await e.step();
      const a = Float32Array.from((await e.snapshot()).pos.subarray(0, 3 * n));
      let settleMove = 0, fell = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(a[3 * i]! - home[3 * i]!, a[3 * i + 1]! - home[3 * i + 1]!, a[3 * i + 2]! - home[3 * i + 2]!) / h;
        settleMove = Math.max(settleMove, d);
        if (d > 0.5) fell++;
      }
      for (let i = 0; i < steps; i++) await e.step();
      const b = (await e.snapshot()).pos;
      let maxMove = 0, topA = -Infinity, topB = -Infinity;
      for (let i = 0; i < n; i++) {
        maxMove = Math.max(maxMove, Math.hypot(b[3 * i]! - a[3 * i]!, b[3 * i + 1]! - a[3 * i + 1]!, b[3 * i + 2]! - a[3 * i + 2]!));
        topA = Math.max(topA, a[3 * i + 1]!);
        topB = Math.max(topB, b[3 * i + 1]!);
      }
      const limits = limitProblems(e.health ? await e.health() : null, e.info.name);
      return { presettle, steps, maxMove: maxMove / h, topDrop: (topA - topB) / h, settle: { maxMove: settleMove, fell }, limits, ms: performance.now() - t0 };
    } finally { e.dispose(); }
  };
  handle.rube = async (level) => {
    const c = compileLevel(level), e = makeEngine(kind, c, device), t0 = performance.now();
    try { return { ...(await rubePlay(e, c, driverOptions(kind))), ms: performance.now() - t0 }; } finally { e.dispose(); }
  };
  handle.wave = async (level, line, opts = {}) => {
    const c = compileLevel(level), e = makeEngine(kind, c, device), t0 = performance.now();
    try { return { ...(await wavePlay(e, c, readShots(line), { ...driverOptions(kind), ...opts })), ms: performance.now() - t0 }; } finally { e.dispose(); }
  };
  handle.mason = async (level, worlds) => {
    const c = compileLevel(level), e = makeMasonEngine(kind, c, worlds.length, device), t0 = performance.now();
    try {
      const v = await judgeMason(e, c, worlds);
      return { ...v, limits: limitProblems(e.health ? await e.health() : null, e.info.name), ms: performance.now() - t0 };
    } finally { e.dispose(); }
  };
  handle.duel = async (id, first, seed, aspect = 1.6, opts = {}) => {
    const table = opts.def ?? DUELS.find((d) => d.id === id);
    if (!table) throw new Error(`no duel ${id}: ${DUELS.map((d) => d.id).join(', ')}`);
    const def = opts.swap ? swappedOrder(table) : table;
    const e = makeEngine(kind, compileLevel(duelLevel(def, first)), device), t0 = performance.now();
    try {
      const r = await noviceDuel(e, def, first, seed, aspect, { ...(opts.turns ? { turns: opts.turns } : {}), ...(opts.rivalOnly ? { rivalOnly: true } : {}) });
      return { ...duelOutcome(r), ms: performance.now() - t0, mirror: r.mirror, shots: r.turns.map(duelShot) };
    } finally { e.dispose(); }
  };
  handle.status = 'ready';
  log.textContent = `${handle.adapter} (${kind}): ready`;
}

main().catch((e: unknown) => { handle.status = 'error'; handle.error = e instanceof Error ? e.message : String(e); log.textContent = `Error: ${handle.error}`; });
