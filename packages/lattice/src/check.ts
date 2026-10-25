// Invariant checks for tests and debug builds. Each returns a list of
// human-readable problems; empty means the invariant holds.
import { EMPTY, type Lattice } from './lattice.ts';
import { type SupportModel } from './support.ts';

/** Occupancy bits and ids agree, the count is right and no body is stored twice. */
export function checkStorage(lat: Lattice): string[] {
  const out: string[] = [];
  const seen = new Map<number, number>();
  let n = 0;
  for (let k = 0; k < lat.nz; k++)
    for (let i = 0; i < lat.nx; i++)
      for (let j = 0; j < lat.ny; j++) {
        const id = lat.idAt(i, j, k), bit = lat.has(i, j, k);
        if (bit !== (id !== EMPTY)) out.push(`cell ${i},${j},${k}: bit ${bit} but id ${id}`);
        if (!bit) continue;
        n++;
        const prev = seen.get(id);
        if (prev !== undefined) out.push(`body ${id} in cells ${lat.coords(prev).join(',')} and ${i},${j},${k}`);
        seen.set(id, lat.cell(i, j, k));
      }
  // Bits beyond ny in the last word must stay clear.
  for (let c = 0; c < lat.nx * lat.nz; c++) {
    const top = lat.bits[c * lat.words + lat.words - 1]!;
    const used = lat.ny - 32 * (lat.words - 1);
    if (used < 32 && top >>> used) out.push(`column ${c}: bits set above ny`);
  }
  if (n !== lat.count) out.push(`count ${lat.count} but ${n} cells occupied`);
  return out;
}

/** No dormant cube without support ("no floating cubes"). */
export function checkSupport(lat: Lattice, support: SupportModel): string[] {
  return support.violations(lat).map((c) => `cell ${lat.coords(c).join(',')} (body ${lat.idAt(...lat.coords(c))}) is unsupported under ${support.name}`);
}
