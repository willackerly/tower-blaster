// The Camera setting (O4: one module per option; docs/design/options.md). It says keystone.follow and
// keystone.shake (follow.ts, shake.ts), each unless the URL says it.
import { type GameOption, settingOption, storedOneOf } from './option.ts';

/** still: the camera moves only when the player moves it (the default since the 2026-11-02 playtest); dynamic: it follows and shakes too. */
export type CameraSetting = 'still' | 'dynamic';

/**
 * The camera motions: one object, read live by the game, so a change applies to the shake at once and to the
 * follow from the next shot.
 */
export const camera = {
  setting: settingOption<'camera', CameraSetting>({
    field: 'camera',
    default: 'still',
    stored: storedOneOf<CameraSetting>(['still', 'dynamic']),
    drives: { fields: ['follow', 'shake'], feel: (v) => ({ follow: v === 'dynamic', shake: v === 'dynamic' }) },
    door: {
      act: 'camera',
      label: 'Camera',
      choices: [
        { arg: 'still', value: 'still', text: 'Still', title: 'Moves only when you move it' },
        { arg: 'dynamic', value: 'dynamic', text: 'Dynamic', title: 'Follows the collapse and shakes on hits' },
      ],
    },
  }),
} satisfies GameOption;
