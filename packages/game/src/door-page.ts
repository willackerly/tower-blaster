// The front door on the game page (DOM side; door.ts formats it). Shown over
// the level that loads behind it, so the first level is ready by the time the
// player picks it. Esc and the Menu button bring it back; while it shows, the
// game's keys are held back (a capture listener on window runs before the
// game's own).
import { type CompiledLevel, compileLevel, isTrial, type LevelDef } from '@tb/keystone';
import { type DoorDuel, DOOR_CSS, doorHtml, doorLevels, type DoorLevel } from './door.ts';
import type { GameHandle } from './play.ts';
import type { ProgressStore } from './progress.ts';
import { QUALITY_SETTINGS, type QualitySetting } from './quality.ts';
import type { Settings, SettingsStore } from './settings.ts';

export interface DoorPage {
  show(): void;
  hide(): void;
  readonly open: boolean;
  /** The door's level view as drawn last (tests read it through window.__door). */
  readonly levels: DoorLevel[];
  /** A level the player picked before the game had finished loading: the page loads it once it can. */
  takePending(): string | null;
}

export interface DoorOptions {
  root: HTMLElement;
  menu: HTMLElement;
  levels: readonly LevelDef[];
  /** The level the page opens on (loading behind the door until handle.level says it). */
  start: string;
  handle: GameHandle;
  progress: ProgressStore;
  settings: SettingsStore;
  /** A setting changed: the page applies it (look, sound, sharpness, quality) and drops its URL key. */
  applied(s: Settings, changed: keyof Settings): void;
  /** The Two players section's tables (none: no section), and what picking one does (the page opens ?duel=<id>). */
  duels?: DoorDuel[];
  openDuel?(id: string): void;
  /** Set while the page plays something else than `levels` (a duel): picking a level opens it the same way (?level=<id>). */
  openLevel?(id: string): void;
}

export function installDoor(o: DoorOptions, doc: Document = document): DoorPage {
  if (!doc.getElementById('kg-door-style')) {
    const style = doc.createElement('style');
    style.id = 'kg-door-style';
    style.textContent = DOOR_CSS;
    doc.head.append(style);
  }
  let open = false, howTo = false, advanced = false, armedReset = false, pending: string | null = null, levels: DoorLevel[] = [];
  // The Trials toggle: open from the start when the page opened on a trial, else closed (its levels uncompiled until opened).
  const trialCount = o.levels.filter((d) => isTrial(d.id)).length;
  let trialsOpen = isTrial(o.start);
  // Compiled once each (B2 and B3 take some 75 ms): the door redraws on every settings click.
  const compiled = new Map<LevelDef, CompiledLevel>();
  const compile = (d: LevelDef) => compiled.get(d) ?? compiled.set(d, compileLevel(d)).get(d)!;
  const loaded = () => o.handle.level || o.start;
  const current = () => o.levels.findIndex((l) => l.id === (pending ?? loaded()));
  const draw = () => {
    levels = doorLevels(o.levels, (id, h) => o.progress.best(id, h), compile, (d) => !trialsOpen && isTrial(d.id));
    o.root.innerHTML = doorHtml({
      levels, current: o.openLevel ? -1 : current(), settings: o.settings.current, howTo, advanced, detected: o.handle.quality?.probed ?? null, duels: o.duels ?? [],
      ...(trialCount ? { trials: { count: trialCount, open: trialsOpen } } : {}),
    });
    const reset = o.root.querySelector('[data-act="reset"]');
    if (armedReset && reset) reset.textContent = 'Click again to forget every best play';
  };
  const page: DoorPage = {
    show() { armedReset = false; draw(); o.root.classList.add('show'); doc.body.classList.add('door-open'); o.menu.style.display = 'none'; open = true; },
    hide() { o.root.classList.remove('show'); doc.body.classList.remove('door-open'); o.menu.style.display = ''; open = false; },
    get open() { return open; },
    get levels() { return levels; },
    takePending() { const p = pending; pending = null; return p; },
  };
  const pick = (i: number) => {
    const id = o.levels[i]!.id;
    if (o.openLevel) { o.openLevel(id); return; }
    page.hide();
    if (o.handle.status === 'running') { if (id !== o.handle.level) void o.handle.load(id); return; }
    pending = id === o.start ? null : id;
  };
  const set = (change: Partial<Settings>) => {
    const s = o.settings.set(change);
    o.applied(s, Object.keys(change)[0] as keyof Settings);
    draw();
  };
  o.root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const act = b.dataset.act, arg = b.dataset.arg ?? '';
    if (act !== 'reset') armedReset = false;
    switch (act) {
      case 'level': pick(Number(arg)); break;
      case 'duel':
        if (o.duels?.some((d) => d.id === arg && d.current)) page.hide(); else o.openDuel?.(arg);
        break;
      case 'close': page.hide(); break;
      case 'how':
        howTo = !howTo;
        draw();
        if (howTo) o.root.querySelector('.how')?.scrollIntoView({ block: 'nearest' });
        break;
      case 'trials':
        trialsOpen = !trialsOpen;
        draw();
        if (trialsOpen) o.root.querySelector('.trials-head')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        break;
      case 'advanced':
        advanced = !advanced;
        draw();
        if (advanced) o.root.querySelector('.advanced')?.scrollIntoView({ block: 'nearest' });
        break;
      case 'sound': set({ sound: !o.settings.current.sound }); break;
      case 'look': set({ look: arg }); break;
      case 'sharp': set({ sharp: arg === '1' ? 1 : 2 }); break;
      case 'quality': if ((QUALITY_SETTINGS as readonly string[]).includes(arg)) set({ quality: arg as QualitySetting }); break;
      case 'camera': set({ camera: arg === 'dynamic' ? 'dynamic' : 'still' }); break;
      case 'rapid': set({ rapid: arg === 'on' }); break;
      case 'duelview': set({ duelView: arg === 'on' }); break;
      case 'handoff': set({ handoff: arg === 'on' }); break;
      case 'launch': set({ launch: arg === 'level' ? 'level' : 'high' }); break;
      case 'marks': set({ marks: arg === 'on' }); break;
      case 'layout': set({ layout: arg === 'classic' ? 'classic' : 'docked' }); break;
      case 'reset':
        if (armedReset) { o.progress.reset(); armedReset = false; } else armedReset = true;
        draw();
        break;
    }
  });
  o.menu.addEventListener('click', () => page.show());
  addEventListener('keydown', (e) => {
    if (open) {
      // The door has the keyboard: the game's keys (fire, retry, levels) wait until it closes.
      e.stopPropagation();
      if (e.key === 'Escape' && (current() >= 0 || o.openLevel)) page.hide();
    } else if (e.key === 'Escape' && !document.body.classList.contains('kg-building')) {
      // (While building, Esc is the build phase's Cancel: play.ts takes it.)
      e.stopPropagation();
      page.show();
    }
  }, true);
  return page;
}
