// The game's collision sound, offline: which sound each body gets, and the L1 par line's
// collapse rendered through it (on Rapier, which clears L1 too) at the game's level.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { CEILING, contactTime, loudness, parseSoundMaterial, ROUGH_T } from '@tb/audio';
import { AMMO_KINDS, ammoBody, compileLevel, grenadeShell, iceOf, KEYSTONE_GRENADE, L1, levelById, LEVELS, MATERIALS, shatterPieces } from '@tb/keystone';
import { PRESET_NAMES } from '@tb/weapons';
import { capture, render } from '../src/sound-cli.ts';
import { AMMO_SLOT, PIECE_SLOT, ammoKindOf, ammoOn, mainMaterial, pairEc, GAME_SOUND_DB, gameSoundDb, KEYSTONE_SOUNDS, keystoneSounds, slotSounds, SOUND_SLOTS, soundSetOf, soundSlotOf } from '../src/sound-map.ts';

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

  it('the ammo plays the pair\'s contact with the level\'s main material: Hertz E*, and asperities as long as the pair\'s', () => {
    const s = keystoneSounds('real'), steel = s.steel, plaster = s.plaster;
    expect(pairEc(steel, steel)).toBeCloseTo(steel.E, -3); // equals: its own
    // The pair's contact time is the Hertz one for 1/E* = (1-nu1^2)/E1 + (1-nu2^2)/E2.
    const star = 1 / ((1 - steel.nu ** 2) / steel.E + (1 - plaster.nu ** 2) / plaster.E), on = ammoOn(steel, plaster);
    expect(on.Ec! / (2 * (1 - steel.nu ** 2))).toBeCloseTo(star, -3);
    expect(contactTime(on, 3, 0.5) / contactTime(steel, 3, 0.5)).toBeCloseTo((steel.E / (2 * (1 - steel.nu ** 2)) / star) ** 0.4, 6);
    // Asperities on plaster last ~5x steel's, so roughness stops near 1.4 kHz, under a steel ball's modes.
    expect(ammoOn(steel, steel).roughT).toBeCloseTo(ROUGH_T, 12);
    expect(on.roughT! / ROUGH_T).toBeGreaterThan(4);
    expect(1 / on.roughT!).toBeLessThan(1500);
    for (const l of LEVELS.filter((x) => /^L[1-5]$/.test(x.id))) {
      const c = compileLevel(l), real = slotSounds(c), classic = slotSounds(c, 'classic');
      expect(mainMaterial(c)).toBe('plaster');
      for (let k = AMMO_SLOT; k < PIECE_SLOT; k++) {
        expect(real[k]!.material.Ec).toBeCloseTo(on.Ec!, -3);
        expect(classic[k]!.material.Ec).toBeUndefined(); // G6's steel on steel
        expect(() => parseSoundMaterial(real[k]!.material)).not.toThrow();
      }
    }
  });

  it('a shattered ice block\'s pieces sound as ice at half the edge (an octave up, an eighth of the energy), not as whole blocks', () => {
    const c = compileLevel(L1), h = c.frame.unit, slot = slotSounds(c)[PIECE_SLOT]!;
    expect(PIECE_SLOT).toBe(SOUND_SLOTS - 1);
    expect(slot).toEqual({ material: KEYSTONE_SOUNDS.ice, edge: h / 2 });
    const block = compileLevel(levelById('T-I1')).scene.bodies[0]!; // an ice block, as a level stands it
    const pieces = shatterPieces(block, block.pos, block.rot, [0, 0, 0], [0, 0, 0], 6, iceOf(undefined), 0);
    expect(pieces).toHaveLength(8);
    for (const e of pieces) expect(soundSlotOf(c, e.body, c.meta.n + 1)).toBe(PIECE_SLOT);
    expect(soundSlotOf(c, block, c.meta.n + 1)).toBe(-1); // a body at ice's own density spawned later is not a piece
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
