// PT1 on the city levels (sightlines-gpu.test.ts has the chambers): B2, whose first visit scored -15,361 with
// the cathedral and the crowns hidden, plus one each of the other towns with objectives (B2's draft c with its
// cathedral: T-B2C, since PT11 dropped the 16-roof-crown T-B2A; Domino Boulevard: T-B4A). The other copies of B2's town open on the same view (view.test.ts, CPU).
import { describe, expect, it } from 'vitest';
import { gamePage } from './page.ts';
import { expectObjectivesInSight, SHAPES, sightOf } from './sightlines-gpu.ts';

const game = gamePage();
const CITIES = ['B2', 'T-B2C', 'T-B4A'];

describe('PT1: objectives in sight at the opening view (ID pass, city levels)', () => {
  for (const id of CITIES) for (const shape of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) {
    it(`${id} ${shape}`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      const s = await sightOf(game, id, shape);
      if (!s) return ctx.skip();
      ctx.annotate(`crowns ${s.crownsSeen}/${s.crowns}, heritage ${s.heritageSeen}/${s.heritage}`);
      expectObjectivesInSight(s);
    }, 10 * 60_000);
  }

  it('B2 desktop, keystone.view=classic (the view the agent playtest met): the gate sees no crown and no heritage', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const s = await sightOf(game, 'B2', 'desktop', '&keystone.view=classic');
    if (!s) return ctx.skip();
    ctx.annotate(`crowns ${s.crownsSeen}/${s.crowns}, heritage ${s.heritageSeen}/${s.heritage}`);
    expect(s.crownsSeen).toBeLessThan(3);
    expect(s.heritageSeen).toBe(0);
  }, 10 * 60_000);
});
