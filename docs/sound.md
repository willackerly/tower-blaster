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
- **Non-modal layers** (stone grit, splinters, rubble sliding) are granular,
  with >= 16 grain variants and random offsets (step S8). Stone grit is
  built (see Grit below) as grains synthesised per impact, not pre-mixed
  bills: at its grain rates it costs the same and keeps each hit's own count.
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
| `snd.grit` | 0 | chips off hard hits (stone only), dB over the material's |
| `snd.rough` | 0 | contact roughness, dB over the material's (Realism below) |
| `snd.dense` | 0 | the dense modes above the table, dB over the material's |
| `snd.set` | real | the material set: real, or classic (G6's) |
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
under `rules=keystone` the viewer's own sound waits and the game's plays (In
the game, below).

## In the game (2026-11-01)

The game page (and the viewer under `rules=keystone`) plays the same collapse
synth for its impacts. `@tb/game` collapse-sound.ts taps the snapshot the game
already has on the CPU once per physics step (the game's physics loop,
physics-loop.ts; the audio frame spans the wall time since the last step, so
slow motion stretches it), and posts it to the same worklet on the page's one AudioContext.
The old synth (audio.ts) keeps the cues: launch whump, crown arpeggio,
heritage tritone, tier bowl and level end. Its `impacts` and `contact` voices
are off unless `keystone.sound=synth`. Both paths meet in a last fast
compressor at -1 dBFS, so the two never clip together. It starts on the first
click or key, and M mutes both.

Sounds by body (sound-map.ts): one slot per Keystone material, then one per
ammo kind, so each sounds at its own size.

| Keystone | Sound | Model, at 0.5 m |
|---|---|---|
| plaster (hollow maquette) | `plaster` | shell, 2 cm walls: a damped bonk at ~300 Hz; grit |
| stone | `stone` | cube: a thud with grit |
| iron (hollow) | `iron` | shell, 6 mm walls: a clang at ~200 Hz ringing near a second (ringDb -6) |
| ice | `ice` | cube: a thud, a little brighter than stone; grit |
| rubber | `rubber` | cube: a dull bomp (34 ms contact) |
| marble, cannonball, drop | `steel` at 0.2, 0.5, 0.4 m | cube: a hard knock |
| cue | `steel` as a 1.2 m bar | plank (free-free beam): it rings |
| a rack grenade's shell | `steel` as the marble | (iron, marble-sized) |
| rack projectiles (`p-<preset>`) | silent for now | each needs its own material (rubber, resin, stone) |

Level: the game's camera is ~10 m from 0.5 m blocks, where the viewer's city
is 75 m from 1 m ones, so at the viewer's level every par line limits by 18-19
dB. `GAME_SOUND_DB` = -22 puts the loudest at ~0.6, and `keystone.impacts=`
(dB) moves it. `sound-cli.ts` plays each par line on the AVBD reference and
renders it from the game camera (WAVs in /mnt/project-files/sound/game/):

| Level | Impacts (slot) | Peak at the game level | Limited |
|---|---|---|---|
| L1 | plaster 480, cannonball 5 | 0.60 | 0 dB |
| L2 | plaster 425, stone 13, cannonball 4 | 0.59 | 0 |
| L3 | plaster 84, marble 19 | 0.64 | 0 |
| L4 | plaster 154, drop 9 | 0.13 | 0 |
| L5 | plaster 484, marble 10 | 0.35 | 0 |

Tests: game sound-map.test.ts checks every slot's sound and size, the ammo
kind of every ammo body, and the L1 par line on Rapier rendered under the
limiter with at most 3 dB of limiting. e2e-sound.test.ts covers the page:
the first key starts it, the par line's impacts reach the worklet and peak
under 0.9, and `keystone.sound=synth` creates nothing. The materials' tests
(audio modes.test.ts) check that plaster and iron ring, ice, rubber and steel
thud, and only stone, ice and plaster shed grit.

Cost: the game holds ten slots, most of them silent. Silent materials used to
cost ~1.5% of a core each, scanning idle banks and click resonators every block.
Now a material with nothing ringing and no input is skipped (an engine test
holds its work at zero). L1's capture costs 16% of a VM core where it was 32%
(`cost-cli.ts`; VM figures are sanity checks only, the M5 gives the real
number). The hand balances (plaster's
and iron's levels, the game level) wait for S9's recordings and a listen.

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

Checked on every material in both captures (`capture-cli.ts scene=city` and
`scene=kapla`, a 3,000-plank Kapla topple heard standing 6 m away), before
(f51ef21) and after:

| Scene, material | Peak at volume 0 | Steepest gain step at +12 dB | Energy above 1 kHz | Spectrum change (bands with 1% of the energy) |
|---|---|---|---|---|
| city, stone 1 m | 0.43 -> 0.34 | 3.5 -> 0.05 dB a sample | -25.9 -> -41.0 dB | 16 Hz -5.1 (low cut), 256 Hz -2.5, the treble carpet gone |
| city, stone 0.25 m | 0.10 -> 0.10 | (no limiting) | -15.5 -> -18.6 dB | 1 kHz -2.0, the rest within 0.6 |
| city, acrylic | 0.90 -> 0.90 | 9.2 -> 0.33 | unchanged | within 0.1 dB |
| city, pine | 0.15 -> 0.16 | (no limiting) | unchanged | within 0.1 dB |
| Kapla, pine | 0.90 -> 0.90 | 5.2 -> 0.16 | unchanged | within 0.1 dB |
| Kapla, acrylic | 0.90 -> 0.90 | 7.5 -> 0.68 | unchanged | 512 Hz +0.4, the rest within 0.1 |
| Kapla, stone (2.3 cm) | 0.21 -> 0.15 | (no limiting) | unchanged (all above 1 kHz) | 1-4 kHz +2.5 to +4.7, 16 kHz -10.7: its click, now exact |

Acrylic and pine ring: their modes carry the sound, so the bank's click
change does not show, and only the limiter's steps go. At volume 0 the
acrylic city and the Kapla tower already touch the limiter on their loudest
transients (4 and 3 dB taken off, for under a millisecond in all); that was
where the old limiter stepped. The bank-click test covers stone at 1 m,
0.25 m and Kapla size, acrylic and pine. One limit it found: a click
shorter than ~16 samples (stone blocks under ~3 cm: 8 samples at Kapla
size) is sampled too coarsely for its top octave, in the voices' kernel and
in the bank alike. Against the band-limited pulse, 16 kHz reads 4.6 dB low
in one and 4.8 dB high in the other. That band is 20+ dB under the click's
own. Band-limited kernels for both would fix it (A7 did, for the real set: Band-limited clicks, below).

Stone city before and after, energy above 1 kHz: -27 dB of the total before,
-37 dB after. The audio thread's cost is unchanged (both ~15% of a VM core;
a sanity check only, not a performance result). Stone now sounds like what
the model says 1 m concrete blocks are: dull thumps. Its crunch is the grit
layer (S8), below.

## Grit (2026-11-01)

Chips knocked off hard hits: what makes stone crunch rather than thump.
The model is the study's (`add_grit` in /mnt/project-files/sound/scripts/snd.py),
made exact in energy so the bank and the foreground voices agree:

- An impact with speed change dv > 0.6 m/s sheds Poisson(min(3 dv, 30))
  grains. Each is one of 16 Hann-derivative kernels, 4 to 32 samples long at
  48 kHz (chip sizes; ~1.5-12 kHz), with a lognormal(0, 0.7) amplitude, delayed
  by an exponential of mean 20 ms x sqrt(edge / 25 cm) (chips fall further
  from a bigger block: 40 ms at 1 m).
- A grain's energy is gritEnergy (A dv)^2, A = dv / distance. gritEnergy
  matches the study's grain on a 25 cm block and goes with the block's volume
  (edge^3): chip energy as a share of the impact's. `gritDb` sets it, and
  `snd.grit` moves it live.
- The bank rebuilds its impulses from the histogram (n impacts as k <= 256
  impulses), so impulse i sheds n / k impacts' grains. Above 64 expected
  grains a cell and frame (`maxGrains`), fewer grains carry the same energy.
- Grit draws from its own random stream: with it on, the modes and clicks
  are bit for bit what they were.

Tests (`packages/audio/test/grit.test.ts`): the energy law in the foreground
(within 0.25 dB) and in the bank, capped and not (0.35 dB); every grain is
played whole across block edges (each kernel sums to zero, so the output
must); soft hits, pine and acrylic shed none; grit only adds (grit on minus
grit off is the grit-only render, to float rounding); it is impulsive and
bright (kurtosis over 8, 90% of its energy at 1-16 kHz); its spread follows
the block size; and it stays under the limiter when grains overflow. A
mutation check: dropping the bank's 1 / sqrt(q), cutting grains at block
edges, or sharing the random stream each fails a test.

Level, on the stone city capture (1 m blocks, volume 0):

| `gritDb` | Energy above 1 kHz | A-weighted energy vs no grit | Peak |
|---|---|---|---|
| none (main) | -41.0 dB | 0 | 0.34 |
| -18 | -36.5 | +0.1 | 0.34 |
| -12 (`snd.grit=-6`) | -31.9 | +0.4 | 0.34 |
| **-6 (default)** | -26.4 | +1.4 | 0.34 |
| 0 (the study's, `snd.grit=6`) | -20.5 | +4.0 | 0.37 |

The default is -6: the crunch is clearly there, and the thump still carries
the loudness. Before the distortion fix the bank's broken click put a similar
-27 dB above 1 kHz, but on every impact's onset, which is what clipping does
to a transient; grit is on hard hits only and spread after them. WAVs:
/mnt/project-files/sound/grit/. Every other case in the per-material check
(city acrylic and pine, Kapla pine and acrylic) is bit-identical to main.
The 25 cm city gets +0.3 dB at 1 kHz, and Kapla-size stone (2.3 cm) almost
none: its grit is 31 dB under a 25 cm block's (volume scaling), the one
place the scaling is a guess S9 should check. Cost: in the noise of the
audio thread (a VM sanity check, not a performance result; ~3.5k grains a
second in the city collapse).

Alternatives weighed: pre-mixed bills (the study's plan) fix the grains per
impact and their spread in the bill; per-grain synthesis costs the same at
these rates and lets dv set the count. PhISEM (noise through resonant
filters, energy-driven) is cheaper still at huge densities but turns into
hiss, while chips are crackle. A fracture impulse into the block's own modes
(a short, full-band "crack" instead of the Hertz thump) is the most physical
next layer; it waits for recordings (S9).

## Realism (2026-11-05)

Will heard the game's collisions as "a bit too synthetic". This section is how that was made
measurable, what caused it, and what changed. The old sound is kept bit for bit as the `classic`
material set (viewer `snd.set=classic`, game `keystone.sound=classic`).

### The judge

`tools/sound-judge/` re-implements YAMNet (Google's AudioSet classifier, 521 everyday sound classes)
in numpy and scores each render: the mean probability of real impact events (Smash/crash, Knock,
Clatter, Crack, Thump, Glass, Explosion, ...), of electronic sounds (Synthesizer, Sine wave, Beep) and of
musical instruments (Music, Marimba, Wood block, Bell, Percussion), and the real share
real / (real + electronic + instrument). It is level-free. Calibrated on ESC-50 recordings: knocks,
footsteps, glass, fireworks, can openings and mouse clicks score 0.68-0.98 (category means, 16 clips
each) with the right top classes; alarm clocks 0.07 and church bells 0.00. A classifier is not an ear; it guards against "sounds like an instrument",
and values below sit on its plateaus, never its peaks, and only where the physics puts them.

G6's game collapse (L1-L5 par lines, AVBD reference, game camera) scores **0.19**, heard as
"Music, Plop, Synthesizer". Two things were ruled out first:

- **Not the room.** The same renders convolved with a hall, a room, an outdoor tail or a lone
  ground reflection score *more* musical (instrument 0.34 -> 0.7-2.0: "Percussion, Drum, Wood
  block"). A dry modal source in a room is a drum kit in a room. Reverb waits for a real source.
- **Not damping or pitch spread alone.** Damping x3 trades "Music" for "Heartbeat" (a low thump,
  real share 0.4); pitch spread x5 changes nothing.

### The cause

A Keystone block is a 0.5 m hollow plaster shell of 30 kg; Hertz contact against it lasts 4 ms
at 1 m/s. A smooth 4 ms force pulse has nothing left above ~250 Hz, so of the shell's 48 table modes
only the lowest cluster (six walls at ~300 Hz, all within 3%) is struck: 95% of the ringing energy is
one pitch. Every block in a level is the same size, so the collapse is one instrument played 500 times:
the "plop". Its ratios (1 : 2.04 : 3.01 for a clamped plate) are near-harmonic, which makes it a note.

### What changed (the `real` set)

1. **Contact roughness** (`roughDb`, modes.ts `forceSpectrum`). Real faces and corners touch at
   several points within the contact: the force fluctuates by eps of itself as noise of ~1 / ROUGH_T
   (0.15 ms asperities) bandwidth. Its power adds a floor 0.75 eps^2 ROUGH_T / T under the pulse's
   spectrum, so a long contact (a heavy block) stays smoother per impulse than a short one.
2. **The dense modes** (`denseDb`, `denseField`, the engine's dense layer). Shell walls and solid
   blocks have thousands of modes above the table (2D and 3D Weyl densities). They play as a
   statistical field: band noise per (material, sector, half-octave) under an amplitude each impulse
   raises by the band's energy, decaying at the band's loss factor. Its energy is physical, not a
   balance: 2 J^2 Int |F|^2 Re Y df with the mean point conductance Re Y = n(f) / (4 M) (Cremer and
   Heckl; the infinite plate's 1 / (8 sqrt(D rho h)) for a wall), radiating its share
   eta_rad / (eta_rad + eta) by Maidanik's efficiency (walls below coincidence) or the body's size
   (solids).
3. **The energy law for the table** (`law: 'energy'`, `modeGain`). G6 played every mode at the
   impact's dv, a balance that grows with the mode count (pine and iron radiated 22-27% of the
   impact's energy, rubber would have radiated 6x its energy with the dense field). Now each mode takes
   J^2 |F|^2 / (2 M) and radiates by its efficiency, the dense field's law, so table, field and click
   balance by physics. Table and field each take at most `VIB_SHARE` (half) of the impact's energy.
4. **Contact damping and cast walls.** A block in a pile loses energy through its contacts: loss
   factors 2-8x a free body's (plaster 0.08, stone 0.03, ice 0.04, iron 0.03, steel 0.002). Cast walls
   differ by ~10% in thickness (`walls`: frequencies within 15%), which breaks the six-wall unison.

Per material (real share, mean of L1-L3 with the material on every structure body; the city is the
viewer's 10k knock-down from 75 m):

| Material | Classic | Real | Classic top classes | Real top classes (L1, L2, L3) | Values |
|---|---|---|---|---|---|
| plaster (game) | 0.27 | **0.87** | Music, Plop, Synthesizer | Shuffling cards; Knock, Door, Thunk; Door, Tap | eta 0.08, rough -6, cast walls |
| stone | 0.33 | **0.84** | Heartbeat, Heart murmur | Rattle, Coin dropping; Coin dropping, Keys jangling; Tick, Clock | eta 0.03, rough -6 |
| ice | 0.39 | **0.86** | Heartbeat | Crack, Crushing, Breaking; Crackle; Glass, Chink | eta 0.04, rough -6 |
| rubber | 0.20 | **0.82** | Heartbeat | Crackle, Explosion; Rodents (!); Tick | rough -20 |
| iron | 0.00 | **0.68** | Chant, Mantra, Music | Wind, Door; Fart, Wind noise (!); Door | eta 0.03, rough -20, cast walls |
| steel ammo | 0.35 | **0.61** | Plop, Ding | Ding, Clang, Glass, Chink; Ding, Clang; Tick, Ping | eta 0.002, rough -12 |
| acrylic (viewer city) | 0.20 | **0.84** | Music, Clock | Camera, Wood, Mechanisms | rough -6 |
| stone (viewer city, 1 m) | 0.36 | **0.90** | Heartbeat, Throbbing | Crackle, Fire, Static, Clatter | as above |
| pine (Kapla) | 0.47 | 0.47 | Jingle bell, Glass, Bell, Chink | (unchanged) | classic |
| **the game, L1-L5 as played** | **0.19** | **0.81** | Music, Plop, Synthesizer | Door; Knock, Whack; Door, Whack; Knock, Door; Door, Knock | |

(Silence, Sound effect and Inside, small room are left out of the top classes.) The two viewer-city rows
were rendered without the background bank (see "Judge fix: viewer captures"); with it, stone at 1 m is
classic 0.02, real 0.99 (Explosion, Fireworks, Crackle), and acrylic classic 0.25, real 0.75 (Wood, Tools,
Mechanisms). The real set still wins by as much or more. The real share is the
headline, but the top classes keep it honest: rubber and iron leave "instrument" for odd neighbours
(Rodents, Fart, Wind), a sign their low, noisy rumble is not yet right either. Both are rare in the
levels; they wait for listening and recordings.

Plateaus: plaster is 0.82-0.87 for rough -20 to 0 at eta 0.08 (0.45-0.54 at its old 0.04); stone
0.74-0.81 over rough and eta 0.015-0.06; iron needs eta >= 0.03 (0.06-0.12 below). Steel ammo stays
partly "Ding": steel balls do ring. Kapla pine is a beam whose table already reaches 18 kHz, so it is
unchanged and reads as clinks (it is not wrong: Kapla planks clink); it is the next material to study.

Energy audit (realism.test.ts): no real material radiates more than 10% of an impact's kinetic
energy (modes and field; the dense field alone under 5%), from 0.25 to 1 m and 0.5 to 4 m/s. The
click is left out of that audit: it is G6's compact dipole, which overstates a 1 m box stopping in
1 ms (ka ~ 9), a known limit for a later step.

Level: the real set is transient where the classic one rings, so at the same headroom it reads
quieter. `GAME_SOUND_DB_REAL` = -17 limits nothing on the par lines (loudest peak 0.81) and sits
1.1-3.4 LU under the classic set (BS.1770, `loudness.ts`); `keystone.impacts=3` closes it.

Cost: the dense layer is 15 bands x 4 sectors of table lookups per sounding material, skipped when
idle (an engine test holds an idle material at zero work). Real numbers come from the M5.

Knobs: `snd.rough` and `snd.dense` (dB over the material's), `snd.set`. Tools: `sound-sweep-cli.ts`
renders captures with any material change; `sound-cli.ts set=` prints peak, limiting and loudness.

## Material identity (2026-11-05, the listening ladder)

Will's listen of the real set: better than classic by a bit, but every level reads as soft wood
(crunching firewood, a branch falling, footsteps on wood), and the stone city as "wood blocks
falling". The realism judge agreed without saying so: its top classes were Door, Knock, Whack. Its
real share rewards any real impact, and wood knocks are AudioSet's commonest one.

The judge now also reports material shares from AudioSet's material labels: wood (Wood, Knock,
Door, Whack, ...), glass (Glass, Chink, Shatter), metal (Clang, Ding, Coin, ...) and mineral (Crack,
Clatter, Rattle, Crushing, Smash; AudioSet has no stone class). On ESC-50, door knocks score wood
0.84-1.00 (8 of 8), and glass breaking reads glass in 6 of 8 (0.42-0.79). On the game's levels as played (real set) it
says wood 0.40-0.83 on all five, as Will did.

Will proposed building up instead of tuning whole levels: two blocks knocking, then a clatter, then
a tower, then a level, each described and listened to, moving on only when the descriptions line up.
`ladder-cli.ts` renders those steps as scripted impacts (the tap's frame format, no physics engine),
per material, far under the limiter and peak-normalised, so a step hears only the synth.

Step 1 (knock, 0.5 m blocks): the material label follows damping, as the perception literature
predicts (Wildes and Richards 1988; Klatzky, Pai and Krotkov 2000: the decay rate per cycle, eta, is
the strongest material cue, and it does not depend on size). Solid cubes (stone, ice, steel):
eta <= 0.002 reads metal (Ding), 0.005-0.01 glass (Chink, clink), 0.02-0.04 mineral, >= 0.04-0.08
wood. The real set raised eta to stop the ringing (stone 0.015 to 0.03, plaster 0.04 to 0.08, ice
0.005 to 0.04, iron 0.002 to 0.03), which moved every material into the wood band. The hollow shells
(plaster, iron) read wood at almost every eta: a knocked 0.5 m hollow box is a door. Pine planks
(Kapla) read glass (Ding, Chink), acrylic a clock tick.

Will's reads of step 1 (2026-11-06): stone decent but a little soft, plaster a little too wood-like,
iron way too woody, steel good, rubber quite good, ice too much like rubber. The judge's material
labels agreed on plaster, iron and ice, and Will judged it reliable enough to iterate on; it does
so from here, with Will at the gates.

Step 1 fixes (each material moved into its band, by the judge; knock at 0.5 m):

| material | change | judge before | judge after |
|---|---|---|---|
| stone | eta 0.03 to 0.02 | mineral, softer | mineral 0.41 |
| plaster | hollow shell to a solid porous block at the game's 250 kg/m^3 (E 2 GPa, a light gypsum's), eta 0.035 | wood (Door) | mineral 0.44 (Crack, Breaking) |
| iron | 6 mm shell to 22.6 mm walls (what gives the game's 1950 kg/m^3), plate modes up to 8 half-waves a wall, eta 0.003 | wood | metal 0.72 (Ding, Clang) |
| ice | eta 0.04 to 0.005 (ice's own) | rubber-like | glass 0.70 (Chink) |

Leissa's table has 8 modes a clamped wall; past it the walls use Bolotin's edge-effect asymptote,
lambda = 0.91 pi^2 ((p + 1/2)^2 + (q + 1/2)^2), which meets Leissa at (3, 2) within 0.6% and at
(3, 3) within 0.01% (`plateModes`, modes.ts `plateTable`). With 8 modes a wall the shell rings in
near-harmonic clusters (a bell, "Music"); with 64 it is a clang. More plate modes alone did not
save the thin shells (they still read Music or Door), so plaster went solid. Tried and rejected:
plaster as a 1000 kg/m^3 cube (Quack, Duck in a clatter), at E 0.3 GPa (Plop, Tick), grit (none at
knock speed).

In the levels the new plaster reads mineral (L1 0.61, Crack and Breaking) on its own, but the steel
ammo, 28 dB under the blocks, turned the mix to glass (Chink, Glass, Ding): every hit rang the ball.
A steel ball on plaster has plaster's contact, though: the Hertz pair modulus
1/E* = (1-nu1^2)/E1 + (1-nu2^2)/E2 is plaster's, the contact lasts ~5x longer, and the asperities,
Hertz contacts too, last as long (E*^(-2/5)), so the roughness stops near 1.4 kHz instead of 7, under
the ball's modes. The game's ammo now plays the pair's contact with the level's main material
(sound-map.ts `ammoOn`; a material's asperity time is `roughT`, default ROUGH_T 0.15 ms). The
classic set keeps G6's steel on steel. On the same L1-L5 captures, main's real set before this
change read L1 and L2 as glass (0.39 and 0.37, Chink, Glass, Ding), and after it they read mineral
(0.53 and 0.51; Crack, Crushing); L5 stays mineral (0.43 to 0.44), wood is 0.10-0.32 on all five,
real share 0.80-0.95. L3 and L4 stay mixed
(their impacts are few, and the clip is mostly silence).

Level: the solid plaster is louder at the peak; at GAME_SOUND_DB_REAL -17 one hit in L1 goes 1.1 dB
into the limiter and nothing else limits. -18 would avoid it but leave the set 3.4 LU under the
classic one (2.4 at -17), so the level stays.

Step 2 (clatter, 2026-11-06). Findings:

- The clatter script struck on a 0.2 s cadence, and evenly spaced strikes read as a rhythm. Its six
  blocks now tip at random over 1.2 s. Iron's Music went from 0.51 to 0.42 (0.18 for another random
  draw; metal 0.90), and plaster's Fart and Quack (0.32) went down to Silence 0.11.
- The judge, calibrated on real single hits (DiffImpact's robot recordings, Clarke et al. 2021; 99
  clips from github.com/samuel-clarke/diffimpact):
  - A steel fork on a steel bowl reads Music and Ding (metal 0.85), so "Music" on struck metal is what
    real metal gets too.
  - Wood on wood reads Tick, Clock, Inside small room (wood only 0.34).
  - Ceramic reads glass (0.81-0.84).
  - Sparse hits read Silence and Tick, real or synthetic, so a sparse clip's top labels are weak
    evidence. Its material shares still hold.
- With the irregular script: ice clatter reads glass (0.69), iron metal (0.90), steel glass and metal
  (0.52 and 0.46). Plaster and stone read weakly as wood (0.50 and 0.52) with no strong top label.
  That is the open question for Will's ear.

Two physics gaps, now options, off by default because the judge is mixed on them:

- `overlap` (modes.ts `sparseModes`): band noise stands in for modes only where they overlap. The
  modal overlap is n(f) f eta pi / 2. At the top of steel's 24-mode table (5.9 kHz) it is 0.07: modes
  600 Hz apart and 8 Hz wide, a line spectrum, which band noise turns into a pad (steel tumble without
  the field: Ding, with it: Music). `overlap: 1` adds discrete modes at the Weyl count up to overlap 1
  (14.4 kHz for steel, 6.5 kHz for ice, 4.9 kHz for stone; plaster and iron already overlap at their
  tables' tops). Steel clatter moved from Music to Cowbell and Glass, stone knock from mineral 0.41 to
  0.56, ice knock from glass 0.70 to metal 0.52 (worse), stone tumble from wood to glass.
- `clickModel: 'sphere'` (modes.ts `clickFilter`): the click as a rigid sphere of the body's volume
  radiates it, |p| / |accel| = rho w a^3 / (c sqrt(4 + (ka)^4)) (the oscillating sphere's exact far
  field). The compact dipole alone holds below ka ~ 1.4, which is 250 Hz for a 0.5 m block, and puts
  up to 11 dB too much into 300 Hz-1 kHz. The judge barely moved (stone knock mineral 0.41 to 0.31,
  plaster clatter unchanged).

Tried and set aside:

- The rough contact's acceleration noise as a click component (prototype; ~0.1 of the peak, small).
- Body jitter 0.05-0.25 on metal and on stone/plaster: no effect on Music or the animal reads.
- Grit up to +12 dB, the click down to -12 dB, contact radius 2 mm.

Will's step-2 reads (2026-11-06): plaster acceptable, iron and steel good if hollow, stone way off,
ice should be far more crisp and shattery. Of the step 2b takes he picked stone with `overlap: 1`,
which still sounds "very much in an enclosed room, not very stone like", and the original ice
("closest, but far"). He suggested measuring real recordings of stone and of ice cracking.

Step 2c (real recordings, 2026-11-06). Freesound and the other sound libraries are blocked from the
cloud, so the references are recordings shipped in open-source game repositories on GitHub:
Minetest Game's ice footsteps and ice chipping (CC BY-SA 3.0, from Freesound), and SuperTux's ice
crash. They are references for measurement only, not shipped. Against ours at the game's 0.5 m:

| | octave levels 125 Hz-16 kHz (dB re max) | spectral flatness 1-8 kHz | transients per event | judge |
|---|---|---|---|---|
| real ice footstep / chipping | -25 -20 -1 -1 0 -4 -4 -9 | 0.40-0.48 | 9-36 | mineral 0.6, Crack, Breaking |
| ice now, knock | -19 -31 -36 -30 -4 0 -6 -19 | 0.18 | one strike | glass 0.70, Chink, Glass |

Real ice cracking is a dense run of small snaps, flat from 500 Hz to 16 kHz. Ours is a ring with a
hole from 250 Hz to 1.5 kHz. Stone has the same hole: under the 0.5 m block's first mode (2.1 kHz)
only the rigid-body click radiates, and its smooth Hertz pulse (7.5 ms at a 5 cm drop) sits at
130 Hz. The rough part of the contact force radiating through the body's rigid motion would fill it,
but with the sphere's radiation (clickModel 'sphere') it adds only 2 dB at 500 Hz-1 kHz: not the gap.

The grit (chips) was there all along but about 50 dB too quiet to hear at 0.5 m: at gritDb -6 a
knock's 2 grains are lost under the ring. Three new options, off by default:

- `gritRate` (grains per m/s of dv; absent GRIT.perDv 3, the cap scaling with it) and `gritSpread`
  (the grains' mean delay, s, at GRIT.refEdge; absent GRIT.spread 20 ms). Brittle ice cracks in a
  burst of many small events rather than shedding a few chips.
- `gritRing` (0 to 1, absent 0): the share of grit's energy that rings the body. A crack is a stress
  pulse inside the block: it strikes the modes (flat, a pulse shorter than any contact, no rigid-body
  click) and the dense field (the shortest contact's row), scaled so a crack rings with its share of
  the grain's energy (a mode of amplitude c holds c^2 tau sr / 4). Ringing draws from grit's stream,
  so a material without it plays bit for bit as before.

Ice clatter at gritRate 30, gritDb 50: dry cracks over 30 ms read Crack first (mineral 0.35, real
share 0.96), and the octaves fill to -18 -21 -15 -7 -2 0 -1 -9 (flatness 0.50), the real recordings'
shape. Half of each crack ringing reads Glass and Breaking (glass 0.38, mineral 0.32). All ringing
reads Music and Ding (metal 0.84): ice's table is a sparse chime from 1.7 to 3.6 kHz. Cracks running
80 ms with jitter 0.08 read Crack 0.54, Crackle 0.31, Breaking 0.29 (mineral 0.58), the closest to the
recordings.

Stone: every block rang at one pitch (jitter 0.02), and its clatter read Tick, Clock, Tick-tock,
Music (real share 0.26). At jitter 0.15 (natural stone's E varies some 30% piece to piece, so its
pitch about 15%) it reads Tick, Animal, Drip (real share 0.56); the material shares barely move
(mineral 0.06 to 0.07). Chips at gritDb 44, gritRate 10 bring it to mineral 0.24, real share 0.75.
(In step 2 jitter alone did nothing; that was without `overlap: 1`.)

Stone, against 105 Freesound previews the Mac fetched (stone knock, impact, block, rock hit, brick;
ice crack, pond, footsteps, sheet; 53 CC0, 33 Attribution, 13 NonCommercial: references only, see
/mnt/project-files/sound-refs-index.csv). The judge reads real stone much as ours: stone knocks
wood 0.53 (Whack, Door), stone drops "Inside, small room" in 5 of 8, mineral 0.11-0.35 throughout. So
for stone the target is the spectrum, not the labels. Octave levels re their mean, 125 Hz-8 kHz:

| | 125 | 250 | 500 | 1k | 2k | 4k | 8k | rms distance |
|---|---|---|---|---|---|---|---|---|
| real stone knock and impact (median of 16) | -6.5 | -2.4 | 1.3 | 5.4 | 5.9 | 1.4 | -6.5 | 6.8 (each recording to the median) |
| stone A, clatter | 2.8 | -2.3 | -13.5 | -10.6 | 5.7 | 11.8 | 6.0 | 10.9 |
| A + jitter 0.15, chips (gritDb 50, gritRate 10), face 0.6 | -9.1 | -2.4 | 5.1 | 4.7 | 0.7 | 2.6 | -1.6 | 3.2 |

Real stone peaks at 500 Hz-2 kHz. Ours had a hole there because the click sat at 130 Hz: a 7.5 ms
Hertz contact, which holds for a 2 mm corner but not for a face. Flat on flat, the stiffness is the
block's own, k = E* L, so T_face = pi sqrt(m* / k), 0.50 ms for the 0.5 m block. A landing starts on an
edge and rolls flat, so it falls between the two. New option `face` (0 to 1, absent 0):
T = T_hertz^(1 - face) T_face^face (modes.ts contactTime). At face 0.6 (1.6 ms) the clatter reads
mineral 0.45 (Crack, Plop), real share 0.93, and the knock reads Door and Tap (wood 0.57), as the real
stone knocks do. Ice with face 0.5, cracks over 80 ms and jitter 0.08 reads Crack 0.74, Breaking 0.58,
Glass 0.32 (mineral 0.49), 2.5 dB from the median of 39 real ice recordings (their own spread is 5.2).

Fixed: `sparseModes` hung on a body with no mode table (a 5 cm stone cube, whose first mode is past
18 kHz): the Weyl count started at 0 Hz, and its step (x * 0.002) never moved. It starts at 20 Hz.

Page for Will: https://claude.ai/artifact/Rx7wFWSp5tVpMhauwwYpQ4 (stone A-E, ice now and B-E, and
real recordings of each). His picks become the real set's defaults.

Defaults (2026-11-07). Will, away for a while, delegated the picks, so the recommended takes are the
real set: stone E (`overlap: 1, jitter: 0.15, gritDb: 50, gritRate: 10, face: 0.6`) and ice E
(`jitter: 0.08, gritDb: 50, gritRate: 30, gritSpread: 0.08, face: 0.5`), with step 3's level trims and
grit caps (below: stone `gritShare: 0.0015, levelDb: -10`, ice `gritShare: 0.01, levelDb: -7`). The real set before this is
the set `real1` (viewer `snd.set=real1`, game `keystone.sound=real1`); `classic` stays G6's.

A loud crack burst grows as rate dv^3 against the impact's dv^2: ice at 4 m/s would radiate 16% of the
impact's kinetic energy as grit. Grit is now capped at GRIT_SHARE (5%) of it (fewer grains of the same
size past that); soft hits and G6's grit are far under the cap, so they play as before. With step 3's
trims L1-L5 keep their level: L1 limits 0.9 dB (real1: 1.1), L2 (13 stone hits) peaks at 0.39 (real1: 0.43;
untrimmed 0.67).

### Step 3: a tower (2026-11-07)

The ladder's scripts stop at a hand-made pile (`tumble`); a tower is the first step the physics writes.
`capture-cli.ts scene=tower` stands one building of the game's blocks (S5, F x F x H cubes of
DEFAULT_UNIT, 0.5 m) on Rapier, knocks it down with the viewer's ball and taps it from the viewer's camera
angle `dist` m away. Four towers: F3 H12 ball 15 units/s at 8 m (1148 impacts), F2 H10 10/s (645), F4 H8
20/s (1581), F3 H16 12/s at 12 m (917). Each take is rendered level-free (peak 0.5) and judged
(tools/sound-judge), and matched on octave spectra (dist.py) to the real rock-break, brick and stone drops
(stone) or ice break and crack (ice). Means over the four:

| take | real share | mineral | fireworks-like | crack-like | tonal | octave rms (dB) |
|---|---|---|---|---|---|---|
| stone real1 (step 2b) | 0.60 | 0.35 | 0.00 | 0.05 | 0.02 | 8.1 |
| stone E, grit at GRIT_SHARE 5% | 0.98 | 0.49 | **0.69** | 0.27 | 0.00 | 6.6 |
| stone E, gritShare 0.0015 (default) | 0.95 | 0.50 | 0.08 | **0.39** | 0.00 | **4.9** |
| stone E, no grit | 0.91 | 0.42 | 0.04 | 0.09 | 0.00 | 5.0 |
| ice real1 | 0.47 | 0.05 | 0.00 | 0.00 | 0.88 | 10.9 |
| ice E, grit at 5% | 0.97 | 0.44 | **0.69** | 0.20 | 0.00 | 2.0 |
| ice E, gritShare 0.01 (default) | 0.92 | 0.50 | 0.19 | 0.33 | 0.01 | 2.7 |
| ice E, no grit | 0.42 | 0.10 | 0.00 | 0.00 | 0.50 | 3.4 |

(fireworks-like: Explosion, Fireworks, Firecracker, Cap gun, Gunshot, Burst in the judge's top six;
crack-like: Crack, Breaking, Crackle, Crumpling, Scrape, Shatter, Smash, Rumble, Thud, Clatter, Rattle.
The real rock-break and ice-break clips read Crack, Breaking, Crackle, Crumpling; none reads fireworks.)

What the tower found, and what changed:

- **Grit at a tower's speeds read as fireworks.** Knocks and clatters (0.5-3 m/s) shed little grit; a ball
  at 10 m/s and the blocks it throws shed it at the 5% cap, a dense string of loud dry pops. New key
  `gritShare` (0 to 1, absent GRIT_SHARE): the material's own cap. Stone takes 0.0015 and ice 0.01
  (ice needs its crackle: with no grit it reads glass and tonal again). Below the cap nothing changes,
  so the knock and clatter takes are as judged (their loudness moves 0.0 dB for stone, 0.3 dB for ice).
- **The takes were 5-17 dB louder than the sounds they replaced.** Step 2c judged them peak-normalised,
  so their level was never heard: the face contact alone adds ~10 dB for stone and ~6 dB for ice (a
  shorter contact puts more force into the radiating modes), and grit at the 5% cap added up to 7 dB
  more on a tower. In the game a stone tower would have limited by 13 dB. New key `levelDb` (-60 to 60 since A9,
  absent 0): one gain on everything the material sounds (top voices, background, dense field, grit;
  it scales A = dv / distance, which all of them are linear in), so timbre is untouched. Stone takes
  -10 dB and ice -7 dB, the medians of real-minus-real1 loudness over knock, clatter, tumble and the four
  towers (spread +-1.4 dB). A level trim, not physics: the game was mixed on real1, and the tower now
  plays stone within 1.0 dB and ice within 0.3 dB of it (test: knock, clatter and tumble within 3 dB).

`levels-cli.ts` takes `set=`.

### Step 4: a level (2026-11-07)

The game's own path: `sound-cli.ts` plays a level on the AVBD reference, taps it from the game's opening
camera and renders it through the level's sound slots at the game's level, limiter and all. It now takes
any built-in level (its par line, else its showcase line, else `shots=`), and maps every body by its
description as the page does (a spawned ice piece was an index past the shots). The ice trials have no
recorded line, so each takes a cannonball at the centre then a grenade from 20 degrees round
(`cannonball.0.16.0.20.100_w-grenade.40.12.0.30.100`).

| level (impacts) | set | judge: real share, top classes | limiter: worst, time under -3 dB |
|---|---|---|---|
| T-I1 ice tower (526 block, 6449 piece) | real1 | 0.79: Glass, Chink, Music, Ding | -6.9 dB, 80 ms |
| | **real** | **0.93**: Explosion, Chainsaw, Breaking (mineral .42) | -12.3 dB, 370 ms |
| T-I2 ice wall (1083, 1185) | real1 | 0.62: Glass, Chink, Ding, Music | none |
| | **real** | **0.89**: Glass, Explosion, Chink, Fireworks | none |
| T-I3 stone keep, ice top (476 stone, 299 ice, 1429 piece) | real1 | 0.64: Glass, Music, Chink, Breaking | -7.6 dB, 100 ms |
| | **real** | **0.86**: Sound effect, Camera, Fire (mineral .39) | -9.9 dB, 340 ms |

What the level found:

- **A shattered ice block's pieces sounded as whole blocks.** Keystone splits a block 2 x 2 x 2 (ice.ts);
  every piece played ice at the block's edge, so a grenade's 6000 piece hits rang like 6000 blocks. New
  slot `PIECE_SLOT` (sound-map.ts, after the ammo): ice at half the edge, an octave up with an eighth of
  a block's energy. The pieces now sit 12-18 LU under the blocks.
- **A grenade among ice blocks drives the limiter in either set**: the whole blocks it throws peak
  7-9 dB over full scale at the game's level (real1 too). The real set holds it 3-4 times as long (its
  grit is crackle: peak-to-loudness 2-6 dB over real1's). Left as is: it lasts a third of a second inside
  an explosion, which is what the limiter is there for; a listening item for Will.
- The real set reads as breaking where real1 read as glass and music on every ice level.

## Launch (A10, 2026-11-07)

The launch cue was a sine gliding down an octave (70 Hz for a cannonball, 110 for the rest): the judge
heard it as Beep, Music and Sound effect (real share 0.11-0.17). It is now a gas launcher's whump, made
from the fired body's own size and speed (launch-sound.ts; the launcher stands behind the camera, so it
is heard close):

- **Barrel**: closed at the breech, open at the muzzle, `BARREL_CALIBRES` (6) shot diameters long. It
  rings at its odd quarter-wave partials f_k = (2k - 1) c / (4 (L + 0.61 r)) with Q 3 (a wide open end
  radiates them away in a few cycles), struck as the gas behind the shot vents. A cannonball's barrel
  (3 m) sits at 27/82/136/190 Hz, a marble's (1.2 m) at 68/204/340/476 Hz.
- **Muzzle blast**: one Friedlander pulse, its positive phase the cube root of the gas's energy
  (Hopkinson-Cranz scaling; the gas holds ke (1/0.3 - 1) once the shot takes its 30%): 2.0 ms for a
  cannonball at 15 m/s, 1.0 ms for a marble at 20.
- **Chuff**: the gas leaves the bore choked (at the speed of sound), so its turbulence peaks at Strouhal
  0.2, f = 0.2 c / d (137 Hz for a cannonball, 343 Hz for a marble), broadband (Q 0.7: a narrow band read
  as a struck bell), venting over four barrel transits (35 ms and 14 ms).
- Mixed 0.3 / 0.3 / 0.4 by energy; peak 0.35 at 100 kJ, rising as ke^0.1 within 0.2-0.5.

Judged (tools/sound-judge): the marble's whump reads Plop, Door, Whack (real share 0.68-0.69); the
cannonball's reads 0.79-0.80 real but as Ding, Chink and Clang. YAMNet hears nothing under 125 Hz,
where the barrel and the blast are (either alone it calls silence), so for a cannonball it judges only
the chuff's upper half; every mix and band width tried (Q 0.3-1.5) kept that label. So the judge can
rank the whump against the glide but cannot tune a cannonball's. Real launch recordings (mortar, air
cannon, potato cannon) are the next reference (A10b). A drop (released, not launched) and the cue (pushed)
keep the glide. `keystone.launchsound=glide` brings the old cue back.

## Blasts (A6, 2026-11-07)

A weapon going off (a grenade, a bomb, a plunger's charges) made no sound of its own: only the blocks it
threw were heard. It now booms (blast-sound.ts), from the blast's reach (the radius it pushes out to) and
the camera's distance from it:

- **Shock**: a Friedlander pulse, its positive phase 0.4 ms per metre of reach (Hopkinson-Cranz: every
  time and length of a blast grows as the cube root of its charge, and the reach is such a length).
  A charge's 1.5 m is a 0.6 ms crack; the grenade's 5 m a 2 ms thump.
- **Rumble**: the same pulse echoing off the ground and the scene, a velvet-noise train of 2000 echoes a
  second under e^(-t/tau), tau = 0.4 s x sqrt(reach) (0.49 s for a charge, 0.89 s for the grenade),
  darkened by two poles at 400 Hz for the echoes' longer paths. The Friedlander pulse is the impulse
  response of a two-pole filter, so both parts are that filter run over their taps (exact, O(n)).
- Mixed 0.35 / 0.65 by energy, DC-blocked at 20 Hz, then a tanh-like soft clip at drive 8: the overload
  of an ear or microphone near a blast. Peak 0.6 for the grenade at 15 m, scaling as reach / distance
  within 0.05-0.8, and it plays distance / c after the flash (at most 150 ms).

Judged (tools/sound-judge), four takes each at reach 1.5, 2, 3 and 5 m: all 16 top-1 Explosion
(0.50 / 0.55 / 0.63 / 0.62 by reach; real share 0.92-0.94). One step off at a time, one take each:

| ablation | judge's top label | Explosion |
|---|---|---|
| rumble not darkened (no 400 Hz poles) | Ocean, Waves (all 4 reaches) | 0.00 |
| no overload (drive 0: the 1-sample peak sets the level, the rumble 25 dB under) | Silence (3 of 4) | 0.27-0.38 |
| rumble half as long | Timpani, Sound effect | 0.00-0.17 |

Tried and dropped: clustered echoes (a slow random swell over the taps, for a rolling rumble) read as
Wind (Explosion 0.08-0.20). As with the launch, the judge hears nothing under 125 Hz, so the grenade's
low thump is judged by its upper half; real explosion recordings would be the next reference.

Each wave is built once per reach (to the centimetre) and take (four, so blasts going off together do
not add up coherently) and cached by the Synth: building one is a few ms on a CI box. The feedback
carries only the reach, not the blast's impulse, so two weapons of one reach sound alike.
`keystone.blastsound=none` brings the old silence back.

## Everything spawned sounds (A6, 2026-11-07)

Before this, a body spawned during a level was heard only if it was Keystone's own steel or iron ammo
or an ice piece. The rack's real-world presets, every weapon's shell (B1-B3's bomb, B2's ram, the
firework, the default w-grenade: their densities are scaled to the level's blocks, so they are neither
steel nor iron) and Mason's Trial probes were silent. sound-map.ts soundSlotOf now goes, for a spawned body:
ice piece; rack preset (a sphere at a preset's real diameter and its density x MODEL_DENSITY, presetOf);
Keystone ammo; a structure material's density (a probe) as that material; anything else as the steel
ammo of its shape, a metal casing. Nothing spawned is silent.

Each preset has its own slot (PRESET_SLOT + k, at its real diameter; 6 slots, ~5 ms to build next to
the other 11's ~120 ms):

| preset | body model | judge, knock (clatter) |
|---|---|---|
| beach ball | vinyl shell, 0.25 kg wall, inflated contact 25 ms | Door, Knock, Tap (wood .78) |
| basketball | rubber shell, 0.62 kg wall, inflated contact 12 ms | Knock .54, Whack, Door, Thump (wood .91) |
| bowling ball | solid polyester resin, E 3.5 GPa, loss 0.02 | Sound effect, Tick (no class over .2) |
| cannonball (24-pounder) | solid cast iron | Tick, Sound effect |
| wrecking ball | solid steel, 0.9 m | Chink .70, Glass, Ding (metal .80 on clatter): it rings, as the steel ammo does |
| boulder | the level's stone at 6.7 m, grit and all | Music, Door (clatter: Plop, Crack; mineral .41) |

An inflated ball's stiffness is its air's, not its wall's: Hertz on the rubber gives a 3 ms contact,
where high-speed video puts a basketball's at 10-15 ms; ecForContact solves the contact modulus for
INFLATED_CONTACT. A shell this thin and soft put its plate modes under 20 Hz, where the synth's
resonators barely decay and drifted toward full scale (the beach ball's knock peaked at 0.9, 97% of its
energy under 20 Hz, at the end of the clip). modes.ts now drops every mode under MIN_MODE_HZ (20 Hz) for
every model; no Keystone material or ammo had one. The inflated balls' wall modes are off as well
(ringDb -Infinity): a pressurised membrane is not a clamped plate, and the basketball's plates (now
20-60 Hz) read as a murmur where without them it reads Knock. What is not modelled: a ball's air cavity (a basketball's
"ping") and a preset's own size for a weapon shell (a shell takes the nearest ammo slot's size: B2's
ram, 1 m across, sounds as the 0.5 m cannonball). The judge separates these less than it did stone
from ice; the baseline here is silence.

## Kapla (A9, 2026-11-07)

Pine (Kapla, 117 x 23.4 x 7.8 mm) was the one material A1 left alone: a free plank's loss factor, eta 0.01,
which is the judge's glass band (step 1). Every step read as glass or bells: knock 0.49, clatter 0.50, tumble
0.38, and a 2,000-plank topple of the viewer's S15 tower (capture-cli scene=kapla planks=2000, 23,726 impacts)
0.39 with "Jingle bell, Glass, Bell" on top.

The real set's pine is the classic plank damped as in a pile, under the energy law (the other real materials'):
`{ ...classic pine, law: 'energy', eta: 0.045 }`. Contact with neighbours carries a plank's energy away as it
does a block's (2-15x a free body's); 0.045 is the middle of the plateau. Real share, level-free, judged on
the ladder (dist 0.6 m) and on two topples (2,000 and 3,000 planks):

| eta, roughness | knock | clatter | tumble | topple 2k | topple 3k | topple top classes |
|---|---|---|---|---|---|---|
| 0.01 (classic) | 0.49 | 0.50 | 0.38 | 0.39 | | Jingle bell, Glass, Bell |
| 0.03, smooth | 0.83 | 0.70 | 0.42 | 0.86 | | Rattle, Snake, Glass |
| 0.04, smooth | 0.83 | 0.72 | 0.56 | 0.90 | 0.87 | Crack, Scrape, Coin, Rattle |
| **0.045, smooth** | **0.81** | **0.71** | **0.56** | **0.92** | **0.90** | **Crack, Scrape, Breaking, Rattle** |
| 0.05, smooth | 0.79 | 0.69 | 0.58 | 0.93 | 0.92 | Crack, Scrape, Breaking / Fart |
| 0.06, smooth | 0.77 | 0.67 | 0.60 | 0.97 | 0.94 | Crack, Fireworks / Explosion |
| 0.045, roughDb -6 | 0.82 | 0.69 | 0.65 | 0.89 | 0.87 | Snake, Rattle / Fireworks |
| 0.08, roughDb -6 | 0.76 | 0.72 | 0.68 | 0.99 | | Fireworks, Explosion, Firecracker |

The topple columns were rendered without the background bank, 8 voices a frame of ~140 impacts (see "Judge
fix: viewer captures"). With the bank, 2k / 3k: classic 0.30 / 0.56, eta 0.01 0.60 / 0.83, 0.03 0.79 / 0.97,
0.04 0.90 / 0.98, **0.045 0.94 / 0.99**, 0.05 0.97 / 0.99, 0.06 0.99 / 0.99, 0.045 roughDb -6 0.96 / 0.97,
plaster at 0.3 m 0.98 / 0.99. The order holds and 0.045 stands (it is chosen on the ladder, where the
plateau is). But every eta from 0.04 now tops out as Fireworks, Explosion, Scrape: a topple's thousands of
small clicks through the bank are a dense crackle, as the stone city's are. That is a listening item, not
a judge failure (fireworks are among the control's real recordings).

Knock and clatter read as wood (wood share 0.43-0.46, the highest of the four materials, with Tick and "Inside,
small room" on top, which is what real wood on wood gets: DiffImpact, step 2). Above 0.05, or with contact
roughness, the topple turns to fireworks, as stone grit did on a tower (step 3); planed wood is smooth, so pine has no `roughDb`.
real1 and classic keep the free plank (the classic set still hashes as G6's).

The voice cap. The 2k topple posts about 140 impacts a frame; the tap plays the 8 loudest as voices and the rest
through the background bank. With 32 voices the same topple reads Fireworks, Explosion: more of the loudest
hits as their own sharp pops. The game and the viewer keep 8.

**In the game.** B5 Kapla Spire (T-B5A to T-B5C: 2,884-3,106 planks of 1.5 x 0.3 x 0.1 m at h 0.3) is built of
plaster, so its planks sounded as plaster cubes at the level's edge. A Kapla plank is now its own slot
(sound-map.ts `KAPLA_SLOT`): a plaster box in a Kapla plank's proportions, 15:3:1 within 2% (`isKaplaPlank`).
That is every plank of B5's towers and the build tool's Plank (5 h x h x h/3), and no other body in any level
(a scan of every series). The slot plays a real plank (its timbre) with the on-screen plank's energy: under
the energy law a mode's amplitude goes as the square root of the body's mass, which goes as length^3 at fixed
proportions, so `levelDb = 30 log10(5 h / 117 mm)`, +33.2 dB in B5. On a pile of impacts 10 m off it
plays 0.9 dB under the plaster it replaces (test), and B5's grenade shot within 0.4 LU of it.

Rejected: the plank at the game's size. A 1.5 m pine beam rings from 194 Hz, a marimba bar, and the judge
heard exactly that on every step (knock: Music 0.46; clatter: Music, Drum machine; topple: Music, Heart sounds;
real share 0.02-0.19). B5's own copy calls it a toy tower in slow motion (13x real Kapla, falling 3.6x slower),
so it sounds as the toy. A new Keystone wood material (physics, render, editor) would also do it; it is a
bigger change than the sound needs, and B5 renders plaster for now.

Option `keystone.kaplasound` = `pine` (default) | `plaster` (the old sound); the classic set (keystone.sound=classic)
always plays plaster, as G6 did.

Cost (cost-cli, this VM; a sanity check, not an M5 number): the 2k and 3k topples take 4.0% and 4.9% of a core
as real pine, against 6.5% and 8.2% as classic pine and 6.6% and 8.0% as plaster at 0.3 m (what B5 played):
shorter decays leave fewer resonators ringing. Inside A3's budget.

Clips for listening (before, after): /mnt/project-files/sound/kapla/ (knock, clatter, the 2k topple, B5's
grenade shot level-free).

## Band-limited clicks (A7, 2026-11-07)

The click of a body's own acceleration is one sine cycle as long as the contact (modes.ts clickKernel).
Sampled at mid-sample, a cycle of D samples is not the continuous pulse: against its exact spectrum,
|C(w)| = w0 |2 sin(w D / 2)| / |w0^2 - w^2|, octave by octave (dB):

| D (samples) | 0.5-1 kHz | 2-4 kHz | 8-12 kHz | 12-16 kHz | 16-20 kHz |
|---|---|---|---|---|---|
| 2.5 | +11.4 | +1.6 | -0.9 | -0.2 | +1.0 |
| 3 | +1.6 | +1.6 | +1.2 | +0.6 | -1.0 |
| 8 | +0.2 | +0.2 | -0.3 | -1.6 | -3.3 |
| 16 | +0.1 | 0.0 | -0.6 | -1.6 | -3.7 |
| 24 | 0.0 | 0.0 | -0.7 | -1.7 | |
| 64 | 0.0 | 0.0 | | | |

(blank: under 1e-4 of the click's energy). It droops in the top octaves and aliases under ~5 samples. The bank's
click, a resonator with a whole-sample period of at least 4, was further off: at Kapla-size stone, +9 dB at
16 kHz against the voice's. The real set's Kapla planks (12-24 samples), ice pieces at B5's h (20-29) and
small stone blocks (8 samples at Kapla size) click in that range.

New key `clickBand`: `'sampled'` (absent, G6's) or `'limited'`. Limited, a click under BL_CLICK_MAX (64)
samples is the pulse convolved with a Kaiser-windowed sinc (cutoff 0.45 of the rate, half-width 24 samples,
beta 8; modes.ts clickShape): within 0.3 dB of the continuous spectrum in every octave to 20 kHz, with no net
pressure. Shapes are quantised to 0.5% of D and cached (a few hundred at most, ~30 us each). The bank plays
such a click as the same kernel, overlap-added per (bin, sector) (engine.ts firClick), so a bank click and a
voice click are one kernel to within one gain (0.17 dB, the bank's level on every click, sampled or not).
A band-limited click starts 24 samples (0.5 ms) after its onset; a voice's modes start at the onset.

Every material of the real set is limited; real1 and classic keep G6's sampled clicks (classic still hashes
bit for bit). The judge barely moves, as a fix this far up should: the 2k Kapla topple 0.92 -> 0.95, the pine
ladder 0.69 -> 0.71 (mean of knock, clatter, tumble), stone and ice at 5 cm within 0.01.

Cost (cost-cli on the 2k Kapla capture, 23,726 impacts, this VM, best of 5; sampled -> limited): pine at
Kapla size 3.9% -> 4.2% of a core, stone at 0.117 m 5.3% -> 5.3%, stone at 0.5 m 10.6% -> 10.4%, ice 12.6%
-> 12.5%, acrylic 19.7% -> 19.6%. Within the run-to-run noise except pine's +0.3 points (its bank rows are
FIRs of 60-70 taps instead of 20-sample resonators); inside A3's budget.

## Room (A5, 2026-11-07)

A1 found that a room made the old sound worse: a dry modal source in a room is a drum kit in a room. With
the source fixed (the real set, A9, A7), A5 adds the room as an option, `@tb/audio` room.ts, after the dry mix
and before the low cut and the limiter. It has two parts:

- **early**: sparse reflections off what is far away (a hall's roof and walls; a tree line and a building
  outdoors). They are taps on a delay line of the mono mix after a diffuser (four Schroeder allpasses, g 0.6),
  each low-passed for the air it crossed and sent to one side.
- **late**: a feedback delay network (Jot): eight prime-length delay lines mixed by an orthonormal Hadamard
  matrix (a fast Walsh-Hadamard transform). Each line has a one-pole loop filter whose gains at DC and at 8 kHz
  are exactly rt60's and rtHigh's for its length (`loopFilter`). It is fed by the diffuser after a pre-delay,
  and its two outputs are orthogonal rows, so the sides are decorrelated (L/R correlation 0.0).

Levels are energies against the dry sound: an impulse through each path carries `earlyDb` and `lateDb` of its
energy (measured once per room, `pathEnergies`). So `lateDb` is the negative of the direct-to-reverberant
ratio. The room idles, at zero cost, once its tail is 100 dB down after the input stops. Running, it takes
0.6-0.8% of a core on this VM.

| preset | rt60 / at 8 kHz | early | earlyDb | lateDb | measured RT60 125 Hz .. 8 kHz (octaves) |
|---|---|---|---|---|---|
| hall (Grand Hall, size x) | 3.0 / 1.3 s | roof 0.17 s, side walls 0.18-0.21, end walls 0.42-0.45 | -14 | -6 | 2.92 3.01 3.03 2.90 2.66 2.19 1.50 |
| outdoor (size x as far) | 0.7 / 0.2 s | tree line 0.09 s (left), building 0.16 s (right) | -16 | -22 | 0.74 0.70 0.67 0.60 0.50 0.34 0.23 |

The hall's listener stands at about half its critical distance (0.057 sqrt(V / RT60) = 17 m), so the late part
is 6 dB under the direct sound. Echo density (the share of samples over one sd per 20 ms, 1 = Gaussian) is 0.5
at 0.1 s and 0.9-1.0 by 0.2 s.

**The judge, with a control.** The real share only means something against real sounds in the same room. So
each preset was judged on 24 real recordings put through it: ESC-50 door knocks, glass, footsteps, cans,
mouse clicks and fireworks, 4 of each. The synth was judged on 7 game mixes (L1-L5, the 2k Kapla topple, the
city of stone at 0.5 m) and on 6 ladder clips (clatter and tumble for stone, plaster and ice at 0.5 m, 10 m off).

| room | real recordings | game mixes | ladder |
|---|---|---|---|
| off (dry) | 0.88 | 0.90 | 0.77 |
| **outdoor** | **0.89** | **0.94** | **0.93** |
| hall | 0.60 | 0.84 | 0.76 |

- The game-mix column's Kapla topple and city were rendered without the background bank (see "Judge fix:
  viewer captures"). With it, off / outdoor / hall: city 0.98 / 0.99 / 0.98, Kapla topple 0.94 / 0.97 /
  0.97. Outdoor stays the default.
- **Outdoor leaves real recordings as they were** and lifts the synth on every set. L3, a glass-and-stone
  scatter, goes from 0.75 ("Silence, Sound effect, Tick") to 0.91 (Glass, Chink); clatter of plaster goes from
  0.68 (Animal, Inside small room) to 0.97 (Coin, Crackle, Crack).
- **The hall costs real recordings 0.28.** The judge hears a big hall's impacts as percussion: a door knock
  drops from 0.67 to 0.22, glass from 0.96 to 0.49. The synth loses only 0.06 there. So the hall is the
  judge's blind spot, not the synth's fault, and it waits on listening.

How the presets were found, on the control (real recordings, mean real share):

- The first outdoor preset had a ground reflection at 3 ms and seven echoes out to 0.68 s: 0.63. The ground
  reflection alone, with no echoes or tail, scored 0.59.
  - Without the ground reflection, two echoes and the tail: 0.88.
  - The ground reflection is left out on purpose. Its delay is the path difference, 2 h_s h_l / d: 0.4 ms for a
    block at 0.25 m seen from 5 m up and 20 m away, 4 ms for one at 3 m. One fixed delay puts one comb on
    hundreds of impacts at every height, where the true sum is incoherent, a 1-3 dB lift at low frequencies.
  - The floor in the hall is left out for the same reason.
- Seven echoes read as a rhythm (door knocks 0.67 to 0.18); two do not.
- In the hall, the late level against the control: 0 dB 0.41, -6 dB 0.55, -12 dB 0.60 (all without the floor).
  - The game mix at those levels: 0.75, 0.82, 0.89.
  - -6 dB, half the critical distance, is where a camera over the table stands. -12 dB would put it 4 m from
    the tower.

**Alternatives weighed:**
- Convolution with a measured or modelled response: exact, but a 3 s response is 144k taps. A partitioned FFT
  convolution costs about 10x this, and recorded responses would have to come from the Mac, with their licences.
- Schroeder/Freeverb comb banks: cheap, but they ring metallic on impulsive input, which a collapse is.
- Velvet-noise convolution: thousands of taps a sample for a dense 3 s tail.

**Options:**
- Game: `keystone.room` = `outdoor` (the default: the game is played in an open field) | `hall` | `off` (dry,
  as before). The classic set always plays dry.
- Viewer: `snd.room` = `auto` (the real look's hall at its `real.hallSize` when the scene is in it, else
  outdoor) | `off` | `outdoor` | `hall`.
- The renderers take `room=` `size=` `tail=` (sound-sweep-cli, ladder-cli). The judge now also reports
  AudioSet's environment labels per clip (`environment`). They barely move with any room (under 0.1), so they
  are not a criterion.

Not covered by the room: blasts and the launch whump play outside the worklet, dry; the blast has its own echo
rumble (A6).

Clips at game level, for each of L1, L3, L5, the Kapla topple and the stone city: off, outdoor and hall, in
/mnt/project-files/sound/room/.

## Space (A8a, 2026-11-07)

Where an impact is heard. Before A8a, the game set each impact's level by distance (A = dv / distance) and its
pan by angle (sin of the angle off the camera's axis, equal power). Captures of L1-L5, the Kapla topple and the
stone city show two gaps:

| scene | impact distance p10 / p50 / p90 (m) | mean pan, abs | bank energy per sector (left to right) |
|---|---|---|---|
| L1 | 8.6 / 9.3 / 11.4 | 0.08 | 0, 0.44 at -0.07, 0.56 at +0.09, 0 |
| L3 | 5.6 / 6.5 / 8.3 | 0.08 | 0, 0.57 at -0.07, 0.43 at +0.09, 0 |
| Kapla topple | 6.1 / 6.4 / 6.6 | 0.02 | 0, 0.54 at -0.02, 0.46 at +0.02, 0 |
| stone city | 91.3 / 98.3 / 109.6 | 0.05 | 0, 0.48 at -0.05, 0.52 at +0.04, 0 |

1. **Pan.** The bank's four sectors played at their fixed centres, pan -0.75, -0.25, 0.25 and 0.75. A
   tower's impacts sit within 6 degrees of centre, so the bank played a centred tower as two points at 14.5
   degrees either side: 3.5 dB off at a pan of 0.02. The voices were exact.
2. **Distance.** The room (A5) ran on the finished mix, so it was as loud against the dry sound at 6 m as at
   98 m.

The fix, behind `setSpace` in the engine:

- **Pan:** the frame gains `space`, three sums per sector over its impacts with weight w = A^2: sum w, sum w
  pan, sum w distance (`frame.ts`, `tap.ts`). Each sector plays at its impacts' mean pan, smoothed over
  `SPACE_TAU` = 50 ms with gains ramped across the block. A sector that was silent takes the new pan at once,
  so the first hit does not glide in. Frames without the sums play at the centres, as before.
- **Late reverb:** the room gets its own mono send instead of the mix. An impact at distance d goes into it
  at (d / dref)^law, where dref is `SPACE_DREF` = 10 m (about the levels' median) and the cap is
  `SPACE_CAP` = 32. The law is the room's own `distanceLaw`:
  - **hall, law 1:** a diffuse field, whose level does not fall with the source's distance (Sabine). The dry
    sound falls 6 dB per doubling and the reverb holds.
  - **outdoor, law 0.5:** in the open, scattered sound is not a field that holds its level. It gains 3 dB on
    the dry sound per doubling. The 0.5 was chosen on the judge's control, not measured.
- **Early reflections:** these follow geometry whatever the law. A reflection with extra path p (its delay x
  343 m/s) arrives at d / (d + p) of the direct sound, which the preset holds at dref. So each tap is scaled
  by (dref + p) / (d + p) x (d / dref)^(1 - law), with d the mix's mean distance (`RoomVerb.setDistance`).
  The first fix, d / dref for everything, put the outdoor echoes of a city 98 m away 4 dB over the direct
  sound. No real echo does that, and on the judge the city fell from 0.99 to 0.90.
- **Cost:** the voices' modes sum into one buffer before they are panned, so with a room, space is cheaper
  than without it on this VM: city 11.1-11.4% of a core against 12.4-12.9%, and the Kapla topple 5.2%
  against 5.6%. With the room off there is no send.
- **Off, or the classic set:** plays exactly as before A8a.

**Judge** (mean real share; the control is the 24 real recordings put through what space does to a source at
that distance, `ctl.py` overrides on `wet.ts`). Re-judged with the city's and the Kapla topple's bank (see
"Judge fix: viewer captures"; the first table had game 0.932 / 0.934 / 0.805 / 0.798 and city 0.99 / 0.99 /
0.99 / 0.74):

| | outdoor, space off | outdoor, space on | hall, space off | hall, space on |
|---|---|---|---|---|
| game mixes (L1-L5, Kapla) | 0.934 | 0.938 | 0.813 | 0.799 |
| stone city (98 m) | 0.99 | 0.99 | 0.98 | 0.64 |

| control | at dref | 6.4 m | 17 m | 98 m |
|---|---|---|---|---|
| outdoor | 0.894 | 0.888 | 0.883 | 0.829 |
| hall | 0.597 | | 0.530 | 0.464 |

- **Outdoors space is neutral on the judge**, as it should be: the judge hears a mono mix, so it cannot hear
  where a sound is, and the distance law outdoors is gentle.
- **The stereo image narrows to the tower.** L/R correlation rises from 0.905 to 0.953 on L3, and from 0.931
  to 0.954 on the Kapla topple.
- **The hall at 98 m is a listening item.** The city goes 0.98 -> 0.64, while real recordings at 98 m in
  the hall drop to 0.46. A city 98 m off in a hall is not a scene the game has; the viewer's auto room puts
  the hall only under the real look's hall.

**Alternatives weighed:**
- Eight or more bank sectors: doubles the bank's rows, and still leaves 0.125 of pan error at centre.
- Sectors spaced by angle: a duel's side view lands in the coarse ones.
- One room gain from the mix's mean distance: a near and a far impact in one mix would be equally wet.
- A room per distance band: 0.6-0.8% of a core each, and a scene spans 2x in distance or less.
- Left out, with reasons in the A8a proposal:
  - sound delay over distance: at most 33 ms of spread inside a level, eaten by AV-sync budget;
  - interaural time differences: about 50 us at these angles;
  - HRTF: headphones only, needs measured data, and the judge cannot hear it;
  - a ground reflection: A5 already showed it combs.

**Options:**
- Game: `keystone.space` = 1 (default) | 0. The classic set never uses it.
- Viewer: `snd.space` = 1 (default) | 0, in the panel, the URL and the scene file.
- The renderers take `space=1 dref=10` (sound-sweep-cli). cost-cli takes `room=` and `space=`.

Clips (before / space) for L3, L5, the Kapla topple and the city, plus the city in the hall:
/mnt/project-files/sound/space/.

## Air (A8a step 3, 2026-11-07)

Air takes a sound's top end over distance. ISO 9613-1:1993 gives the pure-tone absorption of the atmosphere,
alpha(f) in dB/m (`air.ts` `airAlpha`, the standard's formula; the test checks it against its Table 1 at
20 C, 70% RH to 0.05 dB/km). The game's air is 20 C, 50% RH:

| | 1 kHz | 2 kHz | 4 kHz | 8 kHz | 16 kHz |
|---|---|---|---|---|---|
| dB/m | 0.005 | 0.010 | 0.028 | 0.105 | 0.364 |
| 10 m (a level) | 0.05 | 0.1 | 0.3 | 1.1 | 3.6 |
| 25 m | 0.1 | 0.3 | 0.7 | 2.6 | 9.1 |
| 98 m (the city) | 0.5 | 1.0 | 2.8 | 10.3 | 35.7 |

So it matters for the city and for long shots, and barely inside a level, which is what it should do: a far
collapse loses its sparkle, a near one keeps it.

**The filter.** The loss in dB goes about as f^2 d. One pole cannot follow that past ~3 dB: fitted at 8 kHz
for 100 m it takes 5.5 dB at 4 kHz, where the air takes 3.0. Two first-order sections with real poles and
zeros and unit gain at DC, multiplied into one biquad, do. They are fitted minimax (`air-cli.ts`, Nelder-Mead
from nine starts, then warm passes from each neighbour) on 60 log-spaced frequencies from 500 Hz to 20 kHz,
where the standard's loss is under 20 dB (beyond that the band is gone either way). The fits are a table,
`air-table.ts`, 123 entries at 5% steps from 1 to 400 m; fitting in the audio thread would take ~10 ms.
Worst error against the standard: 0.07 dB at 25 m, 0.14 at 50 m, 1.6 at 100 m, 1.9 at 200 m, 2.25 dB
anywhere. The table is fitted at 48 kHz; at another rate the filter takes the entry for d (rate / 48 kHz)^2
(the loss is ~f^2 there), within 0.2 dB to 50 m at 44.1 kHz and 2.5 dB at 96 kHz.

**In the engine** (`setAir`, with space on): each voice is filtered for its own distance, each bank sector for
its impacts' mean distance (from the frame's space sums, smoothed as its pan is), before the pan and the
room's send, so the reverb hears the far sound as the listener does. Moving to another entry ramps the
coefficients over the next block: real poles keep (a1, a2) in the stability triangle, which is convex, so
every filter on the way is stable. Without the ramp, a 3 kHz tone swept from 5 to 200 m clicked at the 47 m
step (second difference 1.41x the tone's); with it, 1.0x.

Measured on the city (98 m, room off), air on against off, by octave from 1 kHz: -0.5, -2.4, -6.2, -14.3,
-31.8 dB. The standard at the band centres: -0.6, -1.6, -5.4, -19.5, -51. The top two fall short where the
fit stops (loss over 20 dB); 2 kHz takes 0.8 dB too much (the 100 m fit's error).

**Judge** (outdoor room, space on; mean real share): the game mixes 0.938 without air, 0.938 with; the city
0.99 and 0.99, the Kapla topple 0.99 and 0.98. Control: the 24 real recordings through the same air drop
from 0.884 dry to 0.878 at 25 m and 0.860 at 98 m, so the judge marks real sound down a little for losing
its top, and the synth holds. Neutral, as it should be: air is a physical fact, and the judge cannot hear
distance. **Cost** (cost-cli, this VM): within noise, city 11.3-11.7% of a core, Kapla 5.2-5.4%.

**Alternatives weighed:**
- One pole per distance: 2.5 dB off at 4 kHz by 100 m (above).
- A filter per distance band in the bank: sectors already carry their distance; bands would multiply rows.
- Fitting on the fly: ~10 ms a fit, and nothing to gain over a 5% table.
- Humidity and temperature as options: the standard covers them, but nothing in the game sets the weather;
  `airAlpha` takes both, the table is one climate.

**Options:** it acts only with space (it needs each impact's distance), and the classic set never uses it.
- Game: `keystone.air` = 1 (default) | 0, in the panel.
- Viewer: `snd.air` = 1 (default) | 0, in the panel, the URL and the scene file.
- The engine has `setAir(on)`; the host's `space` message takes `air`. Renderers: `sound-sweep-cli air=1`,
  `cost-cli air=1`.

Clips (space, space + air) for L3, L5, the Kapla topple and the city: /mnt/project-files/sound/air/.

## Judge fix: viewer captures (2026-11-07)

`sound-sweep-cli` rendered the viewer's captures (the city and the Kapla topple, from `capture-cli`) with no
background bank. Their JSON carried no `materials` or `sectors`, the sweep spread the record as it was, and
the engine's bank loops ran to `undefined`: only the 8 foreground voices a frame played, and the space sums
were never read. The game levels (sound-cli frames, which carry both) were not affected. It showed up as the
air filter taking 1.6 dB at 8 kHz off a 98 m city, where a single stream lost 14.

The fix: `framesFrom` (frame.ts) reads frame records for every renderer, taking a record without them as
capture-cli's tap (1 material, 4 sectors) and refusing one whose arrays do not fit; capture-cli now writes
both; and `CollapseEngine.push` refuses a frame without them instead of playing its voices alone.
Re-judged with the bank, no decision changed: the corrected numbers are under Realism (the viewer city),
Kapla (the topples), Room (the game mixes) and Space. Clips that had the same fault were re-rendered
(sound/space city and Kapla, sound/kapla topple).

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
7. S7 ground and hall: reverb tied to `real.env`, done as A5 (Room above; the viewer's snd.room=auto). Floor resonators not yet. Distance in the room and stereo by impact: A8a (Space above); air absorption: A8a step 3 (Air above).
8. S8 granular non-modal layers: stone grit done (2026-11-01, Grit above); splinters and rubble sliding not yet.
9. S9 calibration from recordings (example-guided, Ren et al. 2013). The realism judge (2026-11-05,
   Realism above) is the objective half; recordings of the actual materials would pin the levels.
10. S10 M5 bench (`pnpm bench:audio`): audio-thread load and the tap's main-thread cost at 10k and 100k.
11. S11 game adoption, and ball and level materials. Done (2026-11-01, In the game above).
