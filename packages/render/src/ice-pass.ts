// The renderer's side of ice (ice.ts): the per-slot surface words (surface.ts)
// with their GPU copy, which the cull pass reads to put ice boxes in their own
// list, and what the ice pass binds as group 2: its uniforms, the opaque
// scene resolved before it (`under`), a sampler and the surface words.
//
// The scene pass is split in two only while some slot is ice (count > 0):
// the opaque scene resolves into `under` and keeps its MSAA samples and
// depth (stored, not discarded), then the ice and the effects drawn after it
// go on top and resolve into the HDR target. Without ice the frame is one
// pass, exactly as before, so nothing is paid for ice that is not there.
import { writeStruct } from '@tb/schema';
import { DEFAULT_ICE, IceFrame, iceUniforms, type IceParams } from './ice.ts';
import { HDR_FORMAT } from './post.ts';
import { packSurface, SURFACE_ICE, type SurfaceOptions, unpackSurface, type Surface } from './surface.ts';

export class IcePass {
  /** How ice is drawn (ice.ts IceParams; URL keys ice.<knob>). Applied from the next frame. */
  params: IceParams = { ...DEFAULT_ICE };
  readonly layout: GPUBindGroupLayout;
  private words = new Uint32Array(1024);
  private buf: GPUBuffer | null = null;
  private iceSlots = 0;
  private readonly uniform: GPUBuffer;
  private readonly data = new DataView(new ArrayBuffer(IceFrame.size));
  private readonly sampler: GPUSampler;
  private underTex: GPUTexture | null = null;
  private group: GPUBindGroup | null = null;

  constructor(private readonly device: GPUDevice) {
    this.uniform = device.createBuffer({ size: IceFrame.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ice frame' });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', label: 'ice under' });
    const F = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'ice',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
        { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } },
      ],
    });
  }

  /** Slots whose surface is ice: while above 0 the scene pass splits (above). */
  get count(): number { return this.iceSlots; }

  /** Surface words from slot0 on (packSurface); applied from the next frame. */
  set(slot0: number, words: ArrayLike<number>): void {
    this.grow(slot0 + words.length);
    for (let k = 0; k < words.length; k++) {
      const i = slot0 + k, was = (this.words[i]! & 0xf) === SURFACE_ICE, now = (words[k]! & 0xf) === SURFACE_ICE;
      this.iceSlots += (now ? 1 : 0) - (was ? 1 : 0);
      this.words[i] = words[k]! >>> 0;
    }
    if (this.buf && (slot0 + words.length) * 4 <= this.buf.size) this.device.queue.writeBuffer(this.buf, slot0 * 4, this.words, slot0, words.length);
  }

  setOne(slot: number, s: SurfaceOptions): void { this.set(slot, [packSurface(s)]); }

  /** Every slot back to the default surface. */
  clear(): void {
    this.words.fill(0);
    this.iceSlots = 0;
    if (this.buf) this.device.queue.writeBuffer(this.buf, 0, this.words, 0, Math.min(this.words.length, this.buf.size / 4));
  }

  word(slot: number): number { return this.words[slot] ?? 0; }
  get(slot: number): Surface { return unpackSurface(this.word(slot)); }

  /** The surface words on the GPU, at least `capacity` of them (reallocated and uploaded whole when they grow). */
  buffer(capacity: number): GPUBuffer {
    this.grow(capacity);
    if (!this.buf || this.buf.size < this.words.byteLength) {
      this.buf?.destroy();
      this.buf = this.device.createBuffer({ size: Math.max(16, this.words.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'surfaces' });
      this.device.queue.writeBuffer(this.buf, 0, this.words);
      this.group = null;
    }
    return this.buf;
  }

  /** The opaque scene's resolve target for a split frame, w x h (made or remade as needed). */
  under(w: number, h: number): GPUTexture {
    const t = this.underTex;
    if (t && t.width === w && t.height === h) return t;
    t?.destroy();
    this.group = null;
    return (this.underTex = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'scene under ice' }));
  }

  /** Group 2 of the ice pipelines for this frame (after under() and buffer()). */
  bind(metres: number): GPUBindGroup {
    writeStruct(this.data, IceFrame, 0, iceUniforms(this.params, metres));
    this.device.queue.writeBuffer(this.uniform, 0, this.data);
    if (!this.underTex || !this.buf) throw new Error('IcePass.bind before under() and buffer()');
    return (this.group ??= this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.underTex.createView() },
        { binding: 2, resource: this.sampler }, { binding: 3, resource: { buffer: this.buf } },
      ],
    }));
  }

  private grow(slots: number): void {
    if (slots <= this.words.length) return;
    let len = this.words.length;
    while (len < slots) len *= 2;
    const next = new Uint32Array(len);
    next.set(this.words);
    this.words = next;
  }

  destroy(): void {
    this.buf?.destroy();
    this.underTex?.destroy();
    this.uniform.destroy();
  }
}
