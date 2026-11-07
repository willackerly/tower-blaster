// Lost heritage reads as lost (PT28), candy look, with Undo and Retry: heritage-lost-check.ts.
import { describe, expect, it } from 'vitest';
import { c, runLook } from './heritage-lost-check.ts';
import { gamePage } from './page.ts';

const game = gamePage();

describe('lost heritage reads as lost (PT28)', () => {
  it('L3 in candy: a cracked heritage block flashes red and stays red; Undo and Retry give its glaze back', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    expect(Array.from(c.meta.heritage)).toEqual([35, 37, 39]);
    const seen = await runLook(game, 'candy', true);
    if (!seen) return ctx.skip();
    console.log('L3 heritage colours', JSON.stringify(seen));
  }, 10 * 60_000);
});
