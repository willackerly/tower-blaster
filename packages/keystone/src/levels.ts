// Starter levels, one per behaviour the mechanics probe found usable on
// Rapier (pnpm keystone:probe): shear, lintel tip, pick-off, catapult,
// dominoes. Coordinates are in cells (h); see LevelDef. Par lines are the most
// robust clean solutions pnpm keystone:bot found (docs/game/findings.md), and
// tests replay them. lGold is provisional: about 0.9 x the par line's leverage.
import type { LevelDef } from './level.ts';

type V3 = [number, number, number];

/** W1-1, shear. A slender tower: a cannonball brings most of the crowns down, a second shot cleans up. */
export const L1: LevelDef = {
  id: 'L1', name: 'Open Fire', version: 2, world: 1,
  parts: [{ kind: 'block', at: [-1.5, 0, -1.5], size: [3, 12, 3], material: 'plaster', courses: [{ k: 11, role: 'crown' }] }],
  lot: { min: [-7, -7], max: [7, 7] },
  crownLine: 2, objective: { kind: 'crowns' }, par: 2,
  rack: ['cannonball', 'cannonball', 'marble', 'marble'],
  launcher: { radius: 14, y: 2, dropY: 16 },
  lGold: 1.0,
  solutions: { par: [{ ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 505, power: 100 }, { ammo: 'cannonball', az: 180, y: 8, yaw: -46, pitch: 526, power: 60 }] },
};

/** W1-2, lintel tip. Fell one column and the lintel sheds its crowns; fell the other and it lands on the pavilion. */
export const L2: LevelDef = {
  id: 'L2', name: 'Lintel', version: 2, world: 1,
  parts: [
    { kind: 'block', at: [-4, 0, -1], size: [2, 12, 2], material: 'plaster' },
    { kind: 'block', at: [2, 0, -1], size: [2, 12, 2], material: 'plaster' },
    { kind: 'slab', at: [0, 12, 0], half: [4, 0.125, 1], material: 'stone' },
    { kind: 'block', at: [-1.5, 12.25, -1], size: [3, 1, 2], material: 'plaster', role: 'crown' },
    { kind: 'block', at: [-9, 0, -2], size: [3, 3, 4], material: 'plaster', role: 'heritage' },
  ],
  lot: { min: [-10, -8], max: [10, 8] },
  crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'marble', 'cannonball'],
  launcher: { radius: 16, y: 2, dropY: 18 },
  lGold: 2.5,
  solutions: { par: [{ ammo: 'cannonball', az: 360, y: 8, yaw: 16, pitch: 363, power: 100 }] },
};

/** W1-3, pick-off. Crowns sit between heritage cubes on top of a wall: take them without touching their neighbours. */
export const L3: LevelDef = {
  id: 'L3', name: 'Surgeon', version: 2, world: 1,
  parts: [{
    kind: 'block', at: [-2.5, 0, -0.5], size: [5, 8, 1], material: 'plaster',
    courses: [{ k: 7, role: 'heritage' }, { k: 7, cells: [[1, 0], [3, 0]], role: 'crown' }],
  }],
  lot: { min: [-7, -7], max: [7, 7] },
  crownLine: 2, objective: { kind: 'crowns' }, par: 2,
  rack: ['marble', 'marble', 'marble', 'cannonball'],
  launcher: { radius: 14, y: 8, dropY: 14 },
  lGold: 0.25,
  solutions: { par: [{ ammo: 'cannonball', az: 540, y: 8, yaw: -42, pitch: 192, power: 60 }, { ammo: 'marble', az: 180, y: 8, yaw: -42, pitch: 290, power: 60 }] },
};

/** W2-1, catapult. A slab on a central pier with its crown end on a prop: drop the anvil on the free end. */
export const L4: LevelDef = {
  id: 'L4', name: 'Catapult', version: 2, world: 2,
  parts: [
    { kind: 'block', at: [5.5, 0, -1.5], size: [1, 4, 3], material: 'plaster' },
    { kind: 'block', at: [11, 0, -0.5], size: [1, 4, 1], material: 'plaster' },
    { kind: 'slab', at: [6, 4, 0], half: [6, 0.125, 1.5], material: 'plaster' },
    { kind: 'block', at: [9, 4.25, -1.5], size: [3, 1, 3], material: 'plaster', role: 'crown' },
    { kind: 'block', at: [-4, 0, -4], size: [1, 6, 1], material: 'plaster', role: 'heritage' },
    { kind: 'block', at: [-4, 0, 3], size: [1, 6, 1], material: 'plaster', role: 'heritage' },
  ],
  lot: { min: [-3, -6], max: [14, 6] },
  crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['drop', 'marble', 'marble'],
  launcher: { radius: 14, y: 2, dropY: 12 },
  lGold: 0.4,
  solutions: { par: [{ ammo: 'drop', x: 34, z: -4 }] },
};

/** W2-2, dominoes. Five slender columns; the crown sits on the last. */
export const L5: LevelDef = {
  id: 'L5', name: 'Dominoes', version: 1, world: 2,
  parts: [0, 1, 2, 3, 4].map((k) => ({
    kind: 'block' as const, at: [-8 + 4 * k, 0, -0.5] as V3, size: [1, 9, 1] as V3, material: 'plaster' as const,
    courses: k === 4 ? [{ k: 8, role: 'crown' as const }] : [],
  })),
  lot: { min: [-14, -8], max: [14, 8] },
  crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'marble', 'cannonball'],
  launcher: { radius: 18, y: 2, dropY: 14 },
  lGold: 10,
  solutions: { par: [{ ammo: 'marble', az: 0, y: 8, yaw: 0, pitch: 272, power: 60 }] },
};

export const LEVELS: readonly LevelDef[] = [L1, L2, L3, L4, L5];
