// The keystone.fx option (O4: one module per option; docs/design/options.md).
import { EFFECT_STYLES, type EffectStyle } from '@tb/render';
import { choice, type GameOption } from './option.ts';

/** keystone.fx: damage or classic (absent: damage). */
export function effectStyle(text: string | null): EffectStyle {
  if (text === null) return 'damage';
  if (!(EFFECT_STYLES as readonly string[]).includes(text)) throw new Error(`keystone.fx must be ${EFFECT_STYLES.join(' or ')}: ${text}`);
  return text as EffectStyle;
}

/**
 * How impacts are drawn (@tb/render EffectStyle, PT2): 'damage' (the default since the agent playtest of
 * 2026-11-06) makes sparks, flashes and heat follow what a shot moved, so a shot that moves nothing gets a
 * puff, and draws felled crowns and cracked heritage in their colours rather than glowing white; 'classic'
 * (keystone.fx=classic) as before.
 */
export const fx = {
  feel: choice({
    field: 'fx',
    url: 'keystone.fx',
    default: 'damage',
    of: effectStyle,
    scene: { key: 'fx', json: 'string' },
    panel: { label: 'impact effects', choices: [['damage', 'follow the damage: a miss gets a puff'], ['classic', 'classic: every hit sparks in full']] },
  }),
} satisfies GameOption;
