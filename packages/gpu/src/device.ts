// Device creation with the features and limits the engine needs, requested
// only when the adapter has them, and reported so callers can adapt.

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** timestamp-query was granted: GpuProfiler gives per-pass GPU times. */
  timestamps: boolean;
}

export async function createDevice(opts: { timestamps?: boolean; powerPreference?: GPUPowerPreference } = {}): Promise<GpuContext> {
  if (!('gpu' in navigator)) throw new Error('WebGPU unavailable (navigator.gpu missing; needs a secure context)');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: opts.powerPreference ?? 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const timestamps = (opts.timestamps ?? true) && adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: timestamps ? ['timestamp-query'] : [],
    // Defaults cap storage bindings at 128 MiB; 100k bodies need far less, but
    // the sort and bandwidth probe want large buffers on big machines.
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { adapter, device, timestamps };
}

/** What isSoftwareAdapter reads: GPUAdapterInfo's text fields, any of them absent. */
export interface AdapterText { vendor?: string; architecture?: string; description?: string; device?: string; isFallbackAdapter?: boolean }

/**
 * A software (CPU) adapter: SwiftShader, llvmpipe, lavapipe, or one the
 * browser marks as a fallback. Its timings are never performance results
 * (CLAUDE.md), and a few defaults are chosen for it (the solver's tail width).
 */
export function isSoftwareAdapter(info: AdapterText): boolean {
  const text = `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.description ?? ''} ${info.device ?? ''}`;
  return /swiftshader|llvmpipe|lavapipe|software/i.test(text) || info.isFallbackAdapter === true;
}

/** Read a buffer back to the CPU (test and debug path; stalls the queue). */
export async function readBuffer(device: GPUDevice, src: GPUBuffer, bytes = src.size, offset = 0): Promise<ArrayBuffer> {
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, staging, 0, bytes);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = staging.getMappedRange().slice(0);
  staging.destroy();
  return out;
}

/** Throw (instead of a later validation error) when the device cannot bind a storage buffer this large. */
export function assertStorageFits(device: GPUDevice, bytes: number, label = 'storage buffer'): void {
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (bytes > limit) throw new Error(`${label}: ${bytes} bytes exceeds the device's ${limit}-byte storage binding limit`);
}

export function storageBuffer(device: GPUDevice, bytes: number, label?: string, extraUsage = 0): GPUBuffer {
  assertStorageFits(device, bytes, label);
  return device.createBuffer({
    size: Math.max(16, Math.ceil(bytes / 16) * 16),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extraUsage,
    ...(label ? { label } : {}),
  });
}

export function uploadU32(device: GPUDevice, data: Uint32Array, label?: string): GPUBuffer {
  const buf = storageBuffer(device, data.byteLength, label);
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}
