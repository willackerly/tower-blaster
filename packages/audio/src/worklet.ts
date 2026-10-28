// The AudioWorklet processor 'tb-collapse': a CollapseHost (host.ts) on the
// audio thread, fed SoundMessages through the node's port, rendering one
// 128-sample quantum per process() call into a stereo output. Load it with
// audioWorklet.addModule(url of this file); the page side is the viewer's
// sound.ts. Nothing here is tested in node: the e2e test plays it in Chromium.
import { BLOCK } from './engine.ts';
import { CollapseHost, PROCESSOR, type SoundMessage } from './host.ts';

// The AudioWorkletGlobalScope, which lib.dom does not describe.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options?: unknown) => object): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class CollapseProcessor extends AudioWorkletProcessor {
  private readonly host: CollapseHost;
  private readonly spare = new Float32Array(BLOCK);
  private failed = false;

  constructor() {
    super();
    this.host = new CollapseHost(sampleRate, (s) => this.port.postMessage(s));
    this.port.onmessage = (e: MessageEvent<SoundMessage>) => {
      try { this.host.onMessage(e.data); } catch (err) { this.port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }); }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out?.[0] || this.failed) return true;
    if (out[0].length !== BLOCK) {
      // A render quantum other than 128 (renderSizeHint) is not supported yet: say so once, stay silent.
      this.failed = true;
      this.port.postMessage({ type: 'error', message: `render quantum ${out[0].length}, the synth renders ${BLOCK}` });
      return true;
    }
    this.host.render(out[0], out[1] ?? this.spare);
    return true;
  }
}

registerProcessor(PROCESSOR, CollapseProcessor);
