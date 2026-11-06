// Fuse & Fold's sites (M5, docs/game/fuse-and-fold.md): frame buildings in lots with heritage neighbours,
// each a fold level (fuse-buildings.ts foldLevel). FOLD_CANDIDATES are the designs the search judged
// (pnpm keystone:fuse; keystone-lab fuse-search.ts); FUSE_LEVELS are the ones that passed the
// order-matters gate and ship (docs/game/mode-probes.md, X2 on levels).
import { type FoldSite, foldLevel } from './fuse-buildings.ts';
import type { LevelDef } from './level.ts';

const rods = { slab: 0.5, colH: 2, column: 'rod' } as const;

/** The candidate sites, by id. */
export const FOLD_SITES: Readonly<Record<string, { name: string; site: FoldSite }>> = {
  // A slender 2 x 2 tower: a yard to the west as long as it is tall; houses close on the other three sides.
  'FC-1': { name: 'Timber', site: { frame: { nx: 2, nz: 2, span: 3, storeys: 6, ...rods }, cuts: [0], margin: 1, yards: [{ side: 'W', len: 22 }],
    neighbours: [{ side: 'E', gap: 1, w: 6, d: 2, h: 6 }, { side: 'N', gap: 1, w: 4, d: 2, h: 4, along: 0 }, { side: 'S', gap: 1, w: 4, d: 2, h: 4, along: 0 }], min: 0.6, spillMax: 0.05 } },
  // The same tower, the yard to the north: the fall's direction is the decision.
  'FC-2': { name: 'Wrong Way', site: { frame: { nx: 3, nz: 3, span: 2, storeys: 6, ...rods }, cuts: [0], margin: 1, yards: [{ side: 'N', len: 22 }],
    neighbours: [{ side: 'W', gap: 1, w: 6, d: 2, h: 6 }, { side: 'E', gap: 1, w: 6, d: 2, h: 6 }, { side: 'S', gap: 1, w: 6, d: 2, h: 5 }], min: 0.6, spillMax: 0.05 } },
  // A wide block, a short yard ending in a heritage wall: a gentle sweep lands in it, a hard one overshoots.
  'FC-3': { name: 'Short Yard', site: { frame: { nx: 4, nz: 3, span: 2, storeys: 5, ...rods }, cuts: [0], margin: 1, yards: [{ side: 'W', len: 14 }],
    neighbours: [{ side: 'W', gap: 1, w: 8, d: 2, h: 3 }, { side: 'E', gap: 1, w: 6, d: 2, h: 6 }], min: 0.6, spillMax: 0.05 } },
  'FC-3b': { name: 'Short Yard', site: { frame: { nx: 4, nz: 3, span: 2, storeys: 5, ...rods }, cuts: [0], margin: 1, yards: [{ side: 'W', len: 11 }],
    neighbours: [{ side: 'W', gap: 1, w: 8, d: 2, h: 3 }, { side: 'E', gap: 1, w: 6, d: 2, h: 6 }], min: 0.5, spillMax: 0.05 } },
  // A corner lot: houses east and south, a yard west and north, each shorter than the fall; the diagonal is longer.
  'FC-4': { name: 'Corner Lot', site: { frame: { nx: 3, nz: 3, span: 2, storeys: 5, ...rods }, cuts: [0], margin: 1, yards: [{ side: 'W', len: 12 }, { side: 'N', len: 12 }],
    neighbours: [{ side: 'E', gap: 1, w: 8, d: 2, h: 6, along: -2 }, { side: 'S', gap: 1, w: 8, d: 2, h: 5, along: -2 }, { side: 'W', gap: 1, w: 6, d: 2, h: 4, along: 0 }, { side: 'N', gap: 1, w: 6, d: 2, h: 4, along: 0 }], min: 0.6, spillMax: 0.05 } },
  // Relays on the fourth storey's columns: they go when jolted, cutting the tower again as it moves.
  'FC-5': { name: 'Sympathy', site: { frame: { nx: 3, nz: 3, span: 2, storeys: 8, ...rods }, cuts: [0], relays: [4], margin: 2, yards: [{ side: 'W', len: 10 }],
    neighbours: [{ side: 'E', gap: 1, w: 6, d: 2, h: 6 }, { side: 'N', gap: 1, w: 6, d: 2, h: 5 }, { side: 'S', gap: 1, w: 6, d: 2, h: 5 }], min: 0.6, spillMax: 0.05 } },
  // FC-5 with a longer yard (shipped as F5), and its control without the relays: the relays are what fold it short enough.
  'FC-5b': { name: 'Sympathy', site: { frame: { nx: 3, nz: 3, span: 2, storeys: 8, ...rods }, cuts: [0], relays: [4], margin: 2, yards: [{ side: 'W', len: 14 }],
    neighbours: [{ side: 'E', gap: 1, w: 6, d: 2, h: 6 }, { side: 'N', gap: 1, w: 6, d: 2, h: 5 }, { side: 'S', gap: 1, w: 6, d: 2, h: 5 }], min: 0.6, spillMax: 0.05 } },
  'FC-5c': { name: 'No Sympathy', site: { frame: { nx: 3, nz: 3, span: 2, storeys: 8, ...rods }, cuts: [0], margin: 2, yards: [{ side: 'W', len: 14 }],
    neighbours: [{ side: 'E', gap: 1, w: 6, d: 2, h: 6 }, { side: 'N', gap: 1, w: 6, d: 2, h: 5 }, { side: 'S', gap: 1, w: 6, d: 2, h: 5 }], min: 0.6, spillMax: 0.05 } },
};

/** The levels that passed the order-matters gate (fuse-and-fold.md, mode-probes.md X2), in door order. */
export const FUSE_LEVELS: readonly LevelDef[] = [
  shipped('F1', 'FC-1'), // a west sweep of 0.6 s or more; everything at once drops it a storey
  shipped('F2', 'FC-2'), // the same verb, the yard to the north: the sweep's direction is the decision
  shipped('F3', 'FC-4'), // a corner lot: west, north or the diagonal fold it; east or south hit a house
  shipped('F4', 'FC-3'), // a wide block and a short yard: a west sweep of 0.4 to 0.8 s folds it; 0.3 s or 1.0 s spills out of the lot
  shipped('F5', 'FC-5b'), // relays on storey 5 fold the tower in two as it falls: without them it overshoots (FC-5c)
];

/** A candidate shipped under its level id (the site's name kept): same building, lot and charges. */
function shipped(id: string, site: string): LevelDef {
  const s = FOLD_SITES[site]!;
  return foldLevel(id, s.name, s.site);
}

export const foldCandidate = (id: string): LevelDef => {
  const s = FOLD_SITES[id];
  if (!s) throw new Error(`no fold site ${id}: ${Object.keys(FOLD_SITES).join(', ')}`);
  return foldLevel(id, s.name, s.site);
};
