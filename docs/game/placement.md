# Placement tool and domino brush (C9)

Roadmap item C9 (`docs/game/modes-roadmap.md`): edit mode with time stopped and an exact rebuild on Play, a ghost, face snap, rotate, an overlap check, a budget, course stamps, and a stroke brush that lays dominoes along a path. It unlocks M6 Wavefront (the brush), M8 Mason's Trial and M10 Rube Lab (the full tool), and M14 Chain War.

Verify (`plan/dag/nodes.json`): edit mode rebuilds the scene exactly on Play (hash); the overlap check rejects; the stroke brush spaces dominoes at the set pitch along a curve.

## What it is

- **Edit mode.** Time stops: the world shows every body at its authored pose, as the level compiles, before any presettle. You place, turn and remove pieces, lay domino runs, and undo. **Play** compiles the edited level and starts the run from it, exactly as loading the saved level file would (same level hash, same bodies; `build.test.ts`, the viewer's e2e test).
- **Ghost.** The piece you hold is drawn where it would go, green when it fits and red when it does not (overlap, into the ground, over budget), with the reason in the panel.
- **Face snap.** Pointing at a face puts the piece's face flush on it: on top of a top face, lattice-spaced (h (pitch - 1)) beside a side face. Its centre snaps to a half-cell grid in the face's own frame (the hit body's centre, steps of h pitch / 2 across, whole courses up a side), so a cube lands on a course, centred or straddling two cells (a bond). On the ground it snaps to the level's half-cell grid. A piece on a turned body (a domino, a Kapla plank) takes the body's yaw. Snap off (hold Alt) follows the pointer.
- **Rotate.** Turn 90 degrees (Q / E, 15 degrees with Shift), tip (T: stand the piece on its x or z axis, so a plank goes on edge or end).
- **Overlap check.** Separating-axis test on oriented boxes; a piece may touch (interpenetrate up to 1e-4 h, `validateLevel`'s tolerance) and no more.
- **Budget.** A level's `build` block: `budget` (catalogue cost), `pieces` (what is offered), `brush`, `material`. Placed parts carry `placed: true`, so the budget counts only them and only they can be taken back; the viewer's author mode has no budget and may remove any piece or run.
- **Course stamps.** One click places several lattice-spaced cubes: a course of 4, a wall 4 x 2, a pier of 3.
- **Domino brush.** Drag on the ground; the stroke is smoothed and becomes a run of dominoes, neighbours exactly `pitch` apart (straight line), each facing along the path. Dominoes that would cross the world or the run itself are left out (shown red while drawing) and the rest are laid.

## Level format

Two part kinds join `LevelDef.parts` (level.ts); every existing level compiles and hashes as before.

| Part | Fields | Compiles to |
|---|---|---|
| `piece` | `at` (centre, h, no lattice pitch), `half` (h), `yaw` (degrees, default 0), `material`, `role`, `placed` | one box, turned about +y |
| `run` | `path` ([x, z] in h), `pitch` (h), `half` (h: across, up, along), `y` (default 0), `material`, `role`, `omit` (indices), `placed` | the dominoes `runPoses(path, pitch)` gives, less `omit` |

The default domino is 2 h x 1 h x 0.3 h at a pitch of 1.2 h: at the game's 0.5 m h that is probe X1's tested domino (1 m x 0.5 m x 0.15 m, 0.6 of its height apart), which propagated on every line and curve X1 ran.

Hash rules: a piece's or run's fields are hashed in one fixed order with defaults left out (`placedKey`), so the build tool, a file and the URL give the same hash; a run's bodies join the hash (as a scenario part's do), so a change to the brush's spacing is a different level.

`validateLevel` measures overlaps of turned bodies as oriented boxes (AABBs of neighbours on a curve cross; the dominoes do not). Upright bodies are checked exactly as before.

## Alternatives considered

**Storing a run: its path, or every domino.** Storing each domino as a piece makes every one individually editable with no new compile code, but a 1,000-domino run is about 80 KB of level file and URL, and the run is no longer a thing you can re-space. Storing the path is a few hundred numbers, the hash covers it, and single dominoes are still removable through `omit`. Chosen: the path.

**Spacing: arc length or chord.** Arc-length spacing is the textbook brush, but what carries a wave is the distance between neighbours, and on a curve the chord is that distance while the arc is longer. Chord spacing makes "neighbours are exactly `pitch` apart" true on any path, and facing each domino along the chord between its neighbours is exactly the tangent on a circle. Chosen: chord.

**Overlap test.** AABBs are wrong for any turned piece (a curve's dominoes would all clash). GJK handles general convex shapes, which we do not have; SAT on boxes is exact, short and needs no iteration. Asking the physics engine for contacts after a step is asynchronous, engine dependent and too slow per pointer move. Chosen: SAT, with a uniform grid so a query only looks near the piece.

**Rotation.** Full 3D rotation lets a piece go anywhere but makes placement a 3-axis gizmo problem with a mouse and turns every part into a quaternion. Yaw plus "tip" (which axis stands up) covers what building needs (planks flat, on edge, on end; dominoes on curves) with two keys, and every compiled body stays upright, which keeps the support check meaningful. Chosen: yaw and tip.

**Where edit state lives.** The engine could be paused instead of stopped (bodies at their presettled pose), but then Play would not start from what you saw being placed against, and a presettle that moved bodies would invalidate placements. Editing the level definition and recompiling on Play makes "exactly" a hash comparison. Chosen: edit the definition.

**Ghost drawing.** A dedicated translucent pass would look nicer; extra body slots tinted with the renderer's per-slot effects (tint and glow) cost nothing new in the renderer and show the piece with the look's shading and shadows. Chosen: tinted slots; translucency can come later as a look option.

## Where it is

- `packages/keystone/src/placement.ts`: oriented boxes, `obbOverlap`, ray picks, `PlacementIndex`, `snapPlace`.
- `packages/keystone/src/stroke.ts`: `runCentres`, `runPoses`, `smoothStroke`, the default domino.
- `packages/keystone/src/build.ts`: the catalogue and stamps, `BuildDef`, `BuildSession` (ghost, place, remove, stroke, lay, undo, clear, def).
- `packages/game/src/edit.ts`: `EditController` (tools, what is held, pointer and keys over a session), `edit-panel.ts` (the Build panel), `edit-view.ts` (draws the world as edited and the ghost into a renderer). Shared by the viewer and the game.
- Viewer (`packages/viewer/src/main.ts`): key B or the Build panel, or the link `edit=1` (with `edit.tool=place|brush|erase` and `edit.item=<catalogue name>`). Author mode: no budget, anything removable. A scenario is built on as a level of its own (`scenarioLevel`). Play loads the edited level as the page's level (`level.def` in the link); Cancel (Esc) reloads the scene without the edits. Keys while editing: 1 to 8 items, Q / E turn (Shift: 15 deg), T tip, B brush, X erase, Z undo, Alt snap off, Enter Play.
- Tests: `packages/keystone/test/{placement,stroke,build}.test.ts`, `packages/game/test/edit.test.ts`, `packages/viewer/test/e2e-build.test.ts` (headless Chromium: time stops, the ghost draws green, Play's level hash equals the edited definition's and the page's link reloads the same level), `packages/viewer/test/level-file.test.ts` (format), `packages/keystone-lab/test/brush-physics.test.ts` (a brush-laid run topples end to end on the reference engine).
