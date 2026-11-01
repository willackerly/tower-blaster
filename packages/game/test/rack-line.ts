// A line of real projectiles on L1 for the rack tests (rack-presets*.test.ts): a bowling
// ball high on the tower, a dud against plaster that moves nothing (spectacle-mode.md
// section 7), then a wrecking ball from the other side that brings the crowns down.
// Aimed with aimAt at the tower; on the Rapier and AVBD reference it clears L1 in 737
// steps with both shots fired, and the basketball is left in the rack.
import type { RackItem, Shot } from '@tb/keystone';

export const PRESET_RACK: RackItem[] = ['p-bowlingball', 'p-wreckingball', 'p-basketball'];
export const PRESET_LINE: Shot[] = [
  { ammo: 'p-bowlingball', az: 360, y: 8, yaw: 0, pitch: 442, power: 100 },
  { ammo: 'p-wreckingball', az: 540, y: 8, yaw: 0, pitch: 176, power: 100 },
];

/**
 * A grenade on L1 (rack-grenade-gpu.test.ts; the reference and Rapier cases are keystone-lab
 * rack-grenade.test.ts): aimed at the tower's middle from L1's par launcher, its proximity
 * fuse sets it off on the tower's face and the blast brings the crowns down.
 */
export const GRENADE_RACK: RackItem[] = ['w-grenade', 'w-grenade', 'marble'];
export const GRENADE_LINE: Shot[] = [{ ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 176, power: 100 }];
