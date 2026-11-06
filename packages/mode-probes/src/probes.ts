// Every mode probe, by id.
import type { Probe } from './probe.ts';
import { X1 } from './x1-dominoes.ts';
import { X2 } from './x2-demolition.ts';
import { X3 } from './x3-towers.ts';
import { X4 } from './x4-hold.ts';
import { X5 } from './x5-pinned.ts';
import { X6 } from './x6-shake.ts';
import { X8 } from './x8-islands.ts';

export const PROBES: readonly Probe[] = [X1 as Probe, X2 as Probe, X3 as Probe, X4 as Probe, X5 as Probe, X6 as Probe, X8 as Probe];

export function probeById(id: string): Probe {
  const p = PROBES.find((x) => x.id === id.toUpperCase());
  if (!p) throw new Error(`unknown probe ${id}: known ${PROBES.map((x) => x.id).join(', ')}`);
  return p;
}
