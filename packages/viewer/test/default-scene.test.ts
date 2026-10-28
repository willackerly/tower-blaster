// The default scene (default-scene.ts): what a bare viewer URL opens, filled
// into the address bar in full; ?defaults=factory opens the built-in setup; a
// URL with keys is left to mean what it says.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_SCENE, parseSceneFile, parseViewerConfig, startConfig, startSearch, toSearch } from '../src/index.ts';

const favourite = () => parseSceneFile(JSON.stringify(DEFAULT_SCENE)).config;

describe('the default scene', () => {
  it('is a valid scene file holding Will\'s favourite (favorites2.json)', () => {
    expect(favourite()).toMatchObject({
      scenario: 'S3', params: { W: 50, H: 20, running: false }, engine: 'avbd-gpu:iterations=20,restitution=true', bounce: 0.5,
      projectile: { shape: 'ball', size: 5, mass: 1, speed: 80 }, look: 'candy', loop: 'free', pipeline: true,
      camera: { target: [0, 8.95, 0], yaw: 0.628, pitch: 0.126, distance: 46.381 }, view: { pitch: 7, fit: 1.05, fov: 73 }, rules: 'sandbox',
    });
  });

  it('fills a bare URL in full, offscreen kept, and the filled URL is left as it is', () => {
    const s = startSearch('');
    expect(parseViewerConfig(s)).toEqual(favourite());
    expect(startSearch(s)).toBe(s);
    expect(parseViewerConfig(startSearch('?offscreen=1'))).toEqual({ ...favourite(), offscreen: true });
  });

  it('opens the built-in setup for defaults=factory, and leaves a URL with keys to mean what it says', () => {
    expect(parseViewerConfig(startSearch('?defaults=factory'))).toEqual(DEFAULT_CONFIG);
    expect(startSearch('?defaults=factory&offscreen=1')).toBe(toSearch({ ...DEFAULT_CONFIG, offscreen: true }));
    expect(startSearch('?scenario=S1&engine=rapier')).toBe('?scenario=S1&engine=rapier');
    expect(startSearch('?scenario=S1&defaults=factory')).toBe('?scenario=S1');
    expect(() => startSearch('?defaults=mine')).toThrow(/defaults must be factory/);
    expect(() => startSearch('?scenario=S1&defaults=mine')).toThrow(/defaults must be factory/);
  });

  it('takes another scene file, checked as strictly as a loaded one', () => {
    const other = { ...DEFAULT_SCENE, scene: { scenario: 'S1', params: { F: 2, H: 3 }, seed: 1, sleep: null, scale: 1, bounce: 0.5 }, camera: null };
    expect(startConfig(new URLSearchParams(''), other)).toMatchObject({ scenario: 'S1', params: { F: 2, H: 3 } });
    expect(() => startConfig(new URLSearchParams(''), { ...DEFAULT_SCENE, typo: 1 })).toThrow(/unknown key typo/);
  });
});
