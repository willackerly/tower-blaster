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
