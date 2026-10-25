// Regenerates packages/schema/generated/structs.wgsl. A test fails if the
// checked-in file is stale, so run `pnpm codegen` after changing structs.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wgslModule } from './codegen.ts';
import { ALL_STRUCTS } from './structs.ts';

export const GENERATED_PATH = fileURLToPath(new URL('../generated/structs.wgsl', import.meta.url));

mkdirSync(dirname(GENERATED_PATH), { recursive: true });
writeFileSync(GENERATED_PATH, wgslModule(ALL_STRUCTS));
console.log(`wrote ${GENERATED_PATH}`);
