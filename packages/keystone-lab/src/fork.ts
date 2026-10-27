// Copies of a live session, so the bot can play many shots from one settled
// state instead of re-running the pre-settle and the shared first shots for
// every attempt. Only engines whose whole state is plain JS data can be
// copied (the f64 reference); a WASM engine (Rapier) can not.

/**
 * A deep copy of `root` that keeps prototypes, shared references and cycles,
 * and the aliasing of typed arrays that view one buffer. Objects in `shared`
 * are not copied (immutable inputs such as the compiled level). Throws on
 * anything it can not copy faithfully: a function held as data (a closure
 * may hold state), a WeakMap, or a WebAssembly memory.
 */
export function forkDeep<T>(root: T, shared: readonly object[] = []): T {
  const memo = new Map<unknown, unknown>(shared.map((o) => [o, o]));
  const copy = (v: unknown, path: string): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function') throw new Error(`forkDeep: a function at ${path}`);
      return v;
    }
    if (memo.has(v)) return memo.get(v);
    if (v instanceof ArrayBuffer) {
      const b = v.slice(0);
      memo.set(v, b);
      return b;
    }
    if (ArrayBuffer.isView(v)) {
      if (!(v.buffer instanceof ArrayBuffer)) throw new Error(`forkDeep: a shared buffer at ${path}`);
      const buf = copy(v.buffer, path) as ArrayBuffer;
      const C = v.constructor as new (b: ArrayBuffer, off: number, len: number) => ArrayBufferView;
      const len = v instanceof DataView ? v.byteLength : (v as unknown as { length: number }).length;
      const out = new C(buf, v.byteOffset, len);
      memo.set(v, out);
      return out;
    }
    if (v instanceof Map) {
      const out = new Map();
      memo.set(v, out);
      for (const [k, x] of v) out.set(copy(k, `${path}<key>`), copy(x, `${path}[${String(k)}]`));
      return out;
    }
    if (v instanceof Set) {
      const out = new Set();
      memo.set(v, out);
      for (const x of v) out.add(copy(x, `${path}<item>`));
      return out;
    }
    if (v instanceof WeakMap || v instanceof WeakSet || v instanceof WebAssembly.Memory || v instanceof Promise || v instanceof Date || v instanceof RegExp || v instanceof Error) throw new Error(`forkDeep: an uncopyable ${v.constructor.name} at ${path}`);
    const out = Array.isArray(v) ? new Array(v.length) : Object.create(Object.getPrototypeOf(v));
    memo.set(v, out);
    for (const key of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (d.get || d.set) throw new Error(`forkDeep: an accessor at ${path}.${String(key)}`);
      Object.defineProperty(out, key, { ...d, value: copy(d.value, `${path}.${String(key)}`) });
    }
    return out;
  };
  return copy(root, '$') as T;
}
