// Every mode probe, by id.
import type { Probe } from './probe.ts';
import { X1 } from './x1-dominoes.ts';

export const PROBES: readonly Probe[] = [X1 as Probe];

export function probeById(id: string): Probe {
  const p = PROBES.find((x) => x.id === id.toUpperCase());
  if (!p) throw new Error(`unknown probe ${id}: known ${PROBES.map((x) => x.id).join(', ')}`);
  return p;
}
