# Stars on par levels

How the chamber levels (L1 to L5, `scoring: 'par'`) award stars, why the rule changed on
2026-11-06, and what was measured. Code: `packages/keystone/src/rules.ts` (`parStars`,
`levelScore`); audit tool: `pnpm keystone:stars` (`packages/keystone-lab/src/stars-audit-cli.ts`).
Outcome levels (B1 on, Undercut, trials) keep their cast thresholds (`outcome.ts`); see the last
section.

## The rule

| Play | Stars |
|---|---|
| Objective not met | 0 |
| Cleared | 3 − (strokes over par) − (1 if any heritage broke), never under 1 |

So, on a par-1 level: one clean shot is ★★★, two shots ★★, three or more ★. Breaking heritage costs
one star. On a par-2 level an ace (one shot) and par are both ★★★.

Leverage no longer gates a star. A clear in par with heritage intact and leverage at the level's
`lGold` or more earns the **gold-leverage badge**: "◆ Gold leverage" under the stars on the result
card (or, short of it, "◇ Gold leverage at ×0.71, in par, heritage intact"), "gold leverage" in the
door's best-play line, and `gold: true` in the progress record (kept once any play of that level
hash earns it). The score (the Leverage line), the tier banner and the lot sheet goals still use
leverage as before.

## Why it changed

Will, after the G9a playtest: "completing a round in one shot then getting 2 of 3 stars feels sad."
The rule before (design doc section 7) was: ★1 cleared, ★2 in par, ★3 in par with no heritage
broken *and* leverage ≥ lGold. Three things made that wrong rather than just strict:

1. **The gold line was set to miss one play in four.** lGold is the lower quartile of the leverage
   the par line's clean neighbours reach (`goldLine`). By construction about a quarter of the
   bot's own best par shots, nudged by a hair, earned ★★.
2. **Level 1's designed answer earned ★★.** On the reference engine L1's par line (one cannonball
   at the column seam) releases leverage 0.707 against lGold 0.71 (`goldLine` rounds the quartile
   down to two figures; the nominal shot sits under it). The first thing the game teaches, done
   exactly as designed, got two stars.
3. **Fewer strokes could earn fewer stars.** On L3 (par 2) an ace with modest leverage was ★★
   while a high-leverage two-shot par was ★★★: the Ace bonus said one thing and the stars another.

And one thing made it worse since: shots now launch from 2 h over the structure's top by default
(#214). That makes a shot that knocks the crowns off the top natural, and such a shot releases
little potential energy, so a one-shot clear from the new launcher sits well under lines cast from
the old 2 h launcher. The launcher's extra height is also potential energy leverage does not charge
(not re-par'd, per Will), so leverage across launch heights is no longer like for like.

## Principles the rule is held to

Tested in `packages/keystone/test/rules.test.ts`.

- **Monotone.** Fewer strokes, or less heritage broken, never earns fewer stars.
- **The best play tops out.** A clear in par with heritage intact (any one-shot clear of a par-1
  level, any ace) is always ★★★.
- **Legible.** Every star is a count the player sees on the result card (strokes against par,
  the Heritage line), stated up front on the door ("…in 2 shots", "…in par (1 shot), heritage
  intact"). No hidden number takes a star away.
- **Every star reachable on every level.** On a level with no heritage the three stars are par,
  bogey and worse. (With leverage no longer gating, keeping ★★ for "in par" would leave it
  unreachable on L1 and L5, which have no heritage.)
- **No record demoted.** The new rule gives at least the old rule's stars for every play (tested
  over every strokes × par × heritage × leverage combination), so stored progress stays true; a
  record kept from before shows its old stars until the level is played again.

## Alternatives considered

- **Keep leverage for ★3, waive it under par or in one shot.** Fixes the one-shot case, but
  leverage would then gate ★3 on L3 (par 2, two-shot par) and never on L1, L2, L4, L5 (par 1):
  a rule that means different things per level, and still hides a star behind a number.
- **★3 by a cast score threshold (as B2's outcome stars).** The score includes strokes, leverage
  and combo, so a one-shot clear can still miss it; it moves the problem rather than fixing it.
- **Re-par par-1 levels to 2,** so one shot is a birdie. Changes the golf stamps (every one-shot
  clear an ACE) and the Strokes line for no gain over changing the rule.
- **Recast lGold** (lower quartile → 5th percentile, or from the high launcher). Fewer sad
  one-shots, never none: any line below which ★3 is lost leaves some clean one-shot clears
  under it, and the uncharged launch energy would make the line depend on launch height.
- **Keep ★2 for in par and ★1 for any over par** (only drop the leverage gate). On a level with
  no heritage ★2 could then never be earned. Bogey = ★★ is the gentler, standard step.

## Audit: one-shot clears on the reference

`pnpm keystone:stars --every 4 --powers 60,100` (f64 AVBD reference at Keystone's settings, the
engine par lines are pinned on): the bot's candidate shots (every face cell of every block every 4
courses, at 60% and 100% power, plus anvil drops over every top cell), each played as a single
shot from the level's own launcher (2 h) and from the game's default high launcher (2 h over the
top). Stars are for that one shot; "old" is the rule before 2026-11-06. Full output:
`/mnt/project-files/stars/one-shot-audit-ref.txt` and `.json`.

| Level | Launch | One-shot clears | Breaking heritage | Clean leverage P25/P50/P75 (lGold) | Old ★★ / ★★★ | New ★★ / ★★★ | Gold badge |
|---|---|---|---|---|---|---|---|
| L1 (par 1) | its own, 2 h | 0 of 128 | – | – (0.71) | – | – | – |
| L1 | high, 12 h | 0 of 128 | – | – | – | – | – |
| L2 (par 1) | its own, 2 h | 58 of 408 | 32 | 1.84/2.24/2.41 (1.5) | 32 / 26 | 32 / 26 | 26 |
| L2 | high, 15.25 h | 95 of 408 | 38 | 2.23/2.65/3.86 | 38 / 57 | 38 / 57 | 57 |
| L3 (par 2: these are aces) | its own, 8 h | 12 of 144 | 12 | – (1.3) | 12 / 0 | 12 / 0 | 0 |
| L3 | high, 10 h | 10 of 144 | 10 | – | 10 / 0 | 10 / 0 | 0 |
| L4 (par 1; the clears are anvil drops) | its own, 2 h, and drops | 7 of 171 | 0 | 0.17/0.18/0.19 (0.18) | 3 / 4 | 0 / 7 | 4 |
| L4 | high, 8 h | 0 of 120 (launched balls) | – | – | – | – | – |
| L5 (par 1) | its own, 2 h | 95 of 240 | 0 | 0.58/1.01/5.83 (5) | 66 / 29 | 0 / 95 | 29 |
| L5 | high, 11 h | 89 of 240 | 0 | 0.53/1.25/5.98 | 62 / 27 | 0 / 89 | 27 |

Across the levels, 274 one-shot clears broke no heritage. The old rule gave 131 of them (48%) ★★. The new rule gives all 274 ★★★, and the 143 the old rule rated ★★★ all carry the gold badge.
Every ★★ left is a clear that broke heritage, under both rules.

- **L5 is where the old rule bit hardest**: 128 of 184 clean one-shot clears (70%) got ★★. A marble
  straight into the crown column clears at leverage 0.5 to 1; lGold 5 comes from the par line's
  neighbours, which topple more columns (the par line itself scores 12). The level's idea, the
  domino chain, still earns the badge.
- **L1:** no candidate clears in one shot from either height. Candidates aim at cell centres, and
  the par line hits the seam between two columns, which they never try (findings.md). The par line
  played alone: one shot, leverage 0.707, old ★★, new ★★★.
- **L2:** every clean one-shot clear was already over lGold; what costs a star there is the
  pavilion (heritage). The high launcher finds more clears (95 against 58) at higher leverage,
  plausibly in part from the launch height's potential energy, which leverage does not charge.
- **L3:** the only aces found break the heritage cubes beside the crowns: ★★ under both rules.
  No clean ace was found, so par 2 stands.
- **Pars:** in this candidate grid no level has a clean clear in fewer strokes than its par from either launcher, so
  none is re-derived.

## Outcome levels

Unchanged. B1 and B2 star on their cast metric (collapse, points) at the bot's T2 and T3, which the
HUD's Down bar marks while you play, and nothing ends an outcome level at one shot but the
player's own bank. Levels with no cast yet (U3 until its pull cast lands, the trials) earn only
the objective's star, and the door shows that star alone: one target row and one star slot, no
placeholder (2026-11-06, the agent playtest's PT7, which read "targets coming soon" as unfinished).
Undercut's crown levels U1 and U2 are par puzzles since then (undercut-bullet-time.md): three
stars in par, one less per pull over it.
