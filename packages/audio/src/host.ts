// What runs inside the AudioWorklet, minus the worklet: the engine and the
// messages that drive it, so node tests cover everything but the WebAudio
// plumbing (worklet.ts). The page posts SoundMessages on the node's port; the
// host answers with a HostStats every statsEvery blocks.
import type { AudioFrame } from './frame.ts';
import { BLOCK, CollapseEngine } from './engine.ts';
import type { SoundMaterial } from './material.ts';

export type SoundMessage =
  | { type: 'frame'; frame: AudioFrame }
  /** Material slot i (null: silent). edge: the body's edge in metres (shell and cube materials without their own size). */
  | { type: 'material'; slot: number; material: SoundMaterial | null; edge: number }
  /** Master gain (linear, before the limiter), mute, and the low cut (Hz, 0 off; absent: unchanged). */
  | { type: 'gain'; gain: number; muted?: boolean; lowcut?: number };

export interface HostStats {
  type: 'stats';
  /** Frames and impacts received, blocks rendered, since the host started. */
  frames: number;
  impacts: number;
  blocks: number;
  /** Largest output sample since the last stats, and since the host started. */
  peak: number;
  loudest: number;
  /** Bank resonators ringing now. */
  live: number;
  /** Impulses dropped for a full block bucket (their energy kept). */
  overflow: number;
}

/** The worklet processor's registered name (worklet.ts, which the page must not import: it registers on load). */
export const PROCESSOR = 'tb-collapse';

export const STATS_EVERY = 64; // blocks (171 ms at 48 kHz)

/** Pa at the listener that maps to full scale at gain 1 (EngineOptions.fullScale). */
export const FULL_SCALE = 30;

export class CollapseHost {
  readonly engine: CollapseEngine;
  private frames = 0;
  private impacts = 0;
  private blocks = 0;
  private peak = 0;
  private loudest = 0;

  constructor(sampleRate: number, private readonly post: (s: HostStats) => void = () => {}, seed = 1) {
    this.engine = new CollapseEngine({ sampleRate, seed, fullScale: FULL_SCALE });
  }

  onMessage(m: SoundMessage): void {
    switch (m.type) {
      case 'frame':
        this.frames++;
        for (let i = 0; i < m.frame.counts.length; i++) this.impacts += m.frame.counts[i]!;
        this.engine.push(m.frame);
        break;
      case 'material':
        this.engine.setMaterial(m.slot, m.material, m.edge);
        break;
      case 'gain':
        if (!(m.gain >= 0 && Number.isFinite(m.gain))) throw new Error(`gain must be a finite number >= 0: ${m.gain}`);
        this.engine.fullScale = m.gain > 0 ? FULL_SCALE / m.gain : FULL_SCALE;
        this.engine.muted = m.gain === 0 || (m.muted ?? false);
        if (m.lowcut !== undefined) {
          if (!(m.lowcut >= 0 && Number.isFinite(m.lowcut))) throw new Error(`lowcut must be a finite number >= 0: ${m.lowcut}`);
          this.engine.lowcut = m.lowcut;
        }
        break;
    }
  }

  /** One block (BLOCK samples) into L and R. */
  render(L: Float32Array, R: Float32Array): void {
    this.engine.render(L, R);
    for (let i = 0; i < BLOCK; i++) this.peak = Math.max(this.peak, Math.abs(L[i]!), Math.abs(R[i]!));
    if (++this.blocks % STATS_EVERY === 0) {
      this.loudest = Math.max(this.loudest, this.peak);
      this.post({ type: 'stats', frames: this.frames, impacts: this.impacts, blocks: this.blocks, peak: this.peak, loudest: this.loudest, live: this.engine.liveResonators(), overflow: this.engine.overflow });
      this.peak = 0;
    }
  }
}
