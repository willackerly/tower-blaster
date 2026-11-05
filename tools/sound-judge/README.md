# Sound judge

An objective check of how synthetic a render sounds, for picking sound materials and catching
regressions (docs/sound.md, Realism). Offline only: it needs Python and downloads, so CI does not run it.

It is YAMNet (Google's AudioSet classifier, 521 everyday-sound classes) re-implemented in numpy in
`judge.py`; `fetch.sh` downloads only its weights. Each clip gets three grouped scores, the mean over
its loud 0.96 s windows of the class probabilities in each group:

- **real**: impact events (Smash/crash, Breaking, Thump/thud, Clatter, Knock, Crack, Wood, Glass, Explosion, ...)
- **electronic**: Synthesizer, Sine wave, Beep, Electronic music, ...
- **instrument**: Music, Musical instrument, Marimba/xylophone, Wood block, Bell, Percussion, Drum, ...

and the **real share** real / (real + electronic + instrument). The judge is level-free (each clip is
normalised), so a change that only makes things louder cannot score.

Calibration on ESC-50's real recordings (folds 1-2, 16 clips a category, fetched to `ref/`), mean real
share: footsteps 0.98, fireworks 0.95, glass breaking 0.93, can opening 0.84, mouse click 0.75, door
knock 0.68, with the right top classes (Walk/footsteps, Explosion/Fireworks, Glass/Shatter, Knock);
alarm clocks 0.07 and church bells 0.00 (Alarm, Bell). G6's game collapse on L1-L5 scores 0.19 with
"Music, Plop, Synthesizer" on top; the real set scores 0.81 (docs/sound.md, Realism).

```sh
python3 -m venv .venv && .venv/bin/pip install -r tools/sound-judge/requirements.txt
sh tools/sound-judge/fetch.sh
# capture the par lines once, then render variants and judge them
tsx packages/game/src/sound-cli.ts levels=L1,L2,L3 frames=/tmp/frames
tsx packages/game/src/sound-sweep-cli.ts from=/tmp/frames out=/tmp/wav name=classic set=classic only=0
tsx packages/game/src/sound-sweep-cli.ts from=/tmp/frames out=/tmp/wav name=real only=0
.venv/bin/python -I tools/sound-judge/judge.py /tmp/j.json /tmp/wav/*.wav tools/sound-judge/ref/*.wav
.venv/bin/python -I tools/sound-judge/judge.py --summary /tmp/j.json
```

Each clip also gets **material shares** (wood, glass, metal, mineral) from AudioSet's material
labels; AudioSet has no stone class, so mineral means Crack, Clatter, Rattle, Crushing, Smash. The
real share rewards any real impact, so a set can score high and still sound like the wrong material
(docs/sound.md, Material identity). `packages/audio/src/ladder-cli.ts` renders the listening ladder
(knock, clatter, tumble) per material for it.

A classifier is not an ear: it is a guard against "sounds like an instrument", not a target to
maximise. Values were picked on plateaus of the real share, never on peaks, and only where the
physics says they belong (docs/sound.md). Listening is still the last word.
