// Opt-in lattice-preferred colouring (AvbdParams.colorMode) and largest-degree-
// first priority (AvbdParams.colorPriority). The defaults must not change.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { AvbdReferenceEngine, type AvbdParams, colorGraph, colorGraphWith, latticeColor, latticeParity, latticePreferences, outranks } from '../src/index.ts';

const all = (n: number) => Array.from({ length: n }, (_, i) => i);
function randomGraph(n: number, edges: number, seed: number) {
  const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const adj: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  for (let e = 0; e < edges; e++) {
    const a = Math.floor(r() * n), b = Math.floor(r() * n);
    if (a !== b) { adj[a]!.add(b); adj[b]!.add(a); }
  }
  return { lists: adj.map((s) => [...s].sort((x, y) => x - y)), r };
}

/** Jones-Plassmann round by round, as the GPU runs it: a body colours once it outranks every uncoloured neighbour. */
function jonesPlassmann(lists: number[][], prefer: ArrayLike<number> | null, degreeFirst: boolean) {
  const n = lists.length, col = new Int32Array(n).fill(-1);
  const beats = (v: number, u: number) => (degreeFirst && lists[v]!.length !== lists[u]!.length ? lists[v]!.length > lists[u]!.length : outranks(v, u));
  let rounds = 0;
  while (col.includes(-1)) {
    rounds++;
    const ready = all(n).filter((v) => col[v] === -1 && lists[v]!.every((u) => col[u] !== -1 || beats(v, u)));
    const next = ready.map((v) => {
      const used = new Set(lists[v]!.map((u) => col[u]!));
      const want = prefer ? prefer[v]! : -1;
      if (want >= 0 && !used.has(want)) return want;
      let c = 0;
      while (used.has(c)) c++;
      return c;
    });
    ready.forEach((v, k) => { col[v] = next[k]!; });
  }
  return { col, rounds };
}

async function trajectory(scene: SceneDesc, steps: number, params: Partial<AvbdParams>) {
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) { e.step(); out.push(...e.snapshot().pos, ...e.snapshot().rot); }
  return out;
}

/** Colours used (max + 1) and the reference's points-per-body walk: ΣW over colours, W_c the most points a body of colour c walks. */
function structure(e: AvbdReferenceEngine) {
  const w = e.world!, n = w.bodies.length;
  const pts = new Int32Array(n);
  for (const c of w.contacts) { pts[c.b]!++; if (c.a >= 0) pts[c.a]!++; }
  return { K: w.stats.colors, pts };
}

const offsets = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dz) => [dx, dy, dz] as const))).filter(([a, b, c]) => a || b || c);
const kind = ([dx, dy, dz]: readonly [number, number, number]) => {
  const k = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
  return k === 1 ? 'face' : k === 3 ? 'corner' : dy === 0 ? 'in-plane diagonal' : 'vertical diagonal';
};

describe('lattice-preferred colouring (AvbdParams.colorMode)', () => {
  it('the patterns: 4 colours proper on faces and vertical diagonals, sharing only along their kernel; the 8-colour fallback proper on all 26 neighbours', () => {
    // Every cell of a 4x4x4 block (both parities of every axis) against each of its 26 neighbours.
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
      const bits = (x & 1) | ((y & 1) << 1) | ((z & 1) << 2);
      for (const o of offsets) {
        const nb = ((x + o[0]) & 1) | (((y + o[1]) & 1) << 1) | (((z + o[2]) & 1) << 2);
        const k = kind(o);
        // colorMode 2: the kernel is the corner offset; colorMode 3: the in-plane diagonal.
        expect(latticeColor(nb, 2, false) === latticeColor(bits, 2, false), `${o}`).toBe(k === 'corner');
        expect(latticeColor(nb, 3, false) === latticeColor(bits, 3, false), `${o}`).toBe(k === 'in-plane diagonal');
        for (const mode of [1, 2, 3]) expect(latticeColor(nb, mode, true)).not.toBe(latticeColor(bits, mode, true));
      }
      for (const mode of [2, 3]) {
        expect(latticeColor(bits, mode, false)).toBeLessThan(4);
        // The fallback's low two bits are the 4-colour, so a 4-coloured body never meets its neighbour's fallback colour.
        expect(latticeColor(bits, mode, true) & 3).toBe(latticeColor(bits, mode, false));
      }
      expect(latticeColor(bits, 1, false)).toBeLessThan(8);
    }
  });

  it('latticeParity: aligned cubes on either lattice, measured from the ground; tilted, off-cell and non-cube bodies have none', () => {
    const q = [0, 0, 0, 1];
    expect(latticeParity([0.5, 2.5, -3.5], q, 0.5)).toBe(0 | (0 << 1) | (0 << 2)); // floor(0.5)=0, floor(2.5)=2, floor(-3.5)=-4
    expect(latticeParity([1.5, 3.5, -2.5], q, 0.5)).toBe(1 | (1 << 1) | (1 << 2));
    expect(latticeParity([1.05, 2.97, -0.02], q, 0.5)).toBe(1 | (1 << 1) | (0 << 2)); // integer centres: the nearer integer
    expect(latticeParity([0.5, 3.5, 0.5], q, 0.5, 1)).toBe(0 | (0 << 1) | (0 << 2)); // ground at y = 1
    expect(latticeParity([0.25, 2.5, -3.5], q, 0.5)).toBe(-1); // between the two lattices
    expect(latticeParity([0.5, 2.5, -3.5], q, null)).toBe(-1); // not a cube
    expect(latticeParity([0.25, 1.25, 0.75], q, 0.25)).toBe(0 | (0 << 1) | (1 << 2)); // half-size cubes, a half-size lattice
    expect(latticeParity([0.5, 2.5, -3.5], [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)], 0.5)).toBe(0); // a quarter turn is aligned
    expect(latticeParity([0.5, 2.5, -3.5], [0, Math.sin(0.15), 0, Math.cos(0.15)], 0.5)).toBe(-1); // 17 deg
  });

  it('colorGraphWith: no options is colorGraph; preferences and largest degree first are proper and are what Jones-Plassmann computes round by round', () => {
    const { lists, r } = randomGraph(400, 2400, 7);
    expect([...colorGraphWith(lists)]).toEqual([...colorGraph(lists)]);
    const prefer = Int32Array.from(all(400), () => (r() < 0.7 ? Math.floor(r() * 8) : -1));
    for (const [p, d] of [[prefer, false], [null, true], [prefer, true]] as const) {
      const c = colorGraphWith(lists, { ...(p ? { prefer: p } : {}), degreeFirst: d });
      for (let v = 0; v < 400; v++) for (const u of lists[v]!) expect(c[u]).not.toBe(c[v]);
      const jp = jonesPlassmann(lists, p, d);
      expect([...c]).toEqual([...jp.col]);
      // A preference never changes when a body colours, so the rounds are the priority's.
      if (!d) expect(jp.rounds).toBe(jonesPlassmann(lists, null, false).rounds);
    }
  });

  it('latticePreferences: only cubes with 3 or more aligned neighbours prefer; a 4-colour clash takes the fallback', () => {
    // Body 0 in cell parity 001, 1-3 its face neighbours, 4 a corner neighbour, 5 unaligned.
    const adj = [[1, 2, 3, 4, 5], [0], [0], [0], [0], [0]];
    const parity = [0b001, 0b000, 0b011, 0b101, 0b110, -1];
    expect([...latticePreferences(adj, parity, 2)]).toEqual([6, -1, -1, -1, -1, -1]); // the corner clashes in mode 2: 2 + 4 x 1
    expect([...latticePreferences(adj, parity, 3)]).toEqual([2, -1, -1, -1, -1, -1]);
    expect([...latticePreferences(adj, parity, 1)]).toEqual([2, -1, -1, -1, -1, -1]);
    // An in-plane diagonal neighbour (cell 100) clashes in mode 3 instead.
    expect(latticePreferences(adj, [0b001, 0b000, 0b011, 0b101, 0b100, -1], 3)[0]).toBe(6);
    expect(latticePreferences(adj, [0b001, 0b000, 0b011, 0b101, 0b100, -1], 2)[0]).toBe(2);
    expect(latticePreferences([[1, 2], [0], [0]], [0, 1, 2], 2)[0]).toBe(-1); // two aligned neighbours only
    expect(() => latticePreferences(adj, parity, 5)).toThrow(/mode/);
  });

  it('latticePreferences mode 4: mode 3\'s colour, only when every neighbour is aligned and none clashes', () => {
    // Body 0 in cell 001 with face neighbours 1-3 and a corner neighbour 4 (no clash in the mode-3 map).
    const adj = [[1, 2, 3, 4], [0], [0], [0], [0]];
    const parity = [0b001, 0b000, 0b011, 0b101, 0b110];
    expect(latticePreferences(adj, parity, 4)[0]).toBe(latticePreferences(adj, parity, 3)[0]);
    expect(latticePreferences(adj, parity, 4)[0]).toBe(2);
    // One unaligned neighbour: mode 3 still prefers, mode 4 does not.
    expect(latticePreferences([[1, 2, 3, 4, 5], [0], [0], [0], [0], [0]], [...parity, -1], 3)[0]).toBe(2);
    expect(latticePreferences([[1, 2, 3, 4, 5], [0], [0], [0], [0], [0]], [...parity, -1], 4)[0]).toBe(-1);
    // An in-plane diagonal neighbour (cell 100) clashes: mode 3 takes the fallback, mode 4 nothing.
    const diag = [0b001, 0b000, 0b011, 0b101, 0b100];
    expect(latticePreferences(adj, diag, 3)[0]).toBe(6);
    expect(latticePreferences(adj, diag, 4)[0]).toBe(-1);
    expect(latticePreferences([[1, 2], [0], [0]], [0, 1, 2], 4)[0]).toBe(-1); // two aligned neighbours only
  });

  it('the engine rejects colorMode and colorPriority values it does not implement, in its constructor; at 0 they are no variant', () => {
    for (const bad of [{ colorMode: 5 }, { colorMode: 1.5 }, { colorMode: -1 }, { colorPriority: 2 }, { colorPriority: -1 }]) {
      expect(() => new AvbdReferenceEngine(bad), JSON.stringify(bad)).toThrow(/^AvbdParams\.color(Mode|Priority) must be one of/);
    }
    expect(() => new AvbdReferenceEngine({ colorMode: 5 })).toThrow('AvbdParams.colorMode must be one of 0, 1, 2, 3, 4, got 5');
    for (const ok of [{ colorMode: 4 }, { colorMode: 0, colorPriority: 1 }]) expect(() => new AvbdReferenceEngine(ok)).not.toThrow();
    expect(new AvbdReferenceEngine({ colorMode: 0, colorPriority: 0 }).info.variant).toEqual(new AvbdReferenceEngine().info.variant);
    expect(new AvbdReferenceEngine({ colorMode: 3, colorPriority: 1 }).info.variant).toMatchObject({ colorMode: 3, colorPriority: 1 });
  });

  it('an 8x8x6 packed tower takes 4 colours (modes 2, 3 and 4) or 8 (mode 1), against 8 or more by the hash; ΣW falls with K; mode 4 colours it as mode 3', async () => {
    const scene = buildScenario('S1', { F: 8, H: 6, gap: 0 }, 1);
    const out: Record<string, { K: number; sumW: number }> = {};
    const colours: Record<string, number[]> = {};
    for (const mode of [0, 1, 2, 3, 4]) {
      const e = new AvbdReferenceEngine({ colorMode: mode });
      await e.init(scene);
      for (let i = 0; i < 6; i++) e.step();
      const { K, pts } = structure(e);
      const color = e.world!.stats.colorOf!;
      const Wc = new Array<number>(K).fill(0);
      color.forEach((c, i) => { Wc[c] = Math.max(Wc[c]!, pts[i]!); });
      out[mode] = { K, sumW: Wc.reduce((s, v) => s + v, 0) };
      colours[mode] = [...color];
    }
    expect(colours[4]).toEqual(colours[3]);
    expect(out[2]!.K).toBe(4);
    expect(out[3]!.K).toBe(4);
    expect(out[1]!.K).toBe(8);
    expect(out[0]!.K).toBeGreaterThanOrEqual(8);
    for (const m of [2, 3]) expect(out[m]!.sumW).toBeLessThan(0.55 * out[0]!.sumW);
  });

  it('explicit defaults are bit-identical to unset ones; each option is a different, deterministic trajectory', async () => {
    const scene = buildScenario('S1', { F: 3, H: 6, gap: 0 }, 1);
    const base = await trajectory(scene, 20, {});
    expect(await trajectory(scene, 20, { colorMode: 0, colorPriority: 0 })).toEqual(base);
    for (const p of [{ colorMode: 2 }, { colorPriority: 1 }]) {
      const t = await trajectory(scene, 20, p);
      expect(await trajectory(scene, 20, p)).toEqual(t);
      expect(t).not.toEqual(base);
    }
  });

  it('every mode keeps a small packed stack standing', async () => {
    const scene = buildScenario('S1', { F: 3, H: 6, gap: 0 }, 1);
    for (const p of [{ colorMode: 1 }, { colorMode: 2 }, { colorMode: 3 }, { colorMode: 4 }, { colorMode: 2, colorPriority: 1 }, { colorMode: 4, colorPriority: 1 }]) {
      const e = new AvbdReferenceEngine(p);
      await e.init(scene);
      for (let i = 0; i < 60; i++) e.step();
      const pos = e.snapshot().pos;
      scene.bodies.forEach((b, i) => {
        expect(Math.hypot(pos[3 * i]! - b.pos[0], pos[3 * i + 1]! - b.pos[1], pos[3 * i + 2]! - b.pos[2]), JSON.stringify(p)).toBeLessThan(0.01);
      });
    }
  });
});
