// The game's collision sound, offline: which sound each body gets, and the L1 par line's
// collapse rendered through it (on Rapier, which clears L1 too) at the game's level.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { CEILING, parseSoundMaterial } from '@tb/audio';
import { AMMO_KINDS, ammoBody, compileLevel, grenadeShell, KEYSTONE_GRENADE, L1, MATERIALS } from '@tb/keystone';
import { PRESET_NAMES } from '@tb/weapons';
import { capture, render } from '../src/sound-cli.ts';
import { AMMO_SLOT, ammoKindOf, GAME_SOUND_DB, KEYSTONE_SOUNDS, slotSounds, SOUND_SLOTS, soundSlotOf } from '../src/sound-map.ts';

describe('game sound slots', () => {
  it('every Keystone material and ammo kind has a valid sound at its own size', () => {
    const c = compileLevel(L1), slots = slotSounds(c), h = c.frame.unit;
    expect(slots).toHaveLength(SOUND_SLOTS);
    for (const m of MATERIALS) expect(slots[MATERIALS.indexOf(m)]).toEqual({ material: KEYSTONE_SOUNDS[m.name], edge: h });
    for (const s of slots) expect(() => parseSoundMaterial(s.material)).not.toThrow();
    const ammo = (k: (typeof AMMO_KINDS)[number]) => slots[AMMO_SLOT + AMMO_KINDS.indexOf(k)]!;
    expect(ammo('marble').edge).toBeCloseTo(0.4 * h, 12);
    expect(ammo('cannonball').edge).toBeCloseTo(h, 12);
    expect(ammo('drop').edge).toBeCloseTo(0.8 * h, 12);
    // The cue is a steel bar: the plank model, its own length and section.
    expect(ammo('cue').material.model).toBe('plank');
    expect(ammo('cue').material.dims!.map((x) => x / h)).toEqual([2.4, 0.2, 0.2].map((x) => expect.closeTo(x, 9)));
  });

  it('knows each ammo kind from its body, at any cube size and either cue direction; real-world projectiles are silent for now', () => {
    for (const h of [0.5, 1, 0.25]) for (const k of AMMO_KINDS) for (const alongZ of [false, true]) expect(ammoKindOf(ammoBody(k, h, [0, 0, 0], [0, 0, 0], alongZ), h)).toBe(k);
    // A GrenadeSpec flies in the iron grenade shell, marble-sized, and sounds as a marble.
    const g = compileLevel({ ...L1, rack: ['w-g'], weapons: { g: KEYSTONE_GRENADE } });
    expect(g.frame.shells!['w-g']).toEqual(grenadeShell(0.5));
    expect(ammoKindOf(ammoBody('w-g', g.frame, [0, 0, 0], [0, 0, 0]), 0.5)).toBe('marble');
    // The default w-grenade (w-grenadem) has a WeaponSpec shell, scaled to the blocks as B1-B3's bomb and the
    // firework are: silent like theirs.
    const m = compileLevel({ ...L1, rack: ['w-grenade'] });
    expect(soundSlotOf(m, ammoBody('w-grenade', m.frame, [0, 0, 0], [0, 0, 0]), m.meta.n)).toBe(-1);
    const c = compileLevel(L1);
    for (const p of PRESET_NAMES) expect(soundSlotOf(c, ammoBody(`p-${p}`, c.frame.unit, [0, 0, 0], [0, 0, 0]), c.meta.n)).toBe(-1);
  });

  it('structure bodies sound as their material, spawned ones as their ammo', () => {
    const c = compileLevel(L1);
    for (let i = 0; i < c.meta.n; i++) expect(soundSlotOf(c, c.scene.bodies[i]!, i)).toBe(c.meta.material[i]);
    expect(soundSlotOf(c, ammoBody('cannonball', c.frame.unit, [0, 0, 0], [0, 0, 0]), c.meta.n)).toBe(AMMO_SLOT + AMMO_KINDS.indexOf('cannonball'));
  });
});

describe('L1 par line, heard from the game camera', () => {
  it('sounds its blocks and its shot, under the limiter without limiting at the game level', { timeout: 120_000 }, async () => {
    const { frames, slots } = await capture('L1', new RapierEngine());
    expect(slots[MATERIALS.findIndex((m) => m.name === 'plaster')]).toBeGreaterThan(50);
    expect(slots[AMMO_SLOT + AMMO_KINDS.indexOf('cannonball')]).toBeGreaterThan(0);
    const { L, R, minGain } = render('L1', frames, GAME_SOUND_DB);
    let peak = 0, finite = true;
    for (let i = 0; i < L.length; i++) { finite &&= Number.isFinite(L[i]!) && Number.isFinite(R[i]!); peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!)); }
    expect(finite).toBe(true);
    expect(peak).toBeGreaterThan(0.1); // audible
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(20 * Math.log10(minGain)).toBeGreaterThan(-3); // at most a touch of limiting
    // 20 dB louder (the viewer's level) is far into the limiter: why the game sits at GAME_SOUND_DB.
    expect(render('L1', frames, GAME_SOUND_DB + 20).minGain).toBeLessThan(0.5);
  });
});
