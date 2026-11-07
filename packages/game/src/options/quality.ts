// The Quality setting (O4: one module per option; docs/design/options.md): the quality tier, quality.ts.
// Auto takes the load probe's tier; ?quality= says it for a visit (docs/game/quality-tiers.md).
import { QUALITY_SETTINGS, qualityParam, type QualitySetting } from '../quality.ts';
import { type GameOption, settingOption, storedOneOf } from './option.ts';

/** The quality choices the front door offers, in its order, with their names there. */
export const QUALITY_CHOICES: ReadonlyArray<{ quality: QualitySetting; label: string }> = [
  { quality: 'auto', label: 'Auto' },
  { quality: 'high', label: 'High' },
  { quality: 'mid', label: 'Medium' },
  { quality: 'low', label: 'Low' },
];

/** The Quality buttons' tooltips (docs/game/quality-tiers.md). */
export const QUALITY_TITLES: Readonly<Record<QualitySetting, string>> = {
  auto: 'Picked for this device when the page loads',
  high: 'Full resolution, every effect',
  mid: 'One pixel per screen point: a quarter of the pixels on a sharp screen',
  low: 'Half resolution, no ambient occlusion, no sparks or dust',
};

const tierName = (t: string) => QUALITY_CHOICES.find((c) => c.quality === t)!.label;

export const quality = {
  setting: settingOption<'quality', QualitySetting>({
    field: 'quality',
    default: 'auto',
    stored: storedOneOf(QUALITY_SETTINGS),
    url: (q) => qualityParam(q) ?? undefined,
    door: {
      act: 'quality',
      label: 'Quality',
      buttons: (v, { detected, esc }) =>
        QUALITY_CHOICES.map((c) => `<button data-act="quality" data-arg="${c.quality}" class="${v === c.quality ? 'on' : ''}" title="${esc(QUALITY_TITLES[c.quality])}">${c.quality === 'auto' && detected ? `Auto (${tierName(detected)})` : c.label}</button>`).join(''),
      click: (arg) => ((QUALITY_SETTINGS as readonly string[]).includes(arg) ? (arg as QualitySetting) : undefined),
    },
  }),
} satisfies GameOption;
