// The keystone.balls option (O4: one module per option; docs/design/options.md).
import { BALL_STYLES, type BallStyle } from '../scene.ts';
import { choice, type GameOption } from './option.ts';

/** keystone.balls: painted or plain (absent: painted). */
export function ballStyle(text: string | null): BallStyle {
  if (text === null) return 'painted';
  if (!(BALL_STYLES as readonly string[]).includes(text)) throw new Error(`keystone.balls must be ${BALL_STYLES.join(' or ')}: ${text}`);
  return text as BallStyle;
}

/** How fired balls are drawn (scene.ts BallStyle): painted with a band (the default) or plain, the look's own (keystone.balls=plain). */
export const balls = {
  feel: choice({
    field: 'balls',
    url: 'keystone.balls',
    default: 'painted',
    of: ballStyle,
    scene: { key: 'balls', json: 'string' },
    panel: { label: 'fired balls', choices: [['painted', 'painted, banded'], ['plain', "plain: the look's"]] },
  }),
} satisfies GameOption;
