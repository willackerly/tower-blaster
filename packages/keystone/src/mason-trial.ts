// Mason's Trial as the game plays it (M8, docs/game/masons-trial.md): after Play
// the level as built is loaded and pre-settled (Driver.reset), so its engine is
// exactly where the judge's world 0 is at the end of its pre-settle. The trial
// pushes world 0's test (its probes and any quake) into that driver, which the
// page steps and draws as it steps a shot: the player watches world 0 alone, the
// solo run of mason-judge.ts soloMason, step for step. Meanwhile the judge runs
// the level's K worlds as islands on an engine of its own (judgeMason), paced so
// it never holds a frame, and the score is the judge's count (rules.ts
// masonScore). The world the player watched is reported beside it: it is not one
// of the judge's islands bit for bit (docs/design/islands.md, decision 6), so the
// card never claims it was.
import { Islands, type PhysicsEngine, reduceIslands } from '@tb/engine-api';
import { placedCost } from './build.ts';
import type { Driver } from './driver.ts';
import type { CompiledLevel } from './level.ts';
import { masonClass, masonField, masonPasses, masonProbes, masonQuestions, masonTimeline, type MasonTimeline, masonWorld, masonWorlds } from './mason.ts';
import { MasonRun, type MasonVerdict } from './mason-judge.ts';
import { type LevelScore, masonScore } from './rules.ts';

export interface MasonTrialOptions {
  /** The judge's engine (makeMasonEngine in the game), or null for no judge (the score then waits forever: tests of the hero only). */
  judge: PhysicsEngine | null;
  /** The worlds the judge runs (default every world of the level's test). */
  worlds?: readonly number[];
  /** Awaited between the judge's batches of steps: the page yields a frame here. Default: a task. */
  pace?: () => Promise<void>;
  /** Judge steps per batch before pace() (default 8). A GPU engine finishes each batch first, so the judge never queues far ahead of the world drawn. */
  batch?: number;
}

/** What the trial has to show: world 0's verdict, the judge's, and the score once both are in. */
export interface MasonTrialResult {
  /** World 0 as the player watched it: passed, and its count per pass clause. */
  hero: { pass: boolean; counts: number[] };
  verdict: MasonVerdict;
  score: LevelScore;
  /** The build's cost (build.ts placedCost). */
  spent: number;
}

export class MasonTrial {
  readonly timeline: MasonTimeline;
  readonly worlds: readonly number[];
  readonly spent: number;
  private readonly ref0: Float64Array;
  private ref1: Float64Array | null = null;
  private heroResult: MasonTrialResult['hero'] | null = null;
  private judgeVerdict: MasonVerdict | null = null;
  private judgeError: unknown = null;
  private stopped = false;
  /** The judge's run, settled when it is done (or failed, or stopped). */
  readonly judged: Promise<void>;

  /** Pushes world 0's test into `driver`, which must be exactly at the end of its pre-settle (a fresh Driver.reset), and starts the judge. */
  constructor(readonly c: CompiledLevel, readonly driver: Driver, private readonly opts: MasonTrialOptions) {
    if (!c.def.mason) throw new Error(`MasonTrial: ${c.def.id} is not a Mason level`);
    this.timeline = masonTimeline(c);
    if (driver.engine.stepIndex !== this.timeline.presettle || driver.snapshotStep !== this.timeline.presettle) {
      throw new Error(`MasonTrial: the driver is at step ${driver.engine.stepIndex} (observed ${driver.snapshotStep}), not at the end of the pre-settle (${this.timeline.presettle}): load the level again`);
    }
    this.worlds = opts.worlds ?? Array.from({ length: masonWorlds(c.def.mason) }, (_, k) => k);
    this.spent = placedCost(c.def);
    // Heritage is measured from the world as built (the judge's ref 0: the scene as it was loaded).
    this.ref0 = Float64Array.from(c.scene.bodies.flatMap((b) => [...b.pos]));
    driver.push([...masonField(c), ...masonProbes(c, 0)]);
    this.judged = opts.judge ? this.judge(opts.judge) : new Promise<void>(() => {});
  }

  private async judge(engine: PhysicsEngine): Promise<void> {
    const run = new MasonRun(engine, this.c, this.worlds), batch = Math.max(1, this.opts.batch ?? 8);
    const pace = this.opts.pace ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
    try {
      await run.init();
      while (!run.done && !this.stopped) {
        for (let k = 0; k < batch && !run.done; k++) await run.advance();
        await engine.finish?.();
        await pace();
      }
      if (!this.stopped) this.judgeVerdict = await run.verdict();
    } catch (e) {
      if (!this.stopped) this.judgeError = e;
    }
  }

  /** The hero's run: steps the page still has to take before world 0 is judged. */
  get heroDone(): boolean { return this.driver.snapshotStep >= this.timeline.end; }
  /** The judge failed (its engine was lost, or ran out of room): the trial has no score. */
  get error(): unknown { return this.judgeError; }
  get judgeDone(): boolean { return this.judgeVerdict !== null; }

  /**
   * After each of the page's steps: takes the probes' reference one step after they spawned, and world 0's
   * verdict once the driver has observed the judging step. Returns the result once the judge is in too.
   */
  observe(): MasonTrialResult | null {
    const d = this.driver, s = d.snapshot;
    if (!this.ref1 && d.snapshotStep >= this.timeline.test + 1) {
      if (d.snapshotStep !== this.timeline.test + 1) throw new Error(`MasonTrial: observe() missed step ${this.timeline.test + 1} (at ${d.snapshotStep})`);
      this.ref1 = s.pos.slice(0, 3 * s.count);
    }
    if (!this.heroResult && this.heroDone) {
      if (d.snapshotStep !== this.timeline.end) throw new Error(`MasonTrial: observe() missed the judging step ${this.timeline.end} (at ${d.snapshotStep})`);
      // World 0 as one island at the origin, its probes released as the hero's were (so ids, island tags and shapes match the driver's).
      const isl = new Islands([masonWorld(this.c, 0)]);
      for (let st = 0; st <= this.timeline.end; st++) isl.due(st);
      const counts = reduceIslands(isl, s, masonQuestions(this.c), {
        refs: [this.ref0, this.ref1], tagWords: 2, fill: (id, row) => { row[1] = masonClass(this.c, id); },
      }).counts.map((col) => col[0]!);
      this.heroResult = { pass: masonPasses(this.c.def.mason!, counts), counts };
    }
    return this.result();
  }

  /** World 0's verdict and the judge's, with the score, once both are in; else null. */
  result(): MasonTrialResult | null {
    if (!this.heroResult || !this.judgeVerdict) return null;
    const v = this.judgeVerdict;
    return { hero: this.heroResult, verdict: v, score: masonScore(this.c.def, v.passes, v.worlds.length, this.spent), spent: this.spent };
  }

  /** Stops the judge (a load, Retry or the page leaving) and frees its engine. */
  stop(): void {
    this.stopped = true;
    this.opts.judge?.dispose();
  }
}
