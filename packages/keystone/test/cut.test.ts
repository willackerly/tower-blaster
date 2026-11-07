// Wavefront's Cut rule (LevelDef.cut, docs/game/wavefront.md): a pull goes in only while a shot runs, so a wave
// is cut live and never before it starts. Refused while aiming, with a reason the game shows on the block; allowed
// on every other level as before; part of the hash.
import { describe, expect, it } from 'vitest';
import { compileLevel, Session, W5 } from '@tb/keystone';

describe('Cut: pulls only while a shot runs', () => {
  it('W5 refuses a pull while aiming and says why; the same level without cut takes it', () => {
    const cut = new Session(compileLevel(W5)), plain = new Session(compileLevel({ ...W5, cut: undefined }));
    expect(cut.phase).toBe('aiming');
    expect(cut.canFire('pull')).toBe(false);
    expect(cut.pullRefusal(0)).toMatch(/pulls go in while a wave runs/);
    expect(cut.canFire('cannonball')).toBe(true);
    expect(plain.canFire('pull')).toBe(true);
    expect(plain.pullRefusal(0)).toBeNull();
  });
  it('cut joins the hash; absent hashes as before', () => {
    const { cut: _, ...bare } = W5;
    expect(compileLevel(W5).hash).not.toBe(compileLevel(bare).hash);
  });
});
