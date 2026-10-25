// The CPU observer: any engine observed through snapshot() after every step,
// evaluated with reduceRef. Exact by construction, so it is also what native
// observers are compared with.
import type { EngineInfo, GpuBodies, InputEvent, PhysicsEngine, SceneDesc, ShapeDesc, Snapshot, StepReport } from './index.ts';
import {
  checkSpec, gatherRows, OBSERVER_CAPS, type Observation, type ObservedEngine, type ObserveOptions, type Observer,
  type ObserverCaps, reduceRef, type ReduceSpec,
} from './observe.ts';

const isThenable = <T>(v: T | Promise<T>): v is Promise<T> => typeof (v as { then?: unknown } | null | undefined)?.then === 'function';

class SnapshotObserver implements Observer {
  readonly caps: ObserverCaps = OBSERVER_CAPS;
  /** Set once the observer can no longer be used: the reason every call then fails with. */
  retired: string | null = null;
  private spec: ReduceSpec | null = null;
  private prev = new Float64Array(0);
  private prevCount = 0;
  private watchIds = new Int32Array(0);
  private tags: Uint32Array;
  private readonly refs: (Float64Array | null)[];
  private readonly results = new Map<number, Observation>();

  constructor(private readonly host: SnapshotObserved, private readonly scene: SceneDesc, private readonly tagWords: number, private latest: Snapshot) {
    this.tags = new Uint32Array(tagWords * latest.count);
    this.refs = Array.from({ length: this.caps.refSlots }, () => null);
  }

  private usable(what: string): void {
    if (this.retired) throw new Error(`${what}: ${this.retired}`);
    if (this.host.pending) throw new Error(`${what}: a step() is still pending; await it first`);
  }

  query(spec: ReduceSpec | null): void {
    this.usable('query()');
    if (spec === null) {
      this.spec = null;
      return;
    }
    checkSpec(spec, this.caps, this.tagWords, this.scene.gravity, this.scene.dt);
    if (!this.spec) {
      this.prev = this.latest.linVel.slice(0, 3 * this.latest.count);
      this.prevCount = this.latest.count;
    }
    // A copy, so a caller editing its spec later cannot bypass checkSpec.
    this.spec = structuredClone(spec);
  }

  watch(ids: Int32Array): void {
    this.usable('watch()');
    if (ids.length > this.caps.maxWatch) throw new RangeError(`watch(): ${ids.length} ids, over maxWatch = ${this.caps.maxWatch}`);
    this.watchIds = Int32Array.from(ids);
  }

  setTags(first: number, words: Uint32Array): void {
    this.usable('setTags()');
    const tw = this.tagWords;
    if (!(Number.isInteger(first) && first >= 0)) throw new RangeError(`setTags(): first must be an integer ≥ 0, got ${first}`);
    if (tw === 0 ? words.length > 0 : words.length % tw !== 0) throw new RangeError(`setTags(): ${words.length} words is not a whole number of ids at tagWords = ${tw}`);
    const end = tw ? first + words.length / tw : first;
    if (end > this.caps.maxBodies) throw new RangeError(`setTags(): ids up to ${end - 1}, over maxBodies = ${this.caps.maxBodies}`);
    if (end * tw > this.tags.length) {
      const grown = new Uint32Array(Math.max(end * tw, 2 * this.tags.length));
      grown.set(this.tags);
      this.tags = grown;
    }
    this.tags.set(words, first * tw);
  }

  captureRef(slot: number): void {
    this.usable('captureRef()');
    if (!(Number.isInteger(slot) && slot >= 0 && slot < this.caps.refSlots)) throw new RangeError(`captureRef(): slot must be an integer below refSlots = ${this.caps.refSlots}, got ${slot}`);
    this.refs[slot] = this.latest.pos.slice(0, 3 * this.latest.count);
  }

  async result(step: number): Promise<Observation> {
    if (this.retired) throw new Error(`result(): ${this.retired}`);
    await this.host.pending;
    const now = this.host.stepIndex;
    if (!Number.isInteger(step)) throw new RangeError(`result(): step must be an integer, got ${step}`);
    if (step > now) throw new RangeError(`result(${step}): only ${now} steps taken`);
    if (step <= now - this.caps.keep) throw new RangeError(`result(${step}): older than keep = ${this.caps.keep} steps (now ${now})`);
    const o = this.results.get(step);
    if (!o) throw new Error(`result(${step}): no query was active for that step`);
    return o;
  }

  /** The state after a step: evaluate the standing query on it, then make it prev. If this throws, the host retires the observer. */
  after(snap: Snapshot): void {
    if (this.retired) return; // init() or dispose() ran while its step was pending
    const step = this.host.stepIndex;
    if (this.spec) {
      if (snap.count > this.host.shapes.length) throw new Error(`${snap.count} bodies, but the scene and the spawns so far describe ${this.host.shapes.length}`);
      if (snap.count > this.caps.maxBodies) throw new RangeError(`${snap.count} bodies, over maxBodies = ${this.caps.maxBodies}`);
      const out = reduceRef(this.spec, {
        snap, prevLinVel: this.prev, prevCount: this.prevCount, shapes: this.host.shapes, tagWords: this.tagWords, tags: this.tags,
        refs: this.refs, gravity: this.scene.gravity, dt: this.scene.dt,
      });
      this.results.set(step, { step, count: snap.count, out, rows: gatherRows(snap, this.watchIds) });
      this.prev = snap.linVel.slice(0, 3 * snap.count);
      this.prevCount = snap.count;
    }
    this.latest = snap;
    for (const k of this.results.keys()) if (k <= step - this.caps.keep) this.results.delete(k);
  }
}

class SnapshotObserved implements ObservedEngine {
  readonly finish?: () => Promise<void>;
  readonly gpu?: () => GpuBodies | null;
  /** Settles once the pending step's snapshot has been evaluated; null when none is. Never rejects. */
  pending: Promise<void> | null = null;
  /** Shape per id, for the bodies that exist after the last step() call. */
  shapes: ShapeDesc[] = [];
  /** Spawns not yet applied, in the order every engine applies them: by step, then scene.inputs, then push order. */
  private due: InputEvent[] = [];
  /** An async inner step() is unresolved: inputs pushed now could land in it or the next, so push() refuses. */
  private stepping = false;
  private scene: SceneDesc | null = null;
  private observer: SnapshotObserver | null = null;
  /** Bumped by init() and dispose(), so observe() can tell either ran while it awaited its snapshot. */
  private generation = 0;

  constructor(readonly inner: PhysicsEngine) {
    if (inner.finish)
      this.finish = async () => {
        await inner.finish!();
        await this.pending;
      };
    if (inner.gpu) this.gpu = () => inner.gpu!();
  }

  get info(): EngineInfo { return this.inner.info; }
  get stepIndex(): number { return this.inner.stepIndex; }

  /** o keeps its first reason; detached, so later steps run unobserved. */
  private retire(why: string, o = this.observer): void {
    if (o) o.retired ??= why;
    if (this.observer === o) this.observer = null;
  }

  async init(scene: SceneDesc): Promise<void> {
    this.generation++;
    this.retire('the engine was re-initialized by init()');
    this.scene = null;
    await this.inner.init(scene);
    this.scene = scene;
    // Ids as the engines assign them: the scene's bodies, then each input as it spawns.
    this.shapes = scene.bodies.map((b) => b.shape);
    this.due = [...scene.inputs].sort((a, b) => a.step - b.step);
  }

  /** Forwards to the engine, then queues the spawns with the engines' stable insertion. */
  push(events: InputEvent[]): void {
    if (this.stepping) throw new Error('push(): a step() is still running; await it first');
    this.inner.push(events);
    for (const ev of events) {
      let i = this.due.length;
      while (i > 0 && this.due[i - 1]!.step > ev.step) i--;
      this.due.splice(i, 0, ev);
    }
  }

  /** The inputs the step() just called applies: those due at or before its start index. */
  private spawnDue(at: number): void {
    while (this.due.length && this.due[0]!.step <= at) this.shapes.push(this.due.shift()!.body.shape);
  }

  /** The returned promise settles after pending is cleared, so a caller that awaits it may step again at once. */
  private track<T>(p: Promise<T>): Promise<T> {
    const settled = p.finally(() => { this.pending = null; });
    this.pending = settled.then(() => undefined, () => undefined);
    return settled;
  }

  step(): StepReport | void | Promise<StepReport | void> {
    if (this.pending) throw new Error('step(): the previous step() is still pending; await it first');
    const o = this.observer, at = this.inner.stepIndex;
    if (!o) {
      // Tracked unobserved too, so observe() never snapshots a state this step is about to replace.
      const r = this.inner.step();
      this.spawnDue(at);
      return isThenable(r) ? this.track(this.running(r)) : r;
    }
    // A step whose state was not evaluated leaves prev a step behind, so a failed
    // step, snapshot or evaluation retires the observer rather than letting the next dv span two steps.
    const failed = (e: unknown): never => {
      this.retire(`observer failed after step ${this.inner.stepIndex}: ${(e as Error).message}`, o);
      throw e;
    };
    try {
      const r = this.inner.step();
      this.spawnDue(at);
      if (isThenable(r)) return this.track(this.running(r).then(async (rep) => {
        o.after(await this.inner.snapshot());
        return rep;
      }).catch(failed));
      const s = this.inner.snapshot();
      if (isThenable(s)) return this.track(s.then((snap) => {
        o.after(snap);
        return r;
      }).catch(failed));
      o.after(s);
      return r;
    } catch (e) {
      return failed(e);
    }
  }

  /** r, with push() refused until it settles. */
  private running<T>(r: Promise<T>): Promise<T> {
    this.stepping = true;
    return r.finally(() => { this.stepping = false; });
  }

  snapshot(): Snapshot | Promise<Snapshot> { return this.inner.snapshot(); }

  dispose(): void {
    this.generation++;
    this.retire('the engine was disposed');
    this.scene = null;
    this.inner.dispose();
  }

  async observe(opts: ObserveOptions): Promise<Observer> {
    const scene = this.scene, generation = this.generation, tw = opts.tagWords;
    if (!scene) throw new Error('observe(): init() first');
    if (this.pending) throw new Error('observe(): a step() is still pending; await it first');
    if (!(Number.isInteger(tw) && tw >= 0 && tw <= OBSERVER_CAPS.maxTagWords)) throw new RangeError(`observe(): tagWords must be an integer 0..${OBSERVER_CAPS.maxTagWords}, got ${tw}`);
    for (let i = 1; i < scene.inputs.length; i++)
      if (scene.inputs[i]!.step < scene.inputs[i - 1]!.step) throw new Error('observe(): scene.inputs must be sorted by step, or ids would not follow bodiesAt');
    const s = this.inner.snapshot(), snap = isThenable(s) ? await this.track(s) : s;
    if (this.generation !== generation) throw new Error('observe(): init() or dispose() ran meanwhile');
    this.retire('replaced by a later observe()');
    return (this.observer = new SnapshotObserver(this, scene, tw, snap));
  }
}

/**
 * Any engine observed through snapshot() after every step (lag 0). Mirrors the engine's id assignment from init(), its
 * scene inputs and push(); push() refuses while an async step() is still running.
 * An observed step that fails (its step, snapshot or evaluation) retires the observer; later steps run unobserved.
 */
export function withSnapshotObserver(inner: PhysicsEngine): ObservedEngine {
  return new SnapshotObserved(inner);
}
