// RemoveEvent's queue check (remove.ts): what engines refuse before anything changes.
import { describe, expect, it } from 'vitest';
import { checkBlastQueue, checkInputQueue, type InputEvent, queueInputs, TIER_FREE, type Vec3 } from '../src/index.ts';

const O: Vec3 = [0, 0, 0];
const spawn = (step: number): InputEvent => ({ step, kind: 'spawn', body: { shape: { kind: 'sphere', radius: 1 }, pos: O, rot: [0, 0, 0, 1], linVel: O, angVel: O, density: 1, friction: 0, restitution: 0, tag: 0 } });
const remove = (step: number, id: number): InputEvent => ({ step, kind: 'remove', id });
const blastOn = (step: number, body: number): InputEvent => ({ step, kind: 'blast', blast: { centre: { body }, radius: 2, impulse: 1 } });

describe('removal queue check', () => {
  it('takes a removal of a body that exists then, spawned ones included', () => {
    expect(() => checkInputQueue(2, [remove(0, 1)])).not.toThrow();
    expect(() => checkInputQueue(2, [spawn(0), remove(0, 2)])).not.toThrow();
    // A blast centred on a body, then its removal, at the same step: the grenade's own end.
    expect(() => checkInputQueue(2, [blastOn(4, 1), remove(4, 1)])).not.toThrow();
  });

  it('refuses a removal of a body that does not exist then, or is already removed, saying which', () => {
    expect(() => checkInputQueue(2, [remove(0, 2)])).toThrow(/remove at step 0 names body 2, which does not exist then \(2 bodies\)/);
    // Pushed after: a spawn at the same step queues after the removal, so body 2 does not exist yet.
    expect(() => checkInputQueue(2, queueInputs([remove(3, 2)], [spawn(3)]))).toThrow(/body 2/);
    expect(() => checkInputQueue(2, [remove(0, 1), remove(5, 1)])).toThrow(/remove at step 5 names body 1, which is already removed/);
    expect(() => checkInputQueue(2, [remove(0, 1)], new Set([1]))).toThrow(/already removed/);
    for (const id of [-1, 0.5, NaN]) expect(() => checkInputQueue(2, [remove(0, id)])).toThrow(/id must be a body id/);
  });

  it('refuses a blast centred on a removed body; one centred elsewhere still reaches past it', () => {
    expect(() => checkInputQueue(2, [remove(0, 1), blastOn(0, 1)])).toThrow(/blast at step 0 is centred on body 1, which is removed then/);
    expect(() => checkInputQueue(2, [blastOn(0, 1)], new Set([1]))).toThrow(/removed then/);
    expect(() => checkInputQueue(2, [remove(0, 1), blastOn(0, 0)])).not.toThrow();
  });

  it('checkBlastQueue is checkInputQueue with nothing removed before the queue', () => {
    expect(() => checkBlastQueue(2, [remove(0, 1), blastOn(1, 1)])).toThrow(/removed then/);
    expect(() => checkBlastQueue(2, [blastOn(0, 2)])).toThrow(/does not exist/);
  });

  it('a removed body\'s tier is the renderer\'s free slot (@tb/schema TIER.free)', () => {
    expect(TIER_FREE).toBe(255);
  });
});
