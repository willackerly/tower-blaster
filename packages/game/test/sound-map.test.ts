// The game's collision sound, offline: which sound each body gets, and the L1 par line's
// collapse rendered through it (on Rapier, which clears L1 too) at the game's level.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { CEILING, loudness, parseSoundMaterial } from '@tb/audio';
import { AMMO_KINDS, ammoBody, compileLevel, grenadeShell, KEYSTONE_GRENADE, L1, MATERIALS } from '@tb/keystone';
import { PRESET_NAMES } from '@tb/weapons';
import { capture, render } from '../src/sound-cli.ts';
import { AMMO_SLOT, ammoKindOf, GAME_SOUND_DB, gameSoundDb, KEYSTONE_SOUNDS, keystoneSounds, slotSounds, SOUND_SLOTS, soundSetOf, soundSlotOf } from '../src/sound-map.ts';

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

  it('keystone.sound=classic plays G6\'s materials, collapse the real set; the cue keeps its bar in both', () => {
    const c = compileLevel(L1);
    expect(soundSetOf('classic')).toBe('classic');
    expect(soundSetOf('collapse')).toBe('real');
    expect(slotSounds(c, 'classic')[0]!.material).toBe(keystoneSounds('classic').plaster);
    expect(slotSounds(c, 'classic')[0]!.material.roughDb).toBeUndefined();
    expect(slotSounds(c)[0]!.material.roughDb).toBeGreaterThan(-Infinity);
    expect(slotSounds(c, 'classic')[AMMO_SLOT + AMMO_KINDS.indexOf('cue')]!.material.model).toBe('plank');
    expect(gameSoundDb('classic')).toBe(GAME_SOUND_DB);
  });

  it('structure bodies sound as their material, spawned ones as their ammo', () => {
    const c = compileLevel(L1);
    for (let i = 0; i < c.meta.n; i++) expect(soundSlotOf(c, c.scene.bodies[i]!, i)).toBe(c.meta.material[i]);
    expect(soundSlotOf(c, ammoBody('cannonball', c.frame.unit, [0, 0, 0], [0, 0, 0]), c.meta.n)).toBe(AMMO_SLOT + AMMO_KINDS.indexOf('cannonball'));
  });
});

describe('L1 par line, heard from the game camera', () => {
  it('sounds its blocks and its shot, under the limiter without limiting at the game level, as loud in either set', { timeout: 120_000 }, async () => {
    const { frames, slots } = await capture('L1', new RapierEngine());
    expect(slots[MATERIALS.findIndex((m) => m.name === 'plaster')]).toBeGreaterThan(50);
    expect(slots[AMMO_SLOT + AMMO_KINDS.indexOf('cannonball')]).toBeGreaterThan(0);
    const lufs: number[] = [];
    for (const set of ['classic', 'real'] as const) {
      const { L, R, minGain } = render('L1', frames, gameSoundDb(set), set);
      let peak = 0, finite = true;
      for (let i = 0; i < L.length; i++) { finite &&= Number.isFinite(L[i]!) && Number.isFinite(R[i]!); peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!)); }
      expect(finite).toBe(true);
      expect(peak).toBeGreaterThan(0.1); // audible
      expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
      expect(20 * Math.log10(minGain)).toBeGreaterThan(-3); // at most a touch of limiting
      lufs.push(loudness(L, R));
      // 20 dB louder (the viewer's level) is far into the limiter: why the game sits at its level.
      expect(render('L1', frames, gameSoundDb(set) + 20, set).minGain).toBeLessThan(0.5);
    }
    // The sets are levelled by loudness (BS.1770) on the AVBD par lines the page plays (within 1.7 LU a
    // level, sound-cli.ts). On Rapier the classic set rings longer (more repeat contacts: sustained tones
    // read loud) while the real set is transient and peak-bound, so here the gap is wider: within 5 LU.
    expect(Math.abs(lufs[0]! - lufs[1]!)).toBeLessThan(5);
  });
});
