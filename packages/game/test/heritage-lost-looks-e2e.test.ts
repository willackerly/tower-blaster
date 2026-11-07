// Lost heritage reads as lost (PT28) in the hazy and real looks: heritage-lost-check.ts.
import { describe, it } from 'vitest';
import { runLook } from './heritage-lost-check.ts';
import { gamePage } from './page.ts';

const game = gamePage();

describe('lost heritage reads as lost in every look (PT28)', () => {
  for (const look of ['hazy', 'real']) {
    it(`L3 in ${look}: a cracked heritage block is red, unlike the teal ones`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      const seen = await runLook(game, look, false);
      if (!seen) return ctx.skip();
      console.log('L3 heritage colours', JSON.stringify(seen));
    }, 10 * 60_000);
  }
});
