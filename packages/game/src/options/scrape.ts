// The keystone.scrape option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Scraping (A8b, @tb/audio engine.setSlide): bodies that slide without an impact, losing energy to their contacts,
 * crackle as stick-slip grains, about as loud as the impacts it would take to shed that energy (10 dB under). In a
 * collapse it fills the tipping and the settling between the knocks. Off by default until Will has heard it (the
 * judge cannot rank it: docs/sound.md A8b); keystone.scrape=1 turns it on. The classic sound set never uses it.
 */
export const scrape = {
  feel: flag({
    field: 'scrape',
    url: 'keystone.scrape',
    default: false,
    scene: { key: 'scrape', json: 'boolean' },
    panel: { label: 'sound scrape: sliding bodies crackle' },
  }),
} satisfies GameOption;
