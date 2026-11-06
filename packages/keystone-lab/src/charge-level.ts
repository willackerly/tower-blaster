// The test level for charges and the plunger (C5, docs/design/charges.md), shared by the Node
// tests (charges.test.ts: reference and Rapier) and the GPU's (charges-gpu.test.ts, the cast page).
// Three plaster columns four high (left, middle, right, three cells apart), a cube beside the middle
// column's base and one far off. Charges: a cutter on the left base (0), a cutter on the middle base
// (1), a kicker on the right base's +x face (2), and relays armed at start on the near cube (3, in
// reach of the middle cutter's blast) and the far one (4, out of every blast's reach).
import type { LevelDef, Shot } from '@tb/keystone';

export function chargeLevel(): LevelDef {
  return {
    id: 'T-C5', name: 'Charges', version: 1, world: 0, lot: { min: [-8, -8], max: [8, 8] }, crownLine: 1, objective: { kind: 'collapse', min: 0.05 },
    par: 1, scoring: 'outcome', rack: ['plunger'], launcher: { radius: 9, y: 1, dropY: 10 },
    parts: [
      { kind: 'block', at: [-3, 0, 0], size: [1, 4, 1], material: 'plaster' }, // bodies 0-3
      { kind: 'block', at: [3, 0, 0], size: [1, 4, 1], material: 'plaster' }, // 4-7
      { kind: 'block', at: [0, 0, 0], size: [1, 4, 1], material: 'plaster' }, // 8-11
      { kind: 'block', at: [1, 0, 0], size: [1, 1, 1], material: 'plaster' }, // 12, beside the middle base
      { kind: 'block', at: [7, 0, 0], size: [1, 1, 1], material: 'plaster' }, // 13, far off
    ],
    charges: [
      { host: 0, weapon: 'cutter' },
      { host: 8, weapon: 'cutter' },
      { host: 4, weapon: 'kicker', at: [0.5, 0, 0] },
      { host: 12, weapon: 'relay', arm: 'start' },
      { host: 13, weapon: 'relay', arm: 'start' },
    ],
  };
}

/** The 3-event timeline: cut the left base at once, the middle one 20 steps later, kick the right one at 45. */
export const CHARGE_LINE: Shot[] = [{ ammo: 'plunger', fuse: [[0, 0], [1, 20], [2, 45]] }];
/** One plunger arming the kicker alone. */
export const CHARGE_REST_LINE: Shot[] = [{ ammo: 'plunger', fuse: [[2, 0]] }];
/** A marble dropped at the launcher's foot, far from every body: a shot that moves nothing. */
export const MISS: Shot = { ammo: 'marble', az: 180, y: 4, yaw: 0, pitch: -890, power: 0 };
