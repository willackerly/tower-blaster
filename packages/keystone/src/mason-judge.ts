// Mason's Trial's robustness judge (M8, docs/game/masons-trial.md): a build
// played as the level's test in several worlds at once, as islands of one
// solve (C10, engine-api islands.ts), and judged per world by the pass rule
// (mason.ts masonQuestions: one per-island count per clause, in the observer's
// fixed point). The same run with one world is a solo run: world k alone at
// the origin, as the game plays the world the player watches and as the
// judge's verify compares (test/mason-judge.test.ts: the islands' pass count
// against K solo runs').
//
// Engine-agnostic: reference, GPU or Rapier. It reads three snapshots (the
// built world before the pre-settle, the step after the probes spawn, the end)
// and counts on the CPU (reduceIslands), so a GPU engine runs pipelined with
// no read-back per step.
import { Islands, type PhysicsEngine, reduceIslands, type Snapshot } from '@tb/engine-api';
import type { CompiledLevel } from './level.ts';
import { masonClass, masonField, masonPasses, masonQuestions, masonTimeline, type MasonTimeline, masonWorld, masonWorlds } from './mason.ts';

export interface MasonVerdict {
  /** Which worlds were judged (MasonDef worlds' indices), in island order. */
  worlds: number[];
  /** Per judged world: passed. */
  pass: boolean[];
  /** Worlds that passed. */
  passes: number;
  /** Per pass clause, per judged world: the count masonQuestions asked for. */
  counts: number[][];
  /** Bodies outside their island's cell at the samples (should be 0: a leak may have let worlds touch). */
  leaks: number;
  /** Engine steps run. */
  steps: number;
}

/** Bodies the engine must hold to judge `worlds` worlds of c: every world's structure and its probes. */
export const masonCapacity = (c: CompiledLevel, worlds: number): number => worlds * (c.scene.bodies.length + c.def.mason!.probes.length);

/**
 * A judge run, stepped by its caller: the game steps it a frame at a time and draws the engine's bodies (world 0
 * alone is the run the player watches); judgeMason steps it to the end. init() loads the engine.
 */
export class MasonRun {
  readonly islands: Islands;
  readonly timeline: MasonTimeline;
  private ref0: Float64Array | null = null;
  private ref1: Float64Array | null = null;
  private leaksSeen = 0;
  private last: Snapshot | null = null;

  constructor(readonly engine: PhysicsEngine, readonly level: CompiledLevel, readonly worlds: readonly number[] = Array.from({ length: masonWorlds(level.def.mason!) }, (_, k) => k)) {
    if (!level.def.mason) throw new Error(`MasonRun: ${level.def.id} is not a Mason level`);
    this.islands = new Islands(worlds.map((k) => masonWorld(level, k)));
    this.islands.pushField(masonField(level));
    this.timeline = masonTimeline(level);
  }

  async init(): Promise<void> {
    await this.engine.init(this.islands.scene);
    this.ref0 = (await this.engine.snapshot()).pos.slice();
  }

  /** Steps taken since init. */
  get step(): number { return this.engine.stepIndex; }
  get done(): boolean { return this.engine.stepIndex >= this.timeline.end; }

  /** One engine step with whatever is due (the probes, the quake's keys). */
  async advance(): Promise<void> {
    if (!this.ref0) throw new Error('MasonRun: init() first');
    if (this.done) return;
    this.engine.push(this.islands.due(this.engine.stepIndex));
    await this.engine.step();
    if (this.engine.stepIndex === this.timeline.test + 1) {
      const s = await this.engine.snapshot();
      this.ref1 = s.pos.slice();
      this.leaksSeen += this.islands.leaks(s).length;
    }
  }

  /** The verdict at the end (it reads the engine's snapshot once). */
  async verdict(): Promise<MasonVerdict> {
    if (!this.done) throw new Error(`MasonRun: verdict() at step ${this.step} of ${this.timeline.end}`);
    const s = this.last ?? (this.last = await this.engine.snapshot()), isl = this.islands, c = this.level, m = c.def.mason!;
    const counts = reduceIslands(isl, s, masonQuestions(c), {
      refs: [this.ref0, this.ref1], tagWords: 2,
      fill: (id, row) => { row[1] = masonClass(c, isl.localOf(id)); },
    }).counts.map((col) => Array.from(col));
    const pass = this.worlds.map((_, i) => masonPasses(m, counts.map((col) => col[i]!)));
    return { worlds: [...this.worlds], pass, passes: pass.filter(Boolean).length, counts, leaks: this.leaksSeen + isl.leaks(s).length, steps: this.step };
  }
}

/** Judges c (a Mason level, as built) in `worlds` (default every world of its test) on `engine`, stepped to the end. */
export async function judgeMason(engine: PhysicsEngine, c: CompiledLevel, worlds?: readonly number[]): Promise<MasonVerdict> {
  const run = new MasonRun(engine, c, worlds);
  await run.init();
  while (!run.done) await run.advance();
  return run.verdict();
}

/** World k alone at the origin (a solo run), judged by the same rule: what the islands' count is checked against. */
export async function soloMason(engine: PhysicsEngine, c: CompiledLevel, k: number): Promise<boolean> {
  return (await judgeMason(engine, c, [k])).pass[0]!;
}
