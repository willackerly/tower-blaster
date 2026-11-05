# Raw mode ideas (2026-11-05)

These are the 172 unfiltered ideas behind [../modes-roadmap.md](../modes-roadmap.md). Seven designers each worked one lens, from the same capability brief (what the engine does today, what is planned, and the known costs). Read the roadmap first; these files are its evidence, not its conclusions.

| File | Prefix | Lens | Ideas |
|---|---|---|---|
| [stacking.md](stacking.md) | ST | Stacking, balance, extraction | 25 |
| [chains.md](chains.md) | CH | Chain reactions, dominoes, waves | 25 |
| [destruction.md](destruction.md) | DE | Demolition and weapons | 24 |
| [puzzle.md](puzzle.md) | PZ | Puzzle and deduction | 24 |
| [competitive.md](competitive.md) | CO | Competitive, turn-based, social | 25 |
| [sandbox.md](sandbox.md) | SB | Creative and sandbox | 25 |
| [progression.md](progression.md) | PR | Progression, meta, content supply | 24 |

Each idea has the same fields: pitch, fun hook, borrowed from (mechanics only; nothing here recreates another game's name, art, characters or levels), loop at 30 s and 5 min, scale story (1k, 10k, 100k), uses today, needs new (each with a size S/M/L and a risk), level seeds, risks, and self-scores for fun, novelty, engine fit and cost (5 = cheap).

## Read these with three corrections

The designers worked from a brief, not from the code. Three of their engine claims were checked against the code and are wrong or out of date. The roadmap uses the corrected versions.

1. **`remove` already wakes its neighbours.** Several destruction and stacking ideas list "remove must wake sleeping neighbours" as new work. It is done: `packages/physics-gpu/src/engine.ts` issues a zero-impulse blast around each removed body so sleepers nearby wake.
2. **Pinned (static) bodies are small work on the GPU, not medium.** Sleepers are already infinite-mass anchors in the solver (`packages/physics-gpu/src/sleep.ts` header; the inverse-mass path in `solver.ts`). A pinned body is a sleeper that never wakes, so ideas that cost "static bodies" at M are really S on the GPU engine. The CPU reference engine still needs its own path.
3. **A gravity schedule is small.** Gravity is written to the solver every step (`engine.ts`, the `writeParams(n, scene.dt, scene.gravity, ...)` call), so a time-varying gravity vector (quakes, tilting decks) is S. The real cost is waking: a gravity change must wake every sleeper, which is a full-scene wake at 100k.

Also treat the self-scores as optimistic. Designers scored their own ideas, the mean is high, and engine fit was often scored before the corrections above. The roadmap's ranking re-scores the converged modes on its own weights rather than averaging these.
