# Undercut and Bullet Time: capabilities C1 and C2, modes M1 and M2

Status 2026-11-05. Stage 1 of [modes-roadmap.md](modes-roadmap.md) (Will chose "Probes, then Stage 1 verbs", 20:48Z). This note fixes the rules the roadmap left open and lists what each step lands with. The modes reuse the Keystone shell ([spectacle-mode.md](spectacle-mode.md)); nothing here touches the solver.

## C1: the `pull` rack item

**What it is.** `pull` is a rack item like `marble`: one entry per pull. Its shot is `{ ammo: 'pull', body }`, the engine id of a structure body; shot text `pull.<body>`, record code 5. Firing it pushes one engine `remove` event for that body at the fire step (`@tb/engine-api` remove.ts), and nothing is spawned, so later ammo is numbered as if the pull were not there.

**What may be pulled.** Any structure body that is still in the world, except crowns and heritage (the objective's pieces are never taken, and pulling a crown off would be a free clear). Refused bodies throw in `Session.fire`, the same place an empty rack throws, and the game never offers them.

**Physics.** Nothing new. Every engine already removes bodies (spent grenades); the GPU engine wakes what the removed body touched with a zero-impulse blast (engine.ts, sleep.ts header), Rapier wakes contacts on removal, and the reference engine has no sleep. A removed body is a tombstone: it stays where it was, with zero velocity, and the renderer skips it (tier `TIER_FREE`).

**Scoring.** A pulled block counts in every reduction at the pose it had when pulled, frozen there. So the pull itself releases no energy (no collapse is earned by deleting blocks high up), the collapse fraction only counts what falls because of it, and the observers need no tier check. The cost: D can never quite reach 1 on a level where many blocks were pulled high up, which is under 1% for any Stage 1 level.

**Nominal energy.** Leverage divides by energy fired, and a pull fires none (roadmap finding 12). A pull is charged the launch energy of the gentlest shot in the shell, a marble at power 0 at the level's unit (409 J at h = 0.5 m): the shot a pull stands in for, since the marble is the scalpel that knocks one cube out. Alternatives considered: the weight of the block lifted one h (153 J for plaster; ties the cost to the block, but a 10 kg plank then costs a tenth of a cube and every leverage tier collapses to Keystone); the friction work to slide it out under its load (the real Jenga cost, but the load per body is C19, not built). The marble rule keeps pulls and pokes on one scale and is one constant to re-fit after the playtest.

**Feedback.** `fired` carries `ammo: 'pull'` and `body`; the game shows a dust puff at the block and a soft scrape cue.

## M1 Undercut

Two level kinds, both outcome-scored (the slice's shell):

- **Aim.** A rack of 1 to 4 pulls (maybe one marble): pull blocks so the structure falls the way the objective wants (crowns down, heritage spared). Objective `crowns` or `collapse`, stars on the usual metrics.
- **Hollow.** Push your luck: take as many blocks as you dare while the capstone (a crown) stays up; bank before it goes. New objective kind `hold` (every crown above the crown line at the end) and star metric `pulled` (share of the structure's mass pulled, from 0 to 1). A crown that falls ends the level at that settle as failed. Stars are uncast until a cast runs (only the objective's star), as the roadmap allows (personal best).

Levels need slabs, planks and interlocks, because a pull under a loose-lattice column only drops that column one cube (roadmap section 4, risk; probe X4). The three Stage 1 levels are U1 to U3, a series of their own reachable at `?level=U1`.

## C2: input into a running world

**Rule.** A level (or the URL, `keystone.freeze=N`, which marks it custom) may give the player N freezes. A freeze stops the physics mid-shot; the world as it stands is aimed at and drawn (the camera is the player's, as always), and the player may fire one rack item into it. The shot is stamped with the frozen step, `at`, and the run resumes.

**Attribution: volleys.** A shot fired into a running shot joins it: the shots form one volley that settles once. The volley's outcome counts every shot's energy (ke + yield), crowns and heritage from the first shot's baseline. The settle restarts from the newest shot (its quiet count and cap run from there), so a late shot is never cut off by an early one's cap. Alternatives considered: splitting attribution by time (each crown to the latest shot before it fell; cheap but wrong, because the first shot usually did the work), or by contact chains (needs per-body provenance on the GPU). A volley needs neither and keeps "one settle, one outcome".

**Determinism.** A volley is replayed from (level, shots with `at`): `playShots` steps the driver until the engine is at `at` and fires there. The game fires a frozen shot after draining the pipelined read, at `engine.stepIndex`; a replay on the same driver reaches the same index, because a pipelined driver advances one step per call after its first (each resume skips one index, as the live run did). Shot text writes `@at` after the fields (`marble.60.8.0.20.95@412`); records flag the input (code + 8).

**Budget.** `freezes` per level (default 0: off). The HUD shows the freezes left; key T freezes and resumes, and a frozen world with nothing fired resumes for free (the freeze is spent only when a shot goes in).

## M2 Bullet Time

Freeze as an option on any level (`keystone.freeze=3`), plus Stage 1 levels scored on what the volley achieves. Echo (each retry re-fires the earlier volley at its steps) reuses the `at` replay and follows once freeze is in play. Live chain is later.

## Steps

| # | PR | Lands with |
|---|---|---|
| 1 | C1 core: `pull` item, shot text, record code, remove event, nominal energy, refusals | keystone tests: a pull drops the structure above it on the reference engine; replay of a pull line is exact; crowns, heritage and pulled bodies refused; record and text round trip |
| 2 | C1 in the game: pick and pull, outline the block under the cursor, puff and cue | game unit tests for the pick rule; e2e pull on Rapier |
| 3 | M1 levels U1 to U3, `hold` objective and `pulled` metric | level validation; a recorded line clears each level on the reference engine |
| 4 | C2 core: `at` stamps, volleys, `keystone.freeze` | keystone tests: serial and pipelined replays of a frozen shot match; volley outcome sums energy; settle restarts |
| 5 | M2 in the game: freeze key, HUD budget, viewer box | e2e freeze, fire, resume on Rapier |
