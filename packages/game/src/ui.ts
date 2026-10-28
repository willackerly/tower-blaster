// The game's HUD, banner and result card styles, scoped to kg-* classes so a
// page with its own styles (the viewer) can host them: one look on both pages.
// A page positions the HUD itself (the game page top left, the viewer in its
// panel column); the banner and the result card place themselves.

export const GAME_CSS = `
  .kg-panel { position: fixed; background: rgba(17, 20, 28, 0.8); color: #e8ebf2; border-radius: 10px; padding: 12px 14px; backdrop-filter: blur(6px); }
  .kg-hud, .kg-result { font-variant-numeric: tabular-nums; }
  .kg-hud kbd, .kg-result kbd, .kg-help kbd { font: 600 11px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 3px; background: #3a4459; color: #e8ebf2; margin-right: 2px; }
  .kg-hud .bad, .kg-result .bad { color: #f0806a; } .kg-hud .ok, .kg-result .ok { color: #8fd3b6; } .kg-hud .small, .kg-result .small { font-size: 12px; }
  body.ended .kg-hud { opacity: 0.25; }
  .kg-hud .title { font-size: 17px; font-weight: 650; margin-bottom: 4px; }
  .kg-hud .row { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
  .kg-hud .crowns { color: #f7b955; font-weight: 650; }
  .kg-hud .crowns.pop { animation: kg-pop 0.35s ease-out; }
  .kg-hud .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 6px; }
  .kg-hud .chip { padding: 4px 8px; border-radius: 6px; background: #2b3242; }
  .kg-hud .chip.on { background: #d8693f; }
  .kg-hud .chip.spent { opacity: 0.4; }
  .kg-hud .bar { width: 110px; height: 8px; border-radius: 4px; background: #2b3242; overflow: hidden; }
  .kg-hud .bar i { display: block; height: 100%; background: linear-gradient(90deg, #8fd3b6, #f7b955, #f0806a); }
  .kg-banner { position: fixed; top: 22%; left: 0; right: 0; text-align: center; pointer-events: none; font: 800 44px/1.45 system-ui, sans-serif; letter-spacing: 0.04em; color: #fff; text-shadow: 0 3px 18px rgba(0, 0, 0, 0.45); opacity: 0; }
  .kg-banner.show { animation: kg-banner 1.4s ease-out; }
  .kg-banner.crack { color: #f0806a; }
  .kg-result { top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 300px; display: none; padding: 20px 24px; font: 14px/1.45 system-ui, sans-serif; }
  .kg-result.show { display: block; animation: kg-rise 0.3s ease-out; }
  .kg-result .name { font-size: 22px; font-weight: 700; }
  .kg-result .sub { color: #9aa3b8; margin-bottom: 10px; }
  .kg-result .line { display: flex; justify-content: space-between; padding: 3px 0; opacity: 0; animation: kg-slam 0.25s cubic-bezier(.2,1.6,.4,1) forwards; }
  .kg-result .total { border-top: 1px solid #3a4459; margin-top: 6px; padding-top: 8px; font-size: 18px; font-weight: 700; }
  .kg-result .stamp { display: inline-block; margin: 14px 0 4px; padding: 4px 12px; border: 3px solid #f7b955; border-radius: 6px; color: #f7b955; font-size: 24px; font-weight: 900; letter-spacing: 0.08em; transform: rotate(-6deg); opacity: 0; animation: kg-stamp 0.35s cubic-bezier(.2,1.8,.4,1) forwards; }
  .kg-result .stamp.s-bogey, .kg-result .stamp.s-doublebogey, .kg-result .stamp.s-incomplete { border-color: #9aa3b8; color: #9aa3b8; }
  .kg-result .stars { font-size: 30px; color: #f7b955; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-result .actions { display: flex; gap: 8px; margin-top: 14px; }
  .kg-result button { font: inherit; padding: 7px 12px; border: 0; border-radius: 6px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  .kg-result button.primary { background: #d8693f; }
  @keyframes kg-slam { from { opacity: 0; transform: scale(1.6); } to { opacity: 1; transform: scale(1); } }
  @keyframes kg-stamp { from { opacity: 0; transform: rotate(-6deg) scale(2.4); } to { opacity: 1; transform: rotate(-6deg) scale(1); } }
  @keyframes kg-rise { from { opacity: 0; transform: translate(-50%, -44%); } to { opacity: 1; transform: translate(-50%, -50%); } }
  @keyframes kg-pop { 50% { transform: scale(1.5); } }
  @keyframes kg-banner { 0% { opacity: 0; transform: scale(0.6); } 15% { opacity: 1; transform: scale(1.08); } 70% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1); } }
  @media (max-width: 640px) { .kg-banner { font-size: 30px; } }
`;

/** The help line for the game's controls (the game page's, and the viewer's under Keystone rules). */
export const GAME_HELP = 'hover: aim · click: fire · drag: orbit (the launcher follows you) · wheel: zoom · <kbd>1</kbd>–<kbd>4</kbd> ammo · <kbd>Q</kbd>/<kbd>E</kbd> power · hold <kbd>Space</kbd>: fast · <kbd>R</kbd> retry · <kbd>N</kbd>/<kbd>P</kbd> level · <kbd>M</kbd> mute';

/** Add GAME_CSS to the document once. */
export function installGameStyles(doc: Document = document): void {
  if (doc.getElementById('kg-style')) return;
  const style = doc.createElement('style');
  style.id = 'kg-style';
  style.textContent = GAME_CSS;
  doc.head.append(style);
}

/** A banner and a result card for playKeystone, appended to parent (the HUD is the page's to place). */
export function gameOverlays(parent: HTMLElement = document.body): { banner: HTMLElement; result: HTMLElement } {
  const banner = document.createElement('div'), result = document.createElement('div');
  banner.className = 'kg-banner';
  result.className = 'kg-panel kg-result';
  parent.append(banner, result);
  return { banner, result };
}
