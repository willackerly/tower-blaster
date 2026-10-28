# The viewer as a superset of the game

Will, 2026-10-28 02:53: "don't worry about PAR system for now... lets save it for dev testing... keep that in the VIEWER? would love to have the viewer be a testing ground for configurable game scenes too, can we have the viewer kind of be a superset of the game?"

## Goal

Every game scene (a Keystone level, its rules, its ammo, its HUD) can be loaded, played and inspected in the viewer, with every choice a quick-change option (Scene panel, URL key, saved JSON), and the game page becomes the same runtime with the dev chrome hidden. Par lines, stars and the replay check become dev tooling that lives in the viewer.

The property that defines "superset": **every game URL is a viewer URL**, and a session played in the viewer with Keystone rules on gives the same steps, score and snapshot hash as `runSession` headless (and so as the game page), on the same engine and device.

## Model

A viewer setup gets three independent axes. Each is a URL key, a panel control and a scene-file field.

| Axis | Values | URL | Scene file |
|---|---|---|---|
| Scene source | a scenario S1-S15 with params and seed, or a Keystone level (built-in id, later an inline `LevelDef`) | `scenario=S4&param.N=…` or `level=L2` | `scene.scenario` or `scene.level` (later `scene.levelDef`) |
| Rules | none (sandbox), or Keystone (needs a level) | `rules=keystone` | `keystone: { rules, … }` |
| Firing | sandbox: the projectile along the camera ray (weapons thread: `proj=<weapon>`); Keystone: the rack's ammo from the launcher ring, with the arc preview | `proj=…`, `proj.*` | `projectile`, `weapons` (weapons thread) |

The game page is the viewer runtime with `ui=game`: the game's HUD, banner, result screen, audio and Regrow, no Scene panel or perf HUD, and the game's defaults (`level=L1&rules=keystone`, hazy look, GPU at Keystone's 40 iterations and gapSlop 3e-5).

Scene-file changes are additive optional keys, so no version bump: a v1 file parses unchanged, and unknown keys are still refused.

## Runtime: modes

The viewer's page gets a small `Mode` interface that the frame and physics loops call: how many steps this frame (or free-run), one step, what a click or hover does, overlay and camera extras per frame, a HUD panel, and a per-step hook that sees each step's snapshot and may return input events. Two modes:

- **Sandbox** (today's viewer): `runFree` or `loop=frame` as now, fire along the camera ray.
- **Keystone**: a `Driver` (presettle, observe every step, the driver's own pipelined read on GPU) steps the engine, the game's `Pacer` decides steps per frame (hit-stop, slow motion, fast-forward), physics is frozen between shots, clicks aim and fire through `Session.fire`. Because frames only decide *when* steps run and the Driver runs *every* step, the session is `(level, shots)` and replays headless bit for bit, as the game guarantees today.

The weapons thread's runtime (proximity/timer triggers, blast, split, emit) hooks the per-step callback, so it works under either mode.

## Package layering

Today `@tb/game`'s page imports `@tb/viewer` (camera, `Window`), so the viewer cannot import the game's modules without a package cycle. Target:

```
@tb/keystone (rules, pure) ← @tb/game (Keystone presentation: aim, hud, juice, pacing, audio, tints, engines) ← @tb/viewer (runtime, config, panels, modes; both pages)
camera → @tb/render/camera (next to @tb/render/math), Window → @tb/metrics; @tb/viewer re-exports both
```

A test reads every `packages/*/package.json` and source import and fails on a cycle, and on `@tb/game` importing `@tb/viewer`.

## Steps

Each step is one PR with its own tests; `pnpm check` green; merged on green CI (standing rule).

| Step | Content | Proof |
|---|---|---|
| A | Layering: camera to `@tb/render/camera`, `Window` to `@tb/metrics`, re-exported from `@tb/viewer`; game page and tests stop importing the viewer. This doc. | Existing tests unchanged; new acyclic-imports test. |
| B | Levels as a scene source in the sandbox: `level=L1..L5`, `scene.level` in files, a Keystone group in the scenario picker, role and material tints, a "Keystone engine" preset (40 it, gapSlop 3e-5), a generic `presettle=N` option. | Parse/write/file round trips; `level` with `scenario` refused; viewer scene equals `compileLevel(L).scene` under worldScene; e2e: `?level=L2` loads n bodies with tints, a fired ball moves them. |
| C | `Mode` interface; Keystone rules mode (`rules=keystone`): Driver, Pacer, launcher aim and arc preview, rack and power keys, game HUD as a viewer panel, juice, result panel; `__viewer.keystone` test handle. | Unit tests of the mode against a stub engine; e2e: a recorded line played in the viewer ends with the same steps, score and hash as `runSession` on the same engine (Rapier in CI for speed, one GPU case). |
| D | Par and dev panel: par, lGold, stars, per-shot outcomes (leverage, dPE, crowns, heritage), "Play par line", "Replay check" (fresh engine, hash compare), shots as a URL key and in files for sharing repros. Par leaves the game's default UI (an option, off in `ui=game`) if the game thread agrees. | e2e: Play par line on L4 clears; replay check matches; shots round-trip through URL and file. |
| E | Configurable game scenes: inline `LevelDef` in files (`scene.levelDef`), load/download a level JSON, `validateLevel` issues shown in the panel, rule options as keys (slow-mo, freeze between shots, presettle, par panel). Weapons in a rack once the weapons thread defines it. | File round trip; a custom level runs with rules; invalid levels report the right issue codes. |
| F | One runtime: the game page becomes the viewer with `ui=game` (game page moved into `@tb/viewer` as a second entry, `pnpm game` on 5174 as now); `game/main.ts` (433 lines) deleted. Only after the game thread's in-flight fixes land, with its review. | The game's e2e and par-gpu tests pass unchanged against the new page; every game URL key parses as a viewer config. |

## Alternatives considered

- **Make the game the superset** (add the viewer's panels to the game page). Rejected: Will asked for the viewer, and the viewer already has the URL, panel and JSON machinery and every engine.
- **Keystone levels as `@tb/scenarios` entries.** Cheapest (the panel, URL and files would take them as they are), but a scenario is bodies only: roles, materials, crowns, the lot and the rack are lost, and bench suites would gain game scenes. Rejected for the source; the reverse, a `LevelDef` part that imports a scenario's bodies and assigns roles (rules on any scene), is a later option.
- **Two pages sharing a library** (extract more of the game, keep its loop). Leaves two loops that drift (the viewer's `runFree` and the game's tick); every fix lands twice. Rejected in favour of one runtime (step F).
- **Keystone pacing as a time scale inside `runFree`.** Hit-stop is counted in frames and the driver pipelines its own reads, so mapping both onto `runFree`'s due-time and pipelined refresh changes when steps are observed. Rejected: the Keystone mode uses the game's Pacer and Driver as they are.
- **Tolerating a package cycle** (pnpm allows one with a warning). Rejected: step A is a two-file move and keeps the graph a DAG.

## Ownership

- Game thread ("Design a fun, engaging game loop"): `@tb/keystone`, the game's presentation modules and the game page until step F. The viewer imports them read-only.
- Weapons thread ("Design proximity grenade and scripted weapons"): `@tb/weapons`, `proj=<weapon>`, the `weapons` file section, the blast input event, weapons in a rack.
- This thread: the viewer runtime, config model, panels, the Mode interface, steps A to F.
