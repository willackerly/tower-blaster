// The chamber levels' lot sheets but L2 (its own file: its proofs are the slow ones), and every sheet
// is in one of the two files. See lot-proofs.ts.
import { expect, it } from 'vitest';
import { LOT_SHEETS } from '@tb/keystone';
import { lotSheetProofs } from './lot-proofs.ts';

export const HERE = ['L1', 'L3', 'L4', 'L5'];
lotSheetProofs(HERE);

it('every sheet is proved by this file or lot-sheets-L2.test.ts', () => {
  expect(Object.keys(LOT_SHEETS).sort()).toEqual([...HERE, 'L2'].sort());
});
