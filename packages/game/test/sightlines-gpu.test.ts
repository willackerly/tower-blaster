// PT1 (agent playtest round 1: B2 opened on a field of towers hiding the cathedral and the crowns): every level
// with crowns or heritage opens on a view showing them, read off the renderer's ID pass on the game page at the
// desktop and phone shapes, under the page's real HUD. Chamber levels and the city levels each have a file (the
// city ones load 5,000 bodies); view.test.ts checks every level the same way on the CPU (sightlines.ts).
import { describe, it } from 'vitest';
import { compileLevel, SERIES } from '@tb/keystone';
import { gamePage } from './page.ts';
import { expectObjectivesInSight, SHAPES, sightOf } from './sightlines-gpu.ts';

const game = gamePage();
/** Levels with objectives and under 1,000 bodies (the city levels are sightlines-city-gpu.test.ts's). */
const CHAMBERS = SERIES.flat().filter((d) => { const c = compileLevel(d); return c.meta.n < 1000 && c.meta.crowns.length + c.meta.heritage.length > 0; }).map((d) => d.id);

describe('PT1: objectives in sight at the opening view (ID pass, chamber levels)', () => {
  for (const shape of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) {
    it(`${shape}: ${CHAMBERS.join(', ')}`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      for (const id of CHAMBERS) {
        const s = await sightOf(game, id, shape);
        if (!s) return ctx.skip();
        ctx.annotate(`${id}: crowns ${s.crownsSeen}/${s.crowns}, heritage ${s.heritageSeen}/${s.heritage}`);
        expectObjectivesInSight(s);
      }
    }, 10 * 60_000);
  }
});
