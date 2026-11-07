// The game's collision sound: @tb/audio's collapse synth in an AudioWorklet,
// fed one AudioFrame per physics step (physics-loop.ts), from the
// snapshot the game already has on the CPU (FrameTap). It replaces the
// synth's impact and contact voices (audio.ts); the crown, heritage, tier,
// level-end and launch cues stay there. Created on the first user gesture.
import { FrameTap, type HostStats, PROCESSOR, type Room, type SoundMessage, type SoundSet } from '@tb/audio';
import workletUrl from '@tb/audio/worklet?worker&url';
import type { BodyDesc, Snapshot, Vec3 } from '@tb/engine-api';
import type { CompiledLevel } from '@tb/keystone';
import { gameSoundDb, slotSounds, SOUND_SLOTS, soundSlotOf } from './sound-map.ts';

export type CollapseStatus = 'off' | 'starting' | 'waiting' | 'on' | 'error';

/** Slowest speed change that sounds (m/s) and the loudest impacts a frame played as their own voices: the viewer's defaults. */
const DV_MIN = 0.25, TOP = 8;

export class CollapseSound {
  status: CollapseStatus = 'off';
  error = '';
  stats: HostStats | null = null;
  posted = 0;
  muted = false;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private readonly tap = new FrameTap({ materials: SOUND_SLOTS, sectors: 4 });
  private level: CompiledLevel | null = null;
  private slots = 0;
  private last = 0;
  private dest: AudioNode | null = null;

  private readonly kapla: boolean;
  /** The room it plays in (keystone.room); the classic set always plays dry. */
  readonly room: Room;
  /** Space (keystone.space, A8a): sectors at their impacts' pan, the room by distance; never in the classic set. */
  readonly space: boolean;

  /**
   * extraDb: the level over the game's own (gameSoundDb of the set); set: the materials ('classic': G6's); kapla: Kapla
   * planks sound as real ones (keystone.kaplasound pine; never in the classic set, which is G6's); room: where it is
   * heard (keystone.room, @tb/audio room.ts; dry in the classic set); space: keystone.space (A8a; off in the classic set).
   */
  constructor(private readonly extraDb = 0, private readonly set: SoundSet = 'real', kapla = true, room: Room = 'outdoor', space = true) {
    this.kapla = kapla && set !== 'classic';
    this.room = set === 'classic' ? 'off' : room;
    this.space = space && set !== 'classic';
  }

  private get gain(): number { return 10 ** ((gameSoundDb(this.set) + this.extraDb) / 20); }

  /** Start on a user gesture (autoplay policy), on the page's context (the synth's too): loads the worklet, then resumes. */
  wake(ctx: AudioContext, dest: AudioNode = ctx.destination): void {
    if (this.status === 'error') return;
    if (!this.ctx) { this.dest = dest; this.starting ??= this.start(ctx); return; }
    if (this.ctx.state !== 'running') void this.ctx.resume().then(() => this.running());
  }

  /** A level was (re)loaded: new materials and edges, and every velocity forgotten. */
  load(c: CompiledLevel): void {
    this.level = c;
    this.tap.reset();
    this.slots = 0;
    this.last = 0;
    this.sendLevel();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.post({ type: 'gain', gain: this.gain, muted: m });
  }

  /** After a physics step: the snapshot (metres; the frame spans the real time since the last one), the bodies in slot order and the camera. */
  frame(s: Snapshot, descs: readonly BodyDesc[], eye: Vec3, target: Vec3): void {
    const c = this.level;
    if (!c || !this.node || this.status !== 'on') return;
    const now = performance.now(), dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    for (; this.slots < s.count && this.slots < descs.length; this.slots++) this.tap.setMaterial(this.slots, soundSlotOf(c, descs[this.slots]!, this.slots, this.kapla));
    const f = [target[0] - eye[0], target[2] - eye[2]], l = Math.hypot(f[0]!, f[1]!) || 1;
    const frame = this.tap.frame(s, { metres: 1, camera: { pos: eye, right: [-f[1]! / l, 0, f[0]! / l] }, dvMin: DV_MIN, dt, top: TOP });
    this.node.port.postMessage({ type: 'frame', frame } satisfies SoundMessage, [frame.counts.buffer, frame.a2.buffer, frame.top.buffer, ...(frame.space ? [frame.space.buffer] : [])]);
    this.posted++;
  }

  /** Physics paused (aiming, between shots): the next frame's dt starts afresh. */
  pause(): void {
    this.last = 0;
  }

  private sendLevel(): void {
    if (!this.level) return;
    slotSounds(this.level, this.set).forEach((x, slot) => this.post({ type: 'material', slot, material: x.material, edge: x.edge }));
  }

  private post(m: SoundMessage): void {
    this.node?.port.postMessage(m);
  }

  private running(): void {
    if (this.ctx?.state === 'running') { this.status = 'on'; this.last = 0; }
  }

  private async start(ctx: AudioContext): Promise<void> {
    this.status = 'starting';
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = (e: MessageEvent<HostStats | { type: 'error'; message: string }>) => {
        if (e.data.type === 'stats') this.stats = e.data;
        else this.fail(e.data.message);
      };
      node.connect(this.dest ?? ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.status = 'waiting';
      this.sendLevel();
      this.post({ type: 'gain', gain: this.gain, muted: this.muted });
      this.post({ type: 'room', room: this.room });
      this.post({ type: 'space', on: this.space });
      void ctx.resume().then(() => this.running());
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private fail(message: string): void {
    this.status = 'error';
    this.error = message;
    console.error(`sound: ${message}`);
  }
}

