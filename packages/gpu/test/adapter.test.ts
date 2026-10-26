import { describe, expect, it } from 'vitest';
import { isSoftwareAdapter } from '../src/device.ts';

describe('isSoftwareAdapter', () => {
  it('names the CPU rasterisers and fallback adapters, and nothing else', () => {
    expect(isSoftwareAdapter({ vendor: 'google', architecture: 'swiftshader', description: '' })).toBe(true);
    expect(isSoftwareAdapter({ vendor: 'mesa', architecture: '', description: 'llvmpipe (LLVM 15.0.7, 256 bits)' })).toBe(true);
    expect(isSoftwareAdapter({ vendor: 'mesa', device: 'lavapipe' })).toBe(true);
    expect(isSoftwareAdapter({ vendor: 'microsoft', description: 'Microsoft Basic Render Driver (software)' })).toBe(true);
    expect(isSoftwareAdapter({ vendor: 'intel', architecture: 'gen-12lp', isFallbackAdapter: true })).toBe(true);
    expect(isSoftwareAdapter({ vendor: 'apple', architecture: 'metal-3', description: '' })).toBe(false);
    expect(isSoftwareAdapter({ vendor: 'nvidia', architecture: 'ada', isFallbackAdapter: false })).toBe(false);
    expect(isSoftwareAdapter({})).toBe(false);
  });
});
