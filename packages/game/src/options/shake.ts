// The keystone.shake option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** The camera shakes and its field of view punches in on hits and blasts (juice.ts CameraJuice). Off by default; the Camera setting sets it too (camera.ts). */
export const shake = {
  feel: flag({
    field: 'shake',
    url: 'keystone.shake',
    default: false,
    scene: { key: 'shake', json: 'boolean' },
    panel: { label: 'camera shakes on hits' },
  }),
} satisfies GameOption;
