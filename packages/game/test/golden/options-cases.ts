// O4's golden inputs (docs/design/options.md). The outputs in options-golden.json and the viewer's
// feel-golden.json were recorded from main at 1d7158e, before the option registry. Do not regenerate them:
// a change to either means a game option now behaves differently, which O4 promised it would not.
export const FEEL_SEARCHES = [
  ...['hitstop', 'slowmo', 'tailskip', 'follow', 'shake', 'rapid', 'turnview', 'arcs', 'handoff', 'marks', 'spent', 'pullanim', 'frozenlook'].flatMap((k) => ['0', '1', '2', 'yes', ''].map((v) => `keystone.${k}=${v}`)),
  ...['0', '14', '7.5', '1000', '1e2', ' 5 ', '-1', '1001', '', 'x', 'NaN'].map((v) => `keystone.budget=${encodeURIComponent(v)}`),
  ...['0', '1024', '65536', '12.5', '65537', '-3', '', 'lots'].map((v) => `keystone.undo=${encodeURIComponent(v)}`),
  ...['all', 'half', 'auto', 'none', ''].map((v) => `keystone.frames=${v}`),
  ...['high', 'level', 'low', ''].map((v) => `keystone.launch=${v}`),
  ...['painted', 'plain', 'gold', ''].map((v) => `keystone.balls=${v}`),
  ...['damage', 'classic', 'big', ''].map((v) => `keystone.fx=${v}`),
];
export const FLIPPED_FEEL_SEARCH = 'keystone.hitstop=1&keystone.slowmo=1&keystone.budget=0&keystone.tailskip=0&keystone.follow=1&keystone.shake=1&keystone.frames=half&keystone.rapid=0&keystone.turnview=0&keystone.arcs=0&keystone.handoff=0&keystone.undo=0&keystone.launch=level&keystone.balls=plain&keystone.marks=0&keystone.fx=classic&keystone.spent=0&keystone.pullanim=0&keystone.frozenlook=0';
export const STORED: (string | null)[] = [
  null, 'nope', '[]', '{}', 'null', '3',
  '{"sound":false}', '{"sound":"off"}', '{"look":"real"}', '{"look":"candy"}', '{"look":"nope"}', '{"look":3}',
  '{"sharp":1}', '{"sharp":2}', '{"sharp":3}', '{"sharp":"1"}',
  '{"camera":"dynamic"}', '{"camera":true}', '{"rapid":false}', '{"rapid":"off"}', '{"duelView":false}', '{"duelView":0}',
  '{"handoff":false}', '{"handoff":"no"}', '{"launch":"level"}', '{"launch":"low"}', '{"marks":false}', '{"marks":"off"}',
  '{"layout":"classic"}', '{"layout":"dock"}', '{"quality":"high"}', '{"quality":"mid"}', '{"quality":"low"}', '{"quality":"ultra"}',
  '{"sound":false,"look":"real","sharp":1,"camera":"dynamic","rapid":false,"duelView":false,"handoff":false,"launch":"level","marks":false,"layout":"classic","quality":"low","extra":1}',
];
export const URL_SETTINGS = ['', 'sound=on', 'sound=off', 'sound=1', 'sharp=1', 'sharp=2', 'sharp=3', 'look=real', 'look=anything', 'quality=auto', 'quality=high', 'quality=mid', 'quality=low', 'quality=ultra', 'sound=off&sharp=1&look=candy&quality=mid'];
export const FLIPPED_SETTINGS = { sound: false, look: 'real', sharp: 1, camera: 'dynamic', rapid: false, duelView: false, handoff: false, launch: 'level', marks: false, layout: 'classic', quality: 'low' };
export const SCENE_BAD: Record<string, unknown>[] = [{ hitstop: '1' }, { slowmo: 0 }, { budget: '14' }, { tailskip: 'no' }, { frames: 3 }, { undo: true }, { launch: 1 }, { balls: false }, { marks: 'off' }, { fx: null }, { spent: 1 }, { pullanim: 'x' }, { frozenlook: [] }, { follow: {} }, { shake: 'y' }, { rapid: 'n' }, { frames: 'x' }, { budget: 2000 }];
export const CHECK_PATCHES: Record<string, unknown>[] = [{ budgetMs: -1 }, { budgetMs: NaN }, { undoMB: 1e9 }, { frames: 'x' }, { launch: 'x' }, { balls: 'x' }, { fx: 'x' }];
