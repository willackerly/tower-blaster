// Session records: a level hash, the engine and the quantised shots with the
// step each was fired at. Varint-packed and base64url, so a whole attempt is
// a short link and a replay is exact on the same engine build.
import { type Shot } from './shots.ts';

export interface SessionRecord { v: 1; level: string; levelHash: string; engine: string; inputs: { step: number; shot: Shot }[] }

const AMMO_CODE = { marble: 0, cannonball: 1, cue: 2, drop: 3 } as const;
const AMMO_NAME = ['marble', 'cannonball', 'cue', 'drop'] as const;

class Writer {
  bytes: number[] = [];
  uint(v: number) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`varint ${v} must be a non-negative integer`);
    while (v >= 0x80) { this.bytes.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    this.bytes.push(v);
  }
  int(v: number) { this.uint(v >= 0 ? 2 * v : -2 * v - 1); }
  str(s: string) { const b = new TextEncoder().encode(s); this.uint(b.length); this.bytes.push(...b); }
}

class Reader {
  i = 0;
  constructor(private readonly b: Uint8Array) {}
  uint(): number {
    let v = 0, mul = 1;
    for (;;) {
      if (this.i >= this.b.length) throw new Error('record truncated');
      const x = this.b[this.i++]!;
      v += (x & 0x7f) * mul;
      if (x < 0x80) return v;
      mul *= 0x80;
    }
  }
  int() { const u = this.uint(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  str() { const n = this.uint(); const s = new TextDecoder().decode(this.b.subarray(this.i, this.i + n)); this.i += n; return s; }
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function encodeRecord(r: SessionRecord): string {
  const w = new Writer();
  w.uint(r.v); w.str(r.level); w.str(r.levelHash); w.str(r.engine); w.uint(r.inputs.length);
  let last = 0;
  for (const { step, shot } of r.inputs) {
    w.uint(step - last); last = step;
    w.uint(AMMO_CODE[shot.ammo]);
    if (shot.ammo === 'drop') { w.int(shot.x); w.int(shot.z); }
    else if (shot.ammo === 'cue') { w.int(shot.x); w.int(shot.y); w.int(shot.z); w.uint(shot.dir); w.uint(shot.power); }
    else { w.uint(shot.az); w.int(shot.y); w.int(shot.yaw); w.int(shot.pitch); w.uint(shot.power); }
  }
  return b64(Uint8Array.from(w.bytes));
}

export function decodeRecord(s: string): SessionRecord {
  const r = new Reader(unb64(s));
  const v = r.uint();
  if (v !== 1) throw new Error(`unknown record version ${v}`);
  const level = r.str(), levelHash = r.str(), engine = r.str(), n = r.uint();
  const inputs: SessionRecord['inputs'] = [];
  let step = 0;
  for (let k = 0; k < n; k++) {
    step += r.uint();
    const ammo = AMMO_NAME[r.uint()];
    if (!ammo) throw new Error('bad ammo code');
    let shot: Shot;
    if (ammo === 'drop') shot = { ammo, x: r.int(), z: r.int() };
    else if (ammo === 'cue') shot = { ammo, x: r.int(), y: r.int(), z: r.int(), dir: r.uint() as 0 | 1 | 2 | 3, power: r.uint() };
    else shot = { ammo, az: r.uint(), y: r.int(), yaw: r.int(), pitch: r.int(), power: r.uint() };
    inputs.push({ step, shot });
  }
  return { v: 1, level, levelHash, engine, inputs };
}
