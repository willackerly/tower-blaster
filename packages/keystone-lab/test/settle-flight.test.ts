// Agent playtest PT10: a shot must not settle while its ammo is still flying. On Rapier a level at
// rest is asleep (nothing awake), and a launcher over 4 h from the lot (the par levels keep theirs)
// fires ammo the rules do not count until it is close; L2's par line settled 20 steps after the
// launch, the cannonball frozen in the air beside the pillar, and L3's first marble 28 steps in,
// skimming below 0.6 h. Each par line's shots, on Rapier, now settle only after the ammo touched
// something.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, type Feedback, LEVELS, runSession, type Shot } from '@tb/keystone';

describe('no shot settles with its ammo in the air (PT10)', () => {
  for (const def of LEVELS.filter((d) => d.solutions?.par)) {
    it(`${def.id}'s par line on Rapier: every shot settles after its ammo's first contact`, async () => {
      const e = new RapierEngine();
      try {
        const { feedback } = await runSession(e, compileLevel(def), def.solutions!.par! as Shot[]);
        // Feedback is in order: each shot's fired, its contact (if any), ..., its settled.
        let fired: Feedback | null = null, contact = false, ends = 0;
        for (const f of feedback) {
          if (f.t === 'fired') { fired = f; contact = false; }
          if (f.t === 'contact') contact = true;
          if (f.t !== 'settled') continue;
          ends++;
          expect(contact, `${def.id} shot ${f.shot} settled ${f.step - fired!.step} steps after its launch with no contact`).toBe(true);
          expect(f.step - fired!.step).toBeGreaterThan(60);
        }
        expect(ends).toBe(def.solutions!.par!.length);
      } finally {
        e.dispose();
      }
    }, 120_000);
  }
});
