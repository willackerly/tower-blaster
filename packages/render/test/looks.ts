// The looks the GPU test pages draw: the real look with realism step 7's
// polish off (REAL_POLISH_OFF: no film grain, the clear-coated ball), unless a
// case sets those options itself. Grain gets a new seed every frame, so with
// it on two frames of one renderer never match bit for bit, and the checks
// written before the polish measure blocks, ground, ice and light, not grain.
// The polish has its own tests (tonemap.test.ts, render-real-steel.test.ts)
// and the golden gate (render.test.ts).
import { LOOKS as SRC_LOOKS, lookByName as srcLookByName, REAL_POLISH_OFF, realLook as srcRealLook, type LookParams, type RealOptions } from '../src/index.ts';

export const realLook = (o: Partial<RealOptions> = {}): LookParams => srcRealLook({ ...REAL_POLISH_OFF, ...o });
export const LOOKS: Record<string, LookParams> = { ...SRC_LOOKS, real: realLook() };
export const lookByName = (name: string, real: Partial<RealOptions> = {}): LookParams => (name === 'real' ? realLook(real) : srcLookByName(name, real));
