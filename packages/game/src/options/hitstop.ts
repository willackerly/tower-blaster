// The keystone.hitstop option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** Hit-stop: a few frames frozen on the ammo's first contact (juice; off unless asked). Pacing only: it changes when steps run, never what a step does. */
export const hitStop = {
  feel: flag({
    field: 'hitStop',
    url: 'keystone.hitstop',
    default: false,
    scene: { key: 'hitstop', json: 'boolean', always: true },
    panel: { label: 'hit-stop on contact' },
  }),
} satisfies GameOption;
