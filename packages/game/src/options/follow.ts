// The keystone.follow option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** The camera follows the moving structure during a shot and eases back after (follow.ts). Off by default: the camera moves only when the player moves it (playtest feedback, 2026-11-02). The Camera setting sets it too (camera.ts). */
export const follow = {
  feel: flag({
    field: 'follow',
    url: 'keystone.follow',
    default: false,
    scene: { key: 'follow', json: 'boolean' },
    panel: { label: 'camera follows the collapse' },
  }),
} satisfies GameOption;
