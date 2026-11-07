// PT29's level test on the chamber levels, on the f64 reference (opening-aim-physics.ts).
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isBig, openingAimPhysics, RATED, REF_MAX_BODIES } from './opening-aim-physics.ts';

describe('the rated levels with an opening aim', () => {
  it('are the chamber, big and Wavefront levels aimed at a point', () => {
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'B1', 'B2', 'B3']) expect(RATED.map((d) => d.id)).toContain(id);
  });

  it(`each one over ${REF_MAX_BODIES} bodies has its own file on Rapier`, () => {
    for (const d of RATED.filter((x) => isBig(x.id))) expect(existsSync(new URL(`./opening-aim-physics-${d.id}.test.ts`, import.meta.url)), d.id).toBe(true);
  });
});

openingAimPhysics(RATED.filter((d) => !isBig(d.id)), 'ref');
