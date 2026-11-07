// The keystone.view option and the Opening view setting (O4: one module per option; docs/design/options.md).
import { choice, type GameOption, settingOption, storedOneOf } from './option.ts';

/** How the opening view is chosen (PaceFeel.view). */
export type OpeningView = 'goals' | 'classic';
export const OPENING_VIEWS: readonly OpeningView[] = ['goals', 'classic'];

/** keystone.view: goals or classic (absent: goals). */
export function openingView(text: string | null): OpeningView {
  if (text === null) return 'goals';
  if (!(OPENING_VIEWS as readonly string[]).includes(text)) throw new Error(`keystone.view must be ${OPENING_VIEWS.join(' or ')}: ${text}`);
  return text as OpeningView;
}

/**
 * The opening view (view.ts openingDirection, PT1, docs/game/opening-view.md): 'goals' looks for the lowest, least
 * turned view that shows the level's crowns and heritage (the default since the agent playtest's B2 opened on a
 * field of towers hiding them); 'classic' always opens on the 3/4 view from the par line's side at 12 degrees, as
 * before (keystone.view=classic). The Opening view setting says it unless the URL does; read at each level load.
 */
export const view = {
  feel: choice({
    field: 'view',
    url: 'keystone.view',
    default: 'goals',
    of: openingView,
    scene: { key: 'openview', json: 'string' },
    panel: { label: "opening view (the game page's)", choices: [['goals', 'shows the crowns and heritage'], ['classic', "classic: 3/4 from the launcher's side"]] },
  }),
  setting: settingOption<'view', OpeningView>({
    field: 'view',
    default: 'goals',
    stored: storedOneOf(OPENING_VIEWS),
    drives: { fields: ['view'], feel: (v) => ({ view: v }) },
    door: {
      act: 'view',
      label: 'Opening view',
      choices: [
        { arg: 'goals', value: 'goals', text: 'Show the goals', title: 'Each level opens on a view that shows its crowns and what to spare' },
        { arg: 'classic', value: 'classic', text: 'Classic', title: "Each level opens on the low three-quarter view from the launcher's side" },
      ],
    },
  }),
} satisfies GameOption;
