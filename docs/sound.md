# Collision sound

Design and plan for collapse audio at 10k-100k bodies. The study behind it is
the "Collapse Sound Study" report (https://claude.ai/artifact/J2iKMLsRsAtL4ADWa8izyu)
with renders, metrics and scripts in /mnt/project-files/sound/.

## Architecture (recommended, pending Will's choice)

- **Foreground:** the K loudest impacts per frame (K = 8) play as individual
  modal voices with their own speed, contact time and pan.
- **Background:** one shared resonator per (material, pitch class, mode,
  direction sector), driven by an impulse train rebuilt from a per-frame
  histogram (material x speed-change bin x sector: count and sum of A^2,
  A = dv / distance). Exact by linearity for bodies that share frequencies;
  cost independent of the body count. Above ~1k impacts per bin per frame the
  drive becomes noise of the same energy (Cook's PhISEM).
- **Onsets** are spread over the frame, never on frame starts (that buzzes at
  60 Hz, +13 dB in the study).
- **Non-modal layers** (stone grit, splinters, rubble sliding) use pre-mixed
  granular "bills" with >= 16 variants and random offsets (step S8).
- Audio runs in an AudioWorklet; the GPU renderer's detect pass adds the
  histogram (about 1 KB of readback, one frame of lag: inside the 125 ms
  audio-late tolerance of ITU-R BT.1359).

## Materials

`@tb/audio` holds plain-data `SoundMaterial`s (plank, shell, cube models) and
derives mode tables, Hertz contact time and the acceleration click from them.

| Material | Model | Lowest mode | Decay | Contact at 1 m/s |
|---|---|---|---|---|
| pine (Kapla) | free-free beam, Rayleigh-Timoshenko, + torsion | 2.49 kHz | 12.8 ms | 0.40 ms |
| acrylic (bright bricks) | hollow 8 cm shell, clamped-plate walls | 1.11 kHz | 14 ms | 0.45 ms |
| stone (25 cm) | free cube, hex8 FE table (0.45 c_t/L) | 4.2 kHz | 5 ms | 3.0 ms (a thud) |

A solid block of any size thuds: its contact outlasts its mode periods. Bright
"acrylic" therefore needs the shell model. Pitch follows the world scale for
shell and cube materials without a fixed `size`.

## Plan (each step lands with its test)

1. S1 `@tb/audio` material config and mode derivation (this package).
2. S2 offline reference renderer (per voice and shared bank) and the ERB,
   kurtosis and buzz metrics.
3. S3 AudioFrame from snapshots on the CPU (histogram, sum A^2, top K).
4. S4 GPU audio reduce in the render detect pass, plus readback.
5. S5 AudioWorklet engine (foreground, bank, sectors, limiter).
6. S6 viewer Sound section and `snd.*` URL params.
7. S7 ground and hall: floor resonators, reverb tied to `real.env`.
8. S8 granular bills for non-modal layers.
9. S9 calibration from recordings (example-guided, Ren et al. 2013).
10. S10 M5 bench (`pnpm bench:audio`).
11. S11 game adoption (game thread's call).
