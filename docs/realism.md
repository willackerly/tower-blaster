# Photoreal look (`real`)

Design doc with costs and alternatives: https://claude.ai/artifact/DtEnSG7b8KVNRcYfZ8L78u
(thread "Make the world look photoreal", 2026-10-26). This file records the
rules the code follows; the doc has the reasoning.

## Rules

- `real` is a look preset (`LOOKS.real`, `?look=real`), not a fork of the renderer.
- **Existing looks stay bit-identical.** `render.test.ts` pins FNV hashes of
  `candy` and `hazy` frames (`test/golden/looks.json`, per platform key). Realism
  code lives in a second build of the scene shader (`sceneWgsl(true)`) whose
  pipelines only looks with an `atmosphere` use, and its resources live in
  their own bind group (group 1). Changing a pinned hash takes
  `UPDATE_GOLDEN=1 pnpm test packages/render/test/render.test.ts -t golden`
  and a reason in the commit message.
- **Cost target** (M5 Max, 2560x1440, `pnpm bench:render`, GPU p50): `real`
  at most 3 ms a frame at 10k cubes and 4 ms at 100k, in every bench world.
  Until step 4 the target was a delta (+0.5 ms over `candy` at 10k, +1.0 ms
  at 100k); step 4 crossed it at near 10k (+0.635 ms, real 1.69 ms against a
  120 Hz frame of 8.3 ms), and a cap on what the frame costs is the number
  the game feels. Every expensive feature still gets a paired bench variant
  that switches it off, and its delta is reported.
- **No downloaded assets.** Materials are baked on the GPU at startup into
  texture arrays; the arrays can take CC0 scans later without shader changes.
- Each physical model has a CPU twin compared with the GPU result in tests.
- **Knobs, not constants.** Every choice a scene might change (sun, haze,
  ground, exposure, materials) is a `RealOptions` field with a default in
  `REAL_DEFAULTS`, reachable from URL params and the viewer's Scene panel.
- No stylized effects: `real` sets `effects: false` (no sparks, ball trail,
  heat glow or point lights); impact dust replaces them in step 6.

## What step 1 built

- `atmosphere.ts`: Hillaire 2020 LUTs (transmittance 256x64, multiple
  scattering 32x32, sky view 192x108, all rgba16float). Transmittance and
  multiple scattering rerun only when haze or ground albedo change; the sky
  view and the ambient pass run every frame (they follow the sun and eye
  height). Geometry is written in heights (r^2 - Rg^2 = h(2Rg + h)) so f32
  keeps its precision 2 m above the ground.
- Aerial perspective reads the sky view LUT along the view ray and scales its
  in-scattering by the optical depth covered; the sky disc is limb-darkened.
- Ambient until step 2: the cosine-weighted mean sky radiance and the
  ground's radiance (csAmbient, one workgroup, fixed summation order).
- Exposure adapts (`autoExposure`, 0 to 1, default 0.75) to an incident-light
  dome reading: sun / 4 + (sky + ground) / 2. csAmbient computes it and the
  frame copies it into the post uniform on the GPU timeline, so no readback.
  `ADAPT_REF` is the reading at the default sun, so the default exposure
  holds there.

## What step 3 built

- `noise.ts`: periodic integer-hash noise (pcg3d), gradient noise, fbm and
  worley cells, each with a WGSL twin; a period in cells makes every texture
  tile exactly.
- `materials.ts`: four stones (`limestone`, `sandstone`, `granite`,
  `concrete`) baked once per renderer on the GPU (csBake, csDown) into two
  512x512 rgba8 texture arrays with 10 box-filtered mips: detail (albedo
  multiplier, roughness) and normal (tangent normal, cavity). `stoneSample`
  is the CPU twin the bake is compared with. About 11 MB of GPU memory with mips.
- Shading (`REAL_FS_BOX`, the real build only): each face samples the arrays
  at its body-local position divided by `stoneScale`, plus a per-body hash offset
  and quarter turn, so no two blocks show the same patch. Each block takes
  one colour of the stone's palette. Normal mips that average out shorten
  the normal, and Toksvig widens roughness by that amount, so far faces lose
  bump as roughness instead of shimmering. Edge wear lightens and roughens
  the outer 1 to 4 cm of each edge; dirt darkens faces below 2.5 m.
- Material level of detail. On the M5 Max the stone code cost the scene
  pass 0.2 to 0.9 ms even when a uniform branch skipped it, twice what the
  samples themselves cost (bench variants `real-stone-off`, `real-step1`):
  its registers lower occupancy for the whole shader. So the stone fades
  out by pixel footprint (`stoneFade`, default 8 cm per pixel, from half
  that), and the cull pass lists boxes whose bounding sphere lies wholly
  past `stoneLodDepth` in `boxFar`, drawn by the same shader with the stone
  compiled out (`REAL_STONE` false). Past that depth every pixel covers at
  least the fade-out (lod.test.ts checks the bound on random cameras and
  surfaces), so both pipelines compute the same colour and there is no
  seam to see (render.test.ts: within 2 of 255). `stoneDetail` 0 sends
  every box to `boxFar`. `real-no-lod` measures what the split saves.

## What step 4 built

- Ground materials in the same arrays as the stones, after them:
  `gravel` (rounded stones of three sizes, 1 to 10 cm, and mixed tone in a
  dirt matrix, denser in metre-scale clumps) and `dirt` (packed earth, drying cracks in clumps, a
  few small stones), each tiling every `GROUND_TILE` (2 m) at 3.9 mm a
  texel, and a macro layer (`MACRO_TILE`, 64 m) of low-frequency
  brightness, tint and blend fields. The grounds keep the configured
  `groundAlbedo` on average (mean multipliers within 5% of 1, tested on the
  CPU and on the bake). The bake writes heights once into an r32float array
  and takes normals from it, instead of evaluating each texel's material
  five times.
- Shading (`groundAt`, the real build's `fsGround`): the ground at two
  scales, the second 2.71x coarser and turned 0.6 rad so their repeats
  never line up, blended by the macro layer, which also varies brightness
  and tint over tens of metres (`groundVariation`). Four material fetches
  and one macro fetch per floor pixel; Toksvig widens roughness where mips
  and the blend average bumps away; cavity darkens the ambient light.
- Past the floor polygon's reach (600 m), `fsSky` shades the ground with
  the texture's mean (its 1x1 level) under the same macro variation, so the
  cut does not show (render.test.ts measures it).
- Hills on the horizon (`hillsAt`, in `fsSky`): a ridge `hills` degrees high
  at most (default 1.5), `hillDistance` km away (default 6), its profile a
  sum of sines in azimuth so it closes on itself. Slopes face the eye and
  turn sideways with the profile's slope, so a low sun picks out folds; lit
  by the sun and the ambient light in the floor's albedo, and are seen
  through that much air, so far hills fade into the haze. Where the floor
  reaches past the hills' distance, the hills hide it.
- Knobs: `groundMaterial`, `groundDetail` (0: the flat floor, nothing
  sampled), `groundScale`, `groundVariation`, `hills` (0: none),
  `hillDistance`. Bench variant `real-flat-ground` compiles the ground
  material and the hills out (`REAL_GROUND`).
- Cost on the M5 Max (`real` minus `real-flat-ground`, GPU p50): +0.139 ms
  near 10k, +0.106 ms near 100k, +0.032 ms far 100k. `real` itself: 1.69,
  2.79 and 2.31 ms.
- Rejected: hex tiling (Mikkelsen 2022), the best anti-tiling but three
  fetches per texture instead of one each; per-pixel noise (tens of noise
  calls per pixel); parallax offset near the camera, since the relief is
  millimetres to a centimetre and the bake keeps no height channel for it.

## Floor and ambient (fixes after the stone step's screenshots)

- Contact darkening (within 1.5 m of the floor) is for what stands on the
  floor; in the real look a surface facing up takes none of it, so open
  shadow gets the whole sky (about 0.15 of sunlight at 35 degrees).
- The AO volume's sky term looks straight up only. The floor's sky view
  factor (`floorSky`) is baked once a frame, after the AO compose, into a
  2D map at half the AO volume's resolution (`AoVolume.bakeFloorSky`). Each
  texel marches 3 rings (75, 45 and 15 degrees elevation, cosine weights
  0.25, 0.5 and 0.25) of 8 azimuths, 13 taps each from 0.8 to 11.6 m
  through occupancy mip 1. Floor pixels then take one bilinear tap instead
  of about 22 occupancy taps per pixel (the per-pixel version cost 0.07 ms
  at near 10k on the M5 Max). Against a ray-cast ground truth (scratch
  script, exact boxes, cosine-weighted hemisphere) on the floor test's
  scene: street 0.40 against 0.32, open ground 0.94 against 0.91. The
  remaining leak in the street is the mip-1 voxel blur at wall edges.
  Where blocks hide the sky, a surface sees `realBounce`:
  walls of the blocks' mean albedo, lit by the sun averaged over compass
  directions and by half the sky and ground. That turns streets between
  towers from sky-blue to warm, as sunlit walls make them. Step 2 replaces
  both with proper sky lighting. Bench variant `real-no-floor-sky`.
- The clearcoat lobe only runs where there is a coat (the ball).

## Steps

Order of work: 1, 3, 4, then 5, 6, 2, 7 (textures do more for "real" than
sky lighting does, so they came first).

1. Golden gate; sun direction as a look parameter; `real` scaffold and bench variant; Hillaire 2020 atmosphere (sky, haze, sun colour).
2. Sky lighting: SH irradiance, prefiltered cubemap, ground bounce.
3. Cube materials: baked texture arrays, per-cube variation, edge wear, dirt.
4. Ground material, anti-tiling, near parallax, horizon.
5. Soft shadows: PCSS with the sun's 0.53 degree diameter.
6. Dust and chips instead of sparks and heat glow.
7. Polish: steel ball, grain, tone-map A/B, tuning from Mac screenshots.
