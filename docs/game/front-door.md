# Front door (roadmap G7)

Status 2026-11-02. The game page's title and level select, progress kept in the browser, settings, and the pre-aimed first shot. The code is in `@tb/game`: `door.ts` (formatting, pure), `door-page.ts` (DOM), `progress.ts`, and `settings.ts`.

## What a player sees

A bare URL (`pnpm game`, or the playtest link) opens the door over B1, which loads behind it. The door has three parts:

- The title, then **Play · <next level>** (the first level without a star) and, when another level is open, **Esc Back to <it>**.
- **How to play**: four lines on aiming, firing again (rapid fire) and freezing, stars and banking.
- A **section per series**, each under its title: Spectacle (B1 to B3), Chamber (L1 to L5), Undercut (U1 to U3), then after the Two players tables a **Trials · unrated (25)** toggle, closed by default (trials.md). Since 2026-11-06 the door lists every series whatever level the page opened on, and a pick loads in place: the page is not reloaded, only the level's engine is rebuilt. N, P and the result card's Next walk only inside the loaded level's series. Play never picks a trial.
- One **card per level**. Each card shows the id, the name, the block count and the rack, then the three star targets (the objective; T2 and T3 from the cast in the metric's own words, such as "70% down" or "3,200 points, heritage intact"), and the best play. On a phone the targets shrink to one line ("★ 40% · ★★ 70% · ★★★ 94%").

Below the cards, an **Advanced settings** link (closed on every visit; Will 2026-11-05: keep the settings, bury them) opens five settings: **Sound** (On or Off), **Look** (Maquette, Photoreal or Candy), **Camera** (Still, the default: it moves only when the player moves it; or Dynamic: it follows the collapse and shakes on hits, i.e. `keystone.follow=1` and `keystone.shake=1`), **Rapid fire** (On, the default: fire again before the last shot settles; Off waits for each settle, i.e. `keystone.rapid=0`; Will 2026-11-05, see spectacle-mode.md section 5; a change applies to the next click) and **Sharpness** (Full, or Fast, which caps the canvas at 1 device pixel per CSS pixel). The URL's `keystone.follow` and `keystone.shake` each win over Camera for the visit, and a Camera click drops them from the URL. A Camera change applies to the shake at once and to the follow from the next shot. A two-click **Forget my progress** link sits under them, inside the same panel.

In play, **Menu** (top right) or **Esc** brings the door back. While the door is open it holds the keyboard, so the game's keys (N, R, F and so on) wait.

On a first visit, B1's HUD offers **F Fire the first shot**: the first shot of B1's ace line (`solutions.ace[0]`), pre-aimed. The first collapse is then one click after Play, which is the first-minute promise in spectacle-mode.md section 11.

## Options (URL keys; each one wins over storage for the visit)

| Key | Values | Default |
|---|---|---|
| `door` | `auto`, `1` (always on load), `0` (never) | `auto`: shown when the URL names no `level` |
| `keystone.preaim` | `auto`, `1` (every level with a recorded line), `0` | `auto`: the series' first level, until the player has a record on it |
| `progress` | `on`, `off` (this visit only, settings included) | `on` (`localStorage` `tb.progress.v1`, `tb.settings.v1`) |
| `sound` | `on`, `off` | stored, else `on` |
| `look` | `hazy`, `real`, `candy` | stored, else `hazy` |
| `sharp` | `2`, `1` | stored, else `2` |
| `keystone.follow`, `keystone.shake` | `1`, `0` (each) | the stored Camera setting (`still`: both off), else off |
| `keystone.rapid` | `1`, `0` | the stored Rapid fire setting, else `1` |

When the player changes a setting on the door, it is stored and its URL key is dropped, so a reload keeps the choice.

## Stars and progress

- Star targets come from `castStars`, which reads `packages/keystone/src/stars.json`. A level whose cast has not landed (B3) shows only the objective's star and "★★ targets coming soon". Its targets appear as soon as `pnpm keystone:cast B3 ... --stars-into packages/keystone/src/stars.json` writes the file. No change to the door is needed.
- Progress is recorded at each round's end (`KeystoneHooks.ended`) per level id **and hash**, keeping the best play (stars, then the metric, then the total). A level re-authored since a play shows "Not played yet" instead of an old best. Custom runs (URL overrides, an engine other than the cast's) are not recorded and their cards say "custom: stars not recorded".

## Verification

- `game/test/door.test.ts` (pure): options, targets per metric, a simulated B3 drop-in, markup, settings precedence.
- `game/test/door-e2e.test.ts`: a fresh visit opens the door over B1, Play then Fire reaches a first collapse (D ≥ 0.1, about 100 of B1's 1,000 blocks) inside 20 s of sim time. On Rapier in CI this takes 2.3 s of sim. With `TB_CHANNEL=chrome` (the GPU engine on Metal) the test also asserts under 20 s of wall time from navigation. Further cases: Esc and Menu toggle the door, the door holds the game's keys, a settings round trip (settings hidden until Advanced settings is clicked), and progress on the card after a reload.
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

## Follow-ups (not in this step)

- Touch controls on phones: done (U4), [touch-controls.md](touch-controls.md). A finger drags to aim and fires on lift rather than a bare tap, so the arc shows before the shot. On a touch screen the HUD has Undo and Restart buttons after the first shot ([undo.md](undo.md)).
