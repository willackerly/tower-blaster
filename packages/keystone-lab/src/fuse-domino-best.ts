// The order gate's verdict on each shipped domino-fuse level (fuse-gate.ts, docs/game/fuse-and-fold.md "Domino
// fuses"): its fuse site, the lane order its sweeps rank (lane indices, first to fire first), and the best build the
// gate confirmed on 8 nudged builds of the reference. The reference and GPU tests replay these.
export const DOMINO_BEST: Readonly<Record<string, { site: string; order: readonly number[]; best: string }>> = {
  F6: { site: 'FD-1', order: [0, 1], best: 'forward +5' },
  F7: { site: 'FD-2', order: [0, 1, 2], best: 'forward +3' },
  F8: { site: 'FD-3', order: [0, 1, 2, 3], best: 'forward +3' },
};
