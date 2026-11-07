// The keystone.frames option (O4: one module per option; docs/design/options.md).
import { frameMode } from '../frame-rate.ts';
import { choice, type GameOption } from './option.ts';

/** Which display frames are drawn (frame-rate.ts FrameGovernor): every one, half on a fast display, or half only while physics is behind. */
export const frames = {
  feel: choice({
    field: 'frames',
    url: 'keystone.frames',
    default: 'all',
    of: frameMode,
    scene: { key: 'frames', json: 'string' },
    panel: { label: 'frames drawn', choices: [['all', 'every frame'], ['half', 'half on a fast display'], ['auto', 'half while physics is behind']] },
  }),
} satisfies GameOption;
