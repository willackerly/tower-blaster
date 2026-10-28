// The viewer's collision sound: an AudioWorklet running @tb/audio's collapse
// synth, fed one AudioFrame per display frame from the snapshots the viewer
// already reads back (FrameTap). Off by default; nothing is created until
// the sound is first switched on. The audio thread does all the synthesis:
// the main thread's share is the tap's one pass over the bodies.
//
// Browsers start an AudioContext suspended until the page has had a click or
// a key; with snd=1 in the URL the sound waits for the first one (status
// 'waiting'), which in the viewer is usually the first shot.
import { FrameTap, type HostStats, PROCESSOR, type SoundMessage } from '@tb/audio';
import workletUrl from '@tb/audio/worklet?worker&url';
import type { BodyDesc, Snapshot } from '@tb/engine-api';
import type { V3 } from './math.ts';
import type { ViewerConfig } from './params.ts';
import { soundGain, soundMaterial, soundSlot } from './sound-config.ts';

export type SoundStatus = 'off' | 'starting' | 'waiting' | 'on' | 'error';

/** Frames closer together than this are folded into the next (the tap reads the change since its last frame). */
const MIN_FRAME_MS = 1000 / 75;

export class ViewerSound {
  status: SoundStatus = 'off';
  error = '';
  /** The worklet's latest report (frames and impacts it got, output peak, live resonators). */
  stats: HostStats | null = null;
  /** Frames posted to the worklet. */
  posted = 0;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private readonly tap = new FrameTap({ materials: 1, sectors: 4 });
  private slots = 0;
  private last = 0;
  private config: ViewerConfig | null = null;

  /** Apply a config's sound options (live): start, stop, or retune. */
  configure(c: ViewerConfig): void {
    this.config = c;
    if (!c.sound.on) {
      if (this.ctx && this.status !== 'off') void this.ctx.suspend();
      if (this.status !== 'error') this.status = 'off';
      return;
    }
    if (this.status === 'error') return;
    if (!this.ctx) { this.starting ??= this.start(); return; }
    this.send({ type: 'material', slot: 0, material: soundMaterial(c), edge: c.scale });
    this.send({ type: 'gain', gain: soundGain(c) });
    this.resume();
  }

  /** A new scene: forget every velocity, so its first frame only records. */
  scene(): void {
    this.tap.reset();
    this.slots = 0;
  }

  /** The newest snapshot: posts a frame when sound is on and a frame's time has passed. */
  snapshot(s: Snapshot, shapes: BodyDesc[], eye: V3, target: V3): void {
    const c = this.config;
    if (!c || !this.node || this.status !== 'on') return;
    const now = performance.now();
    if (now - this.last < MIN_FRAME_MS) return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    for (; this.slots < s.count; this.slots++) this.tap.setMaterial(this.slots, soundSlot(shapes[this.slots]!));
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    // right = forward x up, flattened (looking straight down keeps the last yaw's right: the orbit never reaches it).
    const rl = Math.hypot(f[2]!, f[0]!) || 1;
    const right: V3 = [-f[2]! / rl, 0, f[0]! / rl];
    const m = c.scale;
    const frame = this.tap.frame(s, { metres: m, camera: { pos: [eye[0] * m, eye[1] * m, eye[2] * m], right }, dvMin: c.sound.dv, dt, top: c.sound.voices });
    this.node.port.postMessage({ type: 'frame', frame } satisfies SoundMessage, [frame.counts.buffer, frame.a2.buffer, frame.top.buffer]);
    this.posted++;
  }

  private async start(): Promise<void> {
    this.status = 'starting';
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = (e: MessageEvent<HostStats | { type: 'error'; message: string }>) => {
        if (e.data.type === 'stats') this.stats = e.data;
        else this.fail(e.data.message);
      };
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.status = 'waiting';
      if (this.config) this.configure(this.config);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** Running once the context is: now, or at the page's next click or key. */
  private resume(): void {
    const ctx = this.ctx!;
    if (ctx.state === 'running') { this.status = 'on'; return; }
    this.status = 'waiting';
    const go = () => {
      void ctx.resume().then(() => { if (this.config?.sound.on) { this.status = 'on'; this.last = 0; } });
      removeEventListener('pointerdown', go, true);
      removeEventListener('keydown', go, true);
    };
    void ctx.resume().then(() => { if (ctx.state === 'running' && this.config?.sound.on) { this.status = 'on'; this.last = 0; } });
    addEventListener('pointerdown', go, true);
    addEventListener('keydown', go, true);
  }

  private send(m: SoundMessage): void {
    this.node?.port.postMessage(m);
  }

  private fail(message: string): void {
    this.status = 'error';
    this.error = message;
    console.error(`sound: ${message}`);
  }
}
