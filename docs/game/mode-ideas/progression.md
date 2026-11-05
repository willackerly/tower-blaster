# Progression, meta-structure and content supply (lens PR)

Designer lens: what ties the modes together over time, what makes players come back, and how to make levels without spending an hour of Mac GPU time on each one.

Two cost facts shape almost every idea below:

- **Casting is the bottleneck, not authoring.** A 10k level costs about 1 h of M5 time to cast (spectacle-mode.md section 6). Below a few thousand bodies the GPU is dispatch-bound, so a 1k cast is probably 15-25 min, not 6. Small levels alone do not make casting cheap.
- **Many reward structures need no casting at all.** Binary predicates ("the bell lands on the green", "bank with 4 left") use only the validator plus one proof play. Relative scoring (beat your own best) and crowd percentiles need none either. The ideas that score high on cost lean on these.

A cheap-casting primitive comes up again and again, so I name it once here: **Island batching.** The ground plane is infinite, so pack K independent copies of a small level far apart in one engine and run K bot lines at once. For example, 64 competent lines of a 150-body chamber level is 9.6k bodies and one engine pass instead of 64. This needs per-island reductions (observers keyed by region) and spawn/blast events scoped to an island. Results are not bit-identical to a solo run, because solver colouring is global. That is acceptable: cross-device fidelity is already advisory, and thresholds are statistics. I estimate it cuts chamber and hall casts 10-40x.

---

### PR-1 Strata
- **Pitch:** a world-by-world campaign. Each world adds exactly one mechanic, and a world ships only when the engine capability behind it lands.
- **Fun hook:** every world turns your existing skills on their head with one new rule (teach, test, twist), and the roadmap is visible: greyed worlds are labelled with the capability they wait on. Players return because the game visibly grows.
- **Borrowed from:** platformer world structure (one new gimmick per world, teach-test-twist in four levels); early-access roadmap games, where new content arrives with engine updates.
- **Loop:** session = 3-5 levels of one world (10-20 min). Week = finish a world (60% of its stars opens the next, as in the design doc) and come back for the next capability drop.
- **Scale story:** world size grows with capability. W1-W2 are chamber/hall (100-1k), W3-W5 are city (5-10k), and the Mega world (100k) unlocks when sleep plus compaction land. Scale is the reward for progressing.
- **Uses today:** materials (plaster, stone, ice, rubber, iron, steel), Keystone ammo, real projectiles, weapons (grenade, firework, cluster), crowns/skyline/collapse objectives, heritage/footprint constraints, star casting, level select and saved progress.
- **Needs new:** a world map UI with a "waiting on" label per world (S, low); a world manifest (S, low). Each later world rides an engine milestone: "Push" world on sparse kicks (step 6), "Mortar" on joints/welds (step 7), "Megacity" on tiered blasts (step 8) plus sleep compaction. Those are the engine's own costs, not this idea's.
- **Content seeds:** W2 "Cold Snap": ice lintels (mu 0.05) slide off when tapped, so you aim low to slide rather than topple. W4 "Fuse Works": grenade and cluster only, and the puzzle is the order of charges. W7 "Push" (gated on kicks): no projectiles, a 64-body finger push per turn on a Kapla tower.
- **Risks:** campaign content is the most expensive per minute of play (every level cast). Players may hit the end of shipped worlds fast. Visible "waiting" worlds can read as unfinished.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 5 / cost 2

### PR-2 Wrecker's Ledger
- **Pitch:** a roguelike run over 8 shuffled lots. Your rack is your wallet: leverage earns cash, cash buys rack items and "permits" (rule-bending modifiers) between lots.
- **Fun hook:** every shot spends inventory you could have banked. Permits stack into broken combos ("blasts on ice blocks double", "heritage blocks count as crowns"). You chase the run where everything clicks. This is BREAKLINE evolved: the economy is the rack, not chips times mult.
- **Borrowed from:** deck-building roguelikes (shop between floors, modifier cards that rewrite scoring, ante escalation); poker-roguelikes (multiplicative score stacking); run-based shooters (meta-unlocks widen the pool but are not raw power).
- **Loop:** session = one run of 20-30 min (8 lots, a shop after each, a boss lot at 4 and 8). Week = unlock new permits and rack items into the pool, and climb "ante" difficulty tiers (each tier adds a global constraint, like footprint on every lot).
- **Scale story:** at 1k, lots are quick and the run is about economy. At 10k, the boss lots: one big structure where the rack you built must carry you. At 100k (later), a final "condemned district" boss where leverage x1,000 pays off the whole run.
- **Uses today:** existing cast levels as the floor pool (no new casting: quotas are set from the cast T2), the bank mechanic, leverage scoring, rack, WeaponSpec (permits can be data tweaks to specs: bigger yield, extra split), materials.
- **Needs new:** run state, shop and permit system (M, low); a permit DSL that touches scoring and level params, not physics internals (M, med: permits that change physics, like "ice becomes rubber", alter the level hash and invalidate cast thresholds, so the quota must use a conservative fallback); a run seed so runs replay on the same device (S, low).
- **Content seeds:** permit "Salvage Rights": every block that leaves the footprint pays $1. Permit "Double Tap": the first item each lot is fired twice at the same aim. Boss lot "The Bank Vault": a 10k steel-and-stone keep where you must clear the skyline with what is left in your rack.
- **Risks:** quota tuning without casting each permit combination; physics-altering permits break star validity. Run length is bounded by settle times at 10k (long collapses slow the pace).
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 5 / cost 4

### PR-3 Spoil Heap (wild)
- **Pitch:** your rubble carries over. The settled debris of each lot is lifted, translated and dropped into the next lot as terrain, props or ammo.
- **Fun hook:** how you wreck now decides what you face next. A tidy implosion leaves a compact pile you can use as a ramp. A sloppy blast scatters debris that buries the next level's crowns. Players learn to "wreck for the future".
- **Borrowed from:** roguelikes with persistent world damage between floors; city-builders where your previous scar is the new site; puzzle games where the leftover board is the next board.
- **Loop:** session = a chain of 5 lots in a run (the Ledger can host it as a permit, or it stands alone). Week = a weekly "Tip" chain with a fixed seed, run as many times as you like.
- **Scale story:** at 1k, the carried rubble is a handful of blocks that act as props. At 10k, the pile is a granular landscape that jams or channels the next collapse (SPILLWAY's Sluice idea, made by the player). At 100k, sleep makes a huge carried heap almost free: it rests until touched.
- **Uses today:** readable snapshots, `spawn` at rest (placing every carried block), sleep, footprint (the lot boundary decides what carries), bit-determinism per device (a run replays on your device).
- **Needs new:** a "carry" transform: read the snapshot, filter by region, re-spawn bodies at rest with damped settle (S, low); handling of not-quite-at-rest carried bodies so they don't explode on spawn (M, med: needs an overlap-repair or settle pass); per-level stars become uncastable, so scoring is relative to quotas or to your own best (design, low).
- **Content seeds:** "Quarry Chain": five stone towers in a line, each lot's rubble arrives as the next lot's foreground ramp. "Avalanche Ladder": ice rubble carried onto a slope (slab ground) where it slides into the next keep. "Clean Site": a constraint where the carried pile is your penalty; the less you carry, the bigger the bonus.
- **Risks:** respawned rubble at 10k may overlap and "pop"; uncastable stars; runaway snowball (a bad lot dooms the run).
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 3 / cost 4

### PR-4 Almanac
- **Pitch:** one generated lot a day and one bigger lot a week, cast overnight on the Mac. Every past day stays playable forever: no streaks, no FOMO.
- **Fun hook:** a shared puzzle the whole playerbase faces today; talk about the trick shot. It runs on a calendar, not a treadmill: missing days costs nothing, and the archive is a growing library.
- **Borrowed from:** daily word games (one shared puzzle a day, shareable result grid); daily roguelike seeds (one attempt per day ranked, unlimited practice runs); puzzle-calendar apps with full back catalogue.
- **Loop:** session = today's lot (5 min; one "official" attempt plus unlimited practice). Week = the Sunday "Weekender" (bigger, 10k), plus browsing the archive by tag.
- **Scale story:** the daily is 1k-3k (casts in about 20 min, or less with island batching). The weekly is 10k (1 h of overnight Mac time: affordable once a week, even every night). A 100k monthly would have to use cast-free goals (PR-8) or crowd stars (PR-5).
- **Uses today:** the cast pipeline (`pnpm keystone:cast`), the 200-byte replay string as a share code, level hash for official runs, the front door.
- **Needs new:** a nightly cast job and level CDN publish (S, low: cron plus Cloudflare Pages); the generator (PR-6, M, med); a share card (emoji-free result tally, shot string) (S, low); optional leaderboard backend (M, med: scores only, since a replay cannot be re-verified on another device, so leaderboards are honour-based or verified by Mac re-sim of the shot string).
- **Content seeds:** "Tuesday Lintel": a 1.2k colonnade with three crowns and a heritage statue. "Weekender: Harbour Wall": a 10k stone sea wall, footprint constraint. "Rubber Day": a monthly theme day where everything bounces (Will's favourite drive as a puzzle).
- **Risks:** cross-device chaos means a player on a different GPU can face a slightly different daily; leaderboard cheating without server re-sim; the generator must produce good puzzles every day, not just valid ones.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 5 / cost 4

### PR-5 Crowdcast
- **Pitch:** stars come from real players. The bot casts a provisional cut once (cheap, small N), then the thresholds re-settle on the distribution of actual outcomes.
- **Fun hook:** stars mean "you did better than most people", which players read more easily than "better than a bot". Levels need no full cast, so far more of them can ship.
- **Borrowed from:** golf course rating from real rounds; rhythm games' percentile ranks; collaborative puzzle platforms where the crowd defines difficulty.
- **Loop:** session = play any level; your result joins the pool. Week = levels "mature" from provisional (shown with a dotted star) to settled stars.
- **Scale story:** most valuable at 10k-100k, exactly where Mac casting is unaffordable. 100k levels can ship with a 5-line sanity cast plus crowd stars.
- **Uses today:** objective checks and metrics (collapse D, skyline, crowns), the "official run" hash, the competent-bot line (as a seed cast with N=8).
- **Needs new:** a scores backend: submit (level hash, device class, metric, shot string) (M, low); per-device-class pools, since chaos differs by GPU (S, med); robust aggregation against cheats and outliers (M, med); a provisional-cast recipe (S, low).
- **Content seeds:** "Founders' Week": 20 new 10k lots released provisional; the first players set the bar. "Device Derby": pools split by GPU class show which machines collapse differently. "Settled" badge: players who played a level while provisional get a small founder mark.
- **Risks:** needs a backend and a population (empty pools at launch); thresholds drift; it loses the "fair / skill matters / stable" gates unless a minimal bot cast still runs.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 4 / cost 5

### PR-6 Foundry
- **Pitch:** a structural grammar generates levels from a few parameters, and the bot casts a sample of each family. A regression predicts thresholds for the rest, with spot checks.
- **Fun hook:** this is a supply idea. It is what lets Almanac, Ledger and Escalation exist at all. The player-facing hook is infinite "more like this" from any level they liked.
- **Borrowed from:** procedural dungeon generators with solvability checks (puzzle roguelikes that verify every room); procedural puzzle games that grade generated levels by solver effort; ML-style surrogate modelling.
- **Loop:** session = "more like this" after any level. Week = a new family released (e.g. "colonnades") with 200 generated members.
- **Scale story:** families at 1k cast cheaply with island batching (one engine run casts 8 members). At 10k a family casts 5 members fully (5 h, one night) and predicts the others from features (height, slenderness, material mix, keystone count). At 100k, prediction only, labelled provisional (feeds Crowdcast).
- **Uses today:** all scenarios (wall S3, city S4, buildings S14, Kapla S15, pyramid, column, wall with hole) as the generator's primitives; `validateLevel` (tunnelling, mass-ratio, dud, capacity); the cast recipe and gates.
- **Needs new:** a parametric generator over scenarios (M, low); the island-batch caster (M, med); a feature extractor plus a threshold regressor with an error bar (M, med); an auto-reject loop (a member fails a gate and is regenerated) (S, low); GPU fork (spectacle doc's ask) for a further 2-3x (M, med).
- **Content seeds:** family "Colonnades": N columns, lintel material, crown on the third bay. Family "Tenements": 4x4 city blocks with one heritage church. Family "Kapla Spires": plank towers with a parametric twist per course.
- **Risks:** generated levels feel samey; the regressor is wrong for chaotic families (the error bar must gate shipping); procedural fairness is harder than handmade.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 4 / cost 5

### PR-7 Kiln
- **Pitch:** your own GPU casts stars for upcoming levels while you idle in menus (opt-in, with a power indicator), so stars are cast on your device and every level can be cast.
- **Fun hook:** "your kiln has fired three new lots" when you come back, which is a non-manipulative reason to return. Stars cast on your own device also sidestep cross-device chaos entirely: the thresholds match the physics you play.
- **Borrowed from:** idle-game offline progress (work completed while away); distributed volunteer computing; console games that pre-compile shaders on first run.
- **Loop:** session = play while the kiln fires the next pack in the background or between levels. Week = the kiln queue empties into "fresh" lots.
- **Scale story:** 1k lots fire in minutes on a decent laptop; 10k is about an hour on an M5, so slower GPUs get a smaller-N recipe labelled "quick-fired" (wider error bars). 100k: not on player devices.
- **Uses today:** the browser cast runner (it already runs in Chromium: `pnpm keystone:cast --engine gpu`); per-device determinism; the level hash and recipe recorded with thresholds.
- **Needs new:** in-game cast scheduler that yields to play and pauses when the tab hides (M, med); per-device local star storage (S, low); a "quick-fire" recipe (smaller N, gates loosened, labelled) (S, med); battery and thermal etiquette (S, low).
- **Content seeds:** "First Firing": during onboarding, the kiln fires B1 so stars are local from day one. "Seed Pack": 20 Foundry members queued per week. "Bisque" tier: quick-fired stars shown hollow until a full firing finishes.
- **Risks:** players hate background GPU use on laptops (it must be strictly opt-in); local stars break global comparability; casting may be too slow on integrated GPUs to matter.
- **Scores (1-5):** fun 2 / novelty 4 / engine fit 4 / cost 5

### PR-8 Lot Sheet
- **Pitch:** every level carries five hand-written side goals, checked by observer predicates. One cast level becomes five or more distinct challenges, and none of the goals needs a cast.
- **Fun hook:** a single level becomes a playground of specific asks ("drop the bell on the green", "win with only the cue", "leave the clocktower standing alone"). Players replay levels they've three-starred to clear the sheet.
- **Borrowed from:** skateboarding games' per-level goal lists (collect letters, hit a gap, do a combo); assassination-sandbox challenge lists per map; golf trick-shot challenges.
- **Loop:** session = clear 2-3 sheet goals on familiar levels (fast, because the structure is learned). Week = new "sheet refills" for old levels (cheap content), plus a world-wide sheet mastery count.
- **Scale story:** at 1k, goals are precise ("the third column falls last"). At 10k, goals are about selection among many ("only the north tower falls"). At 100k, goals are about shape ("the skyline ends as a staircase") checked by height histograms.
- **Uses today:** observers and reductions (counts, bounding boxes, histograms, predicates on pos/vel/displacement), 64 watched bodies (the named props), heritage, footprint, bank, rack.
- **Needs new:** a goal predicate DSL over observers (S-M, low); proving each goal once with one recorded solution (the author's or the bot's) so it's known achievable (S, low); a sheet UI (S, low).
- **Content seeds:** B1 Long Wall: "make a doorway: remove a 3x3 hole without dropping the top row". B2 Spare the Cathedral: "the cathedral bell (a sphere) must end above 10 m". B3 Ten Thousand: "flatten exactly two city blocks; the rest stays above 80% height".
- **Risks:** goals proven on Will's Mac may be near-impossible on another device in chaotic regions (prove them with a margin); writing good goals is design labour (but cheap labour).
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### PR-9 Escalation
- **Pitch:** each level spawns a five-step ladder of variants. Every step adds one constraint or swaps one material, and the steps are pass/fail, so they need no stars.
- **Fun hook:** "you beat it; now beat it with ice lintels; now with heritage on the fountain; now with 2 items." Each rung re-uses your knowledge of the structure while invalidating your favourite line.
- **Borrowed from:** assassination games' escalation contracts (same map, layered complications); puzzle games' "hard mode" constraint variants; ascension levels in roguelikes.
- **Loop:** session = climb one ladder (5 short attempts on a learned structure). Week = a featured ladder per week, plus player-authored ladders (it's just a list of overrides).
- **Scale story:** at 1k, a material swap changes everything (ice versus stone). At 10k, constraints like footprint dominate (rubble has volume). At 100k, ladders drop rack size until the only path is a true keystone shot.
- **Uses today:** "every option is switchable" (URL param, scene file) as the override mechanism; objectives; constraints; the "custom: stars not recorded" label already exists for overridden levels.
- **Needs new:** a ladder manifest (S, low); a pass/fail-only result card for overridden runs (S, low); one proof play per rung (bot or author) (S, low; one line, not a cast).
- **Content seeds:** B1 ladder: stone, then ice top course, then heritage end posts, then rack of 2, then marbles only. Pyramid ladder: rubber base course, the apex must fall last. Kapla ladder: planks get thinner each rung.
- **Risks:** pass/fail without grades may feel thin; some override combinations make a level trivial or impossible (proof plays catch the impossible, not the trivial).
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### PR-10 Grades
- **Pitch:** one cast yields the full distribution, so offer five grade bands instead of three stars and let each player choose their own bar: Apprentice (P25 of competent plays) up to Master (P90 of nudges).
- **Fun hook:** difficulty is self-selected with no shame and no lost content. Mastery players chase "Master" bands that the bot itself barely reaches. It's honest about what the bot measured.
- **Borrowed from:** rhythm games' letter grades from score distributions; golf handicaps; speedrun tier boards (bronze to author time).
- **Loop:** session = replay a level for the next band up. Week = a per-world "grade bar" set by the player, shown as a ladder rather than a gate.
- **Scale story:** at 10k the clouds are wide (chaos), so bands are honest about luck. At 100k, the nudge cloud is small (few lines), so Master is suppressed until more casting is done.
- **Uses today:** the cast already records P10, P25, P50, P75, P90 of both clouds in `docs/game/levels/<id>.md`; beat-the-bot.
- **Needs new:** band thresholds derived from the cloud summary written into the level (S, low); UI for chosen bar (S, low); gating rules (a world opens on any-band progress, not stars) (S, low).
- **Content seeds:** B3 Ten Thousand: Apprentice = P25 competent D, Master = P90 nudge D. A "Bot's Rival" band above beat-the-bot for leaderboard players. An "Assist" band that is earned while the X-ray hints are on.
- **Risks:** five bands dilute the meaning of three stars; bands at the extremes of a 50-play cloud are statistically shaky (bootstrap errors).
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### PR-11 Collapse Museum
- **Pitch:** save your best collapses as 200-byte replays, hang them in a museum you curate by wing (material, tool, scale), and let them re-simulate live whenever someone visits.
- **Fun hook:** spectacle is what Will responds to, and this makes spectacle collectible. Players chase collapses worth exhibiting and share links to them. Re-simulating each exhibit live costs nothing to store.
- **Borrowed from:** photo-safari games' photo grading and album; racing games' replay theatre; trophy rooms in action games; "photo mode" culture.
- **Loop:** session = a level ends, "Hang it?" offered on any run in the top 10% of your history, plus 1 minute arranging. Week = complete a wing (a curated set of placards), and visit a friend's museum.
- **Scale story:** 1k exhibits play instantly. 10k exhibits play in real time with the viewer's interpolation. 100k exhibits are pre-recorded on the Mac as a baked trajectory (downloaded, since re-sim isn't real time yet) or replayed slow-mo on capable GPUs.
- **Uses today:** replay (level + shots), per-shot ink, displacement heatmap, the look=real mode, the modal impact synth, the replay string as a link.
- **Needs new:** museum UI and wings (M, low); camera bookmarks for an exhibit, player-chosen only, following the camera rule (S, low); automatic placard stats (leverage, peak awake bodies, duration) (S, low); cross-device viewing: replays re-simulate differently on another GPU, so a visitor's copy shows a "re-enacted" tag, or Mac-baked trajectories are stored for featured exhibits (M, med).
- **Content seeds:** "The Ice Wing": every exhibit has an ice lintel slide. "Single-shot Hall": collapses from one item. "Restitution Gallery": Will's favourite drive (size-5 ball at 80 m/s with Bounce into the 1k wall) as the founding exhibit.
- **Risks:** a friend's museum replays differently on their device (it must be honest about that); curation is a niche activity.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 5

### PR-12 Field Guide
- **Pitch:** a natural-history album of physical phenomena. The game recognises 40 named behaviours ("the domino run", "the ice slip", "the pancake", "the rubber ricochet", "the lone survivor") and you collect them by causing them.
- **Fun hook:** knowledge-based progression: each new entry teaches a real physical idea and suggests where to try it. The album pulls players to experiment with materials and tools they would never pick for score.
- **Borrowed from:** open-world compendiums (photograph each creature); knowledge-gated exploration games (a ship log that fills as you understand things); spell-discovery sandboxes.
- **Loop:** session = notice "New entry: the ice slip" mid-level; check what is left. Week = a themed "expedition" (5 entries tied to a world).
- **Scale story:** some phenomena exist only at scale: "the avalanche" (more than 3k bodies moving at once), "the granular jam" (10k rubble that stops a collapse), "the long fall" (a 20 s multi-stage collapse at 100k). Scale unlocks entries.
- **Uses today:** observers (count of moving bodies, potential energy, histograms, predicates on displacement), watched bodies, per-material contact sound tags.
- **Needs new:** a phenomenon detector library over observer time series (M, med: false positives annoy); album UI with "how it looks" mini-replays (S, low).
- **Content seeds:** "The Pancake": a tower falls with its bounding box shrinking vertically under 2x its width while staying in the footprint. "The Lone Survivor": exactly one block of the original structure stays above 50% height. "The Rubber Riot": more than 50 rubber bodies airborne at once.
- **Risks:** detectors misfire (players feel cheated); a checklist can feel like homework if entries are too obscure.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 4

### PR-13 Hand Ranks
- **Pitch:** a mastery track per tool and per material. Ranks are earned by skill feats with that tool ("leverage x50 with a marble", "a three-crown cue push"), and rank-ups give cosmetic ink colours and placards, never power.
- **Fun hook:** players build identity ("I'm a cue specialist") and pick tools for the challenge, not just the optimum. It fights the "always the wrecking ball" collapse of choice.
- **Borrowed from:** shooter weapon-mastery grinds (camo challenges per weapon), but skill-based not volume-based; character mastery in fighting games; skill trees in sports games.
- **Loop:** session = progress on 1-2 ranks naturally while playing. Week = a featured tool of the week with a doubled feat list (still no expiring rewards).
- **Scale story:** at 1k the feats are precise ("topple a column with a single marble"). At 10k the feats are about leverage. At 100k, "a leverage of x1,000 with a marble" is the endgame feat.
- **Uses today:** rack items, the score components (leverage, combo, rack left), per-shot attribution (ink), materials.
- **Needs new:** a feat definition table over existing score signals (S, low); cosmetic unlocks (ink palettes, the pastel "Topple" skin noted in the design) (S, low).
- **Content seeds:** "Cue: Rank 3 – Surgeon": push a block out of B1 without the top course moving. "Ice: Rank 2 – Skater": slide an ice lintel more than 3 block lengths. "Firework: Rank 4 – Showman": 12 stars, each striking a different block.
- **Risks:** feats that are volume grinds in disguise; cosmetics may not motivate a rigorous, physics-minded audience.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### PR-14 Armory Bench (hybrid with destruction and sandbox)
- **Pitch:** unlock WeaponSpec parts (shells, triggers, actions) as progression, then build your own munitions on a bench and take them into Ledger runs and sandbox.
- **Fun hook:** the weapon is the puzzle. A cluster whose bomblets trigger on proximity to ice, a firework that only blasts at apex: the player engineers the tool that cracks a structure.
- **Borrowed from:** wand-building roguelites (spell components in slots, order matters); vehicle-building physics sandboxes; programming games where components are unlocked progressively.
- **Loop:** session = test a new build in a firing range (1k), then field it. Week = unlock 1-2 parts from campaign worlds, and build challenges ("make a munition that removes exactly 1 block").
- **Scale story:** at 1k you see each child munition. At 10k the depth-3 splits matter (cluster of clusters). At 100k, tiered blasts (step 8) let a home-made spec level a district.
- **Uses today:** WeaponSpec is pure data (shell + rules -> blast, remove, split, depth <= 3); the validator's static body budget and nominal energy (the V3 ask) give the cost of each build.
- **Needs new:** the bench UI (M, low); parts as unlockables (S, low); cost model = nominal energy into rack slots or Ledger cash (S, med: under-priced builds break star fairness, so custom builds are off for official star runs unless the level allows them); new trigger kinds (e.g. "near material") (M, med).
- **Content seeds:** part "Apex Fuse" (trigger at apex), unlocked in W4. Bench challenge "Scalpel": remove the keystone of the pyramid without moving anything else. Run permit "Bench Licence": one custom munition allowed per Ledger run.
- **Risks:** degenerate builds; a UI for a rules language is hard to make friendly; casting cannot cover custom weapons, so they live only in uncast contexts.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### PR-15 Licence Tree
- **Pitch:** the sandbox is the viewer (a superset of the game), and its knobs (Bounce, ice everywhere, slow-mo, X-ray, 100k scale, look=real) unlock as you progress through the game.
- **Fun hook:** progress hands you tools to play with, not just stars. Each campaign world ends with "you've earned Bounce for the sandbox". Players go from "solve this" to "now play with it".
- **Borrowed from:** space-flight sim tech trees (science unlocks parts); creative mode unlocks; sandbox games that open options as tutorial gates.
- **Loop:** session = finish a world, unlock a knob, spend 5 minutes playing with it. Week = sandbox "prompts" that use recent unlocks.
- **Scale story:** the final unlock is the scale slider itself, gated on device capability (honest: "your GPU runs 30k in real time").
- **Uses today:** every option is already switchable (URL param, Scene panel, scene file); the viewer is the superset.
- **Needs new:** gating of the Scene panel by profile (S, low); a device capability probe for the scale slider (S, low).
- **Content seeds:** W1 unlock: "Projectile shelf" (all real projectiles in the sandbox). W2 unlock: "Material brush" (repaint blocks to ice/rubber). Finale unlock: "100k city" with sleep.
- **Risks:** locking options in a game whose owner values "every option is switchable"; the URL params let anyone bypass it (fine for a dev audience, but then why gate). Suggest: gate only in the game shell, never in the viewer.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### PR-16 Powers of Ten
- **Pitch:** a progression where each chapter is one structural idea played at four scales: 100, 1k, 10k, 100k. The big version is the small one tiled, scaled or nested.
- **Fun hook:** you learn the principle on a 100-block chamber, then recognise it hidden inside a 10k city ("that's the lintel trick, 40 times over"). Scale is the twist, not decoration.
- **Borrowed from:** zoom-scale documentary structure; growth games that rescale the world each stage; fractal puzzle games where a solved puzzle becomes a tile of the next.
- **Loop:** session = one chapter (4 levels, small to big, about 20 min). Week = one new chapter; the 100k finale of each chapter arrives when the engine allows it.
- **Scale story:** this idea IS the scale story. 100 = read the mechanism. 1k = composite. 10k = search for the mechanism among copies. 100k = chain the mechanism into a multi-stage collapse with leverage x1,000.
- **Uses today:** scenarios as tiles; chamber levels L1-L5 as the "100" rung; B1-B3; X-ray; plan view.
- **Needs new:** a tiling/nesting composer for structures (M, low); casts per rung (the 100 and 1k rungs are cheap with island batching; the 10k costs 1 h each) (cost, med); 100k rungs wait for sleep compaction (engine, high).
- **Content seeds:** chapter "Lintel": one doorway, then a colonnade, then a city block of arcades, then a megastructure of arcades whose keystone arcade drops the rest. Chapter "Ice": one slide, then a staircase of ice, then a glacier wall. Chapter "Counterweight": a seesaw plank, then a lever bridge, then a city held up by counterweights.
- **Risks:** tiling looks artificial; a 10k version may not actually "contain" the small trick under chaos; the 100k rung may not ship for a long time.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### PR-17 First Brick
- **Pitch:** a 90-second onboarding that doubles the world each tap: one cube, a stack, a column, a wall, then a 1k wall that you hit with Will's favourite drive (size-5 ball at 80 m/s with Bounce).
- **Fun hook:** the first thing a player does is the most spectacular thing the engine does. Every tap teaches one verb (aim, power, fire, bank) while the scale grows under them.
- **Borrowed from:** growth games' scale-up reveal; action games' "start at full power, then take it away" tutorial; puzzle games' wordless onboarding.
- **Loop:** session = first launch only, plus a replayable "Showreel" from the menu. Week = n/a (it feeds the campaign).
- **Scale story:** 1 to 1,000 in five taps; the final screen hints at 10k ("the city is waiting").
- **Uses today:** spawn at rest (building each stage), real projectiles, Bounce, the 1k wall scenario, the modal impact synth, look=real.
- **Needs new:** a scripted onboarding sequence that fires the player's input, never moving the camera on its own (S, low); a "teach one verb" prompt layer (S, low).
- **Content seeds:** tap 1 "one cube, a marble": learn aim. Tap 3 "a column": learn low versus high hits. Tap 5 "the wall": learn power, with Bounce and the ricochet sound.
- **Risks:** the "start big, then small" contrast can make the chamber levels feel like a step down (Keystone's risk 3 in the design doc); camera framing without auto-motion needs careful fixed shots.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 5 / cost 5

### PR-18 The Spire (wild)
- **Pitch:** the meta-map is itself a 30k-block tower in the menu. Each level you beat removes, paints or loosens one of its blocks. When you finish the game, you fire the last shot at the map, and your progress decides how it falls.
- **Fun hook:** the level select is a physics object that slowly gets more fragile as you progress. The finale is personal: the collapse you get depends on which worlds you finished and in what order.
- **Borrowed from:** RPG overworlds that change with your progress; metroidvania maps that fill in; incremental games with a final "spend everything" payoff.
- **Loop:** session = beat a level, watch your block in the Spire light and slide out (a tiny, satisfying animation in the menu). Week = a visible change to the map; at the end, the finale.
- **Scale story:** at 30k resting blocks, the map costs nothing to idle thanks to sleep. The finale collapse is the biggest real-time moment of the game; at 100k it needs the full sleep and compaction work.
- **Uses today:** spawn at rest (build the spire from a saved state), `remove` (each beaten level removes a block), sleep, snapshot save in browser storage (30k bodies is under 1 MB), per-device determinism (your spire is yours).
- **Needs new:** sleep compaction so a 30k idle map costs under 1 ms (engine, in progress, med); a map-as-menu UI with picking on blocks (M, med); a guarantee that the spire never collapses before the finale (design-time structural margin, plus a static/anchor body flag) (M, med).
- **Content seeds:** "Plaster Course": the bottom ring stands for W1, and each level beaten pulls one plaster block. "Ice Keystones": W2 levels turn spire blocks to ice (lower friction) so the tower gets slipperier. "The Last Shot": the final rack is one item per world you completed with 3 stars.
- **Risks:** the spire might fall early through drift (a static flag helps); GPU cost in the menu on weak devices; players who want a plain list.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 3 / cost 3

### PR-19 Standing City (wild)
- **Pitch:** a persistent 100k city that is yours alone. You get three shots a day; damage stays; untouched districts slowly regrow overnight; your city's history becomes a map of scars.
- **Fun hook:** this is a garden of destruction. Each day's three shots are precious, chosen with the whole history in mind ("the north wall regrows tomorrow, so hit the harbour now"). Regrowth is the counterweight to the ratchet.
- **Borrowed from:** life-sim daily cadence (a little each real day, no punishment for absence); persistent-world colony sims; tending games (zen gardens, bonsai).
- **Loop:** session = 3 shots, 3-5 minutes. Week = a district fully rebuilt or levelled; weekly "rebuild contracts" spawn new structures on cleared lots.
- **Scale story:** only works because of scale and sleep: 100k resting, three shots waking a few thousand. It's the purest "cost scales with awake bodies" mode. At 10k it's a town; at 100k a city.
- **Uses today:** snapshots (save state to IndexedDB, about 3-5 MB at 100k), spawn at rest (regrowth), sleep, per-device determinism, Rubble Garden's "Regrow" animation.
- **Needs new:** a robust save and restore of a settled state, bit-exact on resume (M, med: woken bodies on reload must not twitch); regrowth that respawns blocks without explosions in rubble (M, med); 100k step cost bounded with sleep compaction (engine, high); a quiet daily cap that rolls over (no loss for absence) (S, low).
- **Content seeds:** "The Founding": a 10k town to start, growing to 100k as the player keeps playing. "Spring Rebuild": once a month, every lot regrows taller. "Heritage District": a protected old quarter that, if left untouched for 30 days, unlocks a cathedral.
- **Risks:** a three-shot cap feels stingy (make it a soft cap: unlimited sandbox shots that don't save); save corruption; 100k real time may not be reached.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 3 / cost 4

### PR-20 Seed Scouts (wild)
- **Pitch:** the Foundry's seed space is open for exploration. Players browse generated lots, find one with an amazing collapse line, and submit "seed + shots" (200 bytes). The Mac verifies the best submissions overnight and promotes them into the Almanac, credited to the scout.
- **Fun hook:** players become content curators and trick-shot discoverers; getting your seed into the daily, with your name on it, is a real reward. Turns the content bottleneck into a game.
- **Borrowed from:** block-world seed-sharing culture; citizen-science puzzle games where players find solutions; trick-shot clip culture.
- **Loop:** session = browse 10 seeds in "rough" mode (uncast, 1k-3k), try lines. Week = submissions reviewed; promoted seeds appear in the Almanac.
- **Scale story:** scouting is cheap at 1k-3k (play instantly). Promoted seeds can be re-generated at 10k (the same family at larger parameters) for weekly lots.
- **Uses today:** replay strings (seed + shots), the cast pipeline (verifies the submission's line meets the gates and seeds the "best line" for the hill-climb, saving cast time), the validator.
- **Needs new:** Foundry (PR-6, M); a submission queue backend (M, low); a Mac verification job (S, low); credit and attribution (S, low). Cross-device: a scout's line on their GPU may fail on the Mac; the Mac's hill-climb starts from it rather than requiring bit-equality (S, med).
- **Content seeds:** "Scout's Week": a weekly theme ("ice colonnades") for submissions. "Golden Seed" badge: a submission promoted to the daily. "Line of the Month": the submitted shot line with the highest leverage among promoted seeds.
- **Risks:** needs a population; moderation of names; the Mac verify queue is still finite (it saves hill-climb time, not the competent plays).
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

### PR-21 Blueprint Desk (hybrid with sandbox and stacking)
- **Pitch:** a block editor (boxes and spheres only, which suits an editor) where players build levels. To publish, the author must clear it themselves, and their own device quick-casts the stars.
- **Fun hook:** building to break is a different pleasure: designing the one keystone that brings it all down, then watching friends fail to find it. It's the largest possible content supply.
- **Borrowed from:** platformer makers' "clear check" before upload (you must beat your own level); physics-sandbox workshops; puzzle editors that run a solver on submissions.
- **Loop:** session = 20 min building and test-firing; or 10 min playing a "hot" community level. Week = weekly theme contest ("only planks", "under 2k blocks"), curated by Will.
- **Scale story:** 1k-3k is the creative sweet spot (hand-placed with stamp tools: fill wall, Kapla tower, column array). 10k via scenario stamps (city block, wall). 100k by composing stamps, published as provisional.
- **Uses today:** spawn at rest (placement), the validator (tunnelling, mass-ratio, capacity), the zero-activation at-rest validity test from LOAD PATH, scene files, the cast runner in Chromium (Kiln), objectives and constraints.
- **Needs new:** the editor itself, with stamp tools and snapping (L, med); at-rest settle check and "pre-settle" bake (S, low); the author clear check (S, low); a sharing backend or link-based sharing (level JSON in the URL or a short code) (M, low); quick-cast on the author's device (from PR-7) (M, med).
- **Content seeds:** stamp "Arcade": N arches with lintels. Contest "One Keystone": 2k blocks, one rack item. "Will's Picks": a curated shelf of community levels re-cast officially on the Mac.
- **Risks:** editors are big projects; most user levels are bad (curation needed); a level built and settled on one device may not be at rest on another (re-settle on load, or make settledness part of the at-rest gate).
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 3

### PR-22 Relay (hybrid with stacking, dominoes and destruction)
- **Pitch:** a run where each leg is a different mode, and the result of one leg is the start of the next. You stack a tower (stacking), it becomes the target (destruction); its rubble lands on a domino field (chain) whose last domino trips the next leg.
- **Fun hook:** one continuous physical story across modes. You're always playing with the consequence of your last leg, so a sloppy stack is a weak target but an unstable stack collapses spectacularly.
- **Borrowed from:** triathlon structure; chain-reaction machine contraption games; microgame collections, but continuous rather than cut.
- **Loop:** session = one relay (4 legs, 15 min). Week = a weekly relay route; legs drawn from sibling modes as they ship.
- **Scale story:** leg 1 at a few hundred (hand stacking), leg 2 at 1k-3k (domino field), leg 3 at 10k (the city the chain feeds into). Scale grows along the route, so the relay is a crescendo.
- **Uses today:** spawn at rest (player-placed stacks), persistence of rubble, observers (leg completion), sleep (the next leg rests until reached).
- **Needs new:** a shared "leg" contract so sibling modes plug in (M, med); a hand-off rule for when a leg is "done" (settled, or a trigger body crosses a line) (S, low); stacking needs sparse kicks or placement-at-rest only (placement exists; push is step 6) (engine, med).
- **Content seeds:** route "Quarry to Harbour": stack 20 stone blocks, topple them into a 1k domino field that runs down to a 10k harbour wall. Route "Ice Rink": the slide leg has ice dominoes. Route "Firework Finale": the last leg's rack is fireworks bought by your earlier legs' scores.
- **Risks:** a mode that's only fun when every leg is fun; long runs at 10k settle slowly; a failed early leg can soft-lock the route (provide a "rescue" fallback each leg).
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### PR-23 Forensics Exchange (hybrid with puzzle)
- **Pitch:** any museum replay can be posted as a "case": others see the start structure and the final rubble (as a ghost overlay), and must find shots that reproduce the outcome closely enough.
- **Fun hook:** reasoning backwards from aftermath ("which column went first?"). Every player's best collapse becomes someone else's puzzle, with zero casting: the target is known to be reachable because someone reached it.
- **Borrowed from:** detective-deduction games (reconstruct events from evidence); "spot the difference" scoring; trick-shot recreation challenges.
- **Loop:** session = solve 2 cases (5 min each). Week = post a case from your museum; see how many solved it.
- **Scale story:** at 1k, match per-block positions. At 10k, match a height histogram and footprint silhouette. At 100k, match the skyline profile only.
- **Uses today:** replays, the displacement heatmap and ghost silhouette (LOAD PATH), observers (histograms, bounding boxes), the Museum (PR-11).
- **Needs new:** a similarity metric over reductions (histogram distance, footprint IoU) with tolerances, because chaos and cross-device differences mean exact matching is impossible (M, med); case sharing (link-based) (S, low).
- **Content seeds:** "The Leaning Collapse": the column fell north, so where was it struck? "Two Shots": the rubble shows two separate collapses; find both. "The Bounce Case": rubber debris scattered past the footprint, so what speed was it?
- **Risks:** tolerance tuning (too loose is trivial, too tight is impossible across devices); not every replay is an interesting case.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 5

### PR-24 Siegeworks (hybrid with competitive)
- **Pitch:** async build-and-raid. You build a fortress on a budget around a treasure crown; others raid it with a rack. Raids are simulated on the raider's device and stored as results, and the defender watches a re-enactment.
- **Fun hook:** two skills meet: building for robustness and finding the flaw. Defenders tune their fortress against the raids it receives, so the content is self-balancing.
- **Borrowed from:** async base-raid mobile strategy (build, get raided, watch the replay); tower-defence building; deck-building with "defence decks".
- **Loop:** session = 2-3 raids (5 min each), then tweak your fort. Week = a ranked league with a weekly reset of fort budgets.
- **Scale story:** 1k-3k forts keep raids fast. 10k "citadels" for top league. Scale changes the fort meta: bigger forts have more redundancy but more rubble to bury the crown.
- **Uses today:** spawn at rest (fort placement), the validator, replays, crowns and heritage (treasure crowns), Blueprint Desk (PR-21) tools.
- **Needs new:** a backend for forts and results (M, med); trust: a raid result is the raider's claim. Without cross-device determinism, verify top results by Mac re-sim of the shot string with tolerance, and accept that defenders see a "re-enactment" that may differ (M, high); matchmaking (M, low).
- **Content seeds:** "Bronze League": 1k blocks, plaster only. "Moat Rule": the footprint is the moat; rubble in the moat counts for the defender. "Iron Gate": one steel body allowed per fort.
- **Risks:** the re-enactment differing from the raider's actual outcome breaks trust; cheating; the LOAD PATH deferral (async raiding needs a deterministic GPU mode) still mostly applies. This is the weakest fit here, and I include it for the hybrid view.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 2 / cost 2

---

## Capability primitives this lens keeps needing

| Primitive | Effort / risk | Needed by |
|---|---|---|
| **Island batching** (K copies of a level in one engine, per-island observers and events) | M / med | Foundry (PR-6), Almanac (PR-4), Powers of Ten (PR-16), Kiln (PR-7), Seed Scouts (PR-20) |
| **Parametric generator over scenarios** plus feature extraction and auto-reject on gate failure | M / low-med | Foundry, Almanac, Ledger (PR-2), Seed Scouts, Spoil Heap (PR-3) |
| **Threshold prediction / provisional stars** (regressor with error bar, or crowd percentiles) | M / med | Foundry, Crowdcast (PR-5), Blueprint Desk (PR-21), 100k content everywhere |
| **Goal predicate DSL over observers** (plus a one-play proof) | S-M / low | Lot Sheet (PR-8), Escalation (PR-9), Field Guide (PR-12), Hand Ranks (PR-13), Relay hand-off (PR-22) |
| **State save / restore at rest** (snapshot to storage, respawn bodies at rest without popping) | M / med | Spoil Heap, Spire (PR-18), Standing City (PR-19), Relay, Blueprint Desk |
| **Similarity metric over reductions** (histograms, footprint IoU, skyline) | M / med | Forensics Exchange (PR-23), Lot Sheet shape goals, Field Guide detectors |
| **In-browser cast runner as a background scheduler** (quick-fire recipe) | M / med | Kiln, Blueprint Desk, Seed Scouts |
| **Scores / submission backend** (level hash, device class, metric, shot string; Mac re-verify) | M / med | Crowdcast, Almanac leaderboards, Seed Scouts, Siegeworks (PR-24) |
| **Static / anchor body flag** | S-M / low | Spire, Standing City, Blueprint Desk (plinths) |
| **Sleep compaction** (100k resting under 3 ms) | engine L / high | Spire, Standing City, Powers of Ten 100k rung, Strata Megacity, Ledger final boss |
| **GPU fork** (branch shared prefixes) | M / med | every cast-dependent idea: 2-3x cheaper casting |
| **Replay re-enactment labels** (honest cross-device playback, or Mac-baked trajectories for featured items) | S-M / med | Museum (PR-11), Forensics Exchange, Siegeworks |

## A proposed spine: how modes could chain into one game over releases

1. **R1, "Keystone + Sheet":** the current campaign as Strata W1-W3 (handmade, Mac-cast), First Brick onboarding, Lot Sheets on every level, Grades from the existing cast clouds. Lot Sheets and Grades are almost free content multipliers on levels that already exist. Museum v1 (local only).
2. **R2, "The Run":** Wrecker's Ledger over the cast level pool, Escalation ladders, Hand Ranks. Build the generator plus island batching (Foundry) behind it, and use it first to fill the Ledger's lot pool at 1k-3k.
3. **R3, "The Calendar":** the Almanac (nightly Foundry lot cast on the Mac, weekly 10k), with an archive and share codes. Field Guide entries tied to themed days. Optional: Kiln for local quick-fire stars.
4. **R4, "The Workshop":** Armory Bench and Blueprint Desk, Seed Scouts feeding the Almanac, Crowdcast for community and 100k content. Licence Tree hands sandbox knobs out as rewards in the game shell only.
5. **R5, "The Megastructure" (when sleep compaction plus tiered blasts land):** Strata Megacity, Powers of Ten 100k rungs, the Spire as the finale, and Standing City as the long-tail "forever mode".

Sibling modes (stacking, dominoes, puzzle, competitive) enter as Strata worlds and as Relay legs, so each new mode feeds both the campaign and the run.

## My top 5 and why

1. **PR-8 Lot Sheet.** It multiplies content five-fold or more on levels that are already cast, without any new casting. It fits the observer system exactly, and it teaches structure reading. The best ratio of value to cost on the list.
2. **PR-6 Foundry (with island batching).** This removes the content bottleneck: 1k-3k levels cast 10-40x cheaper, 10k families cast from a sample. The Almanac, the Ledger and Seed Scouts all need it.
3. **PR-2 Wrecker's Ledger.** This is the long-term pull the design doc says to build second. It reuses the existing cast pool, turns the rack and bank into an economy, and gives scale a payoff at the boss lots.
4. **PR-4 Almanac.** Retention without dark patterns: a daily calendar with no streaks and an open archive. One overnight Mac cast per day is affordable, and it's the natural outlet for the Foundry.
5. **PR-11 Collapse Museum.** Spectacle is the signal Will responds to, and this makes it collectible and shareable at 200 bytes an exhibit. It is cheap, on brand, and it seeds Forensics Exchange. Wild runner-up: **PR-3 Spoil Heap** ("wreck for the future") as a permit inside the Ledger.
