# Collision sound

Design and plan for collapse audio at 10k-100k bodies. The study behind it is
the "Collapse Sound Study" report (https://claude.ai/artifact/J2iKMLsRsAtL4ADWa8izyu)
with renders, metrics and scripts in /mnt/project-files/sound/.

## Architecture (the study's recommendation)

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
- Audio runs in an AudioWorklet. The histogram comes from the snapshots on
  the CPU for now; a GPU reduce (S4) would read back about 1 KB a frame with
  one frame of lag, inside the 125 ms audio-late tolerance of ITU-R BT.1359.

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

## In the viewer

`?snd=1` turns the sound on (off by default: nothing is created until then);
the Scene panel's Sound section does the same live, and the config file saves
it. Keys (`@tb/audio` options.ts):

| Key | Default | Meaning |
|---|---|---|
| `snd` | 0 | 1: on |
| `snd.mat` | auto | pine, acrylic, stone; auto = pine for Kapla (S15), the real look's stone (pine or stone), else acrylic |
| `snd.volume` | 0 | master, dB |
| `snd.ring`, `snd.click` | 0 | the modes and the contact click, dB over the material's |
| `snd.damping` | 1 | loss factor x |
| `snd.pitch` | 0 | semitones (stiffness x 2^(st/6)) |
| `snd.spread` | 1 | body-to-body pitch spread x |
| `snd.dv` | 0.25 | slowest speed change that sounds, m/s |
| `snd.voices` | 8 | loudest impacts a frame as their own voices (0: bank only) |
| `snd.lowcut` | 35 | master high-pass, Hz (0: off) |

How it runs: the viewer already reads every step's snapshot back, so a
`FrameTap` (tap.ts) turns the newest one into an AudioFrame at most every
1/75 s (steps in between add up), and posts it to the AudioWorklet
`tb-collapse` (worklet.ts, a thin shell over host.ts's `CollapseHost`). The
main thread's share is one pass over the bodies; the synthesis is on the audio
thread. Fired balls are silent (their own sound is not modelled yet), and
under `rules=keystone` the sound waits: the game's loop does not feed it yet,
and the game keeps its own feedback sounds (`@tb/game` audio.ts).

## Distortion (2026-10-30)

Will heard the city in stone as distorted. It was not clipping: at the
default camera the stone city peaks at 13 Pa, under the 27 Pa where the
limiter starts. Three faults, found on a capture of the viewer's own frames
(`capture-cli.ts`, a 10k city knocked down by the default ball on Rapier,
12.6k impacts in 7 s) rendered by `levels-cli.ts`:

1. The bank's click (where ~99% of impacts play) was an impulse into a
   damped band-pass, then differentiated. Its energy was right but its first
   sample was a full-band spike. A 1 m stone block's click is a 60 Hz thump
   (16 ms contact), and the bank played it 34-46 dB too bright at 1-4 kHz.
   The whole stone collapse was a carpet of treble ticks: crackle. Now each
   (bin, sector) has an undamped resonator with the contact's period, fed
   the impulse and, one period later, its negative. That is the exact kernel,
   one sine cycle, and nothing rings on. Acrylic's and pine's clicks were
   too bright too (5-13 dB above 4 kHz), but their modes covered it.
2. The limiter set one gain per 128-sample block. At +12 dB of volume it
   stepped up to 3.5 dB, and at +20 dB up to 9.4 dB, between two samples at
   block edges. Now it is a lookahead limiter (63 samples, 1.3 ms): the gain
   ramps over the lookahead and never steps (the steepest change is 0.05
   dB a sample at +12 dB and 0.18 at +20 dB), and the output still never
   passes 0.9.
3. A big block's thump puts a third of its energy under 32 Hz. No speaker
   plays it, but it used up the limiter's headroom. A 35 Hz Butterworth
   high-pass (`snd.lowcut`) takes the stone city's peak from 0.61 to 0.34 at
   volume 0. Limiting then starts at +12 dB (3.4 dB taken off, where it was
   8.7 dB without the cut).

Stone city before and after, energy above 1 kHz: -27 dB of the total before,
-37 dB after. The audio thread's cost is unchanged (both ~15% of a VM core;
a sanity check only, not a performance result). Stone now sounds like what
the model says 1 m concrete blocks are: dull thumps. Its crunch is the grit
layer (S8), which is not built yet.

## Plan (each step lands with its test)

1. S1 `@tb/audio` material config and mode derivation. Done (#93).
2. S2 offline reference renderer (per voice and shared bank) and the ERB,
   kurtosis and buzz metrics. Done in the study (Python); the TS engine's
   tests check the same laws (incoherent sum, voice = bank energy, no buzz).
3. S3 AudioFrame from snapshots on the CPU (histogram, sum A^2, top K): the
   `buildFrame` reference (#93) and the incremental `FrameTap`.
4. S4 GPU audio reduce in the render detect pass, plus readback. Deferred:
   the CPU tap costs ~10 ns a body on the main thread, so it waits for an M5
   measurement (S10), or for snapshots to stop coming back to the CPU.
5. S5 AudioWorklet engine (foreground, bank, sectors, limiter). Done; exact
   bank clicks, lookahead limiter and low cut 2026-10-30.
6. S6 viewer Sound section and `snd.*` URL params. Done.
7. S7 ground and hall: floor resonators, reverb tied to `real.env`.
8. S8 granular bills for non-modal layers (stone grit: `gritDb` is not played yet).
9. S9 calibration from recordings (example-guided, Ren et al. 2013).
10. S10 M5 bench (`pnpm bench:audio`): audio-thread load and the tap's main-thread cost at 10k and 100k.
11. S11 game adoption (game thread's call), and ball and level materials.
