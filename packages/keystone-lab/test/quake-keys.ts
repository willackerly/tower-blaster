// One digest of a set of quake field schedules (steps and gravity keys as multiples of the field quantum), shared by
// the Node side and the browser page of quake-gpu.test.ts.
import { FIELD_QUANTUM, type FieldEvent } from '@tb/engine-api';

export function quakeKeysDigest(schedules: readonly (readonly FieldEvent[])[]): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => { for (const ch of String(v)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0; h = Math.imul(h ^ 44, 0x01000193) >>> 0; };
  for (const s of schedules) { mix(s.length); for (const e of s) { mix(e.step); for (const g of e.gravity ?? []) mix(g / FIELD_QUANTUM); } }
  return h.toString(16).padStart(8, '0');
}
