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
 * A grenade on L1 (rack-grenade-gpu.test.ts; the reference case is the last of keystone-lab
 * rack-grenade.test.ts): the default w-grenade (w-grenadem since 2026-11-05) aimed with aimAt at the
 * tower's middle from L1's par launcher at full power; its proximity fuse sets it off on the tower's
 * face (step 314 on the reference) and the blast brings the crowns down.
 */
export const GRENADE_RACK: RackItem[] = ['w-grenade', 'w-grenade', 'marble'];
export const GRENADE_LINE: Shot[] = [{ ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 106, power: 100 }];

/**
 * A firework on L1 (rack-weapons-gpu.test.ts; the reference and Rapier cases are keystone-lab
 * rack-weapons.test.ts): the built-in WeaponSpec scaled to L1, aimed at the tower's middle at 30%
 * power: it splits into 12 stars on the bounce and they bring the crowns down.
 */
export const FIREWORK_RACK: RackItem[] = ['w-firework', 'w-cluster'];
export const FIREWORK_LINE: Shot[] = [{ ammo: 'w-firework', az: 360, y: 8, yaw: 0, pitch: 176, power: 30 }];
