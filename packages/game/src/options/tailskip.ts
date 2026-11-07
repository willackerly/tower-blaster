// The keystone.tailskip option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** Fast-forward the tail of a shot (pacing.ts TailSkip). On unless keystone.tailskip=0. */
export const tailSkip = {
  feel: flag({
    field: 'tailSkip',
    url: 'keystone.tailskip',
    default: true,
    scene: { key: 'tailskip', json: 'boolean' },
    panel: { label: 'fast-forward the tail of a shot' },
  }),
} satisfies GameOption;
