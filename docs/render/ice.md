# Ice: see-through blocks that crack and shatter

Will, 2026-11-06: "coming up with an algo for transparency / light treatment would be so freaking amazing. and at certain impact velocities have a few different treatments of cracking / breaking? then the ice can glimmer with precomputed or other strategy for light reflection/refraction? would be so cool to look like we're shattering ice".

## What there was

- **Physics.** Keystone already had an `ice` material (`materials.ts`: density 225, friction 0.05, restitution 0.05). No level used it.
- **Sound.** The collision sound has an ice material, and so does the synth's timbre table.
- **Render.** Nothing. Every body went through the same opaque pipelines.

## Rendering: what was weighed

The constraint is cost at scale. A level can hold thousands of blocks and the game must keep 120 fps on the M5 Max, so ice has to cost nothing when absent and stay small per pixel when present.

| Approach | What it gives | Cost | Verdict |
|---|---|---|---|
| Opaque ice in the scene pass, environment map only (reflection and a refracted sky) | A shiny blue block | No new pass | Nothing shows through it, and seeing the tower bent through the ice is most of what reads as ice. **Kept as the off-screen fallback.** |
| Alpha-blended ice, no refraction | Tinted glass | Back-to-front sort, overdraw | Reads as glass, not ice. Rejected. |
| **Screen-space refraction + analytic ray-box path (chosen)** | What is behind it, bent; internal reflections; thickness-correct tint | One extra render pass while any ice exists, plus per-ice-pixel ALU (below) | Gives the look Will asked for at a cost bounded by ice pixels. |
| Ray-traced or depth-peeled refraction | Correct ice seen through ice | Two more depth layers per frame | The one thing the chosen approach gets wrong (below). Revisit if ice walls look flat. |
| Precomputed glints (a baked sparkle texture) | Glimmer | One texture | Sparkle that does not follow the sun or the view reads as a pattern. Replaced by analytic facets (below), which cost about the same. |
| Voronoi prefracture meshes for cracks and shards | Exact shards | New mesh pipeline, and the engines collide only boxes and spheres | Pieces would have to be boxes anyway. Cracks are drawn in the shader; a shatter splits a block into boxes (rules, below). |
| Crack decals (textures) | Cracks | Decal pass | Do not follow a crack into the block. The shader's crack planes are seen through the ice, inside it. |

## The chosen look (`packages/render/src/ice.ts`, `ice-pass.ts`)

Each ice pixel is computed analytically in the box's own frame:

1. **Fresnel.** The view ray meets the face. Exact dielectric Fresnel at n = 1.31 sends about 2% back head-on and all of it past grazing. The reflected part is the look's environment plus the sun's highlight.
2. **Path through the box.** The refracted ray is traced to its exit face (`iceExit`, one ray-box hit). If it meets that face past the critical angle (49.8°), it reflects (total internal reflection) and goes on, up to `bounces` times (default 2). That is why a cube shows bright internal edges and its other faces.
3. **What is behind.** The exit ray reads the opaque scene, which was resolved before the ice into the `under` texture. It reads a little way past the exit point, so the stripes behind are bent (screen-space refraction). The read is a 4-tap blur, so the faces look melted and slightly frosted, not like glass. Off screen, it falls back to the environment.
4. **Colour by thickness (Beer–Lambert).** Absorption runs over the exact path length inside. The spectrum is [1, 0.3, 0.1] × `absorb` per metre: red goes first, so thick ice goes blue-green.
5. **Cloudy core and bubbles.** A cloudy core comes from radial falloff modulated by 3D value noise, with single scattering lit by the sky and the sun. Air bubbles are exact ray-sphere hits, walked cell by cell along the first leg (Amanatides–Woo, 24 cells). Bubbles are analytic: an earlier volume-noise version speckled like snow and showed hatching from its jitter.
6. **Glints (the glimmer).** A sparse grid of tiny facets covers each face: 1 cell in 6 holds a facet tilted up to 0.2 rad. A facet flashes when the sun's half vector lines up with it. Each fades once it is smaller than a pixel, so distant ice does not shimmer. It is view- and sun-dependent, which is the glimmer.
7. **Rime and frost.** White rime runs along face edges, and GGX roughness `frost` blurs the highlights.
8. **Cracks.** Planes through the impact point have jagged extents (`iceCracks`), and there are more of them as the crack level rises (1 to 7). A ring crack appears from level 3. Inside, where the ray crosses a crack plane, the air gap reflects silver-white and passes less light. Where a plane meets the face, a frosted line shows. From level 4, the impact point is crushed white and grainy.

Fog is composed as fog(emitted) + T × (under − fog(0)). The scene behind is already fogged, so it is not fogged twice.

### Data and passes

- **Surface word.** Each slot has a `u32` surface word (`surface.ts`), separate from `fx`, which is transient. Bits 0–3 are the kind (0 default, 1 ice), bits 4–6 the crack level, bits 7–15 the impact point (3 bits per axis), and bits 16–31 the seed. Zero is the default surface, so a world without ice uploads zeros and draws exactly as before. A test holds the no-surface frame bit-identical to the default-surface frame.
- **Cull.** The cull pass's prepare step reads the surface words (binding 10). Ice boxes go to their own segment, `SEG.boxIce` (the seventh), instead of box or boxFar. Their shadow is unchanged (opaque shadow; see the limitations). Prepare now binds 8 storage buffers, which is the WebGPU default limit: the next binding has to share a buffer.
- **Passes.** While any slot is ice, the scene pass splits in two:
  - Pass 1 draws the opaque scene into MSAA, resolves it into `under`, and stores its samples and depth.
  - Pass 2 loads those, draws the ice list with the ice pipeline (group 2: uniforms, `under`, a sampler, the surface words), then the hall glass, sparks, debris, trail, reach preview, fuses and blasts, and resolves into the HDR target.
  - Without ice the frame is one pass, as before.
  - In ids mode (picking) ice is drawn opaque with the id pipeline.

### Cost

Not yet measured on the M5 Max. SwiftShader and CI timings are never performance results. Queued for the Mac's next idle window.

- **Fixed cost of the split.** It applies only while ice exists. The MSAA colour (rgba16float, 4 samples) and depth (depth24plus, 4 samples) are stored after pass 1 and loaded in pass 2: about 4 × (8 + 4) B per pixel each way, plus the `under` resolve (8 B per pixel). On Apple's tile-based GPUs that store and load is the expensive part, because MSAA is otherwise memoryless.
  - At 3456 × 2234 that is about 0.8 GB per frame, or roughly 15% of the M5 Max's bandwidth at 120 fps.
  - If the bench confirms it, the fallback is to read last frame's resolved HDR as `under` (one frame of lag in what is seen through the ice) and keep a single pass.
- **Per ice pixel:**
  - up to 3 ray-box exits,
  - one 24-cell bubble walk,
  - about 6 value-noise samples,
  - 4 blurred texture taps,
  - one crack evaluation (up to 7 planes plus a ring).
- **No ice, no cost.** The cull reads one more `u32` per body. The ice pipelines compile lazily on first use.

### Knobs (URL keys `ice.<knob>`, game and viewer)

| Knob | Default | Range | Meaning |
|---|---|---|---|
| `ice.ior` | 1.31 | 1 to 2.5 | index of refraction |
| `ice.absorb` | 0.5 | 0 to 20 | red absorption per metre (green and blue × 0.3, × 0.1) |
| `ice.cloud` | 1.2 | 0 to 20 | scattering in the cloudy core |
| `ice.bubbles` | 0.2 | 0 to 1 | air bubbles |
| `ice.glint`, `ice.glintSize` | 1, 0.012 m | | glint strength, facet size |
| `ice.frost` | 0.12 | 0 to 1 | surface roughness |
| `ice.depth` | 1 | | how far past the exit the background is read (half diagonals) |
| `ice.bounces` | 2 | 0 to 4, whole | internal reflections |
| `ice.crack` | 1 | 0 to 2 | crack visibility |
| `ice.blur` | 2 px | | blur of what is seen through |
| `ice.rime` | 0.35 | 0 to 1 | white rime at the edges |

Absorption and glint size are per metre, converted by the world's metres per unit, so a quarter-metre world looks the same.

## Cracking and breaking (rules, `packages/keystone/src/ice.ts`)

The rules decide when ice cracks and shatters, deterministically, from observed states only, so a session replays exactly, as a weapon's fuses do.

- **Hit.** Each observed step, an ice body's hit is its speed change beyond gravity, combined in quadrature with its spin change times its largest half extent (the speed change at a corner):
  `dv = sqrt(|v − v_prev − g dt|² + (|ω − ω_prev| · max half)²)`.
  Bodies in rubble, the lattice or removed are not judged, and their history restarts, because the tier holding a body still is not a hit.
- **Damage.** Below `crackDv` (1.5 m/s) a hit does nothing: resting contact reads g dt = 0.16, and sliding and rocking stay under it. Above it, a hit adds `((dv − crackDv) / (shatterDv − crackDv))²`.
  - One hit at `shatterDv` (5 m/s) or more shatters the block at once.
  - Smaller hits add up: two at 71% of the way do.
- **Treatments by speed.**

  | Damage | What it looks like |
  |---|---|
  | under crackDv | clear |
  | 0 to 3/7 | crack levels 1 to 3: a few planes, then a ring |
  | 3/7 to 1 | levels 4 to 7: crushed at the impact point, more and longer planes |
  | 1 | shatter |

  The crack starts on the face the first hit pushed from: opposite the speed change, in the body's frame.
- **Shatter.** At damage 1, the block is removed and its pieces are spawned the step after.
  - The block splits 2 × 2 × 2. An axis under 3/4 of the longest is not split, so a plank breaks across.
  - Each piece is 4% smaller than its cell, so the pieces start apart.
  - Each piece is denser by the same share, so mass is kept.
  - Each piece moves at the block's velocity at its centre (v + ω × r), plus an outward kick of 0.6 m/s. The kick grows with the hit, up to twice that.
  - Momentum is kept: the kicks cancel over the symmetric split, and a test checks it.
  - At most one block shatters per step, the hardest hit first; the others keep their damage and go in later steps.
  - Pieces crack but never shatter again.
- **Scoring.** The rules score the structure's n bodies. A shattered block is scored where its pieces are: at their mass-weighted centre, moving at their mass-weighted velocity, awake while any piece is (`IceBreaker.view`). The structure's potential energy is then exactly what it would be summed over the pieces. A shattered crown counts as down, and shattered heritage as broken (`Session.shatter`).
- **Budget.** Engines reserve 8 bodies per ice block (`IceBreaker.budget`), in the GPU capacity and in Rapier's validation.
- **Level block.** `LevelDef.physics.ice` takes `{ crackDv, shatterDv, shatter }`. Whenever a level has ice, the rules join the level hash written out in full, so retuning `ICE_DEFAULTS` drops stars cast under the old values. A level without ice hashes as before.

### Calibration

Measured 2026-11-06 on L1, L2 and L5 built of ice, with their par shots. The table gives each body's hardest single-step hit in m/s: the median, the 90th percentile and the maximum.

| Engine | L1 (40) | L2 (139) | L5 (45) |
|---|---|---|---|
| f64 reference (AVBD) | 3.5 / 4.7 / 6.9 | 0.17 / 0.22 / 10.6 | 2.7 / 3.5 / 5.0 |

At 1.5 and 5, the counts per engine are:

| Engine | L1 shatters, cracked | L2 shatters, cracked | L5 shatters, cracked |
|---|---|---|---|
| reference | 6, 74 crack events | 7, 45 | 1, 44 |
| Rapier | 26, 218 | n/a | 12, 124 |

- The GPU engine is AVBD, like the reference, and the game plays on it, so the defaults are set on the reference.
- Rapier's contacts stop a body in fewer steps, so its single-step speed changes are larger and it shatters about 4× as much.
- A level that plays on Rapier can raise its own `shatterDv`.

## The game

- **On load.** Every ice body is painted ice (`Driver.iceSurfaces`). After an undo, the cracks and pieces as they stood are repainted from the driver's checkpointed state.
- **`iceCrack` feedback** sets the body's crack level, origin and seed. The synth plays a dry high tick, louder for a bigger crack.
- **`shatter` feedback** paints the pieces as ice and puffs ice dust where the block broke. The synth plays a hiss and a quick run of high chimes on the game's pentatonic scale. The pieces never paint as bombs.
- **Collision sound.** Pieces are recognised by their unique density (`isIcePiece`) and sound as ice.
- **Trials.** T-I1 *Ice Tower*, T-I2 *Ice Wall* and T-I3 *Frozen Keep* (stone below, ice above) are in the door under Trials.

## Tests

- **`render/test/ice.test.ts`** (Node):
  - surface words round-trip and clamp;
  - knobs parse and write;
  - uniforms are per metre;
  - Fresnel: 2% head-on, total internal reflection, Stokes symmetry;
  - the path is 2h head-on, and leaves parallel through two faces;
  - a total-internal-reflection case is worked by hand (40° in, 60.6° at the side);
  - invariants hold over 2,000 random rays;
  - an axis-parallel exit does not divide by zero.
- **`render/test/render-ice.test.ts`** (WebGPU, SwiftShader):
  - The ice path shader matches its CPU twin: branch mismatches under 0.5% (0 of 4,096 measured), length and direction within 2e-3 (2.7e-4 measured).
  - For both looks, a block in front of a striped backdrop:
    - no surface is bit-identical to the default surface;
    - the ice is in its own list and in the id buffer;
    - it is see-through: swapping the stripes changes the ice's pixels 0.33–0.39 as much as the backdrop's own, and an opaque block 0;
    - it is bent: its pixels are not the backdrop's;
    - it is tinted blue against the same ice with no absorption.
  - Cracks at levels 1, 4 and 7 grow and change nothing off the block.
  - Effects after the ice pass still draw.
- **`render/test/render.test.ts` cull case** (seed 10, ice): the GPU cull matches its CPU reference with ice in the mix.
- **`keystone/test/ice.test.ts`:**
  - the damage rule and crack levels;
  - the level block's checks;
  - piece grids;
  - pieces keep mass, momentum and centre, start apart, and spin with the block;
  - the kick grows and is capped;
  - free fall and rest are not hits;
  - crack levels and their origin;
  - one shatter per step, hardest first;
  - tiers are not judged;
  - pieces never shatter;
  - the proxy's potential energy equals the pieces' sum;
  - the hash rule;
  - `surfaces()`;
  - `isIcePiece`.
- **`keystone-lab/test/ice.test.ts`** (Rapier):
  - L1 in ice under its par shot cracks and shatters;
  - piece ids, tombstones and mass;
  - serial equals pipelined, and both equal a replay from the recorded inputs, bit for bit;
  - an undo checkpoint taken after the first shatter replays to the same end;
  - `shatter: false` only cracks;
  - plaster has no ice.

## Known limitations and follow-ups

- **Ice behind ice.** Ice seen through ice shows what is behind both. Depth peeling fixes it at two more depth layers, if ice walls need it.
- **Shadows.** Ice casts an opaque shadow. Coloured or caustic shadows would mean a transmittance shadow map.
- **Particles.** Debris and chips from ice use the stone colours.
- **Colour of what is behind.** Through ice, the brown ground reads slightly green in the real look, which is the blue absorption over brown. This is physically right, but may want a hue nudge.
- **Engine-dependent thresholds.** Rapier shatters about 4× as much as AVBD at the same thresholds.
