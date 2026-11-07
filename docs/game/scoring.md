# Scores and leverage (PT9, PT16)

The agent playtest (round 1, `docs/game/agent-playtest-1.md`) found the result card, the HUD and a
chip beside the level's title showing three different numbers that all looked like leverage, a card
calling a round "Brute" beside the gold-leverage badge it had earned, totals far below zero (B2
-15,361), stroke points on rounds that never cleared, and a solo score computed under every duel.
This page is the rule set after the fix (2026-11-06).

## One leverage

**Leverage** is the potential energy a shot releases (mJ) per joule it is charged (launch energy plus
a weapon's nominal yield): `leverage(dPE_mJ, ke)` in `packages/keystone/src/rules.ts`.

- **A shot's** is its own release over its own energy, measured from the state it went in on to its
  settle, or to the state the next shot was fired from when that shot cut it (rapid fire, Bullet
  Time). `ShotOutcome.leverage`, the per-shot lot goal ("one shot that brings down 3x its own
  energy", `bestLeverage`) and the in-flight tier banners read it.
- **A round's** is `roundLeverage(shots)`: the shots' releases summed over their energies summed,
  clamped at 0. The card on par **and** outcome levels (`levelScore`, `outcomeFacts`), the gold
  badge, the lot sheet's round `leverage` fact and the HUD all read this one function.

**The HUD** shows the round's figure, which ends equal to the card's (`Session.roundLeverageNow`:
the closed shots plus the one in flight, its release so far). From the second shot on it shows this
shot's beside it, labelled "this shot". A test checks HUD final = card for one shot, several shots,
a frozen cut-in and an outcome level (`packages/keystone/test/scoring.test.ts`).

**The title chip** the judges read as a third leverage (B1: "×0.84") was never leverage: it is the
slow-motion tag (physics running slower than real time, `pacing.ts slowTag`). It now reads "84% speed".

### Tiers from the level's gold line

Brute, Clean, Elegant and Keystone are named against the level's gold line (`levelGoldLine`:
`LevelDef.lGold`, else `DEFAULT_GOLD` on a par level): Brute under it, Clean from it, Elegant from 3x,
Keystone from 8x. The gold badge needs a round at or over the same line, so no card can show Brute
beside an earned badge (tested over L1-L5, any leverage, strokes and heritage). L5's line is 5, so its
tiers are exactly the old absolute floors (5, 15, 40); on L1 (line 0.71) a round of ×2.00 is now
Clean, not Brute. An outcome level without a line (B1-B3, U1-U3, trials today) names no tier and plays
no tier banner: there is no badge there to measure against.

### Alternatives considered

- **Round leverage as the telescoped drop, `(PE(start) - PE(now)) / energy fired`** (what outcome
  levels used). It also counts whatever falls between a settle and the next shot, which is more
  complete physically, but the par card, the bot's gold lines (`lGold` is a quartile of
  `score.leverage`) and every recorded par score were on the sum of shots; switching par would have
  moved every gold line by the between-shot creep. The difference is that creep only (a cut shot's
  next baseline is the very state it was cut on, so cuts telescope exactly), so outcome levels moved
  to the sum instead. B2's leverage points can move by a few points from it; its cast thresholds
  (770 and 3200 points) are far from that.
- **The HUD shows the last shot's leverage** (as before) with the card renamed "round". Two numbers
  that never meet at the end is what the judges flagged; the round's figure is the one the card and
  badge use, so it leads, and this shot's rides beside it.
- **Absolute tier floors kept, the badge renamed.** Every L1-L4 round stays "Brute" (their lines are
  0.18 to 1.5, under the old Clean floor 5): the label would still say nothing about the level.

## Totals and lines

- **A total never goes below 0** (`floorTotal`): the lines' sum, floored. Lines that cost points
  (Heritage, Footprint) are drawn red end to end on the card, so the cost is its own red line and is
  not hidden by the floor.
- **No stroke points on an incomplete round**: a par level's Strokes line is 0 unless the round
  cleared. A missed L4 with nothing hit now totals 0 (it scored 1,000).
- **Heritage shows the stars it cost**: `LevelScore.heritageStarsLost` (par: the star `parStars`
  takes for it, when it took one; outcome: the third star, only where the round reached the third
  star's threshold), shown on the card as "Heritage cracked: 1 star lost".
- B2 stars by points (`metric: 'score'`): flooring changes no star, since its thresholds are
  positive.
- **Aftershock's quake levels** (M7, docs/game/aftershock.md) have their own tally and metric. The
  tally (`outcomeTally`, `quake` facts) is Objective, Condemned (500 per crown down) and Heritage, with
  no Collapse or Leverage line, since both would pay for felling the protected towers too. Stars are
  on `metric: 'energy'`, the joules fired (`energyFired`, the very sum `roundLeverage` divides by),
  where lower is better (`lowerIsBetter`, shared with skyline by `atLeast`, beat-the-bot and
  `checkStars`). A quake's energy is computed from the shot, so the star lines read the same on every
  engine. Tiers and the gold badge do not apply: quake levels have no `lGold`.
- **Aftershock's retrofits** (M7b, docs/game/aftershock.md "Retrofit") have no condemned towers, so no
  Condemned line; when the objective is met a **Budget left** line pays 10 a block unspent
  (`OUTCOME_WEIGHTS.budgetLeft`). Stars are on `metric: 'built'`, the blocks placed (`placedCost`,
  `OutcomeFacts.built`), lower is better. A build level's stars and the game's progress are kept
  against the level as authored (`CompiledLevel.baseHash`), not the level as built.

## Duels

A Siege Table duel's round is **refereed**: the driver is built with `refereed: true`
(`DriverOptions`, from the game page whenever `env.duel` is set), and the session ends with
`refereedScore`: no lines, total 0, no stars, stamp `DUEL`, `refereed: true`. The duel's own result
(`Duel.result`, the duel card) is the outcome; the page's `result` handle no longer carries a solo
tally (the harness had read "1 star, 4,370, 28% DOWN" off a duel).

## Bullet Time par (with PT8)

On a level with a freeze budget (`LevelDef.freeze`), par for a round is `par + freezesUsed` (one per
cut shot): a frozen cut-in that clears keeps par, and the card says "freezes used 1/2"
(`LevelScore.freezes`). Levels without a budget are unchanged: a rapid-fire cut is a stroke.

## Parts par (Rube Lab, M10; any build level)

A level whose build block names a parts par (`BuildDef.par`: every Rube Lab level, docs/game/rube-lab.md, and
any build level that scores on what you place, such as Wavefront's Lay levels) has no strokes worth counting, so
`levelScore` takes the build's cost (`placedCost`, passed by the session) and scores the parts instead:
stars are `partsStars(cleared, spent, par)` (3 at or under the parts par, 2 within `ceil(1.5 par)`,
1 for any clear) less one for any heritage broken (never under one, `heritageStarsLost` as on par
levels); the stamp is PARTS PAR or +N PARTS (`partsStamp`); there is no gold; the card's sub line reads
"parts N / par P" in place of strokes (`LevelScore.parts`). `LevelDef.rube` is only Rube Lab's marker (its
plunger is the Go button); the scoring keys on `build.par` alone. The parts par is in the level hash, so
retuning it starts a new progress record instead of keeping stars earned under the old par.

## Mason's Trial robustness (M8)

A Mason level (`LevelDef.mason`, docs/game/masons-trial.md) is judged in 64 jittered worlds at once, and
`masonScore(def, passes, K, spent)` scores the count with two lines that sum to the total:
**Robust c/K** (round(500 c / K)) and **Budget left l/B** (round(500 (c / K) (l / B))), so a fully
robust build that spends its whole budget scores 500. The build is cleared at half its worlds or more
(`MASON_CLEAR`); uncleared is 0 stars whatever the points; cleared takes 1, 2 or 3 stars on the total
against the level's `mason.stars`, which are 0.9 of the recorded tier authors' points
(`keystone-lab mason-solutions.ts masonStarsFrom`). The stamp is ROBUST, STANDS or WOBBLY. The card
reads "c of K" from `LevelScore.worlds` (with the counts each star needs at this budget) and the budget
from `LevelScore.mason`. No leverage, gold or heritage star loss.

## Heritage on outcome levels (PT28)

Agent playtest round 2 (`docs/game/agent-playtest-2.md`, PT28) found B2 "Spare the Cathedral" stamping a gold
"18% DOWN" and giving a star and a highlighted Next to a round that broke 25 of the cathedral's 32 cubes
(-12,500, total floored to 0). On an outcome level heritage only ever cost the third star, so a round that met
the objective kept its first star and its gold stamp however much heritage it broke. The rule now
(`outcomeStars`, `outcomeScore` in `packages/keystone/src/outcome.ts`):

- **Broken heritage costs one star at every tier, down to none.** The stars are worked out as before (objective
  met, T2, T3), then one comes off if any heritage broke. A round that met the objective with heritage broken
  under T2 scores no star, so its card leads with Retry (`failedRound`) and the door still offers the level as
  not cleared. The card says "Heritage cracked: 1 star lost" (`heritageStarsLost`).
- **The stamp reads HERITAGE LOST** (red, `.stamp.s-heritagelost`) on any round that met its objective with
  heritage broken, in place of the gold "N% DOWN", "N% PULLED" or BEAT THE BOT. INCOMPLETE and TOPPLED stay as
  they are: a missed objective says so first.
- Par levels keep their rule: heritage is one flaw (`parStars`), the gold badge needs it intact, and the golf
  stamp stays. Rube Lab, Mason's Trial, Chorus and the fold and quake objectives already make heritage part of
  the objective or the clear test.

**What it moves, measured on B2's Metal cast** (`g5-cast-B2-s1x.json`, all 236 plays re-scored from their
recorded ends): three stars 26 before and after; two stars 83 to 75; one star 36 to 8; none 91 to 127. Every
play that changed broke heritage: the 28 that fell from one star to none broke 8 to 32 cubes (scores -888 to
-13,286), and the 8 that fell from two to one broke 1 to 4. No play with the cathedral intact changed. The cast's
gates do not move (`fair` counts the objective met, `skill` and `stable` the T2/T3 thresholds on the score), so
B2's stars and hash stand; the thresholds still separate the same plays. B2's showcase line spares the
cathedral on the GPU solver it was cast on (`big-levels-gpu.test.ts` now asserts heritage 0 on a real GPU; round
2's "the line cracks 3" was the line replayed on Rapier, where that round played the big levels).

**Tests:** `packages/keystone/test/scoring.test.ts` (PT28: B2's novice round, one cracked cube at every tier,
INCOMPLETE kept), `outcome.test.ts` (the star table), `packages/game/test/hud.test.ts` (the B2 card: red stamp,
red line, no star, Retry primary).

### Alternatives considered

- **Heritage caps the round at one star** (what `spectacle-mode.md` first specified). It still gives B2's
  novice a star and a forward button for flattening the cathedral, which is the complaint, and it treats one
  cracked cube like 32.
- **Heritage intact as part of the objective** (as the fold and quake objectives do). Any crack would make B2
  INCOMPLETE. On a 5,184-cube plaster town, 4 of 16 nudges of the best line (`g5-check-b2-line.json`) crack 4 to
  31 cubes, so one stray cube would cost the whole round; it would also move the cast's `fair` gate (share
  meeting the objective), which would mean recasting B2 on the Mac.
- **A second star off past N cracks.** It would grade the damage, but there is no evidence for any particular N,
  and the tally's -500 a cube already grades it in points (B2 stars by score).
