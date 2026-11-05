# Competitive, turn-based and social modes (lens CO)

Designer lens: competitive, turn-based, social. 25 ideas. Tags in the pitch line: [Hybrid: x] crosses into another lens, [Wild] is a deliberate long shot.

## Networking models used below (read this first)

Every idea names one or more of these. Costs assume today's stack (Cloudflare Pages + Workers KV, no game server).

| Code | Model | What crosses the wire | Backend cost | Cross-device safe? |
|---|---|---|---|---|
| **N0 Hot-seat** | One device, players pass it or share the keyboard | nothing | none | yes (one device) |
| **N1 Link** | URL carries level id + quantised shots + claimed score (<200 B, fits a URL) | inputs only | none | **no**: receiver re-simulates; chaotic regions differ. The receiver's own play is always scored on the receiver's device. |
| **N2 Settle-sync mail** | Async turns through Workers KV. After a turn settles, the shooter uploads its inputs **and the settled state** (only moved bodies, quantised pose, ~8-14 B each). The next player loads that state as canonical, never re-simulates it. The opponent's shot is shown as an "approximate replay" re-simulated locally, then snaps to the canonical rest state (the snap happens at rest, so it can be a 0.3 s blend). | inputs + rest-state delta (a few KB to ~150 KB at 10k) | KV exists; S-M of Worker code | **yes**, because the world is only ever exchanged at rest. Cheating = forged state; plausibility checks only. |
| **N3 Room relay** | Realtime relay (Durable Object WebSocket, or KV polling at ~1 s as a crude fallback). One host device simulates and renders on the shared screen; other devices send aim inputs. Nobody else simulates. | inputs up, small UI state down | M (Durable Objects are a new Cloudflare product for us; cheap at party scale) | yes (host-authoritative) |
| **N4 Host stream** | As N3, plus remote viewers see the host's canvas as video (`canvas.captureStream()` over WebRTC). Video sidesteps state sync entirely. | video down, inputs up | L (signalling + TURN relay bandwidth costs real money) | yes |
| **N5 Verifier** | Players upload replays; Will's Mac (or one fixed reference GPU) batch re-simulates them and publishes the verified outcome, like star casting does today. | replay up, verdict down | M (queue in KV + a Mac job) | yes, but the verified score is the reference device's outcome, which rewards robust shots |

Settle-sync (N2) is this lens's key trick: **turn-based games only exchange the world at rest**, so per-device determinism stops mattering for them.

---

### CO-1 Last Pull
- **Pitch:** Hot-seat tower duel: each turn push one block out with a cue, then place it back on top. Whoever topples the tower loses.
- **Fun hook:** Every pull is a bet on how hard you can push without waking the tower. The tower gets taller and worse every turn, and you hand your opponent a slightly more broken one. The first 30 seconds: a 3 m Kapla tower, a pulsing load X-ray, and one block that looks loose but isn't.
- **Borrowed from:** Jenga (pull from below, restack on top, the loser topples it); the "nudge, test, commit" feel of dexterity games like Operation.
- **Loop:** 30 s: orbit, X-ray, tap a face, set cue power, push, watch it slide out, drag the ghost block onto the top, release, wait for it to settle. 5 min: 15-25 turns until the collapse, then an auto-replay with each player's pulls in their ink colour, so the table can argue about whose pull really doomed it.
- **Scale story:** 1k: a 54-plank tower scaled up (3 x 18 rows) that feels like the real thing. 10k: a "tower of towers", a 3x3 grid of linked columns where pulling from one column shifts load into the next. Collapses go regional, and the loss rule becomes "you lose if more than 15% of potential energy goes in one turn", so a partial collapse is survivable and gives a comeback. 100k is not meaningful here: the turn count would explode.
- **Uses today:** Kapla planks (S15), cue ammo, `spawn` at rest, observers (moving count for settle, PE released for the loss rule), shot ink, load X-ray, rubble persistence.
- **Needs new:** a gentle, continuous push: sparse forces (step 6; M, med risk), because a one-shot cue impulse is too binary for a Jenga feel. Today's cue gives a crude version. Placement tool with overlap check and ghost preview (S, low). Turn controller: settle detection, a 6 s timeout, a loser window (S, low). N0 only.
- **Level seeds:** (1) "Classic 18": a plank tower on stone, plaster planks. (2) "Ice Core": every third row is ice (mu 0.05), so those pull out easily but restack treacherously. (3) "Leaning Start": a tower built 2 degrees off plumb, so pulls on one side are safe and on the other are lethal.
- **Risks:** a real Jenga hand feels the friction and AVBD planks may feel arbitrary. Too much stability (AVBD stacks can be over-stiff) makes turns tediously safe. Too little ends it in turn 3. A friction/stiffness tuning probe comes first.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 3 / cost 4

### CO-2 Two Keeps
- **Pitch:** [Hybrid: destruction] A turn-based artillery duel between two block forts across a valley, with wind. First to topple the enemy's crown block wins.
- **Fun hook:** Each shot is a ranging shot and a tactical choice at once: dig at their wall, or lob over it at the crown. Your misses become terrain. The first 30 seconds: you fire, fall 4 m short, and watch your own cannonball gouge a crater that is now cover for the enemy.
- **Borrowed from:** Scorched Earth and Gorillas (alternating angle and power with wind; ranging in), Worms (persistent deformed terrain, weapon variety), Rampart (forts as the playfield).
- **Loop:** 30 s: read the opponent's last impact marker, adjust one quantum of yaw/pitch/power, choose ammo, fire, settle with the camera held where you left it. 5 min: 8-14 shots each. Fort walls are visibly chewed and one side's crown is leaning.
- **Scale story:** 1k: two 500-cube keeps, so every hit matters and you can read it. 10k: two 5k citadels with inner keeps, so you breach in layers and rubble piles become ramps that guide bouncing balls inward. 100k (needs sleep compaction): two walled towns. A hit wakes only a few thousand bodies, and the long build-up of damage across the whole duel is the payoff. Scale turns "hit the target" into "siege engineering".
- **Uses today:** S3/S14 structures, real projectiles, WeaponSpecs (cluster, grenade), `crowns` objective per side, rubble persistence, impact sound, photoreal look with hills.
- **Needs new:** per-side objectives and a turn controller (S, low). Wind as a constant force on the projectile: sparse forces step 6 (S after step 6, low), or fake it as a launch-velocity offset today (S, low). An opponent's last-shot marker (S, low). Networking: N0 now. N2 Settle-sync mail for remote play (see CO-14). N3 for a live room.
- **Level seeds:** (1) "Valley 60": two 500-cube keeps 60 m apart, no wind. (2) "High Ground": one keep on a hill and the other in a bowl; the low side gets an extra item in its rack (asymmetric balance). (3) "Twin Citadels 10k": 5k each, an ice moat, and cluster shells.
- **Risks:** it is well-trodden; the spectacle and real rubble have to carry it. Long settle times on 10k forts could kill turn pace, so cap a turn at 8 s and fast-forward it. Chaos means a well-aimed shot can do nothing, which is fine in artillery games, where luck is part of the genre.
- **Scores (1-5):** fun 5 / novelty 2 / engine fit 5 / cost 4

### CO-3 Build then Breach
- **Pitch:** [Hybrid: sandbox] Each player secretly builds a fort around their crown from a block budget, then attacks the other's fort with a fixed rack. The fort that survives better wins.
- **Fun hook:** You are designing against one particular mind: "they always lob, so I'll roof it". The first 30 seconds of the attack is the reveal, the moment you first see what your rival built.
- **Borrowed from:** Clash of Clans / Boom Beach (base design as a defensive puzzle, raid scoring), Rampart (build phase then fire phase), Poly Bridge (budgeted building).
- **Loop:** 30 s: during the build, snap 20 blocks onto a grid with a running mass/budget bar and press "test settle". During the raid, take one shot from the rack. 5 min: a 2-minute build each, 3 shots each, then the two results side by side. Best of 3 rounds.
- **Scale story:** 1k: hand-placed walls. 10k: hand placement is too slow, so building uses stamps ("wall 4x8", "column", "buttress", "Kapla ring") and real architectural styles emerge. 100k: building becomes city zoning, and the attacker's single mega-weapon (a tiered blast) tests whole layouts.
- **Uses today:** `spawn` at rest for building, rubble persistence, `crowns` / `skyline`, the at-rest validity test (reject builds that are not stable before the raid starts), shot ink.
- **Needs new:** build editor with grid snap, stamps, budget and undo (M, low). Static anchors are optional (S, low). Networking: N0, hiding builds behind a "pass device" cover screen (S). N1/N2 async: a build is a list of spawns; the attacker's device settles it once and that becomes canonical (a resting stack is the most cross-device-stable thing we have). The raid result is scored on the attacker's device. Exploit: an attacker could re-roll a raid many times offline, so N2 locks a raid once it is opened.
- **Level seeds:** (1) "Plinth": 300 blocks, crown on a 2 m plinth, 3 marbles to attack. (2) "Cliff Edge": your lot ends at a drop, so footprint matters. (3) "Iron Budget": 150 heavy iron blocks or 600 plaster, a choice between mass and count.
- **Risks:** building is slow and fiddly with a mouse; stamps are essential. Degenerate builds (a solid cube of blocks) need budget shapes or a minimum crown height. A secret build on a shared screen needs a pass-device ritual.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 3

### CO-4 Shore and Shatter
- **Pitch:** Asymmetric rounds: the Breaker fires one shot per turn, the Warden places three props between shots to keep the tower standing. Then the players swap roles.
- **Fun hook:** It is a race between damage and repair. The Warden reads the X-ray to guess where the next shot lands. The Breaker wants a shot that defeats the prop rather than the tower. The first 30 seconds: the tower is wounded and the Warden has three props and five seconds.
- **Borrowed from:** tower defense (placing defences under pressure), asymmetric 1v1 games (Dead by Daylight-style role swap), Rampart's repair phase.
- **Loop:** 30 s: the Breaker shoots, the world settles, the Warden drops 3 props (planks or wedges) with a 10 s timer. 5 min: 6 shots per round, and the Warden's score is the crown height kept. Swap roles, and the higher crown height wins.
- **Scale story:** 1k: a single tower where props are visibly heroic. 10k: a city block, and the Warden must decide which building to let fall (triage). 100k: a cathedral (B2-style heritage), where props are not enough and the Warden must instead cut a firebreak by removing blocks to stop a cascade spreading.
- **Uses today:** `spawn` at rest (props), `remove` (firebreak), skyline/crowns, load X-ray, rubble persistence.
- **Needs new:** a timed placement tool (S, low). Asymmetric UI and role swap (S, low). Welds would make props feel strong (step 7; M, med) but are optional. N0, or N3 for two devices.
- **Level seeds:** (1) "Lean-to": a leaning column, 3 cannonballs for the Breaker. (2) "The Arch": a stone arch with crowns on top; props under the arch are tempting but block the lob path. (3) "Firebreak 10k": a row of terraces; the Warden has 5 removes instead of props.
- **Risks:** props placed in a rush may look silly or tunnel into the rubble (spawn validity checks). Balance between the roles needs tuning per level (the bot can cast it).
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 4

### CO-5 Cold House
- **Pitch:** Granular curling: each player owns a heap of 500 coloured cubes on an ice rink and slides heavy stones to plough the rival heap out of the scoring ring and shepherd their own in.
- **Fun hook:** A slide is a long, slow shot where you watch it come in. Hitting a heap is satisfying and inexact: you never move one stone, you move a few hundred. The first 30 seconds: a stone glides 20 m on ice, then bursts into a red heap and red cubes spray out of the ring.
- **Borrowed from:** curling and petanque (closest to the target, knocking out, guards), shuffleboard (a sliding launch), the end-by-end scoring of curling.
- **Loop:** 30 s: set the line and weight, release, and the stone takes 6 s to arrive. The camera stays where you placed it. 5 min: one end of 8 stones each, scored as owned cube mass inside the ring. Play 4 ends.
- **Scale story:** 1k: two heaps of 500, cheerful and legible. 10k: heaps of 5k behave like snow drifts, ploughing builds banks, and banks act as guards. 100k: a whole rink is a granular field, and "the house" is wherever your colour is densest, so the game becomes territory. Scale changes the target from stones into terrain.
- **Uses today:** ice material (mu 0.05), steel/iron spheres and boxes as stones, ground plane, observers (count by predicate inside a radius), per-material sound (ice timbre).
- **Needs new:** per-body owner tag and per-owner reduction in a region (S-M, low). A slide launch is just a `spawn` with horizontal velocity at ground height (S). Sweeping (brush to cut friction ahead of the stone) would need per-region friction changes (M, med) and can be dropped. N0, or N1 for an "end of the day" challenge.
- **Level seeds:** (1) "Open Ice": two heaps at the ring edge. (2) "Pillar Guard": a stone pillar in front of the house that you can topple onto the heaps. (3) "Melt": the rink is ice in the middle and stone at the edges, so stones grab and spin.
- **Risks:** sliding on a single infinite ground plane with mu 0.05 may not glide realistically far (rolling spheres are easier). Weak height, so the spectacle is lower than in tower modes. Scoring 500 bodies is cheap with reductions.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 4

### CO-6 Spill Line
- **Pitch:** Tug-of-war over a shared rubble mountain: a centre line splits it, and you score when mass ends up on the opponent's side.
- **Fun hook:** It is sumo with a mountain. Every shot that pushes rubble over also loosens what will slide back. The best shots topple a tall section so it falls the right way. The first 30 seconds: a wrecking ball, and a wall of 2,000 cubes slumps over the line.
- **Borrowed from:** tug-of-war (a net position contest), the playground game "clear the garden over the fence" (Mario Party-style minigame), Pong/air hockey territory pressure.
- **Loop:** 30 s: aim, fire, settle; a meter of mass per side swings and the turn passes. 5 min: 10 shots each. The winner holds less mass on their side at the end, or it is sudden death at 70/30.
- **Scale story:** 1k: a central wall that falls one way or the other. 10k: a granular mountain where piles slide back after a shot (angle of repose), so gains erode. 100k: a long ridge, and the line becomes a tug across a whole landscape. That needs the sleeping-heap cost model to hold.
- **Uses today:** structures, projectiles, blast weapons, observers (half-space mass sums), rubble persistence, sleep.
- **Needs new:** a half-space mass reduction (S, low). A tug meter UI (S). N0, N3, or N2 (it is turn-based and at rest between turns, so settle-sync works).
- **Level seeds:** (1) "The Wall": a 1k-cube wall on the line. (2) "Two Towers": one tower on each side, leaning toward the opponent. (3) "Avalanche 10k": a granular ridge, and blasts are the only ammo.
- **Risks:** the spill direction may be so chaotic that skill does not show. Test whether a deliberate push beats random fire by the bot margin. Rubble that slides back may read as unfair unless it is shown clearly.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### CO-7 Tick Tower
- **Pitch:** [Wild] Pass the bomb: a lit charge sits inside a shared tower with a hidden fuse; each turn you nudge it toward the rival's coloured floors, and when it blows, the blocks it brings down cost their owner.
- **Fun hook:** A hot potato with physics. A big nudge moves the bomb far but shakes your own floors. The fuse might go on your turn. The first 30 seconds: the bomb is ticking, you push it one floor up, it rolls back, and the table shrieks.
- **Borrowed from:** Hot Potato and Pass the Pigs-style party chance, the timer bomb in Bomberman, the hidden-fuse tension of Exploding Kittens.
- **Loop:** 30 s: 5 s to pick a face of the bomb block and a cue power, push, then the bomb settles and the turn passes. The fuse burns only in simulated time. 5 min: 3-6 bombs per game, scored as owned blocks lost.
- **Scale story:** 1k: a 4-floor tower, one colour per floor. 10k: a city block, and you shove the bomb down streets with cues and ramps of rubble. 100k: several bombs at once in a megastructure, each with its own fuse, while sleep keeps it cheap.
- **Uses today:** WeaponSpec with a time trigger and a blast centred on a body, the cue, owner colours via ink, observers (owner counts), sound.
- **Needs new:** a fuse that counts only simulated time (S, low; triggers already exist). A hidden fuse seed that is fair on the same device (S). Owner tags (S-M). A finger push (sparse forces, step 6; M) makes nudges subtle, but the cue works today. N0 only, because the hidden fuse needs one device.
- **Level seeds:** (1) "Four Floors": 4 players, one floor each, the bomb starts mid. (2) "Ramp Street": the bomb is a ball on a sloped street of terraced houses. (3) "Two Bombs": short and long fuses, and only you know which is which (pass-device secret).
- **Risks:** pure chance may dominate. Nudging a body inside a tower may be hard to read. Fuse in sim time vs player wait time needs care so the bomb never blows during aiming.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 4

### CO-8 House Rival
- **Pitch:** Single-player versus a named bot opponent that alternates shots with you on the same structure, racing for crowns in its colour vs yours. A ladder of 8 rivals rising in skill.
- **Fun hook:** You can watch the bot think (ghost arcs of the candidate shots it rejected) and steal its read. Each rival has a tell: one brute-forces, one hunts keystones, one is reckless. The first 30 seconds: the bot opens with a cunning cue shot that drops two of your crowns as collateral.
- **Borrowed from:** chess engines with Elo levels and personalities, fighting-game CPU ladders, the persona bosses of Hearthstone adventures, Puzzle Fighter's AI rivals.
- **Loop:** 30 s: you shoot, then the bot "thinks" for 1-3 s with visible ghost arcs and shoots. 5 min: a 6-shot match. Win to climb the ladder; losses show the bot's best line in a replay.
- **Scale story:** 1k: the bot can afford real rollouts on device. 10k: the bot must use cheaper heuristics (X-ray-guided candidates, short rollouts on sleeping worlds). 100k: the bot plays from a precomputed opening book cast on the Mac.
- **Uses today:** the star bot (sampling, competent plays, nudges), crowns, owner-coloured crowns, replays.
- **Needs new:** on-device rollouts. Needs snapshot fork/restore (save GPU state, try N candidate shots, restore; M, med) and headless fast stepping (S-M). Budget: at 1k, 8-16 rollouts x 200 steps at ~1 ms is about 2-3 s, which is acceptable as "thinking". Personality noise (aim tremor, ammo bias) is S. Precomputed books for big levels (M, cast on the Mac). N0. No networking.
- **Level seeds:** (1) "Duel Pyramid": a 500-cube pyramid, 4 crowns each. (2) "Neighbours": two houses sharing a wall, where hitting yours helps theirs. (3) "The Cartographer" (boss): a 10k city with a precomputed bot book.
- **Risks:** bot strength at 10k on device is an open question. A bot that thinks slowly is boring and one that is too strong is frustrating. Chaos makes the bot look dumb when its best shot fizzles.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 3 / cost 2

### CO-9 Beat My Wreck
- **Pitch:** Async challenge links: finish a level and send a URL holding your shots and score. Your friend must beat it on their device, sees your run replayed on their device, and can send back a counter-link.
- **Fun hook:** A personal rivalry that costs no backend. "I did B2 with 2 shots and x340 leverage, your move." The first 30 seconds after opening a link: watch your friend's shot, then immediately try to top it.
- **Borrowed from:** Trackmania and golf-game shared challenges (beat my time/score), Wordle's shareable result grid, Angry Birds score bragging, Words With Friends' asynchronous rhythm.
- **Loop:** 30 s: open the link, watch the sender's replay (labelled "replayed on your device"), play. 5 min: 3-5 attempts, send a counter. Over days, a chain of links is a rivalry with a running head-to-head tally kept in localStorage.
- **Scale story:** 1k: replays match the original closely. 10k-100k: chaotic regions diverge on a different GPU, so the replay can look better or worse than the sender's claim. Big levels make the divergence visible, which is why the claimed score must be the sender's own.
- **Uses today:** replays (<200 bytes), levels, scoring, browser progress storage, the existing Pages deployment.
- **Needs new:** URL encoding and decoding, a share sheet, a result card with a text/emoji grid (S, low). A "replay on your device may differ" label plus the sender's crowns/collapse numbers (S). Optional robustness hint: show how many of 8 jittered replays on the receiver's device reach the sender's objective (S-M). N1 (no backend).
- **Exploitability (honest):** (1) Claimed scores are forgeable with no server; acceptable between friends, unacceptable for public boards (see CO-22). (2) No cross-device advantage, since each player scores on their own device. (3) The receiver cannot steal the sender's exact line with confidence, because it may not reproduce on their device; this is mostly a feature. (4) Disputes ("your replay didn't do that") are expected; the label and robustness hint defuse them.
- **Level seeds:** (1) any Keystone level as a challenge. (2) "Daily Wreck": one bot-verified level a day, with links comparing scores. (3) "Handicap Link": the sender removes one rack item from the receiver.
- **Risks:** a mismatched replay can feel like a bug. Clipboard/URL friction on mobile. Little to do without friends; the Daily Wreck helps.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### CO-10 Armory Draft
- **Pitch:** Before a duel on one structure, players snake-draft their racks from a shared pool of 12 munitions, then alternate shots for crowns.
- **Fun hook:** Drafting is the first decision and it is spicy: take the wrecking ball yourself, or deny it to your rival? The first 30 seconds is the draft itself, with the structure visible so you can plan.
- **Borrowed from:** Magic: The Gathering booster drafting (pick and deny), 7 Wonders' pass-the-hand, the weapon crates of Worms, MOBA hero pick/ban.
- **Loop:** 30 s: 6 alternating picks (cluster, cue, marble, anvil drop, firework, boulder...), then the first shots. 5 min: a full duel of 6 shots each with drafted racks, possibly with bans.
- **Scale story:** 1k: precise tools (marble, cue) are prized. 10k: area weapons dominate the draft, so the pool rations them. 100k: one "superweapon" (an XL cluster or tiered blast) is in the pool, and the whole draft revolves around who gets it and when it is fired.
- **Uses today:** WeaponSpecs (sizes S-XL), real projectiles, Keystone ammo, racks, crowns.
- **Needs new:** a draft UI and pool definitions (S, low). Owner-coloured crowns (S). N0, N1 (draft-then-async is awkward), N3.
- **Level seeds:** (1) "Open Pyramid": a symmetric pool. (2) "One Wrecking Ball": a pool with a single dominant item. (3) "Ban Phase 10k": each player bans 2 before the picks.
- **Risks:** it is a wrapper rather than a mode, so it lives or dies by the duel underneath. Item balance takes tuning, which the bot can help cast.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### CO-11 Heraldry
- **Pitch:** One shared tower with blocks painted in 2-4 player colours. Each turn you fire one shot, score for rival-coloured blocks that fall below the line, and lose points for your own.
- **Fun hook:** Every shot has collateral. The tower's colour pattern makes every block a political question: hitting red low also drops blue high. The first 30 seconds: a candy tower striped in four colours and one marble.
- **Borrowed from:** Boom Blox's multiplayer colour-scoring modes, billiards' "own balls vs opponent's balls" (8-ball), Carcassonne-style shared board with ownership.
- **Loop:** 30 s: aim, fire, settle, tally the colours ("+7 red, -2 blue"). 5 min: 5 rounds with a tower that gets more chaotic each round; whoever has the lowest loss and highest take wins.
- **Scale story:** 1k: a striped tower with readable effects. 10k: a city where each player owns districts (mixed blocks), so shots cause cascading district wars. 100k: ownership is a fine pattern (checkerboard, spirals), so you can no longer aim at colours, only at structure. The game shifts from tactics to statistics, and that is interesting.
- **Uses today:** crowns machinery, ink tinting, candy look, observers, rubble persistence.
- **Needs new:** per-body owner tag and per-owner below-line counts (S-M, low). Per-owner scoring UI (S). N0, N2, or N3.
- **Level seeds:** (1) "Four Stripes": a 1k tower in horizontal bands. (2) "Checkerboard Keep": alternating owners per block. (3) "Districts 10k": a city split into 4 quadrants.
- **Risks:** pure chaos on mixed colours may feel random, so test whether skilled play wins more than a coin flip. The first player may have an advantage, so alternate or use catch-up rules.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### CO-12 Odds on the Fall
- **Pitch:** [Wild] A party betting mode: one player sets up and locks a shot, the rest bet chips on outcome markets (crowns down, over/under collapse, which zone the tallest fragment lands in), then it fires.
- **Fun hook:** Everyone is invested in every collapse, not just the shooter. 10k-cube collapses become horse races. The first 30 seconds: the shot is locked, the bettors argue, it fires, and the table screams at a teetering column.
- **Borrowed from:** pari-mutuel horse betting, Twitch Predictions on marble-race streams, Plinko, the prop bets of sports broadcasts.
- **Loop:** 30 s: lock the shot, a 15 s betting window, fire, settle, payouts. 5 min: 6 rounds rotating the dealer; the most chips wins.
- **Scale story:** 1k: 2-3 simple markets. 10k: rich markets (which of 8 crowns falls first, total settle time, rubble footprint). 100k: a 25-second collapse with live odds that shift as it unfolds.
- **Uses today:** observers (counts, bounding box, PE released, predicates), crowns, a long settle, spectacle.
- **Needs new:** a market engine resolving bets from reductions (S-M, low). **Anti-precompute rule:** with per-device determinism the dealer could rehearse the locked shot and know the outcome. Fix it by adding a random perturbation after lock: a hidden jitter of ±1 quantum drawn after the bets close (S, low). Watching the dealer's hands is the party fix. Live-odds updates need cheap mid-sim reductions (S). N0 or N3 (phones for private bets).
- **Level seeds:** (1) "Which Way": a leaning column, betting on the fall direction (8 sectors). (2) "First Crown": 8 crowns on a 5k tower. (3) "The Long Fall": a 100k cathedral, over/under settle time.
- **Risks:** without stakes, betting is shallow; it needs a good chip economy. It looks like gambling, which matters for store age ratings even with play chips. Odds calibration needs the bot (cast a distribution per level).
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 4

### CO-13 Room Code
- **Pitch:** A living-room party: the laptop or TV simulates and shows the game, and every player aims from their phone after joining with a 4-letter room code. A crowd variant lets stream viewers vote on the shot.
- **Fun hook:** Friends with phones, one big screen, nobody needs a GPU except the host. Phones show private info (your rack, your secret crown, your bet). The first 30 seconds: scan the code, see your colour, aim at the shared screen.
- **Borrowed from:** Jackbox Party Pack (phones as controllers, room codes, one shared screen), Twitch Plays (crowd input aggregation by vote or average).
- **Loop:** 30 s: each player aims on their phone with sliders and a mini plan view, and the host shows ghost arcs; fire. 5 min: any duel mode (Two Keeps, Heraldry, Sealed Orders) for 4-8 players. Crowd variant: 100+ viewers drop pins on a plan view, and the median pin becomes the shot.
- **Scale story:** scale is the host's problem, and only the host needs an M-class machine. This is how 100k modes reach people without GPUs: they don't simulate, they aim.
- **Uses today:** the full viewer as host, input events (phones just produce quantised spawn parameters), replays.
- **Needs new:** a realtime relay. Durable Object WebSocket rooms (M, low technical risk, new infrastructure plus a small ongoing cost). KV polling (~1-2 s latency) is a viable turn-based fallback with what exists. A phone controller web page (M, low). Crowd variant: an aggregator with rate limits (M, med). Remote viewers who are not in the room need N4 video (L).
- **Level seeds:** (1) "Eight Keeps": an 8-player free-for-all ring of forts. (2) "Secret Crowns": each phone shows which crown is yours. (3) "Crowd Siege": a stream audience versus a 100k city, one median shot per minute.
- **Risks:** infrastructure and abuse moderation for public rooms. Phone aiming must be good. Durable Objects lock in Cloudflare (already in use, so acceptable).
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 4 / cost 2

### CO-14 Letter Siege
- **Pitch:** A correspondence duel across devices: take your shot whenever you like, the settled world goes to your rival through KV, and they shoot back hours later. Per-device determinism doesn't matter because the world is only exchanged at rest.
- **Fun hook:** A ping-pong rivalry with a notification: "Your rival dropped your north tower." You open the game and watch an approximate replay that settles into the true rest state, then think as long as you like. The first 30 seconds: you see the damage and plan revenge.
- **Borrowed from:** correspondence chess, Words With Friends' asynchronous turns, Frozen Synapse's play-by-mail turn files.
- **Loop:** 30 s per turn (any time of day). 5 min = 10 turns of reading and shots; a match lasts days.
- **Scale story:** 1k: a state delta of a few KB. 10k: a 5k-body collapse delta is about 50-70 KB quantised and compressed, fine for KV. 100k: deltas reach about 0.5-1 MB, still OK (KV values go up to 25 MiB), but loading 100k bodies from a snapshot needs the sleeper grid so the loaded rest state stays at rest.
- **Uses today:** spawn-at-rest (a level is a body list, so a snapshot can be a level), quantisation, replays, the Workers KV gate.
- **Needs new:** **snapshot to level**: serialise a settled state and load it as a level (M, med risk: a loaded stack must sit still without re-settling into a different shape; quantising poses to ~1 mm may create small overlaps that wake bodies, so load bodies asleep or with a gentle relax). A Worker API for match rooms, turn tokens and timestamps (S-M, low). The approximate replay plus a 0.3 s snap blend to the canonical state (S). Notifications: none, an email, or the PWA's web push (M). Anti-cheat: plausibility checks only (energy budget, only bodies near the impact moved); friends-only (S).
- **Level seeds:** (1) "Two Keeps by Post" (CO-2 rules). (2) "Heraldry by Post" (CO-11). (3) "The Long Front 10k": a 30-day siege across a 10k wall, one shot a day.
- **Risks:** players drift away from long matches (needs reminders). A forged state from a modified client. The snap from the approximate replay to the canonical state may look like a glitch when they differ a lot; skipping the replay and showing a damage diff is an option.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### CO-15 Chain War
- **Pitch:** [Hybrid: dominoes] Two players take turns laying dominoes into a shared 10k field of neutral dominoes, then each fires one push. Every domino a chain topples takes the colour of the chain that toppled it, and the most territory wins.
- **Fun hook:** Go with dominoes. You build fences that stop the enemy chain and branches that steal their area. The trigger turn is pure spectacle: two colour waves race across 10,000 tiles and crash at a front line. The first 30 seconds: place your first 5 dominoes to cut off a corner, and watch your rival's wave hit the wall.
- **Borrowed from:** Go (territory and walls), Splatoon (ink coverage as score), domino rally world records (fan-out and gap design), Tron light cycles (cutting off space).
- **Loop:** 30 s: place 5 dominoes (rotate, snap) or remove 2 neutral ones to make gaps. 5 min: 6 placement turns each, then a simultaneous trigger and a 20-40 s cascade with territory tally. Best of 3 fields.
- **Scale story:** 1k: a small board where every gap is visible. 10k: needs sleep (the neutral field asleep and nearly free) and turns into strategic regions. 100k: a world-record-sized field where multiple fronts collide in places you never planned; the strongest spectacle in this lens, and only possible with sleep and compaction.
- **Uses today:** box shape (dominoes), `spawn` at rest, `remove`, sleep (E2), observers, ink tinting, sound (clatter scaled by awake count).
- **Needs new:** **contact-propagated ownership** (a toppled body takes the owner tag of the body that woke it, or the first contact above an impulse threshold), a GPU pass on contacts (M, med: needs the contact list per step, plus a rule for ties). A simpler fallback: tag by which push's wave front is nearer when a body's tilt crosses 45 degrees (S-M). A placement tool (S). Persistent sleeper grid for 100k (in progress). N0 or N2 (placements are small; the cascade is resolved on the opener's device and uploaded as the final colour map).
- **Level seeds:** (1) "Open Field 1k": a 30 x 30 grid. (2) "River": a central line of ice dominoes that slide instead of topple. (3) "Hundred Thousand": a 100k field with 4 players.
- **Risks:** contact attribution on GPU is new work. A cascade may not stop at gaps reliably (dominoes slide), which makes walls feel unfair. Placement of 30 dominoes in a 10k field must be fast with good snapping.
- **Scores (1-5):** fun 5 / novelty 5 / engine fit 4 / cost 3

### CO-16 Sealed Orders
- **Pitch:** Simultaneous hot-seat: every player secretly programs one shot (pass the device behind a cover screen), then all shots launch on the same step and collide mid-air and in the structure.
- **Fun hook:** No more waiting for turns, and the reveal is the spectacle: four arcs launch at once and two cannonballs meet over the tower. You have to predict what others will do (double-think). The first 30 seconds: everyone hands back the device, presses fire, and the room counts down.
- **Borrowed from:** Diplomacy and Frozen Synapse (WeGo: simultaneous secret orders then resolution), Robo Rally (programmed moves), Worms Armageddon's turn tension.
- **Loop:** 30 s: each player gets 10 s of private aiming (hidden from others), then a shared launch and settle. 5 min: 6 rounds for 2-6 players, scored as Heraldry (owned blocks) or Two Keeps (crowns).
- **Scale story:** 1k: arcs interfere visibly. 10k: shots hit different districts and cascades meet. 100k: 6 players each start a cascade in a megastructure, and attributing which cascade did what is half the fun (ink).
- **Uses today:** multiple `spawn` events in the same step, replays, shot ink, crowns.
- **Needs new:** a private aiming flow and launch synchronisation (S, low). Per-shot ink for attribution (designed). N0, N3 (phones make the secret part natural), N1 is weak, N2 is awkward but possible (wait for all orders).
- **Level seeds:** (1) "Crossfire": a tower between 4 cannons. (2) "Bait Crown": one crown is worth triple, so everyone aims there and arcs collide. (3) "Six Districts": a 10k city.
- **Risks:** hot-seat secrecy on one screen is clumsy (phones fix it). Simultaneous outcomes are more random. Settle times are longer.
- **Scores (1-5):** fun 5 / novelty 4 / engine fit 5 / cost 5

### CO-17 Blind Engineer
- **Pitch:** Co-op with split information: one player sees the load X-ray and the heritage map but cannot fire, the others fire but see only the plain building. Bring a 100k building down inside its footprint together.
- **Fun hook:** Talking is the game. "Third column from the left, low, the amber one. No, MY left." The first 30 seconds: the engineer sees one blazing load thread and must describe it.
- **Borrowed from:** Keep Talking and Nobody Explodes (asymmetric information co-op), Spaceteam (shouting instructions), Overcooked (role splits).
- **Loop:** 30 s: the engineer studies and describes, a gunner fires, everyone watches. 5 min: 4-6 shots for a controlled demolition graded on footprint, heritage and stars.
- **Scale story:** 1k: easy to describe. 10k: hard; landmark language develops ("the bakery", "the bent column"). 100k: needs labels and pings (the engineer can place 3 numbered beacons the gunners can see), and the communication budget becomes the puzzle.
- **Uses today:** load X-ray (designed), heritage and footprint constraints, B2/B3 levels, stars.
- **Needs new:** a per-player view split. On one device, that means alternating views (pass the device), which is weaker. Two devices via N3 is ideal (M). Beacons (S). The X-ray must be built if not yet (M). N0 is clumsy; N3 or a second screen is better.
- **Level seeds:** (1) "Chimney": one tall stack in a yard with a heritage shed next door. (2) "Spare the Cathedral" co-op cut. (3) "Ten Thousand Blind": the B3 city, footprint lot.
- **Risks:** one device can't hide information well. Communication games depend on the group. The X-ray dependency.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### CO-18 Rubble Cup
- **Pitch:** [Hybrid: progression] A same-device tournament for 4-16 players: a bracket where every match is a mini-mode drawn from a deck, with a trophy replay at the end.
- **Fun hook:** It packages the other modes into an evening; every match is short and the bracket keeps stakes. The first 30 seconds: enter names, shuffle, and the first matchup is announced.
- **Borrowed from:** Mario Party and WarioWare (minigame rotation), Smash tournament brackets, golf match play, Swiss pairing in chess tournaments.
- **Loop:** 30 s: a 1-3 shot mini-match (Two Keeps single round, Heraldry 3 shots, Spill Line sprint). 5 min: a quarter-final round. A full cup is 30-45 min with a highlights reel of the biggest leverage shots.
- **Scale story:** the final is always a big structure (10k), so the cup climbs in scale as it goes.
- **Uses today:** levels, replays, scoring, local progress storage.
- **Needs new:** a bracket UI, mode deck, and highlight picking (the biggest leverage or PE per shot; S-M, low). N0.
- **Level seeds:** (1) "Pocket Cup": 4 players, 3 modes. (2) "Grand Cup": 16 players, Swiss rounds. (3) "Grudge Final": the final on the B3 city.
- **Risks:** it is only a wrapper, so it needs 3+ good duel modes first.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 4

### CO-19 Last Fort Standing
- **Pitch:** [Wild] An 8-player hot-seat battle royale on a 100k landscape: every player has a small fort, a ring of erosion (blasts and removes) eats the outer land each round, and shots are simultaneous sealed orders.
- **Fun hook:** Alliances, betrayals and a shrinking world. Your fort near the edge must decide between fleeing (re-placing your crown inward) and fighting. The first 30 seconds: 8 forts dot a hillside of 100k blocks and the ring begins to glow.
- **Borrowed from:** battle royale (a shrinking zone), Diplomacy (simultaneous orders, verbal alliances), Worms' many teams.
- **Loop:** 30 s: secret orders (shoot or relocate the crown), a shared launch, then the ring erodes. 5 min: 8-10 rounds until one crown stands.
- **Scale story:** only works at 100k. The land is the arena, and erosion turns hills into rubble slopes that forts slide down. Sleep keeps the far land free.
- **Uses today:** blasts (ring of radial impulses), `remove`, spawn, crowns, photoreal hills.
- **Needs new:** 100k real time with sleep compaction (L, in progress, high). Tiered blasts for the ring (step 8; M). Crown relocation (`remove` + `spawn`, S). N0 is long and slow with 8 players, so N3 phones are much better (M).
- **Level seeds:** (1) "Eight Hills". (2) "Island": a ring of ice, so the land slides into the sea of rubble. (3) "City Royale": 8 apartment blocks in a 100k city.
- **Risks:** pacing with 8 players; elimination leaves players idle (spectator bets from CO-12 fix it). Performance at 100k.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 2 / cost 2

### CO-20 The Crooked Mason
- **Pitch:** [Wild] Social deduction: 4-6 players take turns placing blocks to build a tower to a target height, but one secret saboteur wants it to fall. After any collapse, the table scrubs the forensic replay and votes on who did it.
- **Fun hook:** Physics as evidence. Was that wobbly block placed in bad faith or just badly? The replay heatmap and per-player ink are the "body found" moment. The first 30 seconds: your secret role card, then the first innocent-looking placement.
- **Borrowed from:** Among Us and The Resistance (hidden traitor, discussion, voting), Werewolf, Jenga-style stacking as the shared task.
- **Loop:** 30 s: place a block (the saboteur may subtly undermine). 5 min: build to height H or collapse; on a collapse, a 60 s replay forensic (scrub, heatmap, per-player ink), vote, reveal.
- **Scale story:** 1k: obvious sabotage. 10k: the tower is pre-built with 10k blocks and you add or remove a few per turn; the culprit hides among noise, so forensics needs the displacement heatmap and load X-ray. 100k is unnecessary.
- **Uses today:** spawn at rest, deterministic replay (scrubbing by re-simulation is exact on the same device, which is ideal for an evidence room), displacement heatmap, shot ink, X-ray.
- **Needs new:** secret roles on a shared device (pass device; S). A "who destabilised this" view: per-placement load change (M, med). Voting UI (S). N0 or N3 phones (best for secret roles).
- **Level seeds:** (1) "Belfry": build 3 m with 40 planks. (2) "Restoration": a 10k ruin to shore up, each turn place a prop or remove rubble. (3) "Two Masons": 6 players, 2 saboteurs.
- **Risks:** the saboteur may be too easy to spot (any bad block is suspicious) or impossible (physics randomness). Needs a role mechanic where the saboteur has a cover story, such as a forced random block shape for everyone.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 3

### CO-21 Called Order
- **Pitch:** [Hybrid: puzzle] Pool rules on a tower: numbered crown blocks must fall in order, the lowest number first. Fall it and you shoot again; fail and your opponent gets "ball in hand" (a free reposition of the launcher).
- **Fun hook:** Runs. A clean sequence can let one player clear the tower, so positional play (setting up your next shot) matters as much as the current one. Combination shots are legal (lowest first, others may follow). The first 30 seconds: the break shot.
- **Borrowed from:** 9-ball pool (lowest first, combination shots, ball in hand after a foul), snooker breaks (continuation and position play), golf match play.
- **Loop:** 30 s: one shot, check the legality (which crown fell first per the event order), continue or hand over. 5 min: a rack of 9 numbered crowns; frames to 3.
- **Scale story:** 1k: 9 crowns on a small tower. 10k: 15 crowns spread through a city, so position play becomes route planning. 100k: one frame is a long campaign where "breaking" the whole city early is a gamble.
- **Uses today:** crowns, observers with event order (the first watched crown below the line; up to 64 watched bodies per step), rubble persistence.
- **Needs new:** first-crossing event ordering on watched bodies (S, low). Foul and ball-in-hand rules (S). Spectacle cue for the run (S). N0, N2, or N3.
- **Level seeds:** (1) "Nine Rack": 9 crowns in a triangle tower. (2) "Combination Bridge": crowns on a bridge, where 1 must topple 9 directly. (3) "City Fifteen": 15 numbered crowns in 10k.
- **Risks:** a chaotic first fall may decide too many frames. Continuation may lead to runaway wins (that is pool, though).
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### CO-22 Proving Ground
- **Pitch:** [Hybrid: progression] A weekly public leaderboard where only robust shots count: players upload replays, a reference machine re-simulates them, and the board shows the reference outcome, not the player's claim.
- **Fun hook:** It turns the cross-device problem into a skill: "lucky chaos" shots that work only on your GPU don't score; precise shots do. The first 30 seconds: your shot, then "verifying..." and later "verified: 7/8 crowns (you claimed 8)".
- **Borrowed from:** speedrun verification (moderated submissions), Trackmania replay validation, the Super Mario Maker clear check.
- **Loop:** 30 s: a shot as usual. 5 min: several attempts on the weekly level and a submission. Over a week: daily verification batches and board updates, with seasons and titles.
- **Scale story:** 1k: verification matches claims closely. 10k-100k: divergence grows, so the board naturally rewards keystone shots with wide basins over brute chaos; this is the existing bot's basin philosophy made social.
- **Uses today:** replays, the star-casting pipeline on the Mac, KV.
- **Needs new:** a submission Worker and queue in KV (S-M, low). A Mac verification job (M, med: GPU hours, an always-on machine; scale cost per weekly level ~ submissions x settle time; at 1k submissions x ~5 s each = 1.5 h a week). Verified/claimed UI (S). N5. Anti-cheat is strong: the board is never the player's claim.
- **Level seeds:** (1) "Weekly Wall": a 1k wall, crowns. (2) "Cathedral Week": B2 with heritage. (3) "Megaweek": 100k with one shot.
- **Risks:** "my shot worked and the board says it didn't" frustration; show the reference replay video. Single point of failure (Will's Mac). Scaling the verification cost.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 2

### CO-23 Clear-Checked
- **Pitch:** [Hybrid: puzzle + sandbox] Players build trap levels (structure, crowns, rack) and send them to friends. The creator must clear their own level 6 of 8 times with jittered replays before it can be sent.
- **Fun hook:** Making a mean level and watching a friend fail. The robustness gate stops unfair "one-in-a-million" traps. The first 30 seconds: you load a friend's trap: a ring of dominoes with a crown on an ice plinth and 2 marbles.
- **Borrowed from:** Super Mario Maker (clear-check before upload, sharing course codes), puzzle trading in PuzzleScript communities, the Portal 2 workshop.
- **Loop:** 30 s: open a code, read, shoot. 5 min: build and clear-check a trap (needs the editor), send the code.
- **Scale story:** 1k: trap levels are clever. 10k: traps become Rube Goldberg contraptions with domino chains feeding a cathedral. 100k: possible but slow to build and to check (8 jittered clear checks on a 100k level = minutes).
- **Uses today:** the bot's jitter/nudge machinery (run on device), levels as data, replays.
- **Needs new:** a level editor (M-L, med). A device-side jittered clear check (S-M, given rollouts from CO-8). Codes via N1 (a level of 1k bodies is ~10-15 KB; too big for a URL, fine via KV with a short code: S). Exploit: a level robust on the creator's device may still fail on the receiver's; the 6/8 gate reduces this risk.
- **Level seeds:** (1) "Domino Moat". (2) "Heritage Hostage": a crown inside a heritage cage. (3) "The Long Fuse": a 10k domino trail that must be started with one marble.
- **Risks:** the editor is expensive. Without a community, the trade dies (friends only first).
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 3 / cost 2

### CO-24 Babel Race
- **Pitch:** [Hybrid: stacking] A two-player race to build the tallest tower side by side: each turn you drop a random plank, and you can spend charge on hexes against your rival (an ice plank, a gust, a small blast).
- **Fun hook:** Stacking wobble plus sabotage: do you build steadily or bank charge for a hex at the decisive moment? The first 30 seconds: drop a plank that teeters, then hit their tower with a gust.
- **Borrowed from:** Tricky Towers (a competitive physics stacking race with spells), Suika-style random drops, Animal Upon Animal and other dexterity stacking games.
- **Loop:** 30 s: 3-4 drops, then a hex. 5 min: race to 6 m, or the tallest after 40 drops.
- **Scale story:** 1k: planks dominate. 10k: each player has a pre-built 5k base (a city) and drops whole floors (stamps), so towers grow fast and fall big. 100k: not needed.
- **Uses today:** planks, spawn at rest or drop, blast, ice material, skyline height reductions.
- **Needs new:** a drop controller (position the falling piece, rotate, release; S). Hex effects: blast (exists), gust (sparse forces, step 6; M) or a velocity spawn fake (S). Real time on one device with split controls (S-M), or turn-based. N0, or N3.
- **Level seeds:** (1) "Plank Race". (2) "Ice Age": every 5th plank is ice. (3) "Windy": a constant gust, so towers must lean into it.
- **Risks:** only boxes (no tetromino compounds) limits variety; plank sizes help. The "Tricky Towers" comparison is close, so the twist must be real physics and scale.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 4 / cost 4

### CO-25 Rubble Rush
- **Pitch:** [Wild] Real-time same-keyboard two-player war: two launchers fire on cooldowns at a 10k-cube mountain between them, and you win by burying the rival's flag under rubble.
- **Fun hook:** No turns, pure panic. Your shots both push rubble at them and build cover in front of you. The first 30 seconds: rapid fire, a landslide, a flag half-buried.
- **Borrowed from:** real-time tank games (Tank Trouble), Bomberman (couch chaos), Rampart's real-time battle phase.
- **Loop:** 30 s: fire every 2 s with WASD vs the arrow keys. 5 min: 3 rounds of 90 s.
- **Scale story:** 1k: a hill. 10k: a mountain that slides as real granular media, which is the GPU's big moment. 100k: impossible in real time today.
- **Uses today:** the live sim, projectiles, blasts, observers (rubble mass over a flag region).
- **Needs new:** a fixed shared camera (allowed, the player set it), split controls (S). Physics never freezes, so the frame budget must hold at 10k with many awake bodies (med risk). N0.
- **Level seeds:** (1) "Molehill 1k". (2) "Mountain 10k". (3) "Ice Mountain": a slippery slope that slides back.
- **Risks:** it breaks the "freeze while aiming" Keystone grammar. Many awake bodies may stall the frame rate. Real-time aiming with quantised shots on a keyboard is clumsy.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 3 / cost 4

---

## Capability primitives this lens keeps needing

| Primitive | Effort / risk | Needed by |
|---|---|---|
| **Per-body owner tag + per-owner reductions** (count, mass or PE per owner, in a region or below a line) | S-M / low | CO-5, 6, 7, 8, 11, 15, 16, 19, 20, 21 |
| **Turn controller**: settle detection (moving count under threshold for N steps), turn cap with fast-forward, a "who caused it" window | S / low | nearly all turn modes: CO-1-8, 10, 11, 14, 16, 19-21 |
| **Placement tool**: spawn at rest with ghost preview, snapping, overlap check, budget, stamps | S-M / low | CO-1, 3, 4, 15, 20, 23, 24 |
| **Hidden information on one device** (pass-device cover screen, secret roles and orders) | S / low | CO-3, 7, 12, 16, 19, 20 |
| **Snapshot to level / load a settled state at rest** (quantised, sleeping on load) | M / med | CO-3 (async), 14, 15 (async), 23 |
| **Snapshot fork/restore + headless fast stepping** (on-device rollouts) | M / med | CO-8, 23, 12 (odds casting) |
| **Sparse forces (step 6)**: finger push, gust, wind | M / med (planned) | CO-1, 2, 7, 24 |
| **Contact-propagated ownership / causal ink** | M / med | CO-15, 16, 20 (and per-shot ink for all) |
| **Watched-body event order** (first crossing, first to fall) | S / low | CO-12, 21 |
| **Post-lock perturbation seed** (anti-rehearsal under per-device determinism) | S / low | CO-12, 7 |
| **Networking N1 links** (no backend) | S / low | CO-9, 23 |
| **Networking N2 settle-sync mail** (KV + Worker) | S-M / low-med | CO-3, 6, 11, 14, 15, 21 |
| **Networking N3 room relay** (Durable Objects; KV polling fallback) | M / low tech, new infra | CO-4, 12, 13, 16, 17, 19, 20, 24 |
| **Networking N4 host video stream** (WebRTC + TURN) | L / med, ongoing cost | CO-13 (remote crowd) |
| **N5 reference verifier** (Mac batch re-sim) | M / med | CO-22 |
| **100k real time with sleep compaction** | L / high (in progress) | CO-15 (100k), 19 |

## My top 5 and why

1. **CO-2 Two Keeps.** The most proven competitive structure (artillery duels) mapped onto exactly what we have: spawn, blast, persistent rubble, crowns. It is hot-seat with zero networking, and scale turns it into siege engineering. Lowest-risk first competitive mode.
2. **CO-15 Chain War.** The most original idea here, and the one where 10k-100k blocks plus sleep become the game rather than the backdrop: two colour waves racing across a domino field. Needs one new primitive (contact ownership), which also serves ink everywhere.
3. **CO-16 Sealed Orders.** WeGo fixes hot-seat's biggest problem (waiting) and creates spectacle (simultaneous impacts). Nearly free to build, and it is a modifier that makes Two Keeps, Heraldry and Last Fort better.
4. **CO-11 Heraldry.** The cheapest real competitive mode: owner tags + the crowns machinery on one shared structure. Every shot has collateral, so the decisions are rich from the first shot. It is the likely first test of the owner-tag primitive.
5. **CO-14 Letter Siege.** Not the most fun on paper, but it is the answer to "can we play online without cross-device determinism?" with the backend we already have: exchange the world only at rest. That one primitive (snapshot to level) unlocks remote play for every turn-based mode above.

Runners-up: CO-13 Room Code (best party format, but new infrastructure) and CO-20 The Crooked Mason (the replay-as-evidence idea is uniquely ours).
