# The WeaponSpec editor (roadmap C12)

Status 2026-11-06. A visual editor for the WeaponSpec language (`docs/design/weapons.md`, `packages/weapons/src/spec.ts`) with a live arc preview and budget caps, so a weapon shared by link or file cannot overload the device that fires it. Viewer first; the game's Munitions Bench (M11) builds on the same pieces later. Will was away when this was built and delegated the choices; each one below says what else was considered.

## Pieces

| Piece | Where | What |
|---|---|---|
| Arc preview | `packages/weapons/src/preview.ts` `previewWeapon` | A weapon's flight before it is fired: one track per munition (shell, every child, every grandchild), every split and every blast with its sphere. |
| Device-tier caps | `packages/weapons/src/tiers.ts` | `WEAPON_TIER_CAPS` (low, mid, high): bodies, blasts and grenades of energy one shot may cost; `tierIssues`, `tierOf`, `fitsTier`. |
| Editing model | `packages/weapons/src/edit.ts` | Pure draft-to-draft edits (`setAt`, `addRule`, `addAction`, `addChild`, `renameChild`, `removeChild`, trigger and action kinds), the form's field table (`SHELL_FIELDS`, `BLAST_FIELDS`, ...) with the validator's ranges, and issues by field. |
| Viewer panel | `packages/viewer/src/weapon-editor.ts` | The form, the JSON beside it, a side view of the arc, the budget against the tier, Apply. |
| Scene preview | viewer `weapon-preview.ts`, `main.ts` | The arc drawn in the scene (the renderer's overlay beads) from where a click would fire it, while the editor is open or `weapon.preview=1`. |

## Arc preview: run the weapon's own runtime

**Chosen.** `previewWeapon` runs `WeaponRuntime`, the code that decides triggers in play, over a stand-in world that only knows free flight: munitions move by `freeFlight` (the engines' integrator), blasts kick the other munitions by `blastVelocity` (as every engine does), and the ground and the bodies already in the world are sensed by `near` triggers exactly as in play. A munition that touches the ground or a body stops there.

So while a munition flies free its track is the engine's path to rounding, and every trigger, split and blast lands on the engine's step. `packages/weapons/test/preview.test.ts` fires each case on the f64 reference engine and checks: one track per spawn on the same step; every free-flight point to 1e-9; every removal and blast on the engine's step; blasts centred to 1e-9 in flight and within a step's travel (0.6 units) where the munition touched something on that step. Cases: a timer grenade, the firework (apex split, 12 stars that blow each other about), the M grenade's proximity fuse, and the cluster against a wall (exact up to the first blast; from there the engine moves the wall and the preview does not).

In a scene the obstacles are the whole last snapshot, held still. Each step the preview gathers only the bodies near a live munition from a uniform grid (cell twice the largest body radius; the reach is the widest `near` plus the munition's radius and one step's travel), so the cost follows the munitions, not the scene: in Node on the cloud runner the firework into a 10k block takes about 22 ms, the cluster about 12 ms, the open sky about 5 ms (a first pass that tested every body every step took 750 ms). The page recomputes at most every 100 ms while the pointer moves and re-reads the world at most every 500 ms, and not at all while a drag is aiming.

Against the page as fired, the split lands on the shown step exactly. A star fuse set off by a neighbour can land a step or two apart, because the page reads the world once a frame (looking a few steps ahead) while the preview observes every step; the runtime is cadence-independent only while nothing near the path moves much. The e2e test holds blasts to within 2 steps.

What it does not show: bounces, rolls and knock-on after a contact, and the world's response to a blast (it draws the blast's sphere instead). Those need the physics; a preview that ran it would be a second simulation per hover.

Alternatives considered:
- **Re-implement the triggers in the preview** (closed-form apex, timer arithmetic). Rejected: two implementations of `then`, `any` and proximity drift apart, and the preview would be right about a weapon the runtime fires differently.
- **Fire it in a scratch engine** (a reference engine on the visible bodies). Exact through bounces, but the reference engine costs milliseconds per step on a 10k scene, far too slow to follow the pointer; kept as the test oracle instead.
- **Only the shell's arc** (as the game's aim arc does). Rejected: a weapon's point is what happens after the split.

## Budget caps by device tier

A spec already has a language cap (`MAX_WEAPON_BODIES` 256 and the other `validateWeapon` limits): what any page may load. The tier caps are what one shot may cost a device of a tier, measured three ways because each loads a different part of a frame:

| Tier | bodies (shell included) | blasts | grenades of energy | for |
|---|---|---|---|---|
| low | 32 | 16 | 4 | phones, integrated GPUs, SwiftShader, CPU physics |
| mid | 96 | 48 | 8 | laptops |
| high | 256 | 128 | 16 | a desktop-class GPU (the M5 Max) |

- bodies: GPU capacity is fixed at init and a CPU engine's cost grows with them; blasts: each is a GPU dispatch (a pass over every body on CPU) plus a fireball, shock shell and light to draw; grenades: `grenadeEnergies`, the energy that sets the world moving, so the solver's peak (the XL grenade's 16 put 8602 bodies in motion on B3 at frame p99 29.7 ms on the M5 Max in Low Power Mode, which is why high stops at 16).
- A load is over a cap by more than 1% (weapons are tuned to whole grenades within 1%: the XL is 16.003).
- Every built-in fits high; the S, M and L grenades, the firework and the cluster fit low; the XL needs high.
- Every number is a starting point. The device-tier probe (roadmap P1) and measurements on slower machines tune them, and nothing else hard-codes one.

Alternatives considered:
- **One cap (bodies only).** Rejected: a single grenade of huge energy is one body and stalls the solver more than 200 inert pebbles.
- **Measure the weapon on the device before allowing it** (fire it in a scratch world, time it). Rejected for now: costly at load, noisy, and the cost depends on what it hits; the static worst case is what the GPU must reserve anyway.
- **Scale an over-cap weapon down to fit** (fewer children, less energy). Rejected: it silently changes a shared weapon; refusing with a reason and the tier it needs is honest, and the editor shows the bars before anyone shares it.

Where they apply: the viewer refuses to fire a weapon over its tier (a notice says which number and which tier it needs), the editor shows the load against the caps live and will not apply a weapon over them, and `weapon.tier=low|mid|high` sets the tier by hand. Until P1's probe lands the viewer's tier is `high` on the GPU engine and `mid` on Rapier (CPU physics is the slow part of a low device); P1 replaces that guess.

## The editor

A form, not only a text box: shell (shape, size, density, friction, bounce, launch speeds), rules (a trigger, nestable `then` and `any`, and actions: blast, split, remove), and children in a tree, each field with its unit, its range and the validator's message beside it. The canonical JSON is beside the form and edits both ways (a valid text rebuilds the form; an invalid one shows its issues and leaves the form be), so nothing the language can say is out of the form's reach.

Alternatives considered:
- **JSON text only** with live validation. Cheapest and complete, but not visual, and the issue paths ("children.star.rules.0.do.1") are hard to map to the thing to fix.
- **A node graph** (munitions as nodes, splits as edges). Pretty for deep trees, but weapons are at most three deep and a rule's actions are ordered; a tree of forms says the same with less machinery.
- **Form only.** Rejected: a power user pasting a spec from a file or a chat should not have to retype it.

## Steps (each with its test)

1. `@tb/weapons`: `previewWeapon`, tier caps, editing model. Tests: preview against the reference engine, tiers, model round trips. (`packages/weapons/test/{preview,tiers,edit}.test.ts`)
2. Viewer editor panel: form, JSON, side view, budget bars, Apply into `weapon.def`. Tests: the panel's model in Node; headless Chromium edits a field, applies, and the URL's `weapon.def` decodes to the edited spec, which the page then fires.
3. Scene preview and tier enforcement in the viewer: beads along every track from where a click would fire, refreshed as the pointer moves; firing a weapon over the tier is refused with a notice. Tests: the beads are `previewWeapon`'s points and blast spheres within the overlay budget (`weapon-preview.test.ts`); in Chromium the fired firework splits on the shown step and blows within 2 steps of it; an over-cap weapon is refused on its tier and fires with `weapon.tier=high`.

   Beads, not lines: the renderer already draws up to 1024 overlay spheres in one instanced pass; a line pass would be new GPU code for the same read. Blasts are drawn first so a tight budget thins the tracks, never drops a blast.
4. Game: the rack's custom weapons (`keystone.rack` `w-<key>` on a level a link carries) are held to the same tier caps; the Munitions Bench (M11) puts the editor in the game.
