// The keystone.slowmo option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** Slow motion while a crown falls fast (juice; off unless asked). Pacing only. */
export const slowMo = {
  feel: flag({
    field: 'slowMo',
    url: 'keystone.slowmo',
    default: false,
    scene: { key: 'slowmo', json: 'boolean', always: true },
    panel: { label: 'slow motion as crowns fall' },
  }),
} satisfies GameOption;
