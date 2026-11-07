// PT29's level test on B1, on Rapier (opening-aim-physics.ts says why; one file a big level, for CI's shards).
// B2 is the B family's representative on PRs; this level plays under PHYSICS_GPU_SLOW=1 (the nightly run).
import { openingAimPhysics, RATED } from './opening-aim-physics.ts';

openingAimPhysics(RATED.filter((d) => d.id === 'B1'), 'rapier', { slow: true });
