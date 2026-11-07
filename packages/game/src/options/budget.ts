// The keystone.budget option (O4: one module per option; docs/design/options.md).
import { feelOption, type GameOption } from './option.ts';

/**
 * Physics budget (ms of step cost per 1/60 s of sim time) when a level or URL sets none. Over it, time
 * slows, and the HUD says so. URL key keystone.budget; 0 turns the valve off. 14 ms, not a whole 60 Hz
 * step (16.7): a budget of a whole step lets physics fill the GPU queue whenever it is behind, and the
 * frames then wait behind steps. E7 on the M5 Max at 120 Hz (a406519, 10k cluster blasts, steps of about
 * 24 ms; docs/pipelining.md): frame p95/p99 9.8/11.6 ms at 14 against 17.6/21.9 at 16.7 (and the same
 * at off), for a sim at 0.64x against 0.68x real time. G4.4 had chosen 16.7 on a 60 Hz run, where the
 * frames looked the same at both.
 */
export const DEFAULT_BUDGET_MS = 14;

/** The valve's physics budget, ms of step cost per 1/60 s (DEFAULT_BUDGET_MS); 0: no valve, physics runs as fast as it can up to real time. */
export const budgetMs = {
  feel: feelOption<'budgetMs', number>({
    field: 'budgetMs',
    url: 'keystone.budget',
    default: DEFAULT_BUDGET_MS,
    parse(b) {
      const n = b.trim() === '' ? NaN : Number(b);
      if (!(n >= 0 && n <= 1000)) throw new Error(`keystone.budget must be from 0 to 1000 ms (0: no valve): ${b}`);
      return n;
    },
    write: (v) => String(v),
    check(v) {
      if (!(v >= 0 && v <= 1000)) throw new Error(`physics budget must be from 0 to 1000 ms (0: no valve): ${v}`);
    },
    scene: { key: 'budget', json: 'number' },
    panel: { label: 'physics budget, ms per 1/60 s (0: no valve)', attrs: 'step="any" min="0" max="1000"' },
  }),
} satisfies GameOption;
