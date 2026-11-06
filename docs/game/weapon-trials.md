# Weapon trials: the new weapons on L1 to L5

Status 2026-11-06 (DAG nodes V4 and V5, weapons plan steps 5 and 6: "at least one new built-in weapon per step that is fun on L1-L5").

## The weapons

- **Scatter** (`w-scatter`, `@tb/weapons` `SCATTER`, step 5). A slug that, 0.12 s out of the launcher, breaks into five pellets on a level fan across its heading (60 degrees either side, 4 cube units/s outward, `conserve`), each a marble's weight (density 30 cube units: 1.08 cubes; the rack's iron marble is 1.05 plaster cubes). The pellets' centre of mass flies on where the slug would have gone, so you aim it like any shell, and it hits a band a few cubes wide. Pure kinetic energy: 0 grenades.

## How fun is measured (`pnpm keystone:fun`)

`packages/keystone-lab/src/weapon-fun.ts`: on each of L1 to L5, each item alone in the rack, one shot at every candidate the par bot aims (every cell of every side face, every other course, 60% and 100% power), played to rest on Rapier. Per item: the share of shots that clear the level in one, crowns down (mean and best), the mean share of structure bodies moved more than half a cell (spectacle), the share of shots that move anything at all (lively: how forgiving it is to aim), and heritage broken. It is not a star line, only the comparison that says whether a weapon plays differently.

## Results (Rapier, 4 iterations, 2026-11-06)

| Level | Item | Shots | Cleared in one | Crowns (mean / best) | Moved (mean share) | Lively | Heritage broken (mean) |
|---|---|---|---|---|---|---|---|
| L1 | marble | 96 | 0% | 0.70 / 2 | 8% | 50% | 0.00 |
| L1 | cannonball | 96 | 0% | 2.23 / 3 | 45% | 100% | 0.00 |
| L1 | w-scatter | 96 | 41% | 2.80 / 4 | 40% | 92% | 0.00 |
| L2 | marble | 300 | 0% | 0.04 / 2 | 0% | 23% | 0.59 |
| L2 | cannonball | 300 | 22% | 1.50 / 6 | 22% | 82% | 5.55 |
| L2 | w-scatter | 300 | 9% | 0.71 / 6 | 9% | 68% | 4.44 |
| L3 | marble | 120 | 0% | 0.22 / 1 | 7% | 67% | 0.65 |
| L3 | cannonball | 120 | 10% | 0.62 / 2 | 29% | 100% | 1.27 |
| L3 | w-scatter | 120 | 46% | 1.23 / 2 | 39% | 92% | 2.47 |
| L4 | marble | 160 | 1% | 0.36 / 9 | 6% | 61% | 1.07 |
| L4 | cannonball | 160 | 33% | 4.35 / 9 | 31% | 89% | 1.87 |
| L4 | w-scatter | 160 | 22% | 2.86 / 9 | 31% | 91% | 2.70 |
| L5 | marble | 200 | 38% | 0.38 / 1 | 30% | 69% | 0.00 |
| L5 | cannonball | 200 | 43% | 0.42 / 1 | 46% | 68% | 0.00 |
| L5 | w-scatter | 200 | 41% | 0.41 / 1 | 38% | 100% | 0.00 |

The rocket against the grenades the same size and the full one (same method, Rapier, 2026-11-06):

| Level | Item | Shots | Cleared in one | Crowns (mean / best) | Moved (mean share) | Lively | Heritage broken (mean) |
|---|---|---|---|---|---|---|---|
| L1 | w-rocket | 96 | 99% | 3.99 / 4 | 89% | 100% | 0.00 |
| L1 | w-grenades | 96 | 91% | 3.66 / 4 | 80% | 93% | 0.00 |
| L1 | w-grenade | 96 | 100% | 4.00 / 4 | 94% | 100% | 0.00 |
| L2 | w-rocket | 300 | 76% | 4.81 / 6 | 42% | 100% | 8.80 |
| L2 | w-grenades | 300 | 66% | 4.25 / 6 | 36% | 93% | 8.25 |
| L2 | w-grenade | 300 | 69% | 4.94 / 6 | 52% | 100% | 12.63 |
| L3 | w-rocket | 120 | 95% | 1.95 / 2 | 93% | 100% | 3.00 |
| L3 | w-grenades | 120 | 78% | 1.67 / 2 | 78% | 90% | 2.63 |
| L3 | w-grenade | 120 | 98% | 1.98 / 2 | 95% | 100% | 3.00 |
| L4 | w-rocket | 160 | 52% | 4.96 / 9 | 36% | 95% | 2.27 |
| L4 | w-grenades | 160 | 53% | 4.81 / 9 | 32% | 88% | 1.94 |
| L4 | w-grenade | 160 | 58% | 5.37 / 9 | 37% | 96% | 2.52 |
| L5 | w-rocket | 200 | 47% | 0.47 / 1 | 54% | 100% | 0.00 |
| L5 | w-grenades | 200 | 50% | 0.49 / 1 | 53% | 96% | 0.00 |
| L5 | w-grenade | 200 | 79% | 0.79 / 1 | 80% | 100% | 0.00 |

What it says. Scatter plays as its own thing, not as a bigger marble. It is the most forgiving item on every level (lively 68 to 100%), and where the job is "hit several things at once" it is the best one-shot item: L1's crowned tower (41% of shots clear it, against none for the cannonball, which shears the tower but leaves crowns up) and L3's two crowns between heritage cubes (46%, against 10%), at a price in heritage there (2.5 broken on average, against 1.3): a shotgun is not a scalpel. Where the job is one heavy hit (L2's column, L4's catapult slab) the cannonball's single mass does more. On L5 every item clears about as often (the dominoes do the work). A first draft at density 6 (pellets a fifth of a cube) moved 1% of L1 and cleared nothing: the density was raised to make each pellet a marble.

The rocket is a quarter grenade that hits like more: at about the S grenade's energy (0.265 grenades with its motor) it clears more often on L1 to L3 (L2 76% against 66%, L3 95% against 78%) and within three points on L4 and L5 and is never dead on arrival (lively 95 to 100%), because the ram does work before the charge goes off. Against the full grenade, four times its blast, it is close on L1 to L4 and breaks a third less heritage on L2 (8.8 against 12.6): the surgical choice. Where the job is the dominoes' first push (L5) the full grenade's reach wins. Its own trick, a flat line to the far side of a lot, is not in this table (every candidate is aimed straight at its cell); it is what the trials' rack is for. A first draft carried a full grenade and played as the grenade does (within a few points on every level), so the warhead was cut to a quarter.

## Playing them

Trials T-W1 to T-W5 (`trial-levels.ts`): L1 to L5's structures and launchers with a rack of a Scatter, a Rocket and a marble, scored on the objective alone (the lot grown to the launcher ring less 3 cells, as every outcome level's). In the viewer, `proj.weapon=scatter` or `proj.weapon=rocket`; any level's rack may name `w-scatter` or `w-rocket`.
