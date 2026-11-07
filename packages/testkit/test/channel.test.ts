// openWebGPU's channel (channelOf) and its check that a channel got a real GPU (softwareOnChannel). Before these,
// openWebGPU read only opts.channel, so suites that call it bare (physics-gpu's harness.ts) ran on SwiftShader under
// TB_CHANNEL=chrome, and two S5 probes logged as Metal were SwiftShader's (2026-11-06).
import { describe, expect, it } from 'vitest';
import { channelOf, softwareOnChannel } from '../src/index.ts';

const swiftshader = { vendor: 'google', architecture: 'swiftshader', description: '', features: [] };
const metal = { vendor: 'apple', architecture: 'metal-3', description: '', features: [] };

describe('openWebGPU channel', () => {
  it('takes opts.channel, else TB_CHANNEL, else none', () => {
    expect(channelOf({ channel: 'chrome-beta' }, { TB_CHANNEL: 'chrome' })).toBe('chrome-beta');
    expect(channelOf({}, { TB_CHANNEL: 'chrome' })).toBe('chrome');
    expect(channelOf({ channel: '' }, { TB_CHANNEL: 'chrome' })).toBe('chrome');
    expect(channelOf({}, {})).toBeUndefined();
    expect(channelOf({}, { TB_CHANNEL: '' })).toBeUndefined();
  });

  it('flags a software adapter under a channel, and nothing else', () => {
    expect(softwareOnChannel('chrome', swiftshader)).toMatch(/channel chrome gave a software adapter \(google swiftshader/);
    expect(softwareOnChannel('chrome', { ...swiftshader, architecture: '', description: 'llvmpipe (LLVM 17)' })).not.toBeNull();
    expect(softwareOnChannel('chrome', metal)).toBeNull();
    expect(softwareOnChannel(undefined, swiftshader)).toBeNull();
  });
});
