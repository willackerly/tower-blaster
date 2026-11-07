// The keystone.spent option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** Spent ammo (PT19): a fired ball, ram or dud fades to a dull stone grey once its shot settles. On by default; keystone.spent=0 off. */
export const spent = {
  feel: flag({
    field: 'spent',
    url: 'keystone.spent',
    default: true,
    scene: { key: 'spent', json: 'boolean' },
    panel: { label: 'spent ammo fades once its shot settles' },
  }),
} satisfies GameOption;
