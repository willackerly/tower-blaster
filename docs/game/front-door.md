# Front door (roadmap G7)

Status 2026-11-02. The game page's title and level select, progress kept in the browser, settings, and the pre-aimed first shot. The code is in `@tb/game`: `door.ts` (formatting, pure), `door-page.ts` (DOM), `progress.ts`, and `settings.ts`.

## What a player sees

A bare URL (`pnpm game`, or the playtest link) opens the door over B1, which loads behind it. The door has three parts:

- The title, then **Play · <next level>** (the first level without a star) and, when another level is open, **Esc Back to <it>**.
- **How to play**: four lines on aiming, firing again (rapid fire) and freezing, stars and banking.
- A **section per series**, each under its title: Spectacle (B1 to B3), Chamber (L1 to L5), Undercut (U1 to U3), then after the Two players tables a **Trials · unrated (17)** toggle, closed by default (trials.md). Since 2026-11-06 the door lists every series whatever level the page opened on, and a pick loads in place: the page is not reloaded, only the level's engine is rebuilt. N, P and the result card's Next walk only inside the loaded level's series. Play never picks a trial.
- One **card per level**. Each card shows the id, the name, the block count and the rack, then the three star targets (the objective; T2 and T3 from the cast in the metric's own words, such as "70% down" or "3,200 points, heritage intact"), and the best play. On a phone the targets shrink to one line ("★ 40% · ★★ 70% · ★★★ 94%").

Below the cards, an **Advanced settings** link (closed on every visit; Will 2026-11-05: keep the settings, bury them) opens ten settings: **Sound** (On or Off), **Look** (Maquette, Photoreal or Candy), **Camera** (Still, the default: it moves only when the player moves it; or Dynamic: it follows the collapse and shakes on hits, i.e. `keystone.follow=1` and `keystone.shake=1`), **Rapid fire** (On, the default: fire again before the last shot settles; Off waits for each settle, i.e. `keystone.rapid=0`; Will 2026-11-05, see spectacle-mode.md section 5; a change applies to the next click), **Duel turns** (Turn the view, the default: in a Siege Table duel the camera swings to the middle of the side whose turn it is; Leave it keeps the camera where the last player left it, i.e. `keystone.turnview=0`; Will 2026-11-06, see siege-table.md "Whose side"; a change applies from the next turn), **Launch height** (High, the default: shots leave from 2 h over the structure's top, clear of the rubble on the ground; or Level's, the level's own launcher near the ground, where its par lines were recorded, i.e. `keystone.launch=level`; Will 2026-11-06; a change moves the launcher at once, and keys W and S move it a whole h from there), **Stone marks** (Carved, the default: a crosshair carved on every block the level asks you to bring down, a shield on every block to keep, i.e. heritage and a hold level's crown; Off leaves plain stones, i.e. `keystone.marks=0`; Will 2026-11-06, see `packages/render/src/marks.ts`; a change recarves the stones at once), **Layout** (Docked, the default: on a phone the HUD docks to the screen's edges, a status strip on top and an aim tray at the bottom upright or a rail down the left side sideways, and the result card waits 1.2 s after the round, a small tallying banner showing meanwhile, then docks aside; Classic is the one HUD panel and the centred card at once, i.e. `keystone.hud=panel&keystone.card=center&keystone.carddelay=0`; agent playtest PT3 and PT4, see [phone-hud.md](phone-hud.md)), **Sharpness** (Full, or Fast, which caps the canvas at 1 device pixel per CSS pixel) and **Quality** (Auto, the default: the tier a short probe picked for this device on load, named on the button, e.g. "Auto (High)"; or High, Medium or Low; see [quality-tiers.md](quality-tiers.md); a change applies at once). The URL's `keystone.follow` and `keystone.shake` each win over Camera for the visit, and a Camera click drops them from the URL. A Camera change applies to the shake at once and to the follow from the next shot. A two-click **Forget my progress** link sits under them, inside the same panel.

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
