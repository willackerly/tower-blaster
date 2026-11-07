// The keystone.undo option (O4: one module per option; docs/design/options.md).
import { feelOption, type GameOption } from './option.ts';

/** The most keystone.undo takes, MB. */
export const MAX_UNDO_MB = 65536;
/** keystone.undo when the URL sets none: a dozen shots of a 10k level. */
export const DEFAULT_UNDO_MB = 1024;

/**
 * Memory for instant undo, MB (keystone.undo): each shot keeps a checkpoint of the world as it went
 * in (play.ts, @tb/keystone Driver.checkpoint), the oldest dropped past this; an undo with no
 * checkpoint left replays the kept shots instead (docs/game/undo.md). 0: always replay.
 * About 85 MB a shot on a 10k level, under 1 MB on the small ones.
 */
export const undoMB = {
  feel: feelOption<'undoMB', number>({
    field: 'undoMB',
    url: 'keystone.undo',
    default: DEFAULT_UNDO_MB,
    parse(u) {
      const n = u.trim() === '' ? NaN : Number(u);
      if (!(n >= 0 && n <= MAX_UNDO_MB)) throw new Error(`keystone.undo must be from 0 to ${MAX_UNDO_MB} MB (0: undo replays the shots): ${u}`);
      return n;
    },
    write: (v) => String(v),
    check(v) {
      if (!(v >= 0 && v <= MAX_UNDO_MB)) throw new Error(`undo memory must be from 0 to ${MAX_UNDO_MB} MB (0: undo replays the shots): ${v}`);
    },
    scene: { key: 'undo', json: 'number' },
    panel: { label: 'undo memory, MB (0: undo replays the shots)', attrs: `step="1" min="0" max="${MAX_UNDO_MB}"` },
  }),
} satisfies GameOption;
