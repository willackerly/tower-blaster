# tower-blaster conventions

- Plan and phase gates: docs/plan.md. Work in small steps; every step lands with a test that proves it.
- Packages live in `packages/*`, imported as `@tb/<name>`, TypeScript source only (no build step; Vite/tsx/vitest load `.ts` directly).
- `@tb/engine-api` is the only contract between engines, the game and the harness. Every engine (reference, CPU baselines, GPU variants) implements `PhysicsEngine`.
- Shared GPU buffer layouts are defined once in `packages/schema/src/structs.ts`. Run `pnpm codegen` after changing them; a test fails if `generated/structs.wgsl` is stale.
- GPU code is tested in headless Chromium via `@tb/testkit` (SwiftShader when no GPU). Set `REQUIRE_WEBGPU=1` to make a missing adapter fail instead of skip (CI does).
- Timing numbers from SwiftShader or CI runners are never used as performance results; real numbers come from `pnpm bench` on physical machines (target: Apple M5 Max).
- `pnpm check` = typecheck + tests. Run it before every commit.
