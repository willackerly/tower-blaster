// Every game option, in order (O4, docs/design/options.md). The order is the URL's and the scene
// file's for the feel parts and the door's for the settings; to add an option, write its module and
// add its two lines here: one import, one entry. .gitattributes merges this file with merge=union, so
// two branches that each add an option merge without a conflict (keep each entry on its own line).
import { arcs } from './arcs.ts';
import { balls } from './balls.ts';
import { blastSound } from './blastsound.ts';
import { chorusViewOption } from './chorusview.ts';
import { budgetMs } from './budget.ts';
import { camera } from './camera.ts';
import { coats } from './coats.ts';
import { dudNote } from './dudnote.ts';
import { duelLead } from './duellead.ts';
import { follow } from './follow.ts';
import { frames } from './frames.ts';
import { frozenAim } from './frozenaim.ts';
import { frozenLook } from './frozenlook.ts';
import { fx } from './fx.ts';
import { handoff } from './handoff.ts';
import { hitStop } from './hitstop.ts';
import { impact } from './impact.ts';
import { launch } from './launch.ts';
import { launchSound } from './launchsound.ts';
import { layout } from './layout.ts';
import { look } from './look.ts';
import { marks } from './marks.ts';
import { modeUi } from './modeui.ts';
import { view } from './openview.ts';
import { pullAnim } from './pullanim.ts';
import { quality } from './quality.ts';
import { rapid } from './rapid.ts';
import { shake } from './shake.ts';
import { sharp } from './sharp.ts';
import { sleepTint } from './sleeptint.ts';
import { slowMo } from './slowmo.ts';
import { sound } from './sound.ts';
import { sun } from './sun.ts';
import { spent } from './spent.ts';
import { tailSkip } from './tailskip.ts';
import { turnView } from './turnview.ts';
import { undoMB } from './undo.ts';
import { xray } from './xray.ts';

export const OPTIONS = [
  hitStop,
  slowMo,
  budgetMs,
  tailSkip,
  follow,
  shake,
  frames,
  sound,
  look,
  camera,
  rapid,
  turnView,
  arcs,
  handoff,
  duelLead,
  undoMB,
  launch,
  balls,
  marks,
  view,
  impact,
  xray,
  coats,
  sun,
  layout,
  sharp,
  quality,
  fx,
  spent,
  sleepTint,
  pullAnim,
  frozenLook,
  dudNote,
  modeUi,
  chorusViewOption,
  frozenAim,
  launchSound,
  blastSound,
] as const;
