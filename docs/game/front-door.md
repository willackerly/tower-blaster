# Front door (roadmap G7)

Status 2026-11-02. The game page's title and level select, progress kept in the browser, settings, and the pre-aimed first shot. The code is in `@tb/game`: `door.ts` (formatting, pure), `door-page.ts` (DOM), `progress.ts`, and `settings.ts`.

## What a player sees

A bare URL (`pnpm game`, or the playtest link) opens the door over B1, which loads behind it. The door has three parts:

- The title, then **Play · <next level>** (the first level without a star) and, when another level is open, **Esc Back to <it>**.
- **How to play**: seven lines: aiming, firing again (rapid fire) and skipping, Bullet Time (the T key, PT8), stars, banking, leverage, and the Siege Table's two rulesets (PT18).
- A **section per series**, each under its title: Spectacle (B1 to B3), Chamber (L1 to L5), Undercut (U1 to U3), then after the Two players tables a **Trials · unrated (20)** toggle, closed by default (trials.md). Since 2026-11-06 the door lists every series whatever level the page opened on, and a pick loads in place: the page is not reloaded, only the level's engine is rebuilt. N, P and the result card's Next walk only inside the loaded level's series. Play never picks a trial.
- One **card per level**. Each card shows the id, the name, the block count and the rack, then the three star targets (the objective; T2 and T3 from the cast in the metric's own words, such as "70% down" or "3,200 points, heritage intact"), and the best play. On a phone the targets shrink to one line ("★ 40% · ★★ 70% · ★★★ 94%").

Below the cards, an **Advanced settings** link (closed on every visit; Will 2026-11-05: keep the settings, bury them) opens ten settings, each a segmented control whose selected side is filled in the accent (PT18): **Sound** (one button that reads On, filled, or Off; a click flips it), **Look** (Maquette, Photoreal or Candy), **Camera** (Still, the default: it moves only when the player moves it; or Dynamic: it follows the collapse and shakes on hits, i.e. `keystone.follow=1` and `keystone.shake=1`), **Rapid fire** (On, the default: fire again before the last shot settles; Off waits for each settle, i.e. `keystone.rapid=0`; Will 2026-11-05, see spectacle-mode.md section 5; a change applies to the next click), **Duel turns** (Turn the view, the default: in a Siege Table duel the camera swings to the middle of the side whose turn it is; Leave it keeps the camera where the last player left it, i.e. `keystone.turnview=0`; Will 2026-11-06, see siege-table.md "Whose side"; a change applies from the next turn), **Launch height** (High, the default: shots leave from 2 h over the structure's top, clear of the rubble on the ground; or Level's, the level's own launcher near the ground, where its par lines were recorded, i.e. `keystone.launch=level`; Will 2026-11-06; a change moves the launcher at once, and keys W and S move it a whole h from there), **Stone marks** (Carved, the default: a crosshair carved on every block the level asks you to bring down, a shield on every block to keep, i.e. heritage and a hold level's crown; Off leaves plain stones, i.e. `keystone.marks=0`; Will 2026-11-06, see `packages/render/src/marks.ts`; a change recarves the stones at once), **Layout** (Docked, the default: on a phone the HUD docks to the screen's edges, a status strip on top and an aim tray at the bottom upright or a rail down the left side sideways, and the result card waits 1.2 s after the round, a small tallying banner showing meanwhile, then docks aside; Classic is the one HUD panel and the centred card at once, i.e. `keystone.hud=panel&keystone.card=center&keystone.carddelay=0`; agent playtest PT3 and PT4, see [phone-hud.md](phone-hud.md)), **Sharpness** (Full, or Fast, which caps the canvas at 1 device pixel per CSS pixel) and **Quality** (Auto, the default: the tier a short probe picked for this device on load, named on the button, e.g. "Auto (High)"; or High, Medium or Low; see [quality-tiers.md](quality-tiers.md); a change applies at once). The URL's `keystone.follow` and `keystone.shake` each win over Camera for the visit, and a Camera click drops them from the URL. A Camera change applies to the shake at once and to the follow from the next shot. A two-click **Forget my progress** link sits under them, inside the same panel.

In play, **Menu** (top right) or **Esc** brings the door back. While the door is open it holds the keyboard, so the game's keys (N, R, F and so on) wait.

On a first visit, B1's HUD offers **F Fire the first shot**: B1's chosen opener (`solutions.opener`) when it has one, else the first shot of its ace line (`solutions.ace[0]`), pre-aimed. The first collapse is then one click after Play, which is the first-minute promise in spectacle-mode.md section 11.

## Options (URL keys; each one wins over storage for the visit)

| Key | Values | Default |
|---|---|---|
| `door` | `auto`, `1` (always on load), `0` (never) | `auto`: shown when the URL names no `level` |
| `keystone.preaim` | `auto`, `1` (every level with a recorded line), `0` | `auto`: the series' first level, until the player has a record on it |
| `progress` | `on`, `off` (this visit only, settings included) | `on` (`localStorage` `tb.progress.v1`, `tb.settings.v1`) |
| `sound` | `on`, `off` | stored, else `on` |
| `look` | `hazy`, `real`, `candy` | stored, else `hazy` |
| `sharp` | `2`, `1` | stored, else `2` |
| `quality` | `auto`, `high`, `mid`, `low` | stored, else `auto` (an offscreen page runs no probe unless the URL says `auto`, and keeps high) |
| `keystone.follow`, `keystone.shake` | `1`, `0` (each) | the stored Camera setting (`still`: both off), else off |
| `keystone.rapid` | `1`, `0` | the stored Rapid fire setting, else `1` |
| `keystone.turnview` | `1`, `0` | the stored Duel turns setting, else `1` |
| `keystone.launch` | `high`, `level` | the stored Launch height setting, else `high` |
| `keystone.marks` | `0`, `1` | the stored Stone marks setting, else `1` (carved) |
| `keystone.balls` | `painted`, `plain` | `painted` (no door setting) |

When the player changes a setting on the door, it is stored and its URL key is dropped, so a reload keeps the choice.

## Stars and progress

- Star targets come from `castStars`, which reads `packages/keystone/src/stars.json`. A level whose cast has not landed (B3) shows only the objective's star and "★★ targets coming soon". Its targets appear as soon as `pnpm keystone:cast B3 ... --stars-into packages/keystone/src/stars.json` writes the file. No change to the door is needed.
- Progress is recorded at each round's end (`KeystoneHooks.ended`) per level id **and hash**, keeping the best play (stars, then the metric, then the total). A level re-authored since a play shows "Not played yet" instead of an old best. Custom runs (URL overrides, an engine other than the cast's) are not recorded and their cards say "custom: stars not recorded".

## Verification

- `game/test/door.test.ts` (pure): options, targets per metric, a simulated B3 drop-in, markup, settings precedence.
- `game/test/door-e2e.test.ts`: a fresh visit opens the door over B1, Play then Fire reaches a first collapse inside 20 s of sim time: on the GPU solver (a real GPU, or SwiftShader with `PHYSICS_GPU_SLOW=1`) B1's objective, D ≥ 0.4 (PT13, below); on Rapier D ≥ 0.1 (about 100 of B1's 1,000 blocks), because Rapier parts from the GPU solver on B1. On Rapier in CI this takes 2.3 s of sim. With `TB_CHANNEL=chrome` (the GPU engine on Metal) the test also asserts under 20 s of wall time from navigation. Further cases: Esc and Menu toggle the door, the door holds the game's keys, a settings round trip (settings hidden until Advanced settings is clicked), and progress on the card after a reload.
- `game/test/progress-e2e.test.ts`: a round is recorded and survives a reload. Custom runs and `progress=off` are not recorded.

## Alternatives considered

- **Only the open level's series on the door** (as before 2026-11-06). Replaced: a player on the bare URL never saw the chamber or Undercut levels, and Will read the game as "only 5 levels". Every series is listed; the trials stay folded so the rated levels stay first and the door does not compile 25 more levels (up to 10k blocks each) on every visit.
- **A trial picked from the door opens as a new page** (`?level=T-...`, as a duel does). Rejected: a page load re-creates the GPU device and recompiles its pipelines, on top of what a level swap costs. Every level is in the page's level list, so `handle.load` swaps it in.

- **A separate title page** (its own HTML entry) instead of an overlay. Rejected: the overlay lets B1 load and pre-settle behind the door, which is most of the first-minute budget on a 1k-block level.
- **Locking levels until the previous one has a star.** Rejected for the playtest: testers have little time and B3 (10k blocks) is the spectacle to judge. The Play button already points at the next unstarred level.
- **The pre-aimed opener on every level.** Rejected: it hands out each level's best opening. It is offered once, on a first visit, as an option (`keystone.preaim=1` for all).
- **Progress keyed by level id only.** Rejected: levels will be re-tuned between playtest deploys, and an old best would read as earned on the new level.

## In play: the HUD and the hint line (roadmap U5, 2026-11-06)

From the second-perspective visual review of 2026-11-02:

- **Hint line.** One short line, `click: fire · drag: orbit · wheel: zoom · U undo · R restart · ? keys` (`GAME_HELP`, at most `HELP_BUDGET` = 80 characters). The HUD already shows the rack's keys, power (Q, E) and Bank (B), so they are left out. **?** (or the line's "? keys" button) shows every key (`GAME_KEYS`) and goes back. The viewer's help under Keystone rules shows `GAME_KEYS`.
- **Leverage** shows from the first shot on (it is ×0.00 before one, which reads as a score of nothing).
- **Down bar.** Under "Down", an outcome level's HUD draws a bar filled to D with a tick per star threshold in collapse (`meterTicks`): one star where the objective is a collapse share, two and three where the level's cast stars are in collapse (B1: 40%, 70%, 94%). A tick turns white, its stars gold, once D reaches it. A hold level's bar is the share pulled. No ticks, no bar: B2's stars are points and its objective is crowns, and a custom run has no cast stars (`castStars`), so on Rapier B1 shows only the objective's tick. The ticks are a guide; the stars are still scored at the settle.

Tests: `game/test/hud.test.ts` (ticks per level, fill and lit ticks, Leverage, the result card's Undo, the hint's budget) and `game/test/hud-e2e.test.ts` (at 1280x800: the hint is one line within budget and ? toggles every key; no Leverage before the first shot; B1's bar fills as the opener brings the wall down and ends at the HUD's D; on the GPU solver, B1's three ticks at 40%, 70%, 94%). Undo and restart: [undo.md](undo.md).

## The first minute is a win (PT13, agent playtest round 1)

The agent playtest found B1's first visit failing: the opener brought 17% down, then three bombs 33%, against an objective of 40%, while L1's opener is a three-star clear. It played B1 on Rapier. On the players' engine the same opener does better: in B1's Metal cast (seed 1) the ace's first shot alone brought **0.427** down by its first settle, 8.4 s after the fire, so the M5 already meets the objective, with no margin.

**Engines disagree here, and the M5 decides.** The best first shots of B1's two Metal casts (372 lines), replayed alone on Rapier in this container (exact plus 4 nudges each): `w-bomb.537.8.8.71.100` brings 0.725 down on Metal and 0.027 on Rapier; `w-bomb.521.8.62.149.62` 0.668 and 0.027; `w-bomb.583.8.19.124.98` 0.650 and 0.029; `w-bomb.605.8.-90.181.94` 0.684 on Metal, 0.573 exact on Rapier but 0.08 for most nudges. Rapier is the smoke and CPU-fallback engine (PT12 is about the same divergence), so the pick is judged on the GPU solver alone, and the door e2e asks the objective of the opener only there.

**The chooser** (`pnpm keystone:opener B1 --from B1-s1.json,B1-s2.json`, keystone-lab `opener.ts`): the 16 best first shots of the casts' lines, plus the current opener, each played alone exactly and as 8 nudges (the cast's hand noise), on every engine named; ranked on the lower quartile on the worst engine; a winner meets the objective in every play within 20 s of sim with no engine limit. The pick goes into `solutions.opener`, which is not part of the level's hash (the stars stand) and which level files read. No winner: PT13's fallback, a first visit through L1.

Alternatives considered: **retune B1** (thinner wall, lower objective) changes the level and voids its Metal cast; **route a first visit through L1** drops Will's spectacle-first door (G5.5) and is the fallback only; **use the ace's first shot as is** passes on the M5 by 0.027, inside the spread of a nudge and of another GPU; **a dedicated opener** keeps the level and its stars and buys margin, so it is the plan. It gives nothing away: the stars' T2 is 0.65 and T3 0.94, so even a 0.7 opener leaves two bombs to earn three stars.

## Follow-ups (not in this step)

- Touch controls on phones: done (U4), [touch-controls.md](touch-controls.md). A finger drags to aim and fires on lift rather than a bare tap, so the arc shows before the shot. On a touch screen the HUD has Undo and Restart buttons after the first shot ([undo.md](undo.md)).

## Player-facing copy and the phone held sideways (PT18, 2026-11-07)

From the first agent playtest ([agent-playtest-1.md](agent-playtest-1.md), row PT18). Will was away and had delegated the calls.

- **Trials.** The blurb says what they are to a player ("More structures to bring down, just for fun…"), not where they came from. A trial's card and HUD show its number in the trials' order, "Trial 7" ("Trial 7 · Town" in the HUD, no `W5-T-S14T`), and a kept draft's name loses its code ("Long Wall", not "Long Wall (B1b)"). Display only (hud.ts `levelTag`, `playerName`, `hudTitle`): the id stays in the URL (`?level=T-S14T`) and on the card as `data-id`, and the name in the definition, since the name joins the level's hash.
- **HUD titles** use the door card's tag: "L2 · Lintel" and "B1 · Long Wall" (were "W1-2 · Lintel" and "W3-B1 · Long Wall", a second numbering the door never shows; the second-opinion review's first point).
- **The Build panel** (C9): Play is its one orange button; the tool and piece held are filled in the accent like the segmented controls (all three were orange, so Play did not stand out); the turn reads "0°"; the Alt hint shows only with a keyboard.
- **Weapon names.** The sized grenades show as Small grenade, Grenade, Big grenade and Huge grenade (hud.ts `WEAPON_LABEL`); the rack items (`w-grenadel`) and so every hash are unchanged. A test checks that no level's rack shows two names a letter apart.
- **Custom note.** "Custom settings, so no stars are recorded" (was "custom: stars not recorded").
- **Siege Table cards** name the ruleset only where the table's name is not already it ("Two Keeps · Two Keeps" was the playtest's).
- **"1 pt"** in the duel HUD and card comes with the Siege Table's PR (#252, PT5), which rewrote those lines; the copy audit covers it.
- **Sideways** (landscape, at most 500 px tall): the title, tagline, Play and How to play share one row and the cards go compact (the phone's short star line), so an 844 x 390 screen shows the three Spectacle cards whole with Play, unscrolled (was: the title and Play, the first cards cut at their first line).

In play, from the same row:

- **Bank** is an outline (orange text and edge, no fill) until the round meets its objective, then the solid primary button as before (hud.ts `BANK_QUIET`, `slotHtml`): banking before then ends the level with no star, and the playtest's novice was invited to at 17% of B1's 40%.
- **The lot sheet** in the desktop HUD is its count line until the level's first clear ([lot-sheets.md](lot-sheets.md), `keystone.sheet`).
- **Segmented controls** (the Advanced settings): the selected side filled in the accent with dark text, the others outlined on the panel; before, the selected side was the darker of two dark fills. Sound was kept as one button (On, filled, or Off) at the O4 merge rather than move the golden; PT37 (below) made it an On/Off pair after the second playtest's judge read the single button as offering only On.

What is an option and what is a fix: the lot sheet's collapse changes what the HUD shows, so it has a key (`keystone.sheet=open` restores it); the sideways door is a responsive layout for a screen that showed no whole card, the segmented fill and the quiet Bank correct controls that read the wrong way round, and the rest is copy, so those are plain fixes.

Alternatives considered: **renaming the trials** in their definitions (clean names everywhere, but a name joins the level's hash, so every trial's progress and any saved session would orphan; the display layer costs one function); **hiding trial numbers** and showing names only (two cards could then read the same, "Long Wall" beside the rated Long Wall; the number tells them apart); **renaming the rack items** (`w-grenadel` to `w-biggrenade`: a hash change for every level that racks one, for a word only the chip shows); **a horizontally scrolling card rail** for the sideways door (the judge's idea: more cards per screen, but it adds a second scroll axis to a page that already scrolls down, and a rail per series hides most of each series; the one-row header gives two whole cards and Play with no new gesture); **Bank hidden** until the objective is met (simplest, but banking early is a real choice on a bad round: keep the rack's points rather than spend it; quiet keeps it on offer without inviting it).

Tests: `game/test/copy-audit.test.ts` renders the door (every series, trials open, How to play, Advanced settings, the duels), the HUD, the tallying banner and the result card of every level the page lists, and both duels, to visible text and checks it for "engine", "probe", "grenadel", "1 pts", trial ids and the `W5-` prefix; `game/test/phone-door-build-e2e.test.ts` counts the whole cards on the sideways door's first screen (at least two).

## The door and help for a newcomer (PT37, 2026-11-07)

From the second agent playtest ([agent-playtest-2.md](agent-playtest-2.md), row PT37). Will was away and had delegated the calls.

- **How to play, one page per mode.** The help box opens on tabs: Basics, the Chamber, Spectacle, Bullet Time, Undercut, Rube Lab, Fuse & Fold, Aftershock, Wavefront and the Siege Table (door.ts `HOW_TO_PLAY`). Each page is one or two lines. It opens on the page for the level or duel the door is on (`howModeOf`: a freeze budget is Bullet Time, otherwise the level's series, otherwise Basics), and a tab click (`data-act="howmode"`) switches the page. The Chamber page carries the leverage explanation (`LEVERAGE_MEANS`, PT31). `door.test.ts` checks that every page has one or two lines and at most 260 visible characters, and that every series maps to a page. `phone-door-build-e2e.test.ts` checks that each page's box fits an 844 × 390 screen.
- **Advanced settings: six, then Developer.** Advanced opens on Sound, Look, Camera, Hand-over, Layout and Quality. Every other setting, and the progress reset, sits under a "Developer settings ▸" fold. Which rows a player sees is a field on each option's own door row (`DoorRow.player`, docs/design/options.md), so a new option lands under Developer unless it says otherwise.
- **A confirmed reset.** "Forget my progress…" asks "Forget every best play and star on this device?" with Forget and Keep. Keep, or any other click, disarms it.
- **Sound is an On/Off pair** (J1 #19: the single button read as offering only "On").
- **No stars on unrated trials.** A trial's card shows "Goal" where a rated card shows its stars, and after a clear it shows "Goal met · Best …". Its result card and tally banner say "Unrated · goal met" or "Unrated · goal not met". The round-1 "★★ ?" placeholder was already gone after #246. The copy audit now guards both: no "?" in any card's star line, and no ★ or ☆ on a trial's card, result card or banner.

Alternatives considered:

- **One long How to play list**, the round-1 shape with more lines. Every mode in one scroll fails "fits one sideways screen" as modes are added. Tabs keep each page short and open on the one that matters now.
- **A central list of the six player settings** in door.ts. This works, but it is a second place to edit when an option is added, which is what the O4 registry removed. A field on the row keeps the choice beside the option.
- **Hiding the developer settings behind `?developer=1`.** A player who wants Bounce or the rapid-fire toggle could no longer find them. A fold costs one click.
- **A modal confirm for the reset.** The inline question keeps the door one page and needs no focus trap.

The options golden (`options-golden.test.ts`) pins the door's rows. The four Sound rows were edited by hand to the pair's markup (not re-recorded), and the Developer split is compared in registry order. Both changes are documented in the test's header.
