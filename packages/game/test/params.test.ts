// The game page's URL keys (params.ts), which the viewer reads too under
// rules=keystone: defaults, accepted spellings, and refused values named.
import { describe, expect, it } from 'vitest';
import { L1, L3, type Shot, writeShots } from '@tb/keystone';
import { GAME_LOOK, parseGameParams } from '../src/params.ts';

const parse = (search: string) => parseGameParams(new URLSearchParams(search));
const par = L1.solutions!.par as Shot[];

describe('game URL keys', () => {
  it('defaults to the first level on the GPU solver in the maquette look, no juice and no line', () => {
    expect(parse('')).toEqual({ level: L1, engine: 'gpu', feel: { hitStop: false, slowMo: false }, look: GAME_LOOK, shots: null, offscreen: false });
    expect(GAME_LOOK).toBe('hazy');
  });

  it('reads every key, a level in any case and the viewer\'s name for the GPU solver, and leaves other keys alone', () => {
    expect(parse(`?level=l3&engine=rapier&keystone.hitstop=1&keystone.slowmo=0&look=real&real.sunElevation=6&offscreen=1&scenario=S4&cam=1,2,3,0,0,9`)).toEqual({
      level: L3, engine: 'rapier', feel: { hitStop: true, slowMo: false }, look: 'real', shots: null, offscreen: true,
    });
    expect(parse('?engine=avbd-gpu').engine).toBe('gpu');
    expect(parse('?engine=gpu').engine).toBe('gpu');
    expect(parse(`?level=L1&keystone.shots=${writeShots(par)}`).shots).toEqual(par);
  });

  it('refuses bad values, naming the key', () => {
    expect(() => parse('?level=L99')).toThrow(/unknown level L99; known: L1, L2/);
    expect(() => parse('?engine=physx')).toThrow(/unknown engine physx: use rapier or gpu/);
    expect(() => parse('?keystone.hitstop=yes')).toThrow(/keystone.hitstop must be 0 or 1: yes/);
    expect(() => parse('?keystone.slowmo=')).toThrow(/keystone.slowmo must be 0 or 1: $/);
    expect(() => parse('?look=neon')).toThrow(/unknown look neon; known: candy, hazy, real/);
    expect(() => parse('?keystone.shots=')).toThrow(/keystone.shots is empty/);
    expect(() => parse('?keystone.shots=drop.0.0')).toThrow(/fires 1 drop but L1's rack holds 0/);
    expect(() => parse('?keystone.shots=marble.0')).toThrow(/shot 1 .*marble takes 5 fields/);
  });
});
