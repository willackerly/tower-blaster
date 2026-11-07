// PT29's level test on W3, on Rapier (opening-aim-physics.ts says why; one file a big level, for CI's shards).
// W5 is the W family's representative on PRs; this level plays under PHYSICS_GPU_SLOW=1 (the nightly run).
import { openingAimPhysics, RATED } from './opening-aim-physics.ts';

openingAimPhysics(RATED.filter((d) => d.id === 'W3'), 'rapier', { slow: true });
