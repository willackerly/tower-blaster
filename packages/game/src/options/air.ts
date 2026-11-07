// The keystone.air option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Air absorption (A8a step 3, @tb/audio air.ts, ISO 9613-1): each impact loses the top end the air takes over its
 * distance, so a far collapse loses its sparkle and a near one keeps it (9 dB at 16 kHz over 25 m, 10 dB at 8 kHz
 * over 98 m). It acts with keystone.space only (it needs each impact's distance). On by default; keystone.air=0
 * leaves the full band at every distance. The classic sound set never uses it.
 */
export const air = {
  feel: flag({
    field: 'air',
    url: 'keystone.air',
    default: true,
    scene: { key: 'air', json: 'boolean' },
    panel: { label: 'sound air: far impacts lose their top end (with space)' },
  }),
} satisfies GameOption;
