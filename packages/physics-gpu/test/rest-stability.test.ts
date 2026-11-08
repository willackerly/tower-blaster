// Rest stability at the game's settings (rest-stability.ts has the cases, the
// verdict and the suite). CI runs one small wall left idle at the game's
// solver settings (40 iterations, gapSlop on); the struck case is
// rest-stability-struck.test.ts, so each file stays near two minutes on
// SwiftShader, which steps a 1,000-cube scene at 40 iterations only 2-4 times
// a second and a few hundred cubes about 6 (local VM, 2026-11-01).
//
// PHYSICS_GPU_SLOW=1 runs the matrix here instead (restMatrix: 3 structures x
// idle at 40 and 20 iterations, struck at 40, x gapSlop on, off; Kapla settled
// and asleep, and struck Kapla must come down; struck walls and cities run at
// least 1,200 frames and must have been hit; #310 has why)
// at REST_SIZES bodies (commas for several) for REST_FRAMES frames. On a
// physical GPU (TB_CHANNEL) they default to 1000 and 3600 (a minute); on SwiftShader, the nightly, to 400 and
// 600, CI's own case: at 1,000 bodies and 3,600 frames the matrix is hours
// there (2-4 steps a second), and the first nightly (run 42394058839) hit its
// job limit inside this file. The full matrix is the Mac run (docs/ci/nightly.md):
//   TB_CHANNEL=chrome PHYSICS_GPU_SLOW=1 REST_SIZES=1000,10000 REQUIRE_WEBGPU=1 \
//     REST_LOG=rest.txt pnpm vitest run packages/physics-gpu/test/rest-stability.test.ts
// (installed Chrome, so Metal on a Mac); REST_ONLY=<text> keeps the cases whose
// name contains it (e.g. REST_ONLY='city 1000'); REST_TRACE=1 logs every case's
// structure each second (max speed, bodies moving, mean and top height).
import { type RestCase, restMatrix, restSuite } from './rest-stability.ts';

const slow = process.env.PHYSICS_GPU_SLOW === '1', real = Boolean(process.env.TB_CHANNEL);
const sizes = (process.env.REST_SIZES ?? (real ? '1000' : '400')).split(',').map(Number);
const frames = Number(process.env.REST_FRAMES ?? (real ? 3600 : 600));
// Traced, so the trace's bookkeeping is checked in CI (10 snapshots of 400 bodies).
const CI: RestCase[] = [{ structure: 'wall', mode: 'idle', n: 400, iterations: 40, gapSlop: true, frames: 600, trace: true }];

restSuite(slow ? restMatrix(sizes, frames) : CI);
