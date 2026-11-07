// The keystone.rapid option and the Rapid fire setting (O4: one module per option; docs/design/options.md).
import { flag, type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

/**
 * Rapid fire: a shot may go in while the last is still running (it cuts that one: @tb/keystone
 * Session.fire). On by default (Will, 2026-11-05: waiting for things to settle felt too slow);
 * keystone.rapid=0 waits for each shot to settle, as before. A line's timed shots (Shot.after) play either way.
 * The Rapid fire setting (Advanced settings) says it unless the URL does; read live: a change applies to the next
 * click. A duel is one shot per turn, so it never fires mid-shot whatever this says (main.ts).
 */
export const rapid = {
  feel: flag({
    field: 'rapid',
    url: 'keystone.rapid',
    default: true,
    scene: { key: 'rapid', json: 'boolean' },
    panel: { label: 'rapid fire: shoot before the last shot settles' },
  }),
  setting: settingOption<'rapid', boolean>({
    field: 'rapid',
    default: true,
    stored: storedBoolean,
    drives: { fields: ['rapid'], feel: (v) => ({ rapid: v }) },
    door: onOffRow('rapid', 'Rapid fire', { text: 'On', title: 'Fire again before the last shot settles' }, { text: 'Off', title: 'Each shot waits for the last to settle' }),
  }),
} satisfies GameOption;
