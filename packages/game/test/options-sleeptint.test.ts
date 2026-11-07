// The keystone.sleeptint option (roadmap E2.5; options/sleeptint.ts): a debug view, off by default.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEEL, paceFeel, writePaceFeel } from '../src/pacing.ts';

describe('keystone.sleeptint', () => {
  it('is off by default, on by =1, refuses anything but 0 or 1, and writes back only when on', () => {
    expect(DEFAULT_FEEL.sleepTint).toBe(false);
    expect(paceFeel(new URLSearchParams('?keystone.sleeptint=1'))).toEqual({ ...DEFAULT_FEEL, sleepTint: true });
    expect(paceFeel(new URLSearchParams('?keystone.sleeptint=0'))).toEqual(DEFAULT_FEEL);
    expect(() => paceFeel(new URLSearchParams('?keystone.sleeptint=yes'))).toThrow(/keystone.sleeptint must be 0 or 1: yes/);
    const q = new URLSearchParams();
    writePaceFeel({ ...DEFAULT_FEEL, sleepTint: true }, q);
    expect(q.toString()).toBe('keystone.sleeptint=1');
    const none = new URLSearchParams();
    writePaceFeel(DEFAULT_FEEL, none);
    expect(none.toString()).toBe('');
  });
});
