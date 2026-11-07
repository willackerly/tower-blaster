// PT39 (agent playtest 2): a first push that starts Wavefront's wave. The starter slabs (LevelDef.push) carry the
// crosshair, and a first visit of any Steer or Cut level is offered the teaching opener (solutions.teach), which
// pushes a starter from two thirds up; a played level, or keystone.preaim=0, gets none. The wave it starts is pinned
// on Rapier in keystone-lab wave-levels.test.ts.
import { describe, expect, it } from 'vitest';
import { compileLevel, W3, W4, W5 } from '@tb/keystone';
import { MARK_HIT } from '@tb/render';
import { openerFor } from '../src/door.ts';
import { markOf } from '../src/scene.ts';

describe('Wavefront: the push that starts the wave (PT39)', () => {
  it.each([W3, W4, W5].map((d) => [d.id, d] as const))('%s marks its starters, and only them', (_, def) => {
    const c = compileLevel(def);
    const marked = Array.from({ length: c.meta.n }, (_, i) => i).filter((i) => markOf(c, i) === MARK_HIT);
    const starters = Array.from({ length: c.meta.n }, (_, i) => i).filter((i) => def.push!.includes(c.meta.part[i]!));
    expect(starters.length).toBe(def.push!.length);
    expect(marked).toEqual(starters);
  });
  it('offers the teaching opener on a first visit at any index, never once played or with preaim off', () => {
    for (const def of [W3, W4, W5]) {
      expect(openerFor(def, 3, 'auto', false)).toEqual(def.solutions!.opener);
      expect(openerFor(def, 3, 'auto', true)).toBeNull();
      expect(openerFor(def, 3, '0', false)).toBeNull();
    }
  });
  it('push is presentation: it does not change the level hash', () => {
    const { push: _, solutions: __, ...bare } = W3;
    expect(compileLevel(bare).hash).toBe(compileLevel(W3).hash);
  });
});
