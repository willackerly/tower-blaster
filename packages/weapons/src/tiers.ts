// What one shot of a weapon may cost a device (docs/design/weapon-editor.md,
// "Budget caps"). A WeaponSpec travels: a link (the viewer's weapon.def), a
// file, a level. validateWeapon caps what the language allows anywhere
// (MAX_WEAPON_BODIES); these caps are what a device of a tier takes in one
// shot, so a weapon made on a fast machine cannot stall a slow one: a page
// refuses to fire one over its tier's caps and says which.
//
// Three numbers, each a static worst case (weaponBudget: every rule of every
// munition fires once), because each loads a different part of a frame:
//   bodies    spawned in all, the shell included: GPU capacity is fixed at
//             init (a level reserves room for its rack), a CPU engine's cost
//             grows with them, and each draws;
//   blasts    blasts set off: each is a dispatch on the GPU and a pass over
//             every body on a CPU engine, plus a fireball, a shock shell and
//             a light to draw (render blasts.ts);
//   grenades  nominal energy (yield.ts grenadeEnergies, the viewer's grenade
//             = 1): what the shot sets moving, so the solver's peak load.
//             The M5 Max's measured peak (B3, XL = 16 grenades: 8602 bodies
//             moving, frame p99 29.7 ms in Low Power Mode) is why high
//             stops at 16 and not above it.
// Every number is a starting point: the device-tier probe (roadmap P1) and
// measurements on slower machines tune them; nothing outside this table
// hard-codes one.
import { type MunitionSpec, weaponBudget, type WeaponIssue } from './spec.ts';
import { grenadeEnergies } from './yield.ts';

export const WEAPON_TIERS = ['low', 'mid', 'high'] as const;
export type WeaponTier = (typeof WEAPON_TIERS)[number];

/** One shot's worst case: bodies spawned (shell included), blasts set off, energy in grenades. */
export interface WeaponLoad {
  bodies: number;
  blasts: number;
  grenades: number;
}

/**
 * The most one shot may cost on a device of each tier. low: phones, integrated GPUs, SwiftShader and
 * CPU physics; mid: laptops; high: a desktop-class GPU (the M5 Max). Every built-in fits high; the
 * XL grenade (16 grenades) needs high, the L (4) fits every tier.
 */
export const WEAPON_TIER_CAPS: Readonly<Record<WeaponTier, WeaponLoad>> = {
  low: { bodies: 32, blasts: 16, grenades: 4 },
  mid: { bodies: 96, blasts: 48, grenades: 8 },
  high: { bodies: 256, blasts: 128, grenades: 16 },
};

export function isWeaponTier(x: unknown): x is WeaponTier {
  return typeof x === 'string' && (WEAPON_TIERS as readonly string[]).includes(x);
}

/** A weapon's load (weaponBudget, grenadeEnergies): the spec in the viewer's cube units. */
export function weaponLoad(spec: MunitionSpec): WeaponLoad {
  const b = weaponBudget(spec);
  return { bodies: b.bodies, blasts: b.blasts.reduce((n, x) => n + x.count, 0), grenades: grenadeEnergies(spec) };
}

/**
 * Over a cap by more than 1%: weapons are tuned to whole grenades within 1% (the sized grenades'
 * radii are written to three figures, so the XL is 16.003), and a cap is a round number.
 */
const over = (a: number, cap: number) => a > cap * 1.01;

/** Where `spec` goes over `tier`'s caps: one error (code tier) per number over, none when it fits. */
export function tierIssues(spec: MunitionSpec, tier: WeaponTier): WeaponIssue[] {
  const load = weaponLoad(spec), cap = WEAPON_TIER_CAPS[tier], out: WeaponIssue[] = [];
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  for (const k of ['bodies', 'blasts', 'grenades'] as const) {
    if (over(load[k], cap[k])) out.push({ code: 'tier', level: 'error', path: '', message: `${fmt(load[k])} ${k} a shot is over the ${tier} tier's cap of ${cap[k]}${needs(load) ? ` (it needs ${needs(load)})` : ' (over every tier)'}` });
  }
  return out;
}

/** The lowest tier `spec` fits, or null when it is over every tier. */
export function tierOf(spec: MunitionSpec): WeaponTier | null {
  return needs(weaponLoad(spec));
}

function needs(load: WeaponLoad): WeaponTier | null {
  return WEAPON_TIERS.find((t) => !(['bodies', 'blasts', 'grenades'] as const).some((k) => over(load[k], WEAPON_TIER_CAPS[t][k]))) ?? null;
}

/** Whether `spec` fits `tier`. */
export const fitsTier = (spec: MunitionSpec, tier: WeaponTier): boolean => tierIssues(spec, tier).length === 0;
