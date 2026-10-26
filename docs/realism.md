# Photoreal look (`real`)

Design doc with costs and alternatives: https://claude.ai/artifact/DtEnSG7b8KVNRcYfZ8L78u
(thread "Make the world look photoreal", 2026-10-26). This file records the
rules the code follows; the doc has the reasoning.

## Rules

- `real` is a look preset (`LOOKS.real`, `?look=real`), not a fork of the renderer.
- **Existing looks stay bit-identical.** `render.test.ts` pins FNV hashes of
  `candy` and `hazy` frames (`test/golden/looks.json`, per platform key). Realism
  code sits behind a WGSL override (`REAL`) in pipelines only `real` uses, and
  its resources live in their own bind group. Changing a pinned hash takes
  `UPDATE_GOLDEN=1 pnpm test packages/render/test/render.test.ts -t golden`
  and a reason in the commit message.
- **Cost target** (M5 Max, 2560x1440, `pnpm bench:render`): `real` at most
  +1.0 ms over `full` at 100k cubes far view, +0.5 ms at 10k. Every expensive
  feature gets a paired bench variant that switches it off.
- **No downloaded assets.** Materials are baked on the GPU at startup into
  texture arrays; the arrays can take CC0 scans later without shader changes.
- Each physical model has a CPU twin compared with the GPU result in tests.

## Steps

1. Golden gate; sun direction as a look parameter; `real` scaffold and bench variant; Hillaire 2020 atmosphere (sky, haze, sun colour).
2. Sky lighting: SH irradiance, prefiltered cubemap, ground bounce.
3. Cube materials: baked texture arrays, per-cube variation, edge wear, dirt.
4. Ground material, anti-tiling, near parallax, horizon.
5. Soft shadows: PCSS with the sun's 0.53 degree diameter.
6. Dust and chips instead of sparks and heat glow.
7. Polish: steel ball, grain, tone-map A/B, tuning from Mac screenshots.
