// PT29's level test on B2, on Rapier (opening-aim-physics.ts says why; one file a big level, for CI's shards).
// The B family's representative on PRs (B1 and B3 play under PHYSICS_GPU_SLOW=1).
import { openingAimPhysics, RATED } from './opening-aim-physics.ts';

openingAimPhysics(RATED.filter((d) => d.id === 'B2'), 'rapier');
