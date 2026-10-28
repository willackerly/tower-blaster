// The setup a bare viewer URL opens (no keys but offscreen): Will's saved
// favourite (the panel's Configuration > Download, favorites2.json, 2026-10-28),
// committed as the default so anyone opening the viewer starts there. It is a
// scene file like any other, read through parseSceneFile, so it is checked as
// strictly as a loaded one (scene-file.ts). ?defaults=factory opens the
// built-in defaults (DEFAULT_CONFIG) instead; any URL with keys means exactly
// what it says, whatever this file holds, so a shared link never changes with it.
import { DEFAULT_CONFIG, toSearch, type ViewerConfig } from './params.ts';
import { parseSceneFile } from './scene-file.ts';

/** As saved (a later file format version's knobs, absent here, take their defaults). */
export const DEFAULT_SCENE: object = {
  "format": "tower-blaster/viewer-scene",
  "version": 1,
  "name": "favorites2",
  "savedAt": "2026-10-28T05:10:45.855Z",
  "scene": {
    "scenario": "S3",
    "params": {
      "W": 50,
      "H": 20,
      "running": false
    },
    "seed": 1,
    "sleep": null,
    "scale": 1,
    "bounce": 0.5
  },
  "engine": {
    "name": "avbd-gpu",
    "options": {
      "iterations": 20,
      "restitution": true
    }
  },
  "loop": {
    "mode": "free",
    "pipeline": true,
    "maxSteps": 1,
    "substeps": 1,
    "presettle": 0
  },
  "projectile": {
    "shape": "ball",
    "size": 5,
    "mass": 1,
    "speed": 80
  },
  "autofire": 0,
  "look": {
    "preset": "candy",
    "real": {
      "sunElevation": 35,
      "sunAzimuth": 140,
      "visibility": 40,
      "sunStrength": 1,
      "groundAlbedo": [
        0.2,
        0.19,
        0.17
      ],
      "exposure": 1.1,
      "autoExposure": 0.75,
      "stone": "limestone",
      "stoneDetail": 1,
      "stoneScale": 1,
      "stoneFade": 8,
      "wear": 0.5,
      "dirt": 0.4,
      "groundMaterial": "gravel",
      "groundDetail": 1,
      "groundScale": 1,
      "groundVariation": 0.5,
      "groundRelief": 1,
      "groundPatches": 0.05,
      "hills": 1.5,
      "hillDistance": 6,
      "sunSize": 0.53,
      "shadowSoftness": 1,
      "shadowFill": 0.5,
      "dust": 1,
      "chips": 1,
      "dustSize": 0.9,
      "dustOpacity": 0.4,
      "dustThreshold": 2,
      "dustFace": 0.15,
      "env": "outdoor",
      "hallSize": 1,
      "hallGlass": 0.5,
      "hallIron": 0.55
    }
  },
  "camera": {
    "target": [
      0,
      8.95,
      0
    ],
    "yaw": 0.628,
    "pitch": 0.126,
    "distance": 46.381
  },
  "view": {
    "pitch": 7,
    "fit": 1.05,
    "fov": 73
  }
};

/** Keys that don't choose a setup: a URL with only these is bare. */
const NOT_SETUP = ['offscreen', 'defaults'];

/** The config a bare URL opens: the default scene's, or the built-in one for ?defaults=factory. */
export function startConfig(q: URLSearchParams, scene: object = DEFAULT_SCENE): ViewerConfig {
  const d = q.get('defaults');
  if (d !== null && d !== 'factory') throw new Error(`defaults must be factory (the built-in setup): ${d}`);
  const base = d === 'factory' ? DEFAULT_CONFIG : parseSceneFile(JSON.stringify(scene)).config;
  return { ...base, offscreen: q.get('offscreen') === '1' };
}

/**
 * The search the page runs: a bare one filled in with startConfig, written out in full so the
 * address bar shows (and a reload or a shared link keeps) what runs; any other as given, less
 * its defaults key.
 */
export function startSearch(search: string, scene: object = DEFAULT_SCENE): string {
  const q = new URLSearchParams(search);
  if ([...q.keys()].every((k) => NOT_SETUP.includes(k))) return toSearch(startConfig(q, scene));
  if (!q.has('defaults')) return search;
  startConfig(q, scene); // the value is checked even where it changes nothing
  q.delete('defaults');
  return `?${q}`;
}
