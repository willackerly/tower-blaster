// power.ts: reading Low Power Mode and the power source from pmset's output.
import { describe, expect, it } from 'vitest';
import { parsePmset, powerState } from './power.ts';

const settings = (extra: string) => `System-wide power settings:\nCurrently in use:\n standby              1\n Sleep On Power Button 1\n hibernatefile        /var/vm/sleepimage\n${extra} disksleep            10\n sleep                1\n`;
const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n";
const BATTERY = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t80%; discharging; 5:00 remaining present: true\n";

describe('parsePmset', () => {
  it('reads lowpowermode on and off', () => {
    expect(parsePmset(settings(' lowpowermode         1\n'), AC)).toEqual({ lowPower: true, ac: true, raw: { lowpowermode: 1 } });
    expect(parsePmset(settings(' lowpowermode         0\n'), AC)).toEqual({ lowPower: false, ac: true, raw: { lowpowermode: 0 } });
  });

  it('reads Energy Mode: powermode 1 is Low, 0 (automatic) and 2 (high) are not', () => {
    expect(parsePmset(settings(' powermode            1\n'), BATTERY).lowPower).toBe(true);
    expect(parsePmset(settings(' powermode            0\n'), BATTERY).lowPower).toBe(false);
    expect(parsePmset(settings(' powermode            2\n lowpowermode         0\n'), AC)).toEqual({ lowPower: false, ac: true, raw: { powermode: 2, lowpowermode: 0 } });
  });

  it('reads the power source, and null when pmset names neither', () => {
    expect(parsePmset(settings(''), AC).ac).toBe(true);
    expect(parsePmset(settings(''), BATTERY).ac).toBe(false);
    expect(parsePmset(settings(''), '').ac).toBe(null);
  });

  it('is not low power when neither key is present, and ignores keys that only contain the names', () => {
    expect(parsePmset(settings(' xlowpowermode        1\n'), AC)).toEqual({ lowPower: false, ac: true, raw: {} });
  });
});

describe('powerState', () => {
  it('is null off macOS', () => {
    if (process.platform === 'darwin') return;
    expect(powerState()).toBe(null);
  });
});
