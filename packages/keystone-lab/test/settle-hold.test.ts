// Settle v4 and a pending weapon, on the reference engine at full size (one nudged build). F3's plunger line
// fires its last charges with the frame standing still before them: v4's steady-D run counted
// through the hold and the shot settled on that step, before the charges did anything (Fuse & Fold's v4 recast,
// PR #275: step 421, D 0.002, where v3 ends at 492 with 0.289). rules.ts settleHeld now starts v4's runs when
// the hold ends; the line settles where v3 does.
import { describe, expect, it } from 'vitest';
import { FUSE_LEVELS, readShots, type LevelDef, type PlungerShot } from '@tb/keystone';
import { playNudge } from '../src/fuse-search.ts';

const LINE = 'plunger.2.0.1.54.5.60.0.114.4.114.8.114.3.120.6.120.7.120';

describe('settle v4 waits out a pending weapon (reference engine)', () => {
  it('F3\'s plunger line settles after its last charges, where v3 does, not on the step they fire', { timeout: 200_000 }, async () => {
    const F3 = FUSE_LEVELS.find((l) => l.id === 'F3')!, shot = readShots(LINE)[0] as PlungerShot;
    const end = async (settle: LevelDef['settle']) => (await playNudge({ ...F3, settle }, [{ name: LINE, shot }], 1))[0]!;
    const [v3, v4] = [await end('v3'), await end('v4')];
    expect(v3.collapse).toBeGreaterThan(0.2);
    expect(v4.steps).toBeGreaterThan(421);
    expect(v4.steps).toBe(v3.steps);
    expect(v4.collapse).toBeCloseTo(v3.collapse, 3);
  });
});
