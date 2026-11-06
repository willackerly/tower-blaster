# Bullet Time and Undercut polish (agent playtest PT8, PT17)

Agent playtest round 1 (`docs/game/agent-playtest-1.md`) found two readability problems in the
Stage 1 modes (`undercut-bullet-time.md`):

- **PT8, Bullet Time.** A frozen world looked exactly like a running one, the sparks kept
  flashing, a cut-in cost a stroke (so Bullet Time could only hurt the score), and the T key was
  named only in the key list.
- **PT17, Undercut.** The pulled block vanished between two frames, the keep-up crown wore the
  same shield as a heritage stone, the HUD showed an orange "0/1" that read as failure, and the
  refusal hint was red before the player had done anything.

Everything below is an option with a panel control and a URL key. The physics, the rules and every
recorded line are unchanged, except for the scoring rule in PT8c, which is keystone's.

## PT8a: the frozen grade

While a shot is frozen, the post composite (`packages/render/src/post.ts`, `frozenGrade`) grades
the tone-mapped frame:

- It desaturates the frame 85% toward luma.
- It applies a cool tint (0.92, 0.97, 1.08).
- It adds a thin cold rim, 3.5% of the frame from each edge.

The grade eases in over 0.15 s and out over 0.12 s (`frozen-look.ts`). A pill label at the top
reads **FROZEN · aim and fire**, followed by "T resumes" on desktop or "Resume to go on" on touch.
The label moves above the touch controls on narrow screens. The option is `keystone.frozenlook=0`
in the URL, or the "Bullet Time: frozen look" box in the viewer's Scene panel.

Alternatives considered:

| Option | Why not |
|---|---|
| CSS `filter: saturate() hue-rotate()` on the canvas | Cheapest, but readback captures (tests, agent playtests, the share card) would not show it. The grade would not be testable. |
| Grade in the scene pass, per material | Every look's shading would need a branch. The post pass already runs once per pixel in every look. |
| Freeze the frame, grade a still copy | Aiming arcs and overlays still need to draw live over the frozen world. |

**Verified.** `freeze-e2e.test.ts` captures the same frozen world twice, once with the look on and
once with it switched off live. The graded frame's mean saturation is under 0.7 times the plain
frame's; the target was at least 30% lower. `render.test.ts` checks the grade's saturation drop
and the rim on candy cubes at grades 0, 0.5 and 1.

## PT8b: sparks and heat while frozen

When the world is frozen, the frame's `dt` is 0, so sparks hang where they are. The Frame
uniform's `fxGain` scales how many sparks are drawn: a golden-ratio hash per spark decides which
ones stay. Spark count goes from all to none as the grade goes from 0 to 1. Heat glow is scaled to
30%.

The first idea was to dim spark brightness, but it does not work. The sparks are HDR streaks at
about 20 times white, and after AgX tone mapping a 0.3 multiplier changed the lit area by only 3%.
Thinning the sparks reads as "held" without flashing. Because they hang rather than vanish for
good, they come back exactly as they were on resume. This is tested: the sum is equal before and
after.

## PT8c: Bullet Time par

A cut-in that clears within par now keeps par: **effective par = par + freezes used**, on levels
with a freeze budget only. The card shows "freezes used N/M". Scoring is owned by the score module,
and the thread "Make scores and leverage add up" (PR #242) implements it as `freezesUsed` and
`parWithFreezes` in `rules.ts`. This thread pins the rule end to end in
`packages/keystone-lab/test/bullet-time-par.test.ts`, which plays on Rapier:

- L5's opener plus one cut-in that clears stamps PAR with three stars when the level has a freeze
  budget.
- The same line without a budget is plain rapid fire and stamps BOGEY.

Alternatives considered:

- **Cut-ins are free strokes.** This would make rapid fire free too, because it is the same
  mechanism without a budget.
- **Par + freezes available.** This rewards not using Bullet Time.

## PT8d: How to play

How to play has a new line, `BULLET_TIME_HOW` in `door.ts`, that names Bullet Time and its key: T
on desktop, the Freeze button on touch. The line also says that resuming without firing keeps the
freeze. The settled-aim line now says "the world waits while you aim" instead of "physics
freezes", so that "freeze" means Bullet Time only.

## PT17a: the pull, drawn

The engine removes the pulled body at the step of the pull, and that is unchanged. What changes
is the snapshot copy the game uploads to the renderer: `pull-anim.ts` `withPulled` patches the
slot back in for 15 physics steps, then puts it back.

- **Slide.** The block slides horizontally toward the camera, 2.2 times its extent along that
  direction, eased out. Over the second half it shrinks to 15% and is tinted with the hover light.
- **Ghost.** For one second of wall time, a dotted outline of the block's 12 edges stays where it
  stood, drawn with overlay beads, then fades.

The slide is driven by physics steps, not by wall time. So a capture N steps after a pull is the
same on every run, it holds while Bullet Time freezes the world, and it speeds up under
fast-forward. The option is `keystone.pullanim=0`.

| Option | Why not |
|---|---|
| Slide on wall time | Smoother on 120 Hz, but captures would depend on frame timing, and the slide would carry on through a freeze. |
| Transparent ghost box | There is no transparent body pass. Adding one would cost every look. |
| Delay the engine's removal | Changes the physics and every recorded line. |

**Verified.** `pull-e2e.test.ts` freezes the page 10 steps after a pull and checks:

- The block is drawn moved more than 0.25 m horizontally, at its own height, partly shrunk, and
  still covers pixels in an id render.
- With `keystone.pullanim=0` it covers none.
- Once the slide is over it covers none.

`pull-anim.test.ts` checks the pose maths and the ghost's beads: corners drawn once, and the
outline gone after `PULL_GHOST_MS`.

## PT17b: the keep-up crown

The stone-mark word had a fourth value that nothing used. It is now `MARK_KEEP`, a carved crown
(`marks.ts` `crownSd`, with TypeScript and WGSL twins): a band, three points and three jewels. It
replaces the shield on the crowns of hold levels (U3). The shield still means "heritage: don't
break". On hold levels the HUD row reads "Crown: standing ✓" (or "Crowns: all standing ✓",
"fallen", "1 of 2 fallen") instead of a 0/1 counter.

The alternatives were a different colour for the shield, or a halo overlay. A colour alone fails
for colour-blind players. A halo would be a per-frame overlay, which is not carved.

**Verified.** The CPU test checks that the crown's field differs from both other glyphs, and that
its far-shade cover is close to theirs. The GPU test per look checks that a crown reads as neither
a shield nor a crosshair. `hud.test.ts` checks that a hold level shows no "/" counter.

## PT17c: the refusal hint

The hint "Crowns and heritage stay: pull a plain block" uses the neutral `.hint` colour while the
player hovers a crown or heritage block. It turns red (`.bad`) only after the player fires at that
block and the pull is refused. It goes neutral again once the aim leaves that block.
`pull-e2e.test.ts` reads the computed colour at each stage.
