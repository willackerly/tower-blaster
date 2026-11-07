// PT29's level test on W5, on Rapier (opening-aim-physics.ts says why; one file a big level, for CI's shards).
// The W family's representative on PRs (W3 plays under PHYSICS_GPU_SLOW=1).
import { openingAimPhysics, RATED } from './opening-aim-physics.ts';

openingAimPhysics(RATED.filter((d) => d.id === 'W5'), 'rapier');
