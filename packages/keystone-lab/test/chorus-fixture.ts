// The Chorus level the Rapier tests play (chorus.test.ts, chorus-verify.test.ts).
import { L1, type LevelDef, readShots, type Shot } from '@tb/keystone';

/** L1 (Open Fire, a 2 x 10 x 2 tower with four crowns) as one cannonball into K worlds; three crowns down clear a world. */
export const openFire = (worlds: number): LevelDef => ({ ...L1, id: 'CH-T1', rack: ['cannonball'], par: 1, scoring: 'outcome', solutions: undefined, lGold: undefined, chorus: { worlds, need: 3 } });
/** Course 4 from the -x side, full power (aimed for Rapier's 4 substeps): on Rapier about two thirds of the worlds lose three crowns. */
export const SHOT: Shot = readShots('cannonball.360.8.22.249.100')[0]!;
