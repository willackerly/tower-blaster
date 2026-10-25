# Renderer design (P5)

How we draw 100k cubes from the physics GPU buffers, and make smashing them satisfying. Produced by a design panel (three independent designs: performance-first, look-first, risk-first; three judges: GPU performance, visual quality and fun, engineering), then synthesized and checked against the code. Cost figures are estimates until `pnpm bench:render` runs on the M5 Max.

## Adjustments after talking to the physics and lattice threads (2026-10-25)

- **Physics.** `GpuAvbdEngine(params, { device })` already accepts a shared device and does not destroy it. The physics thread agreed to an optional `gpu()` on `PhysicsEngine` returning `{ device, bodies, shapes, count }`; the richer `GpuWorldView` below is the renderer-side view built from it. Body[] is overwritten in place once per step, buffers are STORAGE|COPY_SRC|COPY_DST (read-only storage here), capacity is fixed at init, `count` grows on spawn. A contact-impulse ring (pos, normal, |λn|·dt, a, b) comes after P3.4; until then the Δv detector (tier 1) is the source.
- **Lattice (PR #8).** Its format is used as is, not the `LatticeBrick` proposed below: axis-aligned lattices, frame `{origin, edge}`, 8³ bricks of 16 u32 masks (bit `(lz*8+ly)*8+lx`, key `(bk*nbx+bi)*nby+bj`), `bricks()` and `takeDirtyBricks()` for incremental upload, and a level-set per-cell u8 palette index. Draw rule, "mask wins": tier changes are atomic between steps; static Body[] entries are lattice proxies and are never drawn from Body[]; frozen rubble has its own tier bit and is drawn from Body[].
- **Looks without `ActivationRecord`.** A lattice body id is the scene body index, and slots are stable, so the per-slot look (`BodyLook`) is computed on the CPU from `scene.bodies[i]` (original height, tower tag) and uploaded once at init and once per spawn. No per-frame traffic and no extra cross-thread interface.

## Delivery order

The 24 steps below are grouped into PRs so that each PR is reviewable and leaves something visible on the Mac:

| PR | Steps | Visible result |
|---|---|---|
| R1 | 2, 3, 4, 5 (and the fixed-n scan from 1) | `@tb/render` package; GPU cull and compaction into indirect draws; ID-probe and upload-spy test rig; viewer unchanged in look |
| R2 | 7, 10, 14 | Candy Night look: HDR, AgX, bevelled glossy cubes, OKLab ramp, bloom |
| R3 | 6, 8, 12 | Hexagon fan, fitted shadow, `pnpm bench:render`, first M5 Max numbers |
| R4 | 15, 16, 17 | Sparks, glowing ball, flash lights, heat glow |
| R5 | 13 | Occupancy-volume AO |
| R6 | 11 | Lattice cubes drawn from bricks (after PR #8) |
| R7 | 22, 9 | Zero-upload hookup to the GPU engine; scheduling probe; 100k gate |
| later | 18-21, 23-24 | Polish, tiers, iGPU, game feel hooks |

---


## Decision summary

**Base and grafts.** The base is the "risk" design. Its mean judge score was highest (7.5, 6, 8), it ranked first in two of the three verdicts, and its reading of the current code was the most accurate. Grafted onto it:

- From "perf":
  - the 7-vertex hexagon-fan cube;
  - renderer-owned record compaction with camera-relative positions;
  - exact integer positions for the lattice;
  - the compat-mode fallback;
  - front-to-back bucketing on IMR GPUs;
  - the 2-lobe GGX with key and rim softboxes;
  - the seam-only cavity term;
  - fog evaluated in the forward pass, with HG sun in-scatter;
  - spark ricochet off the volume gradient.
- From "look":
  - prev/current interpolation;
  - the per-body heat glow, with gating added;
  - top-K flash lights;
  - constant-pixel-width spark streaks with coverage-scaled alpha;
  - chips and dust;
  - the hero rounded-mesh LOD;
  - hit-stop and slow motion used as load shedding.

Every mustFix item that checked out against the code is fixed; see the appendix. I checked the judges' code claims against the repo:

- The viewer's box pipeline already uses `cullMode: 'back'` (renderer.ts:265).
- The current shadow pass uses `cullMode: 'none'`.
- `Scanner.encode` calls `queue.writeBuffer` on every call (scan.ts:107).
- `createDevice` requests only `timestamp-query`.
- `Renderer.create` calls `adapter.requestDevice()` itself (renderer.ts:286).
- `main.ts:133` calls `engine.snapshot()` every refresh.
- physics-gpu exports only broadphase, narrowphase and colouring; `Narrowphase.manifolds` is a public GPUBuffer.

**Framework.** Raw WebGPU and WGSL in a new package `@tb/render`. three.js r186 is rejected, for these reasons:

- Sharing buffers with it needs undocumented backend internals.
- We need exact control of the TBDR pass structure: storeOp `discard` on the MSAA attachments, a resolve target, and no loadOp `load`.
- We need indirect draws from GPU-written arguments and timestamps on every pass.
- Its scene graph and material system would go unused.

The renderer has:

- A small frame graph: a static array of passes chosen per quality tier at startup. Each pass declares what it reads and writes, and debug builds check hazards.
- About 8 render pipelines and about 14 compute kernels.
- WGSL structs generated from `@tb/schema`.
- All pipelines created with the `*Async` calls at startup.

`Renderer.create(ctx: GpuContext, target: RenderTarget)` takes the device from `@tb/gpu createDevice`, shared with physics; it no longer calls `requestDevice` itself. It uses core features only. Optional features (`timestamp-query`, `rg11b10ufloat-renderable`, transient attachments if exposed) are requested only when the adapter has them, and are reported back in `GpuContext.features`. The device is shared, so this additive change to `createDevice` is coordinated with the physics thread. All workgroups are 256 threads or fewer.

**Data path.** There is one path for every engine:

1. **Source.** Bodies arrive in the `Body` layout, either physics-owned buffers through `gpuView()` or a CPU snapshot uploaded into renderer-owned buffers of the same layout.
2. **Interpolation copy.** Before every physics step, the renderer copies `bodies` into `prevBodies` (copyBufferToBuffer, 6.4 MB, about 25 µs). Queue order makes it safe.
3. **`bodies.prepare`** runs once per frame, one thread per slot:
   - reads Body, prevBodies and FxState;
   - interpolates the pose with a validity rule;
   - makes it camera-relative;
   - splats it into the AO volume;
   - writes a pose record and segment flags.
4. **Compaction.** One fixed-n scan and a scatter copy 48-byte `RenderRecord`s into six fixed-offset segments: box, tiny box, hero, sphere, box shadow, sphere shadow. A one-thread kernel writes the `drawIndexedIndirect` arguments.
5. **Raster passes** read only renderer-owned memory. Physics buffers are read once per frame, by `prepare` (plus `manifolds`, read-only, in the optional tier 2).
6. **The lattice** is exposed statelessly every frame as a list of exposed faces with exact corner AO. There is no cache and no invalidation protocol.
7. **Uploads.** In steady state with a GPU engine, the only per-frame upload is the FrameUniforms block (≤ 512 B). A writeBuffer/writeTexture spy enforces a ≤ 1 KB per-frame budget, with a separate allowance for spawn frames.

**Art direction.**

- **"Candy Night"** (default):
  - glossy rounded pastel toy-plastic cubes;
  - an OKLab height ramp (orange, yellow, green, cyan, lilac) keyed to each cube's *original* cell, plus a per-tower hue offset, so rubble reads as confetti that shows where it came from;
  - a dark navy studio backdrop;
  - crisp highlight lines on the bevels from two procedural softboxes;
  - layered AO that is never noisy and never temporal;
  - a white-hot ball that acts as a moving light;
  - hundreds of HDR spark streaks per strong impact, flash lights, and a gated heat glow;
  - bloom and the AgX "punchy" look.
- **"Hazy Day"**: the same pipelines with different uniforms, for the slab-and-rod reference.

Estimated GPU time at 2560x1440 on the M5 Max:

| Scenario | Estimate | Budget |
|---|---|---|
| Worst case: 100k awake rubble, all on screen | 2.0-3.5 ms | 4 ms |
| Intact 100k lattice city | 1.3-1.8 ms | 4 ms |

These are estimates. They become numbers only after step 8 (bench) runs on the M5 Max.

## Interfaces needed from physics and the lattice tier

Every item below is a **proposal to the thread that owns it**. Version 1 works without any of them:

- tests use `makeWorldView` and `makeLatticeView`, which build CPU-authored buffers in the same layouts;
- sparks come from the renderer's own Δv detector;
- lattice exposure is stateless.

### engine-api (types only; `PhysicsEngine` stays the only contract)

```ts
// packages/engine-api/src/gpu-view.ts
export interface GpuWorldView {
  device: GPUDevice;
  bodies: GPUBuffer;          // array<Body> (64 B), `capacity` slots; renderer binds read-only-storage
  shapes: GPUBuffer;          // array<Shape> (16 B)
  counts: GPUBuffer;          // array<u32,4>: [bodyCount, awakeCount, 0, 0], GPU-written
  capacity: number;           // fixed at init; lists are allocated once at this size
  version: number;            // bumped when any buffer is reallocated -> renderer rebinds
  slotsStable: true;          // v1 contract: a slot keeps its body for the life of the scene
  ground: { y: number } | null;
  arena: { min: Vec3; max: Vec3 };   // fixed per scene; sizes the shadow ladder and AO volume
  lattice?: LatticeView;
  manifolds?: { buf: GPUBuffer; total: GPUBuffer; ground: GPUBuffer; capacity: number }; // Narrowphase outputs, read-only
  impacts?: ImpactRingView;   // tier-3 proposal, optional
}
export interface PhysicsEngine { gpuView?(): GpuWorldView | null }  // optional; CPU engines omit it
```

**Slot contract.** Slots are stable. A freed slot gets `tier = FREE (255)` in `Body.flags` bits 8-15. A reused slot must have its look rewritten by whoever reuses it. If physics ever needs to permute slots, the contract grows a `slotGeneration: GPUBuffer` (a u32, bumped on each permutation) and a `slotToId: array<u32>`. The renderer would then key `looks`, `FxState` and `prevBodies` by stable id, so physics never permutes renderer state.

**Proposed tier values in `Body.flags` bits 8-15:**

| Value | Tier | Renderer treatment |
|---|---|---|
| 0 | active | drawn |
| 1 | frozen rubble | drawn |
| 2 | lattice proxy | skipped; drawn from bricks |
| 3 | debris | drawn |
| 255 | free | skipped |

### Lattice (proposal to the lattice thread)

```ts
export interface LatticeView {
  bricks: GPUBuffer;        // array<LatticeBrick>, brickCapacity entries; index >= brickCount ignored
  brickCount: GPUBuffer;    // u32
  brickCapacity: number;
  origin: Vec3;             // world centre of cell (0,0,0)
  pitch: number;            // cell spacing (1 + gap)
  cellHalf: Vec3;           // half extents of the cube a cell stands for
  activation: GPUBuffer;    // array<ActivationRecord> per body slot, written by the activation kernel
                            // in the same dispatch that writes the Body; {0xffffffff, 0} if not from lattice
}
```

```text
LatticeBrick   (80 B)  coord: vec3i  (brick units; cell = coord*8 + local)
                       style: u32    (towerId:16 | hueIdx:4 | material:4 | reserved:8)
                       occ0..occ3: vec4u   (512 bits, bit c = x + 8y + 64z)
ActivationRecord (8 B) cell: u32  (x:11 | y:10 | z:11, lattice cell coords)
                       style: u32 (copied from the brick)
```

The lattice thread already writes the Body at activation, so writing `ActivationRecord` alongside it costs it one extra 8-byte store. The renderer turns it into a `BodyLook` with `lookOf(cell, style)`.

That interface is **required** for colour identity once the GPU lattice lands. The renderer has a development-only fallback, "first-sight stamping" from `round(prevPose)`. Its known failure: ball-hit cubes can move more than half a cell in one step. Its error rate is measured, and it is never shipped as the primary path.

The renderer builds its **own dense brick grid** every frame (clear and scatter, 2 dispatches) over `arena / (8*pitch)`, about 32x10x32 = 10k u32 entries. That gives 26-neighbour lookup for corner AO at brick edges and corners without asking the lattice for a lookup structure. Arenas too large for a dense grid fall back to an open-addressing hash at 2x brick capacity.

### Impact events (tier 3, proposal to the physics thread)

```ts
export interface ImpactRingView { events: GPUBuffer /*array<ImpactEvent>*/; head: GPUBuffer /*u32, monotonically increasing*/; capacity: number }
```

```text
ImpactEvent (32 B)  pos: vec3f, strength: f32 (normal impulse, N·s), dir: vec3f (contact normal), packed: u32 (slot:24 | kind:4 | material:4)
```

The renderer reads `[lastHead, head)` modulo capacity and never writes the ring. The same struct is used by the renderer's own tier-1 and tier-2 producers, so all three tiers feed one spawn kernel.

### @tb/gpu (renderer-side, additive)

- **`Scanner` gains a fixed-n mode:** `new Scanner(device, data, capacity, { fixedN: capacity })`.
  - Uniforms are written once, with `mappedAtCreation`.
  - `encodeFixed(pass)` dispatches over capacity and never calls `writeBuffer`.
  - Lists scan over capacity with flags of 0 past `bodyCount`, which costs about 20 µs at 600k elements.
  - Existing `encode(pass, n)` behaviour is unchanged.
- **`createDevice`:**
  - takes `opts.optionalFeatures`;
  - returns `features: Set<GPUFeatureName>`;
  - requests `rg11b10ufloat-renderable` when present;
  - requests `timestamp-query` as today.
- **`GpuProfiler.renderPass(label)`** returns `GPURenderPassTimestampWrites`.

### Renderer-owned schema structs (added in the PR that first uses each)

| Struct | Size | Layout |
|---|---|---|
| `BodyLook` | 4 B, one u32 per slot | bits 0-7 rampT, 8-11 hue-offset index, 12-15 material (0 candy, 1 ball, 2 concrete, 3 chip), 16-31 seed. `lookOf(cell: vec3i, style: u32, rampMinY: f32, rampMaxY: f32) -> u32` is shared in WGSL and TS, with a parity test |
| `RenderRecord` | 48 B (replaces RenderInstance; same size, new meaning) | pos vec3f (camera-relative, interpolated), look u32, rot vec4f (interpolated and normalized), half vec3f, idHeat u32 (slot:24 \| heat:8) |
| `FxState` | 16 B | prevLinVel vec3f, meta u32 (heat f16 in bits 0-15 \| prevTier 16-23 \| valid bit 24) |
| `LatticeFace` | 8 B, vec2u | x = brickIndex:20 \| dir:3; y = cell:9 \| ao0..3 (2 bits each) << 9 |
| `DrawIndexedArgs` | 20 B | indexCount, instanceCount, firstIndex = 0, baseVertex = 0, firstInstance = 0 (no `indirect-first-instance`) |
| `Spark` | 32 B | pos vec3f, age f32 (< 0 means dead), vel vec3f, packed u32 (lifeQ:8 \| seed:24) |
| `Chip` | 48 B | pos vec3f, look u32, rot vec4f, vel vec3f, age f32 |
| `FrameUniforms` | ≤ 512 B | camera-relative viewProj; eyeCell vec3i and eyeFrac vec3f; alpha; dtFrame; time; lightViewProj; lightDir; exposure; the LookParams block; up to 4 ball positions; flags |

Segments start at fixed offsets `s * capacity` in one 6 x capacity x 48 B list buffer (29 MB at 100k), so a segment's base offset is known on the CPU:

- Vertex shaders read `list[SEG_BASE + instance_index]`, with `SEG_BASE` passed as a pipeline-overridable constant.
- In compat mode (`maxStorageBuffersInVertexStage == 0`), the same buffer is bound with `setVertexBuffer(1, lists, SEG_BASE*48)` as an instance-rate vertex buffer, and rot is passed as a flat varying.

### Renderer API

```ts
Renderer.create(ctx: GpuContext, target: RenderTarget /* canvas | offscreen texture */, opts: { tier: Tier; look: LookParams }): Promise<Renderer>
renderer.setSource(src: { kind: 'gpu'; view: GpuWorldView } | { kind: 'snapshot'; source: SnapshotSource }): void
renderer.encodePrevCopy(enc: GPUCommandEncoder): void        // the loop submits this before every engine.step()
renderer.frame(f: { camera: Camera; alpha: number; dtFrame: number; time: number }): void  // encode and submit
renderer.readSummaryAsync(): Promise<FrameSummary | null>   // pooled 64 B mapAsync, 1-2 frames late: impact energy, hot count, sparks alive
SnapshotSource.upload(s: Snapshot, descs: BodyDesc[]): void  // copies into prevBodies then writes bodies (CPU engines only)
makeWorldView(bodies: BodyInit[], opts): GpuWorldView         // test producer, CPU-authored
makeLatticeView(cells: Int32Array, opts): LatticeView         // test producer, CPU-authored
```

## Pass list with estimated cost

Assumptions:

- **M5 Max:** 522 GB/s copy, 0.85 µs per back-to-back dispatch, 8 µs scan and 13 µs compact at 100k, all measured; about 16 TFLOPS, or about 2.4 T useful instructions per second at 30% occupancy, assumed.
- **iGPU, TBDR:** M1/M2 base at 1080p, Low tier.
- **iGPU, IMR:** Iris Xe at 1080p, Low tier, render scale 0.75, 1x MSAA.

All figures are estimates until the step-8 bench runs.

| # | Pass | What | M5 Max, 100k worst | M5 Max, intact city | iGPU TBDR Low | iGPU IMR Low |
|---|---|---|---|---|---|---|
| 0 | prevCopy (per physics step) | `bodies` to `prevBodies`, 6.4 MB | 0.025 per step | same | 0.12 | 0.15 |
| 1 | compute prelude (one compute pass, about 16 dispatches; the volume `clearBuffer` is a separate encoder command before it) | **brickGrid** (clear and scatter). **latticeExpose**: one workgroup per brick loads a 10³ halo through the dense grid, writes a 6-bit exposure mask per cell and 2-bit corner AO, counts camera-facing and light-facing faces per brick; fixed scan; emit into the main and shadow face lists with args. **bodies.prepare**: interpolation, validity rule, camera-relative pose, segment classification (box, tiny box when projected size < 6 px, hero when > 48 px and capped at 1024, sphere, plus box and sphere shadow, tested against frustum planes and the light box), AO splat, pose written to a scratch array. Fixed scan over 6 x capacity; scatter; args. **fx**: Δv detection, workgroup aggregation, event ring, spark and chip spawn and simulation. **volume**: lattice splat, compose to rgba8 3D, sky-column scan, 2 mips | 0.30-0.45 (prepare 0.06, scan and scatter 0.05, lattice 0.05, fx 0.04, volume 0.12-0.2) | 0.20-0.30 | 0.8-1.5 (1 m voxels) | 1.0-2.0 |
| 2 | shadow | Depth-only depth32float: 3072² on High, 4096² on Ultra, 2048² on Low. Fitted to the arena through a discrete size ladder with texel snapping. Casters: hexagon fans of the 3 *light-facing* faces of each box, light-facing lattice faces, spheres. One caster convention and one bias model (below). No fragment stage. storeOp `store` | 0.30-0.50 (600k tris; the real 2x saving over today's `cullMode: 'none'`) | 0.10-0.15 (about 30k faces) | 1.0-1.8 | 1.0-2.0 |
| 3 | main forward pass | 4x MSAA rgba16float colour and depth24plus, both storeOp `discard` (plus TRANSIENT_ATTACHMENT if exposed); resolve to 1x rgba16float. Draw order: ground, lattice faces, box fans, tiny boxes (cheap pipeline), heroes, spheres and ball, sky triangle, then additive sparks, chips (opaque, through the box path), ball trail and shockwave ring with depth test and no depth write. No `discard` or `frag_depth` in any opaque pipeline. Fog evaluated per fragment | opaque 1.0-1.8; additive 0.1-0.25 | 0.6-1.0 | 2.5-4.0 | 3-6 (after bucketing) |
| 4 | dust (later step) | Lit billboards inside the main pass, faded by AO-volume density and ground distance, with no depth texture | 0-0.15 | 0 | off | off |
| 5 | bloom | Render passes: 13-tap Karis downsample, 6 levels from half resolution, tent upsample. rg11b10ufloat if renderable, else rgba16float. loadOp `clear` | 0.20-0.30 | 0.20-0.30 | 0.5-0.8 (4 levels) | 0.5-1.0 |
| 6 | composite | HDR plus bloom, exposure (with the kick), AgX punchy, grade, vignette, ±0.5 LSB blue-noise dither, viewport sub-rect for dynamic resolution, FXAA-lite on the IMR tier | 0.10-0.15 | 0.10-0.15 | 0.25-0.4 | 0.3-0.5 |
| | **Total** | | **2.0-3.5** (budget 4.0) | **1.3-1.8** | **about 6-11** (dynamic resolution holds 10) | **about 6-12** (dynamic resolution holds 10) |

**Main-pass cost breakdown (corrected tiler argument).**

- The current viewer runs 3.6M vertex invocations at 100k, but it already back-face culls (renderer.ts:265). So about 1.2M triangles are assembled, about 0.6M are binned, and the parameter buffer is about 115 MB (about 18 surviving vertices x 64 B x 100k).
- The fan runs 0.7M vertex invocations, assembles and bins 0.6M triangles, and writes about 22 MB of parameter buffer at 32 B of varyings: clip 16, metric local 12, flat record index 4. The fragment shader re-fetches the record from L1.
- So in the main pass the gain is 5x fewer vertex invocations, 2x less primitive assembly and about 5x less parameter-buffer traffic. Binned triangle count is the same as today. Only the shadow pass halves its binned triangles.

**Fragment re-budget.**

- In the far-view worst case cubes are about 6 px across, so each fan triangle covers a few px² and quad helper lanes give about 2-2.5x overshading. MSAA edge pixels add more.
- 3.7 Mpx x 2.25 x about 250 instructions (an average after the shading LOD) is about 2.1 G instructions, or about 0.9 ms. Texture fetches and lights bring this to the 1.0-1.8 ms range.
- That is why the shading LOD is a first-class feature:
  - the **tiny segment** gets its own pipeline: flat normal, no bevel, no clearcoat, one AO tap, one PCF gather, ball light only;
  - an **fwidth fade** inside the standard pipeline removes bevel and clearcoat once they fall under a pixel;
  - the **far-view bench case** (S7-far) measures the result.

**Caster and bias model (one convention).** Bodies and lattice both cast with **light-facing** faces only. Bias is the hardware `depthBias` 2 with `depthBiasSlopeScale` 2, plus a receiver normal offset of 1.5 shadow texels along the geometric normal. Casting front faces keeps a resting cube's bottom face out of the map, so there is no acne or leak at the cube-ground contact. A test checks this.

**Single-queue scheduling.** Each rAF callback runs in this order:

1. `renderer.frame()` submits render work that reads `bodies`, `prevBodies` and `alpha`.
2. Then, for each physics step due, the loop submits `encodePrevCopy` followed by `engine.step()`, with each step in its own submit.

Presentation of frame N therefore never waits on the following 7.5 ms steps. Render latency is at most one in-flight step if the rAF lands mid-step. Overlap between physics and fragment work is **not** assumed. Step 9 measures it.

## Look

**Palette and backdrop (Candy Night).**

- Sky triangle: vertical gradient from zenith #0B1229 to horizon #1C2B57, with a faint radial glow behind the arena centre.
- Floor: matte #111A33, roughness 0.6 with a soft env reflection, a 1 m grid that fades with fwidth and distance, a soft key-light pool, and AO pools under rubble.
- Fog: exponential height fog evaluated **per fragment in the forward pass**, toward the horizon colour. This avoids depth-in-alpha halos, and bloom of fogged highlights is attenuated correctly because fog is applied before bloom.
- The sky uses the same fog function, so the city edge melts into the backdrop.

**Cube material (glossy candy plastic).**

- **Base colour:** `lookOf` evaluates an OKLab ramp over 5 keys keyed to the original cell height: #FF9F5A, #FFD966, #8FE388, #6FD6E8, #B9A3F0. On top of that, a per-tower hue offset of ±12° in 16 steps, chosen from `style`, and a ±4% lightness jitter from the seed.
- **Rubble** keeps its tower colour.
- **Rounded bevel without geometry**, with radius in **metric** body-local units and an explicit bound:

  ```wgsl
  // lp: metric local surface point (local * half), faceN: face normal, pxM: length(fwidth(lp))
  let rMax  = 0.45 * min(half.x, min(half.y, half.z));
  let rWant = max(R_BEVEL /*0.07 m*/, 1.5 * pxM);
  let w     = 1.0 - smoothstep(0.6 * rMax, rMax, rWant);   // fade to a flat face, never invert
  let r     = min(rWant, rMax);
  let nb    = normalize(lp - clamp(lp, -(half - r), half - r)); // exact rounded-box SDF gradient
  let n     = normalize(mix(faceN, nb, w));
  ```

  When `w` reaches 0, the bevel is replaced by a darkened rim term, so distant cubes still read as separate objects.
- **Specular AA:** Kaplanyan geometric specular AA, `alpha² += min(2*(|dpdx n|² + |dpdy n|²), 0.18)`.
- **Specular lobes:** base GGX at roughness 0.30 and F0 0.04, plus a clearcoat lobe at roughness 0.07 and weight 0.35. Clearcoat fades out with fwidth and is off in the tiny pipeline.
- **Environment:** procedural, with no cubemap: the navy gradient, a warm overhead **key softbox** and a cool **rim softbox**, each a smooth rectangle function on the reflection vector. The highlight lines along every bevel are the main "satisfying" cue.
- **Concrete** (material 2, Hazy Day): roughness 0.8, no clearcoat, per-seed albedo noise.

**Lights.**

- **Key:** a warm sun (1.0, 0.95, 0.88) at about 50° elevation, with the arena-ladder shadow and 4x `textureGatherCompare`. That is a 3x3 bilinear tent over 16 texels, counted as 4 fetches, with about 0.12 m of penumbra.
- **Rim:** a cool cyan rim from behind, as a dot product only.
- **Ambient:** wrap-diffuse hemisphere, with cool sky above and warm bounce below.
- **Ball:** a point light of 12 m radius, at most 4 balls.
- **Flash lights:** up to 8, chosen on the GPU. Each event computes a slot from a hash of its 4 m cell modulo 8 and does `atomicMax(strengthQ << 20 | eventIdx)`. Each light decays over about 120 ms.
- The light loop stops early on sphere tests. The Low tier keeps the ball light and 2 flash lights.

**AO (deterministic, no depth store, nothing temporal).**

1. **Lattice corner AO.** Exact Minecraft rule (side1, side2, corner) computed from the 26-neighbour halo, so it does not seam at brick edges. It is interpolated across the face with weight about 0.35, and lattice faces get a dark cavity groove in the outer 20% of the bevel instead of real gaps.
2. **Occupancy volume.**
   - **Grid:** arena-fitted, 0.5 m voxels (1 m on Low), capped at about 5M voxels.
   - **Accumulator:** an `atomic<u32>` buffer in 16.16 fixed point.
   - **Splat rule:** every *unculled* body and every lattice cell is splatted with the **same footprint rule**: an axis-aligned box of equal volume (side `cbrt(8·hx·hy·hz)`) at its centre, with exact separable 1D overlaps per voxel. That is at most 27 atomics for a unit cube. Integer atomics are order-independent, so the result is bit-deterministic. Because the rule is the same, a cube that activates without moving produces an identical splat.
   - **Compose:** a kernel writes an rgba8unorm 3D storage texture (core storage format). R holds occupancy. G holds **sky visibility** from a per-column top-down scan, `exp(-k·Σocc above)`.
   - **Mips:** 2 box-filtered mips (1 m, 2 m; 2 m and 4 m on Low).
3. **Fragment taps:**
   - t0 at `p + 0.3n` (mip 0), t1 at `p + 0.9n` (mip 1), t2 at `p + 2.0n` (mip 2);
   - `ao = Π(1 - kᵢ·max(0, occᵢ - ownᵢ))`;
   - the sky term G is read at `p + 0.5n + 0.5up` and modulates sky ambient.
4. **Own-body subtraction (fixes self-occlusion).** A box-filtered mip of overlap fractions is the overlap fraction at that mip's voxel size, and both the trilinear weights and the overlaps are separable. So the body's own contribution at a tap is exact and cheap: `own = Π_axis (w0·o0 + w1·o1)`, where `o` is the 1D overlap of the fragment's own equal-volume box with the two voxels on that axis. That is about 30 ALU per tap, and it works the same for lattice faces from the cell centre.
5. **Seam-only cavity (from the perf design).** One mip-0 tap at the edge point, offset 0.25 m along the bevel normal, minus own. It darkens bevel bands only when a neighbour is across the edge, so seams go dark while silhouette edges stay bright.
6. **Ground contact darkening** stays as it is now.

**Bloom and tonemap.** No threshold: an energy-conserving 4% mix plus emissives above 1, so glossy glints glow softly while the ball and sparks bloom hard. Then AgX "punchy", vignette and blue-noise dither.

**Ball.** An HDR emissive core at 12-20 with a Fresnel rim, its point light, and a 32-sample additive ribbon trail.

**Sparks.**

- **Count and brightness:** 200-800 per strong event, scaled by strength and clamped by the per-frame budget. HDR 8-20, cooling from a white core to warm amber over a 0.4-1.2 s life.
- **Motion:** spawned in a hemisphere around the event normal at 6-22 m/s, with gravity, quadratic drag, ground bounce at 0.38, and ricochet off rubble using the AO-volume gradient as the normal where density is above 0.5.
- **Drawing:** clip-space streaks from `p` to `p - v/45 s`, a constant 1.5 px wide with tapered ends and alpha scaled by sub-pixel coverage, so they do not alias without TAA. Additive, depth-tested, alpha write-masked.
- **Pool:** a 64k-slot ring with atomic allocation where the oldest slot is overwritten. Every slot is always drawn, and dead slots become degenerate in the vertex shader, so cost is constant.

**Impact feedback, with gating so a collapse does not wash out white.**

- **Heat** (one f16 in FxState):
  - Sources are only (a) bodies within the ball's radius plus 0.6 m, or in a manifold with the ball, and (b) Δv above 6 m/s.
  - Heat uses `max` and is never additive. It saturates at 1 and decays with τ = 0.25 s.
  - Emissive is `heat · mix(white·6, palette·3)`, and the white core only appears above heat 0.8.
  - A global gain of `1 / max(1, hotCountPrev/2000)` comes from the previous frame's atomic count, so at most about 2000 cubes glow at full strength.
- **Chips:** 0.12-0.2 m micro-cubes in the hit cube's colour, drawn through the box path from the `Chip` pool (8k). They shrink out over 4 s.
- **Dust** (later step): low-alpha lit puffs on hard ground hits, faded by volume density, so there is no depth texture.
- **Shockwave and exposure kick:** a floor shockwave ring decal (one quad) and a one-frame exposure kick on the first strong ball hit of each shot.

**Camera and feel (game layer, fed by `readSummaryAsync`).**

- **Shake:** trauma-based, with trauma² and a 0.4 s decay, scaled by impact energy and distance.
- **FOV kick:** +2.5° on launch.
- **Hit-stop:** 0-60 ms, **scaled by energy**, only on the first strong contact of a shot, with a 2 s cooldown.
- **Slow motion:** an eased 0.2x-to-1x ramp over 1.2 s, made by running **fewer 60 Hz steps** (dt is never changed) and rendered smoothly by interpolation. It doubles as load shedding during the most expensive collapse frames.
- **Chase cam:** optional; it follows the ball, then orbits to reframe on the collapse.
- **Audio and haptics:** the same summary readback feeds them (pitch and volume by strength and material).
- **Instant replay:** the bench's Body-trajectory recorder doubles as an instant replay. That is game-layer work, after the renderer gates.

**Hero LOD.** Cubes above 48 px projected size (capped at 1024) are drawn as a real rounded mesh: 3-segment bevels, about 200 triangles, so the worst case is about 200k triangles. Their shading uses the same normal function, so there is no pop at the switch.

**Hazy Day preset (uniforms only).** Pale sky (0.80, 0.86, 0.94), dense height fog with HG sun in-scatter computed per fragment, a warm sun, a desaturated ramp or the concrete material, and lower bloom.

## Novel cube-specific tricks: adopted and rejected

**Adopted**

1. **7-vertex hexagon fan.** For every box, `s = sign(qrotInv(rot, -pos_camrel))`, and the fan is built around the near corner `N = s·half`:
   - `RING = (1,1,-1), (-1,1,-1), (-1,1,1), (-1,-1,1), (1,-1,1), (1,-1,-1)`;
   - `local = s · select(RING[max(vi,1)-1], vec3f(1), vi == 0) · half`;
   - u16 index buffer: `0,1,2, 0,2,3, 0,3,4, 0,4,5, 0,5,6, 0,6,1`;
   - `cullMode: 'none'`, because winding flips with the parity of `s`.

   Each triangle shares a coordinate with N, so it lies in one face and depth is exact. It works for slabs and rods. The shadow pass uses the same fan with the light direction. It is A/B tested against 18-vertex non-indexed fans, because vertex reuse by Apple's tiler for small instanced draws is undocumented.
2. **Record compaction into fixed-offset segments with one fixed-n scan.** It gives deterministic order, so cull tests are exact equality checks. Raster passes never read physics buffers. Segment bases are known on the CPU, which also makes the compat fallback simple.
3. **Interpolation inside the cull kernel, not the vertex shader.**
   - Culling, AO splat, shadow and draw all see the same pose.
   - Validity rule: interpolate only if prev and current have the same tier and shape, the prev quaternion has length² above 0.5, and `|Δpos| < vMax·dt + 1 m`. Otherwise use the current pose.
   - It handles spawn, activation and slot reuse without per-slot state.
4. **Exact camera-relative lattice positions:** `(brick.coord*8 + cell - eyeCell)` in i32, then the fractional part in f32. Bodies are made camera-relative in `prepare`.
5. **Stateless per-frame lattice exposure** with a renderer-built dense brick grid and a 26-neighbour halo, giving exact corner AO. There is no epoch, no cache and no cross-thread invalidation protocol. The judges were right that the epoch gate could not gate the scan anyway.
6. **Equal-volume footprint splat** shared by bodies and lattice cells, with **exact own-body subtraction** through separable overlaps. It fixes AO self-occlusion in all three designs and makes AO invariant at activation.
7. **Sky-visibility column scan** in the volume's G channel: tower bases and pile interiors darken for one dispatch.
8. **Seam-only cavity:** a neighbour-aware edge darkening read from the volume.
9. **Projected-size shading LOD as separate pipelines** (tiny, standard, hero), plus a derivative fade inside the standard one. This is the main mitigation for micro-triangle overshading.
10. **Bounded metric bevel radius:** fwidth widening is capped at 0.45·min(half) with a fade to flat, so normals never invert.
11. **Workgroup-aggregated impact events** (below), with caps and a per-frame spark budget.
12. **GPU top-K flash lights** via `atomicMax` slots.
13. **Constant-pixel-width coverage-alpha streaks.**
14. **Arena-fitted shadow through a size ladder with texel snapping.** Size steps by √2 with hysteresis on the CPU, using the camera frustum intersected with the arena. That keeps shadows stable and still tightens them when the action is small. There is no GPU readback.
15. **TBDR hygiene enforced by tests:**
    - a WGSL lint rejects `discard` and `frag_depth` in opaque entry points;
    - a pipeline lint requires MSAA storeOp `discard` with a resolve target and forbids loadOp `load` in the main pass;
    - culled lattice faces become degenerate in the vertex shader.

**Impact pipeline (tiers 1 to 3 feed one spawn kernel).**

- **Tier 1 (v1):**
  - `dv = v - FxState.prevLinVel - g·dtFrame`, measured over the whole frame, so impacts in either step of a 2-step frame are caught.
  - A candidate needs `|dv| > max(2.5, 3·g·dtFrame)` m/s, `valid == 1` and `tier == prevTier`. New and activated slots set `valid = 0` for one frame.
  - Each workgroup of 256 bodies keeps its top 2 candidates by `atomicMax` on quantized strength and lane in workgroup memory, and sums its energy. It then performs one atomicAdd on the ring head and one on the frame energy.
  - At 100k that is at most 782 events per frame, against a ring cap of 2048.
  - Sparks per event are `min(800, k·strength)`, allocated from a per-frame budget of 8192 (2048 on Low) with an atomic clamp. Over budget, the event is skipped.
- **Tier 2 (optional):** a kernel over `Narrowphase.manifolds` with `count > 0` re-places events of flagged bodies at the deepest contact point, using the manifold normal, read-only.
- **Tier 3:** the physics `ImpactRing`, if the physics thread accepts it.

**Rejected**

- **Velocity extrapolation:** it interpenetrates and snaps at exactly the frames people watch, up to about 0.3 m at 40 m/s, and gets worse in slow motion. Interpolation costs about 25 µs per step.
- **Epoch-gated cached lattice mesher:** a cross-thread invalidation protocol, a missed bump leaves stale geometry that persists, and the scan was never gated. The stateless version costs about 50 µs.
- **Linear depth in HDR alpha:** the MSAA resolve averages depth at silhouettes, which gives fog and dust halos. Fog moved into the forward pass and dust uses volume fade.
- **rg11b10ufloat main HDR target:** blue has a 5-bit mantissa, which bands the navy gradient before dither. Kept for bloom only.
- **GPU-fitted caster-AABB shadow:** it swims every frame, and 6 global atomics from 100k threads contend.
- **Back-face (light-away) shadow casting:** contact acne and leaks for resting cubes, and it is inconsistent with lattice faces.
- **First-sight look stamping as the primary path:** wrong cell for ball-hit cubes. Kept as a development-only fallback, with its error measured.
- **Atomic-append draw lists:** nondeterministic order, and the saving is only about 10 µs.
- **4-triangle silhouette hexagon for tiny cubes:** its depth cuts through the cube interior (up to 0.58 m of error), so contacts in piles would pop. Revisit only if the far-view bench is tiler-bound.
- **Ray-cast or SDF impostors:** they need `frag_depth`, which disables Apple HSR.
- **Greedy lattice meshing:** it loses per-cube seed, colour and bevel, and the exposed-face count (about 54k) is already small.
- **Heat on every Δv:** it washes the pile white. Gated as described above.
- **Assuming overlap between physics and fragment work:** Dawn's hazard tracking on one queue probably serializes them. Measured in step 9 and never budgeted.

## Step plan

Each step is one small PR, merged after `pnpm check`. Structs land with the step that first uses them. "M5" marks a measurement recorded in docs/benchmarks from headed Chrome on the M5 Max. SwiftShader timings are never used as performance results.

1. **@tb/gpu: `Scanner` fixed-n mode and optional features in `createDevice`.** Coordinate the feature change with the physics thread; it is additive.
   - Test: a writeBuffer spy records 0 calls across 100 `encodeFixed` runs.
   - Test: results equal `encode(n)` on fast-check arrays.
   - Test: `features` reports what was granted; SwiftShader runs without `rg11b10ufloat-renderable`.
2. **Extract `@tb/render`.** `Renderer.create(ctx, target)` on the shared device; frame graph with declared reads and writes plus toggles; `GpuProfiler.renderPass`; the viewer uses the new package with identical output.
   - Test: existing viewer e2e and pixelStats unchanged.
   - Test: the graph rejects an undeclared read or a texture missing a required usage.
   - Test: disabling a pass removes its commands and timestamps.
3. **Test infrastructure.**
   - Add an r32uint ID target (1x), `renderOffscreen(world, camera) -> {color, ids}` in testkit, and a CPU raycaster for boxes, spheres and the ground.
   - Add the opaque WGSL lint and the pipeline-descriptor lint.
   - Add the writeBuffer/writeTexture spy with a byte budget.
   - Test: 20 rotated boxes and 1 sphere; 64 probes at least 2 px from any edge match the raycast IDs exactly.
   - Test: the lints pass on today's pipelines, and an injected `discard` fails.
4. **Snapshot path and looks.** `BodyLook` and `lookOf` (WGSL and TS), `SnapshotSource` writing the Body layout plus a Shape table, which replaces `packInstances`, and the `GpuWorldView` and `LatticeView` types in engine-api. Send the interface proposals (`ActivationRecord`, tiers, slot contract, ImpactRing) to the physics and lattice threads.
   - Test: `readStruct` round-trip equals the snapshot.
   - Test: GPU `lookOf` over 4096 cells equals the TS version bit for bit.
   - Test: ID probes from step 3 still match for Rapier and physics-ref.
5. **`bodies.prepare`, scan and scatter into the six segments, and args.** Includes the `prevBodies` copy before each step and the validity rule. Drawing still uses the 36-vertex path, now from records with `drawIndexedIndirect`.
   - Test: fast-check worlds (tier-lattice and free slots, spheres, frustum edges, invalid prev, teleports) give read-back lists equal to a TS reference element by element; `instanceCount` matches.
   - Test: the ID image with culling equals the ID image without.
   - Test: renders at alpha 0 and 1 equal the prev and current renders; at alpha 0.5 the pixel centroid is halfway, ±1 px.
   - Test: `makeWorldView` drives the same path.
6. **Hexagon fan for main and shadow, front-face casting.** The 36-vertex path stays behind a debug flag.
   - Test: ID images differ in at most 0.1% of pixels from the 36-vertex path over 50 random cameras, including eyes inside a slab, slabs and rods.
   - Test: shadow-map depth readback matches the 36-vertex `cullMode: 'none'` map within 1e-5, excluding rasterization edges.
7. **HDR main pass.** rgba16float 4x MSAA with `discard`, resolve; composite with AgX and dither; `LookParams` presets.
   - Test: GPU AgX over an HDR strip matches the TS mirror within 1/255.
   - Test: golden at 256x160 with mean absolute error under 1.5/255 and under 0.5% of pixels off by more than 8/255.
   - Test: the lint confirms storeOp `discard`.
8. **`pnpm bench:render`.**
   - Frozen synthetic worlds: S7-near (100k rubble), S7-far (100k cubes at about 6 px), S4 (100k lattice city, from step 11 on), and a 50/50 mix, at 2560x1440 over 300 frames.
   - Reports whole-frame GPU p50 and p95, per-pass timestamps (direction only), and per-pass marginal cost from toggles.
   - A/B: indexed 7-vertex fan vs 18-vertex non-indexed; 36-vertex vs fan.
   - Test: SwiftShader completes and emits the schema; numbers are discarded.
   - **M5:** first real numbers, and Instruments Metal System Trace shows whether the MSAA attachments are memoryless. From here on each step re-runs the bench and records the deltas.
9. **Scheduling probe.** A synthetic compute kernel calibrated to 7.5 ms on the M5 Max stands in for physics, 2 per frame. Compare render-first ordering with the alternative.
   - Test (unit): the loop orders submits render, then (prevCopy, step) times k.
   - **M5:** rAF-to-present intervals, p99 frame time, and whether any physics/fragment overlap happens. Decide the frame-pacing policy.
10. **Material.** Bounded metric bevel, 2-lobe GGX, key and rim softboxes, Kaplanyan AA, fwidth fade and tiny pipeline, OKLab ramp with tower hue, forward fog with HG.
    - Test: WGSL functions in a compute harness against a TS twin. The normal has unit length, equals faceN at face centres, is continuous along edges, and is never inverted for pixel footprints up to 10x half.
    - Test: shimmer under a 0.5 px jitter of a 10k-cube far wall changes mean luma by less than 2%.
    - Test: goldens for both presets.
    - **M5:** S7-far main-pass cost with and without the tiny pipeline.
11. **Lattice.** `LatticeBrick`, `LatticeFace`, `makeLatticeView`, dense brick grid, stateless exposure with corner AO, scan and emit, lattice draw and shadow faces.
    - Test: fast-check lattices, including brick edges and corners and missing neighbours: face lists and AO bits equal the TS reference exactly.
    - Test: the same tower drawn as lattice and as bodies gives the same per-cell IDs at the probes.
    - Test: a row of pixels across a brick boundary shows no AO step above 2 LSB.
    - Test: S10 at (5000, 0, 5000) renders the same as S1, translated.
12. **Arena-ladder shadow** with texel snapping, 4-gather PCF and the single bias model.
    - Test: a floating cube's shadow lands at the analytic position.
    - Test: variance on a lit flat face is under 1 LSB (no acne).
    - Test: a ring around a resting cube's contact is darker than open ground, and the face directly under it shows no light leak.
    - Test: the shadow map is bit-identical across a small orbit, and the ladder steps at most once over a 90° orbit.
13. **Occupancy volume and AO.** Footprint splat for bodies and lattice, compose, sky column, mips, taps with own subtraction, seam cavity.
    - Test: the read-back integer grid equals the CPU splat exactly.
    - Test: AO on every face and edge of an isolated cube is at least 0.97 (the self-occlusion test).
    - Test: the centre cube of a 5x5x5 heap is at most 0.6; the floor beside a tower is darker than the floor 10 m away.
    - Test: the same cube as a lattice cell and as a body gives an identical volume and AO pixels within 1 LSB.
    - Test: with the pass disabled, output equals the step-12 golden.
    - **M5:** volume cost.
14. **Bloom.**
    - Test: a single HDR pixel of energy E gives a radially monotone response with total energy within 5% of E times the mix; no NaN or Inf in any mip.
15. **FX core.** `FxState`, tier-1 Δv detector with guards and workgroup aggregation, `ImpactEvent` ring, `Spark` pool, streak pipeline, ground and volume collision.
    - Test: an injected Δv gives the expected burst count; the simulation matches a TS reference for 120 steps within 1e-4.
    - Test: no spawns for new, activated or reused slots.
    - Test: a synthetic 100k-body flood stays at or under 782 events and 8192 sparks per frame, with canary words intact.
    - Test: streaks appear in the expected region and nothing shows through an occluding cube.
16. **Ball material, ball lights, trail, top-K flash lights.**
    - Test: a cube 2 m from the ball is brighter with the light on and a cube 20 m away is unchanged.
    - Test: the top-K kernel matches the CPU slot rule.
    - Test: the trail readback is in order.
17. **Gated heat glow.**
    - Test: a scripted S5 ball impact (physics-ref, small N) gives heat above 0 within 2 frames for ball-contact bodies and 0 for a resting tower 20 m away.
    - Test: a recorded S7 collapse keeps the fraction of pixels above luminance 4 under 3% after 0.5 s (no white washout).
18. **Tier-2 manifold placement** (read-only `Narrowphase.manifolds`).
    - Test: a box dropped on the ground spawns events within 0.05 m of the analytic contact points.
19. **Chips, dust, shockwave ring, exposure kick.**
    - Test: chips go through the box path, and their ID probes match the raycaster.
    - Test: a dust puff behind an opaque cube adds 0 over the cube's pixels; a puff intersecting the floor fades with no hard line (gradient check).
20. **Hero LOD.**
    - Test: close-up silhouettes are under 1 px mean error against a compute raymarch of the rounded box.
    - Test: a diff across the 48 px threshold stays under 6 LSB.
21. **Quality tiers, IMR path and dynamic resolution.**
    - Tiers: Ultra, High, Low.
    - IMR path: 4 distance-bucket segments drawn near to far, a lattice-face depth prepass, 1x MSAA plus FXAA-lite, reduced lights.
    - Dynamic resolution: viewport into max-size targets with a hysteresis controller on whole-frame GPU time.
    - Test: the controller unit test on synthetic traces converges with no oscillation above 5%.
    - Test: every tier renders on SwiftShader with zero validation errors and matches its golden.
    - **Measured on M2 base and Iris Xe:** Low tier at most 10 ms render at 100k with dynamic resolution, at most 5 ms at 20k.
22. **GPU physics hookup**, scheduled only once a GPU `PhysicsEngine` exists. physics-gpu implements `gpuView()`, and the viewer stops calling `snapshot()` for engines that have it.
    - Test: the spy shows at most 1 KB per frame in steady state.
    - Test: the same state through `SnapshotSource` and through `GpuWorldView` gives identical ID images and colour within 1 LSB.
    - **M5 gate:** total render at most 4 ms p95 at 2560x1440 for 100k all awake. If it misses, revise the pass budget before adding features.
23. **Game feel** (game layer): energy-scaled hit-stop with cooldown, slow-motion curve, shake, FOV kick, chase cam, audio and haptics from `readSummaryAsync`.
    - Test: unit tests for the timescale curve (0 to 60 ms scaled by energy, back to 1 by 1.26 s; cooldown respected) and the shake decay.
    - Test: e2e firing a ball shows sim speed dip and recover while the frame counter keeps increasing.
24. **Optional, only if measurements justify it:** a static lattice shadow cache, a GTAO Ultra add-on, a 0.25 m clipmap near the camera.
    - Test: each is A/B'd with bench:render using @tb/metrics bootstrap confidence intervals, and kept only on a significant win with pixel equivalence within tolerance.

## Alternatives considered and rejected

- **three.js r186 WebGPURenderer (the plan's choice):**
  - buffer sharing through undocumented internals, pinned to one version;
  - no control of discard and resolve attachments or of indirect draws from GPU arguments;
  - TSL compiles at runtime, which causes hitches and produces shaders we cannot diff;
  - node-system CPU overhead, and none of its scene graph would be used;
  - per-pass timestamps and pass toggles would fight the engine.
- **Babylon.js or PlayCanvas:** the same ownership problems, and heavier.
- **Deferred G-buffer:** WebGPU has no subpasses, tile shaders or framebuffer fetch, so the G-buffer round-trips memory and breaks the single tile pass.
- **Visibility buffer on Apple:** HSR already shades about one fragment per pixel, and antialiasing would need TAA or a stored MSAA r32uint target. It stays an option for IMR, using analytic ray-box reconstruction from the cube id.
- **Half-resolution GTAO or SSAO as the default:** it needs stored depth and normals or a prepass, it is noisy and temporal, and it cannot see off-screen occluders. It is an optional Ultra add-on only if the volume AO falls short.
- **TAA or TAAU:** ghosting on fast debris and on thin streaks, the moments that should look crisp. 4x MSAA is cheap on TBDR.
- **Hi-Z two-phase occlusion culling:** depth is discarded, core WebGPU cannot resolve MSAA depth, HSR already removes the overdraw cost, and the lattice exposure removes buried cubes exactly.
- **Cascaded shadow maps:** the arena is bounded. A single ladder-fitted map gives about 3-5 cm texels.
- **Cubemap IBL:** needs assets and a prefilter pass. The procedural softboxes are deterministic and free.
- **Planar floor reflections:** about 1 ms for a second scene pass. AO pools ground the rubble for much less.
- **Multi-draw-indirect or mesh shaders:** not in core WebGPU.
- **CPU culling, CPU light fitting, or CPU snapshot plus writeBuffer for GPU engines:** a readback stall and 6.4 MB per frame, which violates the zero-upload goal.
- **A RenderInstance repack done by physics:** a second layout to keep in sync, and an extra copy per step.
- **A GPU caster-AABB shadow fit, velocity extrapolation, linear depth in alpha, a cached epoch-gated mesher, and an rg11b10 main target:** rejected for the reasons in the previous section.

## Open risks and how each is measured early

| Risk | Early measurement | Fallback |
|---|---|---|
| Fragment cost of micro-triangles (quad overshading about 2-2.5x on 6 px cubes) breaks the main-pass budget | Step 8 S7-far on M5; toggle deltas for the tiny pipeline (step 10) | Lower the tiny-segment threshold, cut lights further, dynamic resolution |
| Apple tiler does not reuse vertices in small instanced indexed draws | Step 8 A/B: 7-vertex indexed vs 18-vertex non-indexed vs one non-instanced pulled draw | Ship the faster one; even 18 vertices is half of today |
| Single queue serializes physics and render; 7.5 ms submits disturb frame pacing | Step 9 busy-kernel probe on M5: present intervals and p99 | Render-first ordering, per-step submits, slow-motion load shedding, an adaptive physics rate |
| MSAA attachments not memoryless on Dawn Metal (about 177 MB at 1440p) | Step 8 Instruments Metal System Trace | Accept the memory (the bandwidth is still discarded), or MSAA 2x on memory-tight devices |
| Per-pass TBDR timestamps overlap and distort | All gates use whole-frame time plus toggle deltas on frozen worlds | n/a |
| Volume AO looks blobby, or leaks through thin slabs and rods | Step 13 pixel tests plus an S8 slab-and-rod golden reviewed by eye | 0.25 m near-camera clipmap, or the GTAO Ultra add-on (step 24) |
| Volume cost above 0.2 ms (atomic contention in dense piles) | Step 13 M5 timing on S7-near | Coarser voxels, workgroup-local pre-accumulation per 8³ region, a static lattice layer cached by brick count |
| Cross-thread interfaces (`ActivationRecord`, tiers, slot stability, ImpactRing) are not accepted | Proposals sent in step 4; tests run on `makeWorldView` and `makeLatticeView` | Development-only stamping (error rate logged), the renderer's own Δv events, stable-id indirection if slots get permuted |
| Δv false positives or event floods in collapses | Step 15 flood test plus a recorded S7 histogram of events per frame | Thresholds in `LookParams`, tier-2 placement, tier-3 ring |
| Heat or bloom washes out the pastel read | Step 17 hot-pixel fraction under 3% on S7 | Lower the global gain cap, a stricter source rule |
| Interpolation lag (up to one step) or validity-rule misfires (pops) | Step 5 tests; step 9 latency measurement | Alpha clamp; a per-slot spawn generation if the teleport guard misses |
| SwiftShader goldens drift across Chromium versions | Goldens are few, loose and keyed by adapter and version; correctness rests on ID probes and exact list readbacks | n/a |
| Optional device features need physics coordination | Step 1 reports granted features; rgba16float bloom fallback tested on SwiftShader | n/a |
| Integrated GPUs (no HSR on IMR) are overdraw-bound | Step 21 measured on M2 base and Iris Xe | Distance buckets, lattice depth prepass, 1x MSAA, dynamic resolution, a lower supported N |
| Precision far from the origin | Step 11 S10 equivalence test | n/a |
| Headless numbers omit the compositor | Gates run headed with a presenting canvas on M5 | n/a |

## Appendix: how each mustFix item is resolved

- **Fragment re-budget:** main pass planned at 1.0-1.8 ms; tiny pipeline and fwidth LOD are first-class; S7-far bench case.
- **Tiler argument corrected:** main pass saves vertex invocations, assembly and parameter-buffer traffic (about 115 to 22 MB); the binning saving applies to shadow only.
- **Scanner:** fixed-n mode with uniforms written once; the spy enforces a byte budget; one scan over concatenated segments.
- **Device features:** requested in `createDevice` when available, coordinated with physics; rgba16float fallback tested.
- **Single-queue scheduling:** render-first ordering, per-step submits, step-9 probe; overlap never budgeted.
- **IMR overdraw:** distance buckets plus lattice depth prepass.
- **Depth in alpha:** removed; fog is forward, dust fades by volume; sparks and dust are alpha write-masked.
- **Shadow fit:** arena ladder with texel snapping; no GPU AABB fit.
- **Lattice corner AO at brick edges and corners:** 26-neighbour halo through the dense grid.
- **AO splat coverage:** splat from all bodies, not the culled lists; footprint-weighted; own-body subtraction; identical rule for lattice and bodies.
- **Interpolation:** in v1, with a validity rule; extrapolation rejected.
- **Impact floods:** workgroup aggregation, event and spark caps, guards for tier change and new slots.
- **Packing:** `RenderRecord` is 48 B with a full 32-bit look; raster passes never read physics buffers.
- **Heat:** gated, with a global cap.
- **Bevel:** bounded and in metric units.
- **Main HDR target:** rgba16float; rg11b10 only for bloom.
- **Satisfaction layer:** flash lights, chips, dust, hero LOD, energy-scaled hit-stop with cooldown, audio and haptics hook.
- **Viewer `snapshot()` and `Renderer.create` device:** fixed in steps 2 and 22.
- **Slot stability:** contract plus stable-id indirection.
- **Shadow caster convention:** light-facing faces for bodies and lattice, one bias model.
- **Cross-thread hooks:** proposals only; v1 does not depend on them.
- **gpuView integration:** scheduled after a GPU `PhysicsEngine` exists.
- **Schema structs:** added per step, not all up front.