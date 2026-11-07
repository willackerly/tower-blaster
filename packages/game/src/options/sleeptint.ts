// The keystone.sleeptint option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Debug (roadmap E2.5): blocks asleep (GPU per-body sleep, the level's physics.sleep or keystone.sleep=1; Rapier's
 * own) drawn in a cold blue (@tb/render Renderer.toggles.sleepTint). Off by default; keystone.sleeptint=1 on. Read
 * live: the game sets the renderer's toggle from it on every drawn frame.
 */
export const sleepTint = {
  feel: flag({
    field: 'sleepTint',
    url: 'keystone.sleeptint',
    default: false,
    scene: { key: 'sleeptint', json: 'boolean' },
    panel: { label: 'debug: sleeping blocks in blue' },
  }),
} satisfies GameOption;
