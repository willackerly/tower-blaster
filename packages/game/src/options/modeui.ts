// The keystone.modeui option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Each mode's own HUD and result card (mode-ui.ts; agent playtest round 2, PT23 and PT27): Fuse & Fold, Aftershock
 * and Rube Lab show no Power, Height, rack chips or "fire" help, have one start verb (the Timeline's Plunger, the
 * quake's Start, Rube Lab's Run), and their cards speak in the mode's terms; every failed card says why, and HERITAGE
 * LOST shows in red where it failed the round. On by default; keystone.modeui=0 draws the projectile HUD and card
 * for every mode, as before. No door row: Advanced settings are being cut down (PT37).
 */
export const modeUi = {
  feel: flag({
    field: 'modeUi',
    url: 'keystone.modeui',
    default: true,
    scene: { key: 'modeui', json: 'boolean' },
    panel: { label: "each mode's own HUD and result card" },
  }),
} satisfies GameOption;
