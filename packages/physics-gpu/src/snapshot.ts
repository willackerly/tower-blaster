// A Snapshot from Body[] bytes read back from the GPU, in one pass.
// snapshot() runs on the main thread after every step the game or viewer
// shows. Five readField passes (one per field, each re-deriving its view and
// offsets) cost 0.68 ms at 10k bodies and 6.6 ms at 100k in a Node
// microbench; this single pass over one Float32Array and one Uint32Array
// view gives the same values (pipelining audit, docs/pipelining.md).
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { Body, field } from '@tb/schema';

const STRIDE = Body.size / 4;
const at = (name: string) => field(Body, name).offset / 4;
const POS = at('pos'), ROT = at('rot'), LIN = at('linVel'), ANG = at('angVel'), FLAGS = at('flags');

/**
 * Bodies [0, n) of `buf` (Body layout) as a Snapshot: pos, rot, linVel, angVel and awake (flags
 * bit 0). With `tiers`, also each body's tier (flags bits 8-15). Equal, value for value, to
 * readField of each field.
 */
export function decodeBodies(buf: ArrayBuffer, n: number, tiers = false): Snapshot {
  if (!Number.isInteger(n) || n < 0) throw new Error(`decodeBodies: bad count ${n}`);
  if (n * Body.size > buf.byteLength) throw new Error(`decodeBodies: ${n} bodies need ${n * Body.size} bytes, the buffer has ${buf.byteLength}`);
  const s = emptySnapshot(n);
  const f = new Float32Array(buf, 0, n * STRIDE), u = new Uint32Array(buf, 0, n * STRIDE);
  const { pos, rot, linVel, angVel, awake } = s;
  const tier = tiers ? new Uint8Array(n) : null;
  for (let i = 0, o = 0, i3 = 0, i4 = 0; i < n; i++, o += STRIDE, i3 += 3, i4 += 4) {
    pos[i3] = f[o + POS]!; pos[i3 + 1] = f[o + POS + 1]!; pos[i3 + 2] = f[o + POS + 2]!;
    rot[i4] = f[o + ROT]!; rot[i4 + 1] = f[o + ROT + 1]!; rot[i4 + 2] = f[o + ROT + 2]!; rot[i4 + 3] = f[o + ROT + 3]!;
    linVel[i3] = f[o + LIN]!; linVel[i3 + 1] = f[o + LIN + 1]!; linVel[i3 + 2] = f[o + LIN + 2]!;
    angVel[i3] = f[o + ANG]!; angVel[i3 + 1] = f[o + ANG + 1]!; angVel[i3 + 2] = f[o + ANG + 2]!;
    const flags = u[o + FLAGS]!;
    awake[i] = flags & 1;
    if (tier) tier[i] = (flags >> 8) & 0xff;
  }
  if (tier) s.tier = tier;
  return s;
}
