// Rest stability at the game's settings (rest-stability.ts has the cases, the
// verdict and the suite). CI runs one small wall left idle at the game's
// solver settings (40 iterations, gapSlop on); the struck case is
// rest-stability-struck.test.ts, so each file stays near two minutes on
// SwiftShader, which steps a 1,000-cube scene at 40 iterations only 2-4 times
// a second and a few hundred cubes about 6 (local VM, 2026-11-01).
//
// PHYSICS_GPU_SLOW=1 runs the whole matrix here instead (3 structures x idle,
// struck x 20, 40 iterations x gapSlop on, off) at REST_SIZES bodies (default
// 1000; commas for several) for REST_FRAMES frames (default 3600). On a
// physical GPU:
//   TB_CHANNEL=chrome PHYSICS_GPU_SLOW=1 REST_SIZES=1000,10000 REQUIRE_WEBGPU=1 \
//     REST_LOG=rest.txt pnpm vitest run packages/physics-gpu/test/rest-stability.test.ts
// (installed Chrome, so Metal on a Mac); REST_ONLY=<text> keeps the cases whose
// name contains it (e.g. REST_ONLY='city 1000').
import { type RestCase, restMatrix, restSuite } from './rest-stability.ts';

const slow = process.env.PHYSICS_GPU_SLOW === '1';
const sizes = (process.env.REST_SIZES ?? '1000').split(',').map(Number);
const frames = Number(process.env.REST_FRAMES ?? 3600);
const CI: RestCase[] = [{ structure: 'wall', mode: 'idle', n: 400, iterations: 40, gapSlop: true, frames: 600 }];

restSuite(slow ? restMatrix(sizes, frames) : CI);
