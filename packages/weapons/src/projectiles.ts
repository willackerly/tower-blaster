// A catalogue of things to throw, at their real size, density and bounce, so
// what a shot does to a tower matches intuition: a beach ball bounces off
// stone, a wrecking ball goes through it, the Raiders boulder flattens it.
//
// Values are real-world (SI): diameter in m, density in kg/m^3, a launch speed
// in m/s that suits the object (capped well under the broadphase sweep limit,
// so a cannonball is slow for a cannon). A scene's bodies carry their own
// density units, so a page converts with the real density its blocks stand for
// (scene density 1 = blockDensity kg/m^3): the mass ratio to a block is what
// physics sees. Colours: `colour` is the material's (sRGB), `candy` the candy
// look's skin of it.
//
// Sources for the reals (round figures): beach ball 50 cm / 250 g; FIBA size-7
// basketball 24 cm / 620 g; 16 lb bowling ball 21.8 cm / 7.26 kg; 24-pounder
// iron shot 14 cm, cast iron 7200 kg/m^3; a 3 t (6,600 lb) steel wrecking
// ball, 7850 kg/m^3, is 0.9 m across; the Raiders of the Lost Ark boulder is
// said to be 22 ft (6.7 m) across, here in granite (2700 kg/m^3; the prop was
// fibreglass).

export interface ProjectilePreset {
  label: string;
  /** m. */
  diameter: number;
  /** kg/m^3. */
  density: number;
  restitution: number;
  friction: number;
  /** A launch speed that suits it, m/s. */
  speed: number;
  /** sRGB, 0xrrggbb. */
  colour: number;
  /** The candy look's skin, sRGB 0xrrggbb. */
  candy: number;
}

export const PROJECTILE_PRESETS = {
  beachball: { label: 'beach ball', diameter: 0.5, density: 3.8, restitution: 0.75, friction: 0.6, speed: 15, colour: 0xe8473b, candy: 0xff6fb5 },
  basketball: { label: 'basketball', diameter: 0.24, density: 86, restitution: 0.75, friction: 0.7, speed: 15, colour: 0xd9692a, candy: 0xff9a3c },
  bowlingball: { label: 'bowling ball', diameter: 0.218, density: 1340, restitution: 0.2, friction: 0.3, speed: 12, colour: 0x2f4fb0, candy: 0x7b8bff },
  cannonball: { label: 'cannonball', diameter: 0.14, density: 7200, restitution: 0.1, friction: 0.4, speed: 45, colour: 0x3a3a3c, candy: 0xffd23c },
  wreckingball: { label: 'wrecking ball', diameter: 0.9, density: 7850, restitution: 0.1, friction: 0.4, speed: 15, colour: 0x5a6068, candy: 0xc0c8ff },
  boulder: { label: 'boulder (Raiders)', diameter: 6.7, density: 2700, restitution: 0.05, friction: 0.8, speed: 8, colour: 0x9a8a74, candy: 0xb38bff },
} as const satisfies Record<string, ProjectilePreset>;

export type PresetName = keyof typeof PROJECTILE_PRESETS;
export const PRESET_NAMES = Object.keys(PROJECTILE_PRESETS) as PresetName[];
export const isPreset = (name: string): name is PresetName => Object.hasOwn(PROJECTILE_PRESETS, name);

/** Real density of solid stone or concrete, kg/m^3: what a scene block of density 1 stands for unless a scene says otherwise. */
export const STONE_DENSITY = 2400;

/** A preset's real mass, kg. */
export function presetMass(p: ProjectilePreset): number {
  return (p.density * Math.PI * p.diameter ** 3) / 6;
}
