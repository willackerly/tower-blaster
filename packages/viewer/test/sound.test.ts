import { describe, expect, it } from 'vitest';
import { DEFAULT_SOUND, SOUND_MATERIALS, tunedMaterial } from '@tb/audio';
import { TAG_BALL } from '@tb/engine-api';
import { autoSoundMaterial, parseSceneFile, parseViewerConfig, presetSearch, SCENE_FILE_FORMAT, sceneFile, soundGain, soundMaterial, soundMaterialName, soundRoom, soundAir, soundScrape, soundSlot, soundSpace, toSearch } from '../src/index.ts';

describe('viewer sound config', () => {
  it('is off by default and round-trips through the URL, presets and the config file', () => {
    expect(parseViewerConfig('').sound).toEqual(DEFAULT_SOUND);
    expect(toSearch(parseViewerConfig(''))).not.toContain('snd');
    const c = parseViewerConfig('?scenario=S15&snd=1&snd.mat=stone&snd.volume=-6&snd.damping=2');
    expect(c.sound).toEqual({ ...DEFAULT_SOUND, on: true, material: 'stone', volume: -6, damping: 2 });
    expect(parseViewerConfig(toSearch(c)).sound).toEqual(c.sound);
    // A preset's button keeps the sound as it is.
    expect(parseViewerConfig(presetSearch('?scenario=S3', c)).sound).toEqual(c.sound);
    const file = sceneFile(c, '', null);
    expect(file.sound).toEqual(c.sound);
    expect(parseSceneFile(JSON.stringify(file)).config.sound).toEqual(c.sound);
  });

  it('reads a file without sound as off, and refuses a bad one', () => {
    const base = { format: SCENE_FILE_FORMAT, version: 1, scene: { scenario: 'S1' }, engine: { name: 'rapier' } };
    expect(parseSceneFile(JSON.stringify(base)).config.sound).toEqual(DEFAULT_SOUND);
    expect(() => parseSceneFile(JSON.stringify({ ...base, sound: { on: true, loud: 1 } }))).toThrow(/sound: unknown key loud/);
    expect(() => parseSceneFile(JSON.stringify({ ...base, sound: { volume: 90 } }))).toThrow(/snd.volume/);
    expect(() => parseSceneFile(JSON.stringify({ ...base, sound: { material: 'glass' } }))).toThrow(/snd.mat/);
    expect(() => parseViewerConfig('?snd.pitch=x')).toThrow(/snd.pitch/);
  });

  it('auto picks pine for Kapla, the stone of the real look, acrylic otherwise', () => {
    const at = (search: string) => autoSoundMaterial(parseViewerConfig(search));
    expect(at('?scenario=S15')).toBe('pine');
    expect(at('?scenario=S15&look=real&real.stone=granite')).toBe('pine');
    expect(at('?scenario=S4')).toBe('acrylic');
    expect(at('?scenario=S4&look=real')).toBe('stone');
    expect(at('?scenario=S4&look=real&real.stone=pine')).toBe('pine');
    expect(at('?level=L2')).toBe('acrylic');
    const c = parseViewerConfig('?scenario=S4&snd=1&snd.mat=pine&snd.pitch=12');
    expect(soundMaterialName(c)).toBe('pine');
    expect(soundMaterial(c)).toEqual(tunedMaterial(SOUND_MATERIALS.pine, c.sound));
    expect(soundMaterial(c).E).toBeCloseTo(4 * SOUND_MATERIALS.pine.E, 0);
  });

  it("plays in the look's room (A5): the real look's hall at its size, else outdoor; snd.room overrides; classic is dry", () => {
    const at = (search: string) => soundRoom(parseViewerConfig(search));
    expect(at('?scenario=S4')).toEqual({ room: 'outdoor', size: 1 });
    expect(at('?scenario=S4&look=real')).toEqual({ room: 'outdoor', size: 1 });
    expect(at('?scenario=S4&look=real&real.env=hall')).toEqual({ room: 'hall', size: 1 });
    expect(at('?scenario=S4&look=real&real.env=hall&real.hallSize=0.5')).toEqual({ room: 'hall', size: 0.5 });
    expect(at('?scenario=S4&look=real&real.env=hall&snd.room=off')).toEqual({ room: 'off', size: 1 });
    expect(at('?scenario=S4&snd.room=hall')).toEqual({ room: 'hall', size: 1 });
    expect(at('?scenario=S4&look=real&real.env=hall&snd.set=classic')).toEqual({ room: 'off', size: 1 });
    const c = parseViewerConfig('?scenario=S4&snd=1&snd.room=hall');
    expect(parseSceneFile(JSON.stringify(sceneFile(c, '', null))).config.sound.room).toBe('hall');
  });

  it('space (A8a): on unless snd.space=0; never in the classic set; kept in the scene file', () => {
    const at = (search: string) => soundSpace(parseViewerConfig(search));
    expect([at('?scenario=S4'), at('?scenario=S4&snd.space=0'), at('?scenario=S4&snd.set=classic'), at('?scenario=S4&snd.set=real1')]).toEqual([true, false, false, true]);
    const c = parseViewerConfig('?scenario=S4&snd=1&snd.space=0');
    expect(parseSceneFile(JSON.stringify(sceneFile(c, '', null))).config.sound.space).toBe(false);
    expect(parseSceneFile(JSON.stringify(sceneFile(parseViewerConfig('?scenario=S4&snd=1'), '', null))).config.sound.space).toBe(true);
  });

  it('air (A8a step 3): on unless snd.air=0, and only with space; kept in the scene file', () => {
    const at = (search: string) => soundAir(parseViewerConfig(search));
    expect([at('?scenario=S4'), at('?scenario=S4&snd.air=0'), at('?scenario=S4&snd.space=0'), at('?scenario=S4&snd.set=classic')]).toEqual([true, false, false, false]);
    expect(parseSceneFile(JSON.stringify(sceneFile(parseViewerConfig('?scenario=S4&snd=1&snd.air=0'), '', null))).config.sound.air).toBe(false);
    expect(parseSceneFile(JSON.stringify(sceneFile(parseViewerConfig('?scenario=S4&snd=1'), '', null))).config.sound.air).toBe(true);
  });

  it('scrape (A8b): off unless snd.scrape=1; never in the classic set; kept in the scene file', () => {
    const at = (search: string) => soundScrape(parseViewerConfig(search));
    expect([at('?scenario=S4'), at('?scenario=S4&snd.scrape=1'), at('?scenario=S4&snd.scrape=1&snd.set=classic'), at('?scenario=S4&snd.scrape=1&snd.space=0')]).toEqual([false, true, false, true]);
    expect(parseSceneFile(JSON.stringify(sceneFile(parseViewerConfig('?scenario=S4&snd=1&snd.scrape=1'), '', null))).config.sound.scrape).toBe(true);
    expect(parseSceneFile(JSON.stringify(sceneFile(parseViewerConfig('?scenario=S4&snd=1'), '', null))).config.sound.scrape).toBe(false);
  });

  it('balls are silent, blocks sound; volume is dB', () => {
    expect(soundSlot({ tag: TAG_BALL } as never)).toBe(-1);
    expect(soundSlot({ tag: 3 } as never)).toBe(0);
    expect(soundGain(parseViewerConfig('?snd.volume=-20'))).toBeCloseTo(0.1, 12);
    expect(soundGain(parseViewerConfig(''))).toBe(1);
  });
});
