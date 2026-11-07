# Agent playtest round 2 (G9c)

Status 2026-11-07. Will is still away and delegated the calls. Round 2 runs round 1's harness (docs/game/agent-playtest-1.md) on main after the PT fixes. It checks every PT row's "next agent round" verify, measures Siege Table balance on the GPU solver, plays the new mode series, and turns what is left into ranked rows PT20 and up.

Played on main **f52dc5f** (2026-11-07, PRs to #248), with the harness changes of this PR. Merged since then, and so not in the main round: #246 (PT7, PT11, PT13: the trial prune, U1/U2 par puzzles and the B1 opener; still open when the round ran), #273 (PT3b: the opening camera clears the docked phone HUD), #265 (Wavefront W3-W5) and #275 (Fuse & Fold stays on settle v3). The supplement at the end replays what those PRs touch.

## Result in one paragraph

All 176 runs played to the end with no page error: desktop, phone and phone sideways; every rated level, all 30 trials, both Siege Tables, Bullet Time, three looks, and the new series Fuse & Fold (F1-F5), Aftershock (A1-A5) and Rube Lab (RL1-RL5). Mason's Trial and Chorus are not on the game page yet, so they were not played. **No round-1 behaviour that worked has regressed.** The round-1 fixes mostly hold:
- B2's first visit totals 0, not -15,361.
- The phone HUD is down from 45-51% of the screen to 26-30%.
- Retry clears the sparks.
- Bullet Time reads as frozen.
- One leverage number is used throughout.

Three verifies fail:
- **PT5's balance on the GPU solver.** Gold wins 17 of 20 decided D1 duels (85%, two-sided binomial p ≈ 0.003) and 12 of 18 D2 duels (67%), although the seat is fair (55% and 39% for whoever fires first).
- **PT14 on phones.** The pre-aimed opener shows "Out of reach" at load in 15 of 34 trial aim views.
- **PT3 on two levels.** L3's phone HUD grows after shot 1 (27.6% to 29.5%), and Aftershock's quake dial takes 35.1% of a phone.

Four independent Opus judges raised 97 issues: core loop, modes and phone, trials and looks, and the new modes. They found:
- **P0, Fuse & Fold never records stars for a player.** Its stars were cast on the f64 reference, the game plays on the GPU solver, and `onEngine` marks the level custom.
- **P0, the Fuse & Fold timeline panel covers the result card's buttons,** and on F4 it pushes the Plunger off a phone screen.
- **The new modes are built on the projectile HUD.** Power, Height, "click: fire" and an opener appear in modes with no projectile; Aftershock's opener plays the level's three-star quake. None of the three modes shows its goal in the world.

The ranked list below folds the 97 issues and the failed verifies into 19 rows, PT20 to PT38.

## Regressions against round 1

None. Every round-1 strength the judges listed ("keep") is still there, and every number round 1 measured is the same or better:

| Measure | Round 1 (2026-11-06) | Round 2 | Where |
|---|---|---|---|
| B2 first-visit total | -15,361 desktop, -3,054 phone | 0 and 0 (floored, PT16) | `B2-novice-*-result` |
| Phone HUD share of the viewport (portrait) | 45-51%, grew after shot 1 | 25.7-29.5%, same after shot 1 except L3 (27.6 to 29.5) | `report.json` `hudShare` |
| Negative totals | 8 | 0 | table below |
| Sparks and tints after Retry | still there | cleared | `L3-novice-desktop-09-after-retry` |
| Shots at the 30 s settle cap | 5 of 186 | B3 shot 1 (29.4 and 29.9 s, settle v3 until #272); none elsewhere | `report.json` `shots[].simS` |
| Duel ended by a novice hitting their own keep | D1 desktop, turn 2 | 0 of 24 GPU duels (own clicks 0) | `duel-gpu.log` |

The closest things to a regression are two residuals of round-1 rows, not breaks: L3's phone HUD still grows after shot 1, because "Heritage 1 cracked" wraps to a second line (PT3), and the phone shot-0 "Out of reach" warning (PT14). Both are folded into rows below (PT29, PT30).

## PT1 to PT19: the "next agent round" verifies

"Pass" means the round's captures or measurements meet the row's verify. "Test" means a unit or e2e test the row landed covers it and this round had nothing to add. Rows whose PR is still open are "pending" and are replayed in the supplement.

| Row | Verify (short) | Result | Evidence |
|---|---|---|---|
| PT1 | B2 first visit ≥ 0; objectives visible at the opening view | **Pass** | B2 desktop 1★ total 0, phone 0★ total 0; the opening view shows the crowns and the cathedral (`B2-novice-desktop-00-aim-view`). The total is 0 because of PT16's floor: the novice still cracks 25 heritage blocks (-12,500), see PT28. |
| PT2 | Effects follow damage; clear on Retry/Undo/load | **Pass** (reset); look review pending | No sparks or tints after Retry (`L3-novice-desktop-09-after-retry`). Three judges still saw dense sparks in settled frames (J1 #12, J2 #24, J4 #24). On SwiftShader the wall-clock spark density is overstated, so the Metal look review in PT2's verify decides. |
| PT3 | Phone HUD ≤ 30% and unchanged by shot 1; result buttons in view | **Fail** (2 of 30 phone runs) | Portrait 25.7-29.5% on every chamber, big, Undercut, Fuse & Fold and Rube Lab level, unchanged after shot 1, except L3 (27.6% to 29.5%: "Heritage 1 cracked" wraps, `L3-novice-phone-04`) and A1-A5 (35.1%: the quake dial is in the tray). Sideways 27.1% throughout. PT30 and PT25. |
| PT4 | No centred card before 1.2 s; Retry primary on a fail; forward button at a series end | **Pass** | INCOMPLETE cards lead with Retry (`B1-novice-desktop-07-result`). RL5's card offers "Next: Fuse & Fold" (`RL5-line-desktop-07-result`). The phone result frames show fog over the card instead of the debris (J1 #5), which is PT30. |
| PT5 | Novice clicks land on the enemy half; duels last ≥ 2 turns; no empty banner; D1/D2 40-60% on the GPU | **Fail** (balance) | Own-keep clicks 0 in 24 GPU duels; fewest turns 2; no judge saw an empty banner (PT5's DOM test covers it). D1 GPU: Gold 85% of decided (p ≈ 0.003); D2 GPU: Gold 67% (12 of 18; both tables together 29 of 38, p ≈ 0.002). D1 phone draws after 2 shots (`duel-D1-phone-09-result`). PT22. |
| PT6 | Big-level fire-to-settle median ≤ 8 s, none at the cap | **Pending #272** | B3 shot 1 29.4 and 29.9 s (B levels are pinned to settle v3 until #272 lands their recast); B1 18.4 s, B2 10-13 s. The chamber levels settle in 1.4-7.3 s. Rube Lab waits out its 10 s cap after the bell (PT32). |
| PT7 | stars.json holds B3 and U1-U3; no "coming soon" | **Pending #246** | The door still reads "targets coming soon" for B1-B3 (desktop) and "★★ ? · ★★★ ?" (phone). |
| PT8 | Frozen frame clearly graded; L5 cut-in keeps par; How to play names Bullet Time | **Pass** (grade); test (par) | The frozen grade reads (J2 keep #5, `L5-bullet-time-desktop-01-frozen-mid-shot`). The L5 cut-in in this round did not clear, so par was not exercised; the bullet-time-undercut tests cover it. New problems: the grade also greys the crown, and there is no reticle while frozen (PT33). |
| PT9 | One leverage number on HUD, chip and card | **Pass** | HUD and card agree on every run checked; the chip is now "N% speed" (pacing, `L5-bullet-time-desktop-02`). The judges now ask what the number means (PT31). |
| PT10 | Ammo is live while it closes on the lot | **Test** | Chamber levels now play on the GPU solver, which does not sleep, so the round cannot show it; `settleUpdate` tests cover it. |
| PT11 | Trial prune and load-stability test | **Pending #246** | T-S8 is still a heap at load on Rapier (`T-S8-novice-desktop-00`), and T-X4's arch still sheds bricks (`T-X4-novice-desktop-00`). Both are in #246's prune. |
| PT12 | HUD counters in step with the picture | **Pass** | No judge saw a counter that disagrees with its frame (frames are held at their step since round 1's fix). T-X2's "Down 12%" with nothing visible is a different problem: an inner collapse (J3 #20, PT31). |
| PT13 | B1's opener alone ≥ 40% | **Pending #246** | On f52dc5f the opener brings 17% down on Rapier, where this round plays the big levels (`B1-novice-desktop-04`); #246 measured 0.427 on Metal for the same opener, so the GPU decides, and #246's chooser and door e2e (40% on the GPU solver) carry the verify. |
| PT14 | No shot-0 "Out of reach"; opener reachable | **Fail** (phone) | No judge saw the warning at shot 0 on a desktop rated level (J3 saw it on the desktop only on T-S8 and T-X3, both in #246's scope). The phone trial aim views show the warning in 15 of 34 (J3 #3: T-B1A, T-B1B, T-B4A, T-B5A, T-B5C, T-I2, T-S12, T-S14, T-S3, T-S3R, T-S8, T-X1, T-X3, T-X3B, T-X3K; checked by eye on `T-S3-view-phone-00`). In D1 on the phone the warning shows on an arc that lands on the keep and knocks the king off (J2 #5, `duel-D1-phone-01` to `-05`). PT29. |
| PT15 | Crown gold and heritage teal in every look | **Partial** (row still doing) | Real and hazy are right. Candy still uses teal and gold in the body gradient beside the special tiles (`L3-candy-desktop-00`, `B2-candy-desktop-00`); crown and heritage tiles look plastic in the real look (`B2-real-desktop-00`). Evidence passed to PT15. |
| PT16 | Totals ≥ 0; incomplete strokes 0; no solo score in a duel | **Pass** | 0 negative totals in 176 runs; duel cards show no solo score. |
| PT17 | Pull animation; no 0/1 counter on U3 | **Pass** | U3's HUD reads "Crown standing ✓" (report `hud`). The U3 card shows "4 shots · 4% down" beside the "13% PULLED" stamp (J1 #9): a minor leftover, PT35. |
| PT18 | No internal words; sideways door shows two whole cards | **Pass** | The copy audit holds; the sideways door shows three whole cards (`door-phone-landscape-00`). How to play is still jargon (J1 #19, J2 #20), and Advanced settings shows 13 toggles (J2 #19): PT37. |
| PT19 | A fired ram looks like a ram; spent ammo fades | **Test** | No judge flagged a ram; `firedLooks`/`spentLooks` e2e covers it. |

## Siege Table balance on the GPU solver

`pnpm duel:bot D1,D2 24 1.6 5000 --engine gpu` (new in this PR) plays the game's novice bot (`duel-bot.ts`, the same bot PT5 used on Rapier) on the cast page with the GPU solver: 24 seeds a table, the first player alternating. SwiftShader only changes the time, not the outcome.

| Table | Engine | Duels | Gold | Blue | Draws | Gold share of decided | First-seat share of decided | Turns a duel | Own-keep clicks |
|---|---|---|---|---|---|---|---|---|---|
| D1 Two Keeps | Rapier (PT5, 40 seeds) | 40 | about even | | 18% | about 50% | | 5.2 | 0 |
| D1 Two Keeps | GPU | 24 | 17 | 3 | 4 | **85%** (fail) | 55% | 3.6 (fewest 2) | 0 |
| D2 Heraldry | GPU | 18 (of 24 planned: the run hit its 2-hour limit at about 8 minutes a duel) | 12 | 6 | 0 | **67%** (95% CI 44-84%; fail on the point estimate, not significant alone, p ≈ 0.24) | 39% | 7.6 (fewest 4) | n/a |

With 20 decided duels and a fair coin, 17 or more wins for one side has a two-sided probability of about 0.003, so D1's bias is real and not seed noise. D2 leans the same way (12 of 18); alone that could be noise, but both tables together give Gold 29 of 38 decided duels (76%, 95% CI 61-87%, p ≈ 0.002). Because the first seat is fair or slightly unfavoured (55% on D1, 39% on D2), the bias follows the side (west and Gold), not the turn order. Two causes fit:
1. **The GPU solver's colour order.** C10 found that it is not bit-exact under a mirror, because colour priority is global. Gold's parts are 0, 2 and 5-8, and Blue's are 1, 3 and 9-12, so the two keeps are solved in different orders. That could make Blue's keep the weaker one under the same hit.
2. **Something in the bot's view.** The bot clicks in screen space on each side's turn view, so an imperfect mirror would change the bot's aim.

PT22's first step separates the two: replay the same duels with the part order swapped. In D2 Heraldry 4 of the 18 GPU duels ended level on points and went to the struck tie-break ("Gold brought down more"), and only 1 ended early on the 15% rule. That fits J2's finding that the checkerboard makes almost every shot net about zero (+16/-15, +14/-13). Its fix is part of PT22.

## Ranked change list

Ranking: severity first (P0 broken, P1 hurts most players, P2 polish), then how many judges and measurements agree, then how much of the game it touches. The judges, with round 1's split plus the new-modes lens the brief asked for:

| Judge | Area | Captures |
|---|---|---|
| J1 | Core loop | Door and rated levels |
| J2 | Modes and phone | Bullet Time, Siege Table, sideways |
| J3 | Breadth | Trials, looks, ice |
| J4 | New modes | Fuse & Fold, Aftershock, Rube Lab |

Frame names are under `playtest/agent-2/` in the project files (`frames.tar`, `sheets/`, `report.json`, `judges/`).

| Rank | ID | Sev | Change | Evidence | Verify |
|---|---|---|---|---|---|
| 1 | PT20 | P0 | **Fuse & Fold must record stars on the players' engine.** F1-F5's stars were cast on the f64 reference (`stars.json` engine `ref`). The game plays them on the GPU solver, so `onEngine` (params.ts) marks every F level custom, and every HUD and card reads "Custom settings, so no stars are recorded". No player can earn a Fuse & Fold star. Either recast on the GPU (the Metal recast queued in M5), or let `onEngine` accept a reference cast for a level whose GPU replay is gated to agree with it. Guard the class of bug with a test. | `F1-novice-desktop-00-aim-view`, `F1-sweep-desktop-06-result`, `F4-sweep-desktop-06-result`; `stars.json` F1-F5 `"engine": "ref"`; params.ts `onEngine`. J4 #17, checked in code. | A unit test over `SERIES`: every rated level's `stars.engine` is one the game plays it on (or is in an explicit allow-list with its agreement gate), so no rated level opens custom; a clean-profile F1 load shows no custom line (e2e). |
| 2 | PT21 | P0 | **Fuse & Fold's panel must never cover the result card or the Plunger.** On 9- and 12-charge levels at desktop, and on every phone and sideways F run, the Timeline panel draws over the card's stamp, stars and Undo/Retry/Next. On F4 at phone size the 12 delay rows push the Plunger off the screen. Collapse the Timeline when the card opens, and put the card above every panel. On phones, fold the per-charge rows behind "Delays ▸", keep compass, direction, Sweep and Plunger visible, and cap the panel at about 35% of the height. | `F4-sweep-desktop-06-result`, `F2-sweep-desktop-06-result`, `F1-novice-phone-03-result`, `F1-novice-phone-landscape-04-result` (checked by eye); `F4-novice-phone-00-aim-view` (Plunger off screen, checked by eye). J4 #1, #2. | An e2e on F4 at 1280x800, 390x844 and 844x390: `elementFromPoint` at the centre of Next returns Next, and the Plunger's box is inside the viewport on F2, F4 and F5 at 390x844. |
| 3 | PT22 | P1 | **Balance the Siege Table on the GPU solver, and end D1 on more than one lob.** Gold leads on both tables on the GPU (D1 85%, D2 67%, together 29 of 38 decided, p ≈ 0.002; the seat is fair), described above. First find whether it follows the part order or the view, by swapping the sides' part order. On the phone, D1 still ends in one round: the first lob each knocks the king out of its battlement, a draw with 79% and 73% of the keeps standing. Count the king as down only once it leaves the battlement's top course. In D2 Heraldry most shots net about zero (J2), Gold also leads (12 of 18), and 4 of 18 duels go to the tie-break. Group each side's colour toward the face the other side fires at, with a mixed core, and show the rule in the match ("Knock down blue +1 · your gold -1"). | `duel-gpu.log` (balance table above); `duel-D1-phone-09-result` ("both keeps fell in one round · 2 shots"); `duel-D2-desktop-27-result` (Gold 0 pts, Blue -1); J2 #1, #2. | `pnpm duel:bot D1,D2 40 1.6 5000 --engine gpu` and `--engine rapier`: each side wins 40-60% of decided duels, draws ≤ 25%, median ≥ 4 turns; D2's median final score spread ≥ 5 points; `duel-gpu.test.ts` keeps one seeded duel per table green in CI. |
| 4 | PT23 | P1 | **Give each new mode its own HUD and one start verb.** Projectile controls leak into all three new modes: Power and Height rows during runs, "click: fire" and "drag: aim · lift: fire" hints, Plunger and Quake rack chips (even in Rube Lab), and W/S keys next to the "W" compass. Aftershock offers "Fire the first shot (F)" beside "Start the quake", and that opener plays the level's three-star quake (`openerFor` falls back to the ace's first shot), so it gives the answer away. Rube Lab has two start buttons, "Play (Enter)" in the Build panel and "Go: release the ball (F)" in the HUD, and the player must press both. | `A1-novice-desktop-00-aim-view` (checked by eye), `A1-novice-phone-00-aim-view` (largest button on screen), `RL1-line-desktop-01-built` (checked by eye: Play and Go), `F1-sweep-desktop-04-shot-1-152-steps`, `RL1-line-desktop-03-shot-1-20-steps`; play.ts `openerFor`. J4 #6, #7, #9. | DOM e2e per mode (F, A, RL): no "Power" or "Height" row and no "fire" hint; no Plunger chip in Rube Lab; A1's aim view has one primary button, and no level's opener equals its ace (unit test); Rube Lab has one Run control. |
| 5 | PT24 | P1 | **Fuse & Fold: show the plan in the world.** The A1-B2/D3 rows have no counterpart in the scene: charges are unlabelled 8-10 px dots, north is a 20 px panel icon, and nothing links "W" to the yard. "W" is highlighted at load while every delay is 0.0 s, and on F2, whose yard is to the north, it points the wrong way. The camera also leaves the landing under the panel. Label each charge with its delay, draw a ground compass and a building-to-yard arrow, select no direction until a sweep is applied, add one hint ("Sweep toward the yard, then Plunger"), and fit the opening view to the area the panel leaves free (the view is set at load: no camera move). | `F1-novice-desktop-00-aim-view`, `F2-novice-desktop-00-aim-view` vs `F2-sweep-desktop-01-timeline-swept-n`, `F2-sweep-desktop-06-result`. J4 #3, #4, #5. Novice result on all five: about 24% down, INCOMPLETE, no reason given. | A capture shows the labels and the arrow; at load no direction button has the active style (e2e); the yard's projected box misses every panel rectangle at desktop and phone (unit test on the framing). |
| 6 | PT25 | P1 | **Aftershock: make the quake visible and the dial teachable.** The quake is never shown: ground, grid and camera stay still, and during the run the dial is replaced by Power/Height with no time left shown. Move the ground plane and grid with the waveform (the camera stays put, per the camera rule), add dust at the bases, and keep the waveform up with a moving playhead. Every level loads the same dial (0.30 g, 1.0 Hz, 3.0 s, 0°), which does nothing on A2 for 7.3 s. Seed each level's dial with something that does part of the job, and tick each structure's natural frequency on the Frequency control. The phone dial loses its labels and takes 35.1% of the screen. | `A2-novice-desktop-02-shot-1-63-steps`, `A1-novice-desktop-02-shot-1-60-steps`, `A2-novice-desktop-05-result` (total 0), `A1-novice-phone-00-aim-view`; `hudShare` 35.1% on A1-A5 phones. J4 #14, #15, #18, #25. | Two mid-quake frames differ in grid offset (capture test); the A2 novice run scores above 0; the phone dial shows four labels and its tray is ≤ 30% of 390x844. |
| 7 | PT26 | P1 | **Rube Lab: a goal you can see and a ring worth hearing.** Nothing says "ring the bell". The bell is a grey sphere like the ball (RL2, RL4); RL3's target is greyed during the build; RL1 has no identifiable target. Ringing gives a few sparks: the bell does not swing or glow, and the ball is 10 px. Add an objective line and a distinct bell (brass, in colour during the build), mark the ball's start, and make the bell swing, flash and send a ring wave on contact. Give parts the player built their own tint. | `RL2-line-desktop-00-aim-view`, `RL3-line-desktop-00-aim-view` vs `-02-after-play`, `RL2-line-desktop-06-shot-1-settled`, `RL1-line-desktop-07-result`, `RL3-line-desktop-02-after-play`. J4 #8, #10, #23. J4: "Rube Lab has no moment worth watching." | The build-phase capture shows the bell in gold (hue test); the frame 10 steps after the ring shows the bell displaced and emissive; an Opus look review of the ring on Metal. |
| 8 | PT27 | P1 | **Every result card says what happened, in the mode's own terms.** Rube Lab's card uses demolition rows ("Strokes 3,000", "leverage ×0.43 (Brute)", "Gold leverage … heritage intact" with no heritage), and its HUD says "Par 1" while the card says "par 2". Aftershock stamps three-star clears "9% DOWN" and "15% DOWN". No failure card says why or what to try, and a run that loses heritage is stamped only INCOMPLETE. Give each mode its own rows and stamp ("2/2 CONDEMNED · HERITAGE SAFE"; parts used against par), add a reason line on every failure ("38% folded, 60% needed: try a slower sweep"), and stamp HERITAGE LOST in red when it applies. | `RL1-line-desktop-07-result`, `RL1-novice-desktop-06-result`, `A2-line-desktop-05-result`, `A4-line-desktop-05-result`, `F1-novice-desktop-03-result`, `A3-novice-desktop-05-result`. J4 #11, #12, #13; J3 #8. | Unit tests on the card model: no "Leverage" or "Brute" row in Rube Lab or Aftershock; HUD and card par agree; every failed card has a reason line; HERITAGE LOST whenever heritage is broken and the objective needs it. |
| 9 | PT28 | P1 | **Make heritage matter on the big levels and be seen when it cracks.** In B2 "Spare the Cathedral" a novice cracks 25 heritage blocks (-12,500, total 0), yet gets a gold "18% DOWN" stamp, one star and a highlighted Next. The recorded line itself cracks 3. On the B2 trials the pre-aimed opener cracks heritage while still in flight. The cracks themselves cannot be seen: "28 cracked" over a cathedral that looks whole. On a spare-level, broken heritage takes the gold stamp and a star, as chamber levels do; cracked heritage gets a visible crack and a red flash; B2's opener and recorded line spare it. | `B2-novice-desktop-07-result`, `B2-line-desktop-07-result` (Heritage -1,500), `T-B2A-novice-desktop-02-shot-1-64-steps`, `T-B2A-novice-desktop-07-result`. J1 #3, #14; J3 #2, #7, #8. | A headless B2 replay with ≥ 1 cracked heritage shows no gold stamp and loses a star (unit test on the outcome); B2's opener and line leave heritage intact (cast-page test); a capture test: a cracked heritage block differs from an intact one. |
| 10 | PT29 | P1 | **Every opening aim does something and spares heritage, at every viewport.** L3 loads aimed at the centre heritage column, and B2's blast ring overlaps the cathedral. L4's anvil sits on the fulcrum (0% after three shots), and on the phone L4's target is on empty ground and L2's arc lands behind the lintel. On the trials the chain and domino openers hit mid-chain and snap it (T-X1 lands short). On phones the opener is "Out of reach" at load in 15 of 34 trials (PT14's verify). In D1 on a phone the warning shows on an arc that hits. Compute the opener per viewport after the opening view is framed, clamp it to a reachable point, and base the warning on the drawn trajectory. | `L3-novice-phone-00-aim-view`, `B2-novice-desktop-00-aim-view` (checked by eye), `L4-novice-desktop-03-shot-1-settled`, `T-X3-novice-desktop-04-shot-1-settled`, `T-S3-view-phone-00` (checked by eye), `duel-D1-phone-01-turn-1-aim` to `-05`. J1 #2; J2 #5; J3 #3, #5. Trial openers change in #246: re-checked in the supplement. | A level test fires each rated level's opening aim untouched: heritage intact and collapse > 0; an e2e over every level at 390x844 and 1280x800: no "Out of reach" at shot 0; in the duel, no warning on an arc that meets the structure. |
| 11 | PT30 | P1 | **Phones: the scene in the free band at the result and in the modes' panels, and an HUD that does not grow.** PT3b (#273, merged after this round) fits the opening view to the band the docked HUD leaves. Still open from this round: on every phone result frame the card covers what was destroyed (the camera may not move on its own, so this is layout: collapse the card to a strip with a "show card" tab, or dock it to the HUD band); the phone lot sheet is clipped behind the button bar; the sideways result card covers the wall; the portrait duel puts both keeps in the bottom fifth and crops your own; the new modes' panels push the scene into a narrow strip (the F4 panel starts at y=864 of 1688); L3's HUD grows by a line after shot 1. | `L1-novice-phone-05-result` (checked by eye), `L2-novice-phone-06-result`, `B1-landscape-phone-landscape-06-result`, `duel-D1-phone-01-turn-1-aim`, `F4-novice-phone-00-aim-view`, `L3-novice-phone-04` (29.5% after 27.6%). J1 #4, #5, #16; J2 #4, #17; J4 #16. Re-checked on latest main in the supplement. | Phone captures at 390x844 and 844x390: at the result at least one crown or 20% of the debris stays in view; no clipped card text; HUD share identical before and after shot 1 on every level (`hudShare`); in the duel both kings inside the free band. |
| 12 | PT31 | P2 | **Say when a shot did nothing, and what leverage means.** A shot that moves under 1% of the blocks (L2's marbles, L4's anvil on the fulcrum) passes in silence, and the card then shows "×0.00 (Brute)". L1's opener scores "×0.70 (Brute)" with three stars and misses gold by 0.01; leverage pays 1,687 of T-X2's 2,071 at 12% down. Show a one-line toast at the impact ("Glanced off: try the cannonball"), never "Brute" for a zero, and leverage as a share of the level's gold line, capped per shot and scaled by what fell. T-X2's "Down 12%" with nothing visible needs a cue for an inner collapse. | `L2-novice-desktop-05-shot-2-settled`, `L4-novice-desktop-06-result`, `L1-novice-desktop-05-result`, `T-X2-novice-desktop-05-result`. J1 #6, #7; J3 #19, #20. | A zero-collapse shot produces the toast (e2e); a unit test: no Brute label at ×0.00, and a 0% shot adds 0 leverage points. |
| 13 | PT32 | P2 | **End runs when the mode's job is done.** Solved Rube Lab runs sit until the 10.0 s cap after the bell has rung (RL1, RL2, RL4, RL5), and Aftershock's A4 line takes 12.7 s. End a Rube Lab run 1.5 s after the ring, and an Aftershock run once the quake is over and the scene is at rest. The B3 settle cap is PT6b (#272). | `report.json`: RL lines 10.0 s, RL3 8.0 s; A4 line 12.7 s; `RL5-line-desktop-06-shot-1-settled` ("tallying…"). J4 #20; J1 #13. | RL1's recorded build settles in ≤ 5 s (headless); an A-level run ends ≤ 1.5 s after the quake once the bodies are at rest. |
| 14 | PT33 | P2 | **Bullet Time: keep what you aim at in colour, and the reticle up.** The frozen grade turns L5's gold crown grey just when the player aims at it. On the desktop the frozen frame has no reticle or arc; on the phone they are faint. Leave crowns and heritage out of the grade (or outline them), and keep the full aim preview live while frozen. | `L5-bullet-time-desktop-00-aim-view` vs `-01-frozen-mid-shot` (checked by eye), `B1-bullet-time-desktop-01-frozen-mid-shot`, `B1-bullet-time-phone-01-frozen-mid-shot`. J2 #6, #7. | Crown pixels in the frozen frame keep their gold hue (capture test); the frozen frame shows the reticle and dome. |
| 15 | PT34 | P2 | **Siege Table readability.** The match never says the goal ("topple Blue's ⌖ king · protect your ⛨ king"), and west/east mean nothing on a plain field. D2's aim camera sits on the firing line, so the arc is a vertical stack of dots. On the phone the hand-over card lets the rack show through. Shots that drop nothing get no summary in D2, and the last shot is never summarised. The ending frames the winner's keep and says "keeps fell" when the rule is kings. U undo and R restart are offered in a hot-seat match, and R also means Rematch. Your own keep is cropped under the hint bar on the desktop. | `duel-D1-desktop-00-table`, `duel-D2-desktop-01-turn-1-aim`, `duel-D1-phone-06-turn-2-hand-over`, `duel-D2-desktop-14-turn-4-settled`, `duel-D1-desktop-26-result`, `duel-D1-desktop-01-turn-1-aim`. J2 #3, #10-#15, #22, #23. | DOM e2e: the objective line in the first frames; no undo or restart in a duel; every hand-over has a summary line; the D2 preview arc spans ≥ 25% of the width (capture); the result frame shows both keeps. |
| 16 | PT35 | P2 | **Undercut's leftovers after #246.** On f52dc5f, pulling the slab the crowns stand on clears U1 and U2 in one pull (the crowns drop upright and count as felled). #246 rebuilds U1 and U2 as par puzzles with fixed parts. Re-check that shortcut after it lands. The U3 card shows "4% down" beside "13% PULLED"; show one metric. | `U1-novice-phone-01-shot-1-20-steps`, `U2-novice-desktop-03-shot-1-settled`, `U3-novice-desktop-06-result`. J1 #8, #9. | After #246: a pull of the support under the crowns does not clear U1 or U2 (headless); the U3 card has no "% down". |
| 17 | PT36 | P2 | **Aim preview legibility.** On cameras on the firing line (L1, L3, D2) the arc collapses into a stack of 30 px dots over the crowns and heritage. The blast dome is still drawn on the result screen (T-I3's disc covers the keep). Cap the dot size on screen (about 8 px) and fade dots near the camera, offset line-of-fire opening views about 25° (set at load: no camera move), and hide the preview when the card opens. | `L1-novice-phone-00-aim-view`, `L3-novice-desktop-00-aim-view`, `T-I3-novice-desktop-07-result`, `duel-D2-desktop-01-turn-1-aim`. J1 #11; J2 #3; J3 #17, #18. | No preview dot over 10 px in the aim views, and none over a crown's screen box (capture test); no preview geometry in any result frame. |
| 18 | PT37 | P2 | **The door and help for a newcomer.** How to play is a seven-bullet wall of jargon (Leverage, gold line, Brute, bank), and the Siege Table rule sits below the fold sideways. Split it per mode, 1-2 lines each. Advanced settings shows 13 developer toggles with "Forget my progress" just below: keep about six, put the rest under "Developer", and confirm the reset. Hide unknown star tiers ("★★ ?"), and don't draw a star row on unrated trials. The phone rack clips its fourth item with no scroll cue, and the phone −/+ pairs have no labels. | `door-desktop-01-how-to-play`, `door-phone-landscape-02-advanced-settings`, `door-phone-landscape-00-door`, `T-I1-novice-desktop-07-result`, `T-S1-view-phone-00-aim-view`, `duel-D1-phone-01-turn-1-aim`. J1 #19; J2 #16, #19, #20, #21; J3 #13, #21. | Text audit test: no "?" star tiers, no star row on an unrated card; How to play fits one sideways screen per mode; ≤ 6 toggles visible by default (e2e); every rack label visible or an overflow cue at 390 px. |
| 19 | PT38 | P2 | **Ice looks and plays like ice.** Ice throws orange metal sparks in the default look and beige sand dust in the real look. One cannonball brings T-I1 and T-I2 100% down, so the rest of the rack does nothing. Give ice its own debris (white and blue shards, frost puffs), and stiffen the ice or raise those objectives (T-I3's crown buried in stone is the model). | `T-I1-novice-desktop-04-shot-1-settled`, `T-I2-real-desktop-04-shot-1-settled`, `T-I1-novice-desktop-07-result`. J3 #11, #12. Ice trials kept by #246's prune. | No orange sparks near ice blocks in an ice capture (hue test); T-I1's and T-I2's openers alone stay under their objectives (headless). |

### Folded into existing rows rather than new ones

- **Sparks that stay** in settled and result frames (J1 #12, J2 #24, J3 #16, J4 #24). Under PT2's Metal look review: on SwiftShader the wall time per frame stretches every effect.
- **Long settles** on the big levels and big trials (J1 #13, J3 #16). PT6b (#272) moves B1-B3 to settle v4. The trials follow once #246 lands.
- **A flat blue-grey palette** (J1 #15) and **candy's teal and gold, real's plastic tiles** (J3 #14, #15). PT15, still doing, and the R-series looks.
- **The door sends a newcomer to B1, whose opener fails** (J1 #1, J2 #8). Will chose spectacle first (G5.5). The 16-19% is Rapier's (the big levels run on Rapier here); #246 measured the same opener at 0.427 on Metal, and PT13 carries the 40% check on the GPU solver.
- **Trial content**: duplicates, inert B5a-c, T-S8 and T-X4 broken at load, Trial 1 a dud, stray cubes (J3 #1, #6, #9, #10, #23, #24). PT11 (#246) prunes and repairs these. The supplement checks what survives.

### What the judges said to keep

- The crown and heritage block language: gold crosshair to hit, teal shield to spare (`L2-novice-desktop-00-aim-view`).
- The big-level collapses (`B3-novice-desktop-03-shot-1-153-steps`) and the bomb's blast-dome preview.
- The result card's structure: itemised score, red heritage line, Retry first on a fail.
- **New this round:** the duel hand-over card in the next player's colour with a one-line recap, king icons that swap with point of view, mirrored D1 aim views, the grenade's dome and payoff, and Bullet Time's frozen look (J2).
- **New this round:** Fuse & Fold's swept fold (J4 calls it the best-looking physics in the new modes: `F4-sweep-desktop-04-shot-1-150-steps`), charge dots coloured by delay to match the sliders, the desktop Aftershock dial with its waveform and energy bar, one-line rule notes inside panels ("9 relays on storey 5: they go off when jolted"), the green ghost when placing parts, and the next-mode button on a series' last card (J4).

### The new-modes lens: does each verb read, and is there a moment worth watching?

| Mode | Verb reads without a tutorial? | Moment worth watching? |
|---|---|---|
| Fuse & Fold | Partly. "Press Plunger" and the yard read; what the delays do and which way "W" is do not (PT24). | **Yes**, the swept fold, the best of the three. Undercut by the camera and the panel over the result (PT21, PT24). |
| Aftershock | Mostly on the desktop (the dial is labelled); not on the phone; the opener contradicts the verb (PT23, PT25). | **Weak**: the topple is there, but the quake itself is invisible (PT25). |
| Rube Lab | **No**: the goal is unidentifiable, and there are two start verbs (PT23, PT26). | **None** yet: the ring is a puff of sparks (PT26). |

### Judges' claims checked or downgraded

- **Checked by eye** against the frames: PT20 (also in code), PT21 (F4 result and phone Plunger), PT23 (A1's two buttons, RL's Play and Go), PT28 (B2 opener ring), PT29 (T-S3 phone warning), PT30 (L1 phone result, L3 HUD growth), PT33 (L5 crown grey while frozen), PT8 (the frozen grade), PT18 (three whole cards sideways), PT1 (B2 opening view).
- **Downgraded: the "0% speed" / "4% speed" badge** (J2 #9). This is the pacing tag (pacing.ts `slowTag`, PT9's rename of "×0.84"): SwiftShader runs the sim far below real time. On a machine that keeps up it does not show. Not a row.
- **Downgraded: "B1's settle takes 18.4 s on phones and 8.5 s on desktop"** (J2 #18). The two Bullet Time runs fired different cut-in shots (the frozen shot aims at the middle of each viewport), so they are different rounds, not a viewport-dependent settle.
- **Harness artefacts:**
  - "Custom settings" and "★★ ?" on the B levels: the B levels ran on Rapier in this round (their stars were cast on the GPU). The F levels' custom line is not an artefact (PT20).
  - L5 Bullet Time's "Custom settings": `keystone.freeze=2` is a rule change.
  - B3's columns bowing (J1 #22): Rapier.
- **Superseded by #246** (reported for the record, re-checked in the supplement): every trial-content claim, the U1/U2 slab shortcut (PT35), and B1's opener (PT13).
- **Not taken:** J2's request to remove undo from duels outright is in PT34 as "no undo in a hot-seat match", not as a removal from the game; the camera-move proposals (J1 #5 "move the camera to frame the rubble", J1 #21 "follow the crown") conflict with Will's rule that the camera moves only on player input, so PT30 and PT36 solve them with layout and the opening view.

## How the round ran

Same harness as round 1 (`pnpm playtest:agent`, `packages/playtest/src/agent/`), same viewports and novice policy. What changed for round 2:
- **The new modes** (`modes.ts`):
  - **Fuse & Fold:** a "sweep" policy taps the direction toward the site's first yard, then the Plunger.
  - **Aftershock:** the novice starts the quake on the level's dial; the "line" plays the recorded ace.
  - **Rube Lab:** the line builds the level's first recorded solution through the page's own build tool, with the same number keys, Shift-Q/E turns, T tips and pointer rays a player's mouse gives. `agent-modes.test.ts` replays every recorded build through the game's `EditController` and checks that it gives the lab's level exactly.
- **Build-phase levels** (Rube Lab, T-W1) load with `ready` false, so the load wait also accepts the build phase.
- **The phone HUD's share** is measured before shot 1 and after it, from the docked strip and tray (upright) or the side rail (sideways).
- **Siege Table:** the runner taps through the hand-over card (new since round 1) and plays up to eight turns.
- **Balance on the GPU solver:**
  - `duel(...)` on the cast page and `BrowserCastPlayer` runs the game's novice bot there.
  - `tallyDuels`/`tallyLine` (duel-bot.ts, unit-tested) count sides, seats and draws.
  - `pnpm duel:bot ... --engine gpu` prints the line.
  - `keystone-lab/test/duel-gpu.test.ts` plays one seeded duel per table in CI.
- **Not on the page:** Mason's Trial (MT1-MT4: its test phase and `?level=` come in its second PR) and Chorus (#269, a draft). `plan.ts` `NOT_ON_PAGE` names them, so a later round adds them by deleting a line.

Physics per scenario as in round 1. The chamber levels, Undercut, duels and every new-mode level ran on the GPU solver. The 1,000-10,000-block levels and the trials ran on Rapier (minutes a shot on SwiftShader otherwise). Round 2 was 176 runs, 1,026 captures and 176 contact sheets, about 75 minutes with three workers on a 4-core cloud box. The GPU duel tally ran alongside, at about 2 minutes a D1 duel and 8 minutes a D2 duel on SwiftShader.

### Alternatives considered

**Replay round 1's plan, or play fresh?**
1. *Replay round 1's exact plan:* the only way to check PT verifies like-for-like (the same scenario ids, frames and measures).
2. *Fresh exploratory play:* finds what the plan never visits.

Done both, as the brief asked. The plan replays round 1's 107 scenarios unchanged. The new series get a first visit at every form factor plus their verb (sweep) or recorded line. The judges were told to look past the plan (each received the full contact sheets and was asked for anything a newcomer would hit). A model clicking frame by frame was rejected again for the reason in round 1: tens of minutes a level on SwiftShader, and not repeatable.

**Judge the new modes in the same judges, or a separate one?** A separate one (J4), as the brief asked. The new modes are a third of the captures and a different question (does each verb read without a tutorial; is there a moment worth watching). Folded into J2 they would have crowded out Bullet Time and the duels. The cost is one more brief and some overlap: J4 and J1 both flag phone framing, which raises those rows' rank rather than duplicating them.

**Balance on the GPU: the browser harness's duels, or the bot on the cast page?**
1. *The harness's duels:* 4 full-page duels with captures, too few to measure a rate.
2. *The bot on the cast page* (chosen): the same bot and table as the game, physics only, 24 seeds a table, deterministic per seed.

The judges see option 1's captures, and the balance comes from option 2.

**Wait for #246 before playing, or play now and supplement?** Play now on f52dc5f and supplement. #246 touches the trials, U1-U2 and B1's opener, about a quarter of the plan. Waiting would have held the other three quarters, and every PT verify outside PT7, PT11 and PT13, for an unknown time.

## Supplement: latest main

SUPPLEMENT_PENDING

## Re-running it

```sh
pnpm playtest:agent                                   # every scenario, 2 workers, into agent-playtest-out/
pnpm playtest:agent --only '^(F|A|RL|W)[0-9]-' --workers 2   # just the new modes
pnpm playtest:agent --only '-phone$'                  # every phone run
pnpm duel:bot D1,D2 24 1.6 5000 --engine gpu          # Siege Table balance on the GPU solver (TB_CHANNEL=chrome on the Mac)
```

On the Mac with a real GPU the same harness runs with `--engine gpu`. Its numbers are still in sim steps there; wall-time pacing stays with the M5 bench queue.
