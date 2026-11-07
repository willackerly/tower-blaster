// PT29's level test (docs/game/aim-clarity.md): each rated level's opening aim, fired untouched, does something and
// spares heritage. The chamber levels play on the f64 AVBD reference (the GPU solver's algorithm, the engine that pins
// par lines); levels over REF_MAX_BODIES (the big and Wavefront levels: minutes a shot on the reference) on Rapier, the
// game's CPU engine, in opening-aim-physics-<id>.test.ts, so each file keeps within a CI shard's budget (the tests are
// opening-aim-physics.test.ts and one file a big level; this is their shared check). On a PR one big level a family plays
// (B2, W5); the others are `slow`, for the PHYSICS_GPU_SLOW=1 nightly run (CI rule O5). The level pre-settles as the game
// loads it, the opening aim is chosen on the bodies as they then stand from the opening view (a desktop, and an upright
// phone with the docked HUD as the 390x844 page measures it) with the launcher where the game puts it by default, fired,
// and played to its settle: heritage intact and the collapse fraction D above 0. The trials are unrated and left to the
// CPU test.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, Driver, playShots, SERIES } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { launchAz, launchHeight } from '../src/aim.ts';
import { nextSelection } from '../src/hud.ts';
import { aimsAtPoint, openingAim } from '../src/opening-aim.ts';
import { openingInsets, viewOf } from '../src/view.ts';
import { panelTimeline } from '../src/fuse-timeline.ts';
import { DEFAULT_FEEL } from '../src/pacing.ts';

/** The docked phone HUD's band at 390x844 (play.ts dockedHud on L3: the status strip to 11% from the top, the tray and hint over the bottom 25%). */
const PHONE_HUD = { top: 0.11, bottom: 0.25, left: 0, right: 0 };
const VIEWS = [['desktop', 1280 / 800, undefined], ['phone', 390 / 844, PHONE_HUD]] as const;

/** Rated levels (not the trials) whose first item is aimed at a point. */
export const RATED = SERIES.flat().filter((d) => { const item = nextSelection(d.rack, d.rack, null); return !d.id.startsWith('T-') && item !== null && aimsAtPoint(item) && !d.build; });
/** The most bodies a level may have to play on the reference here: W5's 259 take about 2 min a viewport there, too long for a shard. */
export const REF_MAX_BODIES = 200;
/** Levels too big for the reference in a CI shard (the big levels and Wavefront's), played on Rapier in a file of their own. */
export const isBig = (id: string) => compileLevel(RATED.find((d) => d.id === id)!).meta.n > REF_MAX_BODIES;

/** PHYSICS_GPU_SLOW=1 (the nightly run) also plays the big levels that are not a PR's representative (CI rule O5). */
export const SLOW = process.env.PHYSICS_GPU_SLOW === '1';

/** The opening-aim physics check for `levels`, on the reference or on Rapier; `slow`: a big level other than its family's representative, played only under PHYSICS_GPU_SLOW=1. */
export function openingAimPhysics(levels: typeof RATED, engine: 'ref' | 'rapier', opts: { slow?: boolean } = {}): void {
  describe.skipIf(opts.slow === true && !SLOW)(`each rated level's opening aim, fired untouched, on ${engine === 'ref' ? 'the f64 reference' : 'Rapier'}`, () => {
  for (const def of levels) for (const [shape, aspect, hud] of VIEWS) {
    it(`${def.id} ${shape}: heritage intact, collapse above 0`, async () => {
      const c = compileLevel(def), item = nextSelection(def.rack, def.rack, null)!;
      const d = new Driver(engine === 'ref' ? new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP }) : new RapierEngine(), c);
      try {
        await d.reset();
        const view = viewOf(c, aspect, undefined, undefined, undefined, { insets: openingInsets(aspect, panelTimeline(c) !== null), hud });
        const aim = openingAim(c, d.snapshot, { view, aspect, item, power: 100, az: launchAz(view.yaw, DEFAULT_FEEL.fireSide), at: launchHeight(c, 'high') });
        expect(aim, 'an opening aim').not.toBeNull();
        const r = await playShots(d, [aim!.shot], 0, { bank: false, maxSteps: d.engine.stepIndex + 3600 });
        const s = r.session, o = s.outcomes[0], collapse = o ? s.collapse(o.pe_mJ) : 0;
        console.log(`${def.id} ${shape}: ${JSON.stringify(aim!.shot)} on body ${aim!.contact.body}: collapse ${collapse.toFixed(3)}, crowns down ${o?.crownsDown}, heritage broken ${s.heritageBroken.reduce((a, x) => a + x, 0)}, ${r.steps} steps`);
        expect(s.heritageBroken.reduce((a, x) => a + x, 0)).toBe(0);
        expect(collapse).toBeGreaterThan(0);
      } finally {
        d.engine.dispose();
      }
    }, 600_000);
  }
  });
}

