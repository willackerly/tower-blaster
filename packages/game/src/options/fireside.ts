// The keystone.fireside option and the Launcher setting (O4: one module per option; docs/design/options.md).
import { FIRE_SIDES, type FireSide } from '../aim.ts';
import { choice, type GameOption, settingOption, storedOneOf } from './option.ts';

/** keystone.fireside: side or behind (absent: behind). */
export function fireSide(text: string | null): FireSide {
  if (text === null) return 'behind';
  if (!(FIRE_SIDES as readonly string[]).includes(text)) throw new Error(`keystone.fireside must be ${FIRE_SIDES.join(' or ')}: ${text}`);
  return text as FireSide;
}

/**
 * Where the launcher stands for the view (aim.ts launchAz; PT36, docs/game/aim-clarity.md): right behind the eye (the
 * default: a click strikes the face it lands on square, as aimed), or FIRE_SIDE_DEG round to the side
 * (keystone.fireside=side), so the aim's flight reads as a curve rather than end on. Side is not the default: from
 * it a shot strikes everything at an angle, and on L3 (Surgeon) the opening view's crown shot then drove the crown into
 * the heritage beside it on the f64 reference, where square on it knocks the crown off clean. The end-on flight's
 * clutter is answered by the dots instead (preview-dots.ts). Not in a duel: a Siege Table turn fires from the view's
 * own azimuth, inside the side's arc (duel-view.ts). A shot records its azimuth, so this changes only the shots
 * aimed, never a replay. The Launcher setting says it unless the URL does; read live.
 */
export const fireside = {
  feel: choice({
    field: 'fireSide',
    url: 'keystone.fireside',
    default: 'behind',
    of: fireSide,
    scene: { key: 'fireside', json: 'string' },
    panel: { label: 'launcher', choices: [['behind', 'behind the view'], ['side', 'to the side of the view']] },
  }),
  setting: settingOption<'fireSide', FireSide>({
    field: 'fireSide',
    default: 'behind',
    stored: storedOneOf(FIRE_SIDES),
    drives: { fields: ['fireSide'], feel: (v) => ({ fireSide: v }) },
    door: {
      act: 'fireside',
      label: 'Launcher',
      choices: [
        { arg: 'behind', value: 'behind', text: 'Behind you', title: 'Shots leave from right behind your view and strike what you click square on' },
        { arg: 'side', value: 'side', text: 'To the side', title: 'Shots leave from a little to the left of your view, so you see the flight curve; they strike at an angle' },
      ],
    },
  }),
} satisfies GameOption;
