# Front door (roadmap G7)

Status 2026-11-02. The game page's title and level select, progress kept in the browser, settings, and the pre-aimed first shot. The code is in `@tb/game`: `door.ts` (formatting, pure), `door-page.ts` (DOM), `progress.ts`, and `settings.ts`.

## What a player sees

A bare URL (`pnpm game`, or the playtest link) opens the door over B1, which loads behind it. The door has three parts:

- The title, then **Play · <next level>** (the first level without a star) and, when another level is open, **Esc Back to <it>**.
- **How to play**: four lines on aiming, freezing, stars and banking.
- One **card per level** of the series. Each card shows the id, the name, the block count and the rack, then the three star targets (the objective; T2 and T3 from the cast in the metric's own words, such as "70% down" or "3,200 points, heritage intact"), and the best play. On a phone the targets shrink to one line ("★ 40% · ★★ 70% · ★★★ 94%").

Below the cards are four settings: **Sound** (On or Off), **Look** (Maquette, Photoreal or Candy), **Camera** (Still, the default: it moves only when the player moves it; or Dynamic: it follows the collapse and shakes on hits, i.e. `keystone.follow=1` and `keystone.shake=1`) and **Sharpness** (Full, or Fast, which caps the canvas at 1 device pixel per CSS pixel). The URL's `keystone.follow` and `keystone.shake` each win over Camera for the visit, and a Camera click drops them from the URL. A Camera change applies to the shake at once and to the follow from the next shot. A two-click **Forget my progress** link sits under them.

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

When the player changes a setting on the door, it is stored and its URL key is dropped, so a reload keeps the choice.

## Stars and progress

- Star targets come from `castStars`, which reads `packages/keystone/src/stars.json`. A level whose cast has not landed (B3) shows only the objective's star and "★★ targets coming soon". Its targets appear as soon as `pnpm keystone:cast B3 ... --stars-into packages/keystone/src/stars.json` writes the file. No change to the door is needed.
- Progress is recorded at each round's end (`KeystoneHooks.ended`) per level id **and hash**, keeping the best play (stars, then the metric, then the total). A level re-authored since a play shows "Not played yet" instead of an old best. Custom runs (URL overrides, an engine other than the cast's) are not recorded and their cards say "custom: stars not recorded".

## Verification

- `game/test/door.test.ts` (pure): options, targets per metric, a simulated B3 drop-in, markup, settings precedence.
- `game/test/door-e2e.test.ts`: a fresh visit opens the door over B1, Play then Fire reaches a first collapse (D ≥ 0.1, about 100 of B1's 1,000 blocks) inside 20 s of sim time. On Rapier in CI this takes 2.3 s of sim. With `TB_CHANNEL=chrome` (the GPU engine on Metal) the test also asserts under 20 s of wall time from navigation. Further cases: Esc and Menu toggle the door, the door holds the game's keys, a settings round trip, and progress on the card after a reload.
- `game/test/progress-e2e.test.ts`: a round is recorded and survives a reload. Custom runs and `progress=off` are not recorded.

## Alternatives considered

- **A separate title page** (its own HTML entry) instead of an overlay. Rejected: the overlay lets B1 load and pre-settle behind the door, which is most of the first-minute budget on a 1k-block level.
- **Locking levels until the previous one has a star.** Rejected for the playtest: testers have little time and B3 (10k blocks) is the spectacle to judge. The Play button already points at the next unstarred level.
- **The pre-aimed opener on every level.** Rejected: it hands out each level's best opening. It is offered once, on a first visit, as an option (`keystone.preaim=1` for all).
- **Progress keyed by level id only.** Rejected: levels will be re-tuned between playtest deploys, and an old best would read as earned on the new level.

## Follow-ups (not in this step)

These come from the second-perspective visual review (2026-11-02):

- Touch controls on phones: power −/+, no key chips, and "Tap the structure to fire".
- A shorter in-play hint line in place of the full key list.
- Hide Leverage until the first shot.
- A Down bar with tick marks at the star targets.
