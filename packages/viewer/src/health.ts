// The HUD's view of the engine's limits (PhysicsEngine.health): a row per
// limit with the most a step needed against the room there is, and, once a
// limit has changed the physics (the GPU pair buffer dropped contacts), its
// sentence in red and a button that rebuilds the engine with the fix.
import { type EngineHealth, type EngineLimit, limitsHit } from '@tb/engine-api';
import { escapeHtml } from './html.ts';
import { withOption } from './params.ts';

/** How often the page reads the engine's limits: off the step path, and soon enough to warn within a moment. */
export const HEALTH_MS = 500;

/** What the HUD calls a limit. */
const LIMIT_NAMES: Record<string, string> = { pairs: 'pair slots' };

/** The engine spec the fix rebuilds with (spec with the fix's option set), or null when no limit hit has a fix. */
export function limitFix(h: EngineHealth | null, spec: string): string | null {
  const fix = limitsHit(h).find((l) => l.fix)?.fix;
  return fix ? withOption(spec, fix.option, fix.value) : null;
}

/** The HUD's rows for h ('' for an engine without health() or before its first read), and the warning with the fix's button. */
export function limitsHtml(h: EngineHealth | null, spec: string): string {
  if (!h) return '';
  // Red for a limit that changed the physics, amber for one that only cost speed.
  const tone = (l: EngineLimit) => (l.steps === 0 ? 'muted' : l.effect === 'physics' ? 'bad' : 'warn');
  const rows = h.limits.map((l) => `<div class="row"><span>${escapeHtml(LIMIT_NAMES[l.id] ?? l.id)}</span><span class="${tone(l)}">${l.peak.toLocaleString()} / ${l.room.toLocaleString()}</span></div>`);
  const hit = limitsHit(h).map((l) => `<div class="bad">${escapeHtml(l.message)}</div>`);
  const fix = limitsHit(h).find((l) => l.fix)?.fix;
  const button = fix ? [`<div class="buttons"><button data-fix="${escapeHtml(limitFix(h, spec)!)}">Rebuild with ${escapeHtml(`${fix.option}=${fix.value}`)}</button></div>`] : [];
  return [...rows, ...hit, ...button].join('\n      ');
}
