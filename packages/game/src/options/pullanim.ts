// The keystone.pullanim option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** Undercut's pull drawn (pull-anim.ts, playtest PT17): the pulled block slides out toward the camera over a quarter second and a dotted ghost of it stays a second where it stood. On by default; keystone.pullanim=0 off (the block vanishes at the pull, with its dust puff). */
export const pullAnim = {
  feel: flag({
    field: 'pullAnim',
    url: 'keystone.pullanim',
    default: true,
    scene: { key: 'pullanim', json: 'boolean' },
    panel: { label: 'pulls slide out, a ghost where they stood' },
  }),
} satisfies GameOption;
