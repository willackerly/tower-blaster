import { describe, expect, it } from 'vitest';
import { L3, type Shot, snapshotHash } from '@tb/keystone';
import { forkDeep, nudge, playOnce, SessionCache } from '@tb/keystone-lab';

describe('forkDeep', () => {
  class Body { constructor(public x: number, public peer: Body | null = null) {} moved(dx: number) { return this.x + dx; } }

  it('keeps prototypes, shared references and cycles, and copies everything else', () => {
    const a = new Body(1), b = new Body(2, a);
    a.peer = b;
    const src = { a, b, list: [a, b], byName: new Map([['a', a]]), seen: new Set([b]), n: 3, s: 'x', u: undefined };
    const c = forkDeep(src);
    expect(c).toEqual(src);
    expect(c.a).not.toBe(a);
    expect(c.a).toBeInstanceOf(Body);
    expect(c.a.moved(1)).toBe(2);
    expect(c.a.peer).toBe(c.b);
    expect(c.b.peer).toBe(c.a);
    expect(c.list[0]).toBe(c.a);
    expect(c.byName.get('a')).toBe(c.a);
    expect([...c.seen][0]).toBe(c.b);
    c.a.x = 9;
    expect(a.x).toBe(1);
  });

  it('keeps typed arrays that view one buffer aliased, in a buffer of their own', () => {
    const buf = new ArrayBuffer(32), whole = new Float64Array(buf), tail = new Float64Array(buf, 16, 2);
    whole.set([1, 2, 3, 4]);
    const c = forkDeep({ whole, tail, bytes: new Uint8Array(buf) });
    expect(Array.from(c.tail)).toEqual([3, 4]);
    c.whole[2] = 7;
    expect(c.tail[0]).toBe(7);
    expect(tail[0]).toBe(3);
    expect(c.whole.buffer).toBe(c.bytes.buffer);
  });

  it('does not copy what it is told is shared', () => {
    const level = { big: [1, 2, 3] };
    const c = forkDeep({ level, own: [1] }, [level]);
    expect(c.level).toBe(level);
    expect(c.own).not.toBe(level);
  });

  it('refuses state it can not copy faithfully, naming where it is', () => {
    expect(() => forkDeep({ engine: { onStep: () => 1 } })).toThrow(/function at \$\.engine\.onStep/);
    expect(() => forkDeep({ w: new WeakMap() })).toThrow(/WeakMap at \$\.w/);
    expect(() => forkDeep({ get x() { return 1; } })).toThrow(/accessor/);
  });
});

// The bot starts each attempt from a copy of the longest cached prefix of its
// shots; that must be exactly the session played from the start. L3 has a
// two-shot par line; 4 iterations keep the test quick (copying does not
// depend on them).
describe('session cache', () => {
  const ref = { kind: 'ref', iterations: 4 } as const;
  const par = L3.solutions!.par as Shot[];
  const other: Shot[] = [par[0]!, nudge(par[1]!, 4, -3)];
  const same = (x: Awaited<ReturnType<typeof playOnce>>, y: typeof x) => {
    expect(snapshotHash(y.snapshot)).toBe(snapshotHash(x.snapshot));
    expect(y).toEqual(x);
  };

  it('plays from the pre-settle and from a shared first shot exactly as from the start', async () => {
    const fresh = await playOnce(ref, L3, par), freshOther = await playOnce(ref, L3, other);
    expect(fresh.session.outcomes).toHaveLength(2);
    const cache = new SessionCache();
    await playOnce(ref, L3, par.slice(0, 1), cache); // a miss: caches the pre-settled state
    expect({ hits: cache.hits, misses: cache.misses, size: cache.size }).toEqual({ hits: 0, misses: 1, size: 1 });
    same(fresh, await playOnce(ref, L3, par, cache)); // from the pre-settle; caches the state before shot 2
    expect({ hits: cache.hits, size: cache.size }).toEqual({ hits: 1, size: 2 });
    same(fresh, await playOnce(ref, L3, par, cache)); // from before shot 2
    same(freshOther, await playOnce(ref, L3, other, cache)); // another second shot from the same state
    expect({ hits: cache.hits, misses: cache.misses, size: cache.size }).toEqual({ hits: 3, misses: 1, size: 2 });
  }, 300_000);

  it('drops the least recently used state past its capacity', async () => {
    const cache = new SessionCache(1);
    await playOnce(ref, L3, par, cache);
    expect(cache.size).toBe(1); // the state before shot 2 pushed out the pre-settle
    await playOnce(ref, L3, par.slice(0, 1), cache); // looks only for the pre-settle
    expect({ hits: cache.hits, misses: cache.misses }).toEqual({ hits: 0, misses: 2 });
    await playOnce(ref, L3, par, cache); // the pre-settle again (the miss put it back)
    expect({ hits: cache.hits, misses: cache.misses }).toEqual({ hits: 1, misses: 2 });
  }, 300_000);

  it('plays Rapier from the start: its WASM state can not be copied', async () => {
    const cache = new SessionCache();
    const r = await playOnce({ kind: 'rapier' }, L3, par.slice(0, 1), cache);
    expect(r.session.outcomes).toHaveLength(1);
    expect({ hits: cache.hits, misses: cache.misses, size: cache.size }).toEqual({ hits: 0, misses: 0, size: 0 });
  }, 120_000);
});
