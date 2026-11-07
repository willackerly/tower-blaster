// The game's collision sound, offline: which sound each body gets, and the L1 par line's
// collapse rendered through it (on Rapier, which clears L1 too) at the game's level.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type AudioFrame, BLOCK, binOf, CEILING, cellOf, CollapseEngine, contactTime, DV_EDGES, loudness, mass, parseSoundMaterial, pitchZ, ROUGH_T, type SoundMaterial, soundMaterials, TOP_FIELDS } from '@tb/audio';
import { AMMO_KINDS, ammoBody, catalog, compileLevel, DOMINO_HALF, grenadeShell, iceOf, KEYSTONE_GRENADE, L1, levelById, LEVELS, masonProbes, materialId, MATERIALS, shatterPieces } from '@tb/keystone';
import { PRESET_NAMES, presetMass, PROJECTILE_PRESETS } from '@tb/weapons';
import { capture, render } from '../src/sound-cli.ts';
import { CollapseSound } from '../src/collapse-sound.ts';
import { kaplaSoundOf } from '../src/options/kaplasound.ts';
import { roomSoundOf } from '../src/options/room.ts';
import { paceFeel } from '../src/pacing.ts';
import { AMMO_SLOT, isKaplaPlank, KAPLA_DIMS, KAPLA_SLOT, kaplaLevelDb, kaplaSound, PIECE_SLOT, PRESET_SLOT, presetOf, presetSound, ammoKindOf, ammoOn, mainMaterial, pairEc, GAME_SOUND_DB, gameSoundDb, KEYSTONE_SOUNDS, keystoneSounds, slotSounds, SOUND_SLOTS, soundSetOf, soundSlotOf } from '../src/sound-map.ts';

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

  it('knows each ammo kind from its body, at any cube size and either cue direction', () => {
    for (const h of [0.5, 1, 0.25]) for (const k of AMMO_KINDS) for (const alongZ of [false, true]) expect(ammoKindOf(ammoBody(k, h, [0, 0, 0], [0, 0, 0], alongZ), h)).toBe(k);
    // A GrenadeSpec flies in the iron grenade shell, marble-sized, and sounds as a marble.
    const g = compileLevel({ ...L1, rack: ['w-g'], weapons: { g: KEYSTONE_GRENADE } });
    expect(g.frame.shells!['w-g']).toEqual(grenadeShell(0.5));
    expect(ammoKindOf(ammoBody('w-g', g.frame, [0, 0, 0], [0, 0, 0]), 0.5)).toBe('marble');
  });

  it('a weapon\'s shell (its density scaled to the blocks: B1-B3\'s bomb, the firework, w-grenade) sounds as the steel ammo of its shape', () => {
    const onL1 = (item: `w-${string}`) => compileLevel({ ...L1, rack: [item] });
    for (const [item, m, kind] of [['w-grenade', onL1('w-grenade'), 'marble'], ['w-firework', onL1('w-firework'), 'cannonball'], ['w-bomb', compileLevel(levelById('B1')), 'cannonball'], ['w-ram', compileLevel(levelById('B2')), 'cannonball']] as const) {
      const b = ammoBody(item, m.frame, [0, 0, 0], [0, 0, 0]);
      expect(ammoKindOf(b, m.frame.unit), item).toBeNull(); // not Keystone's own ammo
      expect(soundSlotOf(m, b, m.meta.n), item).toBe(AMMO_SLOT + AMMO_KINDS.indexOf(kind));
    }
  });

  it('a Mason\'s Trial probe sounds as its material', () => {
    const c = compileLevel(levelById('MT1')), probes = masonProbes(c, 0);
    expect(probes.length).toBeGreaterThan(0);
    for (const e of probes) expect(soundSlotOf(c, e.body, c.meta.n + 5)).toBe(materialId('stone'));
  });

  it('each rack preset sounds as itself, at its real size, its mass near the real one', () => {
    const c = compileLevel(L1), slots = slotSounds(c), classic = slotSounds(c, 'classic');
    expect(KAPLA_SLOT).toBe(PRESET_SLOT + PRESET_NAMES.length);
    expect(SOUND_SLOTS).toBe(KAPLA_SLOT + 1);
    PRESET_NAMES.forEach((p, k) => {
      const b = ammoBody(`p-${p}`, c.frame.unit, [0, 0, 0], [0, 0, 0]), slot = slots[PRESET_SLOT + k]!;
      expect(presetOf(b)).toBe(p);
      expect(soundSlotOf(c, b, c.meta.n)).toBe(PRESET_SLOT + k);
      expect(slot.edge).toBe(PROJECTILE_PRESETS[p].diameter);
      expect(() => parseSoundMaterial(slot.material), p).not.toThrow();
      expect(() => parseSoundMaterial(classic[PRESET_SLOT + k]!.material), p).not.toThrow();
      // Within the cube's 6/pi of a sphere (a body model is a cube of the diameter) and the shells' walls.
      const ratio = mass(slot.material, slot.edge) / presetMass(PROJECTILE_PRESETS[p]);
      expect(ratio, p).toBeGreaterThan(0.9);
      expect(ratio, p).toBeLessThan(2.5);
    });
    // The hard ones take the pair's contact with the level's main material, as the ammo does; the balls their own.
    expect(slots[PRESET_SLOT + PRESET_NAMES.indexOf('wreckingball')]!.material.Ec).toBeCloseTo(ammoOn(presetSound('wreckingball'), KEYSTONE_SOUNDS.plaster).Ec!, -3);
    expect(slots[PRESET_SLOT + PRESET_NAMES.indexOf('beachball')]!.material).toEqual(presetSound('beachball'));
    // Not a preset: a sphere of a preset's size at another density, or a box.
    expect(presetOf({ ...ammoBody('p-beachball', c.frame.unit, [0, 0, 0], [0, 0, 0]), density: 7800 })).toBeNull();
    expect(presetOf(ammoBody('drop', c.frame.unit, [0, 0, 0], [0, 0, 0]))).toBeNull();
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
    expect(PIECE_SLOT).toBe(PRESET_SLOT - 1);
    expect(slot).toEqual({ material: KEYSTONE_SOUNDS.ice, edge: h / 2 });
    const block = compileLevel(levelById('T-I1')).scene.bodies[0]!; // an ice block, as a level stands it
    const pieces = shatterPieces(block, block.pos, block.rot, [0, 0, 0], [0, 0, 0], 6, iceOf(undefined), 0);
    expect(pieces).toHaveLength(8);
    for (const e of pieces) expect(soundSlotOf(c, e.body, c.meta.n + 1)).toBe(PIECE_SLOT);
    expect(soundSlotOf(c, block, c.meta.n + 1)).toBe(materialId('ice')); // a whole ice block spawned later is ice, not a piece
  });

  it('structure bodies sound as their material, spawned ones as their ammo', () => {
    const c = compileLevel(L1);
    for (let i = 0; i < c.meta.n; i++) expect(soundSlotOf(c, c.scene.bodies[i]!, i)).toBe(c.meta.material[i]);
    expect(soundSlotOf(c, ammoBody('cannonball', c.frame.unit, [0, 0, 0], [0, 0, 0]), c.meta.n)).toBe(AMMO_SLOT + AMMO_KINDS.indexOf('cannonball'));
  });
});

describe('Kapla planks (A9)', () => {
  const box = (half: [number, number, number]) => ({ ...ammoBody('drop', 0.5, [0, 0, 0], [0, 0, 0]), shape: { kind: 'box' as const, half } });

  it('a plaster box in a Kapla plank\'s proportions (15:3:1) is one: every plank of B5\'s towers, and the build tool\'s Plank', () => {
    const c = compileLevel(levelById('T-B5A')), plaster = materialId('plaster');
    expect(c.meta.n).toBe(2884);
    for (let i = 0; i < c.meta.n; i++) {
      expect(isKaplaPlank(c.scene.bodies[i]!), `plank ${i}`).toBe(true);
      expect(soundSlotOf(c, c.scene.bodies[i]!, i)).toBe(KAPLA_SLOT);
      expect(soundSlotOf(c, c.scene.bodies[i]!, i, false)).toBe(plaster); // keystone.kaplasound=plaster, and the classic set
    }
    const items = Object.fromEntries(catalog(1.02).map((x) => [x.name, x.boxes[0]!.half]));
    expect(isKaplaPlank(box(items.plank!))).toBe(true);
    for (const k of ['cube', 'domino', 'slab', 'beam', 'ramp', 'bumper', 'relay']) expect(isKaplaPlank(box(items[k]!)), k).toBe(false);
    expect(isKaplaPlank(box([...DOMINO_HALF]))).toBe(false);
    expect(isKaplaPlank(box([2.5 * 1.03, 1 / 6, 0.5]))).toBe(false); // 3% long: not Kapla's 15:3:1
    expect(isKaplaPlank({ ...box([0.5, 0.5, 0.5]), shape: { kind: 'sphere', radius: 0.5 } })).toBe(false);
    // Other levels' structure is untouched: L1's cubes, X3B's bricks, X1's dominoes.
    for (const id of ['L1', 'T-X3B', 'T-X1']) {
      const l = compileLevel(levelById(id));
      for (let i = 0; i < l.meta.n; i++) expect(soundSlotOf(l, l.scene.bodies[i]!, i), id).toBe(l.meta.material[i]);
    }
    // keystone.kaplasound reads pine or plaster; the classic set never plays Kapla (G6's sound).
    expect(kaplaSoundOf('pine')).toBe('pine');
    expect(kaplaSoundOf('plaster')).toBe('plaster');
    expect(() => kaplaSoundOf('oak')).toThrow(/keystone.kaplasound must be pine or plaster: oak/);
    const on = (set: 'real' | 'real1' | 'classic', kapla: boolean) => (new CollapseSound(0, set, kapla) as unknown as { kapla: boolean }).kapla;
    expect([on('real', true), on('real1', true), on('classic', true), on('real', false)]).toEqual([true, true, false, false]);
    // keystone.room (A5): outdoor by default, hall or off; the classic set always plays dry.
    expect(['outdoor', 'hall', 'off'].map(roomSoundOf)).toEqual(['outdoor', 'hall', 'off']);
    expect(() => roomSoundOf('cave')).toThrow(/keystone.room must be off, outdoor, hall: cave/);
    expect(new CollapseSound().room).toBe('outdoor');
    expect(new CollapseSound(0, 'real', true, 'hall').room).toBe('hall');
    expect(new CollapseSound(0, 'classic', true, 'hall').room).toBe('off');
    // keystone.space (A8a): on by default, off by keystone.space=0; never in the classic set.
    expect([new CollapseSound().space, new CollapseSound(0, 'real', true, 'outdoor', false).space, new CollapseSound(0, 'classic', true, 'outdoor', true).space]).toEqual([true, false, false]);
    expect(paceFeel(new URLSearchParams('keystone.space=0')).space).toBe(false);
    // A stone box in Kapla's proportions stays stone.
    const stone = { ...c, meta: { ...c.meta, material: c.meta.material.map(() => materialId('stone')) } };
    expect(soundSlotOf(stone, c.scene.bodies[0]!, 0)).toBe(materialId('stone'));
  });

  it('the slot is the set\'s pine at a real plank\'s size, as loud as the plank on screen: +30 log10(5 h / 117 mm)', () => {
    const c = compileLevel(levelById('T-B5A')), h = c.frame.unit;
    expect(h).toBe(0.3);
    expect(KAPLA_DIMS).toEqual([0.117, 0.0234, 0.0078]);
    expect(kaplaLevelDb(KAPLA_DIMS[0])).toBe(0);
    expect(kaplaLevelDb(1.5)).toBeCloseTo(33.24, 2);
    for (const set of ['real', 'real1', 'classic'] as const) {
      const s = kaplaSound(c, set);
      expect(slotSounds(c, set)[KAPLA_SLOT]).toEqual(s);
      expect(s).toEqual({ material: { ...soundMaterials(set).pine, levelDb: kaplaLevelDb(5 * h) }, edge: KAPLA_DIMS[0] });
      expect(() => parseSoundMaterial(s.material)).not.toThrow();
    }
    // Under the energy law the trim is the mass's: a real plank scaled up to 5 h radiates as the trim says, within 1 dB.
    const pine = soundMaterials('real').pine, scaled = mass({ ...pine, dims: KAPLA_DIMS.map((x) => (x * 5 * h) / KAPLA_DIMS[0]) as [number, number, number] }) / mass(pine);
    expect(10 * Math.log10(scaled)).toBeCloseTo(kaplaLevelDb(5 * h), 6);
  });

  it('B5\'s planks sound within 3 dB of the plaster blocks they replace (a 2 s pile of impacts, 10 m off)', () => {
    // Impacts as a tap posts them: 12 a frame, speeds exponential (mean 1.5 m/s), all on slot 0, 10 m away.
    let a = 7;
    const r = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 2 ** 32; };
    const frames: AudioFrame[] = [];
    for (let f = 0; f < 120; f++) {
      const counts = new Float32Array(DV_EDGES.length * 4), a2 = new Float32Array(DV_EDGES.length * 4), hits: number[][] = [];
      for (let k = 0; k < 12; k++) { const dv = 0.3 - 1.5 * Math.log(1 - 0.95 * r()), A = dv / 10, cell = cellOf(0, binOf(dv), k % 4, 4); counts[cell]! += 1; a2[cell]! += A * A; hits.push([A, dv, 10, (k % 4) / 2 - 0.75, 0, pitchZ(f * 12 + k)]); }
      hits.sort((p, q) => q[0]! - p[0]!);
      const top = new Float32Array(8 * TOP_FIELDS);
      hits.slice(0, 8).forEach((x, j) => top.set(x.slice(1), j * TOP_FIELDS));
      frames.push({ dt: 1 / 60, materials: 1, sectors: 4, counts, a2, top });
    }
    const lufs = (m: SoundMaterial, edge: number) => {
      const e = new CollapseEngine({ sampleRate: 48000, seed: 1, fullScale: 1 }), n = 180 * 800 / BLOCK, L = new Float32Array(n * BLOCK), R = new Float32Array(n * BLOCK);
      e.setMaterial(0, m, edge); e.limiter.process = () => {};
      const l = new Float32Array(BLOCK), rr = new Float32Array(BLOCK);
      let due = 0, b = 0;
      const out = () => { e.render(l, rr); L.set(l, b * BLOCK); R.set(rr, b * BLOCK); b++; };
      for (const fr of frames) { e.push(fr); for (due += 800; due >= BLOCK && b < n; due -= BLOCK) out(); }
      while (b < n) out();
      return loudness(L, R);
    };
    const c = compileLevel(levelById('T-B5A')), slots = slotSounds(c);
    const kapla = lufs(slots[KAPLA_SLOT]!.material, slots[KAPLA_SLOT]!.edge), plaster = lufs(slots[materialId('plaster')]!.material, c.frame.unit);
    expect(Number.isFinite(kapla)).toBe(true);
    expect(Math.abs(kapla - plaster)).toBeLessThan(3);
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
