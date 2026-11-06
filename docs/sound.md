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
own. Band-limited kernels for both would fix it.

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

(Silence, Sound effect and Inside, small room are left out of the top classes.) The real share is the
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

Next: Will's one-word reads of the clatter, then a tower. The free-text describer (CLAP) still needs
huggingface.co.

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
8. S8 granular non-modal layers: stone grit done (2026-11-01, Grit above); splinters and rubble sliding not yet.
9. S9 calibration from recordings (example-guided, Ren et al. 2013). The realism judge (2026-11-05,
   Realism above) is the objective half; recordings of the actual materials would pin the levels.
10. S10 M5 bench (`pnpm bench:audio`): audio-thread load and the tap's main-thread cost at 10k and 100k.
11. S11 game adoption, and ball and level materials. Done (2026-11-01, In the game above).
