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

AUDIT_TABLE

## Outcome levels

Unchanged. B1 and B2 star on their cast metric (collapse, points) at the bot's T2 and T3, which the
HUD's Down bar marks while you play, and nothing ends an outcome level at one shot but the
player's own bank. Levels with no cast yet (B3 to B5, Undercut's U1 to U3, the trials) earn only
the objective's star and say "targets coming soon"; a clean minimum-pull clear of U1 is ★ of
three until a pull cast lands. Giving Undercut's crown levels a par-style fallback (they have
meaningful pars) is the follow-up, not done here.
