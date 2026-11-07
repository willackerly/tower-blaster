// Bundled into a Chromium page by quake-gpu.test.ts (testkit loadBundle): the quake keys the browser computes for
// the same shots, digested as quake.test.ts's twin does in Node, so the test can compare the two.
import { quakeCandidate, compileLevel, quakeInputs, type QuakeShot } from '@tb/keystone';
import { quakeKeysDigest } from './quake-keys.ts';

export function digest(site: string, shots: QuakeShot[]): string {
  const c = compileLevel(quakeCandidate(site));
  return quakeKeysDigest(shots.map((s) => quakeInputs(c, s, 300)));
}
