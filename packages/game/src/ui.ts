// The game's HUD, banner and result card styles, scoped to kg-* classes so a
// page with its own styles (the viewer) can host them: one look on both pages.
// A page positions the HUD itself (the game page top left, the viewer in its
// panel column); the banner and the result card place themselves.

import { DUEL_CSS } from './duel-hud.ts';
import { LOT_CSS } from './lot-hud.ts';

export const GAME_CSS = `
  .kg-panel { position: fixed; background: rgba(17, 20, 28, 0.8); color: #e8ebf2; border-radius: 10px; padding: 12px 14px; backdrop-filter: blur(6px); }
  .kg-hud, .kg-result { font-variant-numeric: tabular-nums; }
  .kg-hud kbd, .kg-result kbd, .kg-help kbd { font: 600 11px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 3px; background: #3a4459; color: #e8ebf2; margin-right: 2px; }
  .kg-hud .bad, .kg-result .bad { color: #f0806a; } .kg-hud .hint { color: #b9c0cf; } .kg-hud .ok, .kg-result .ok { color: #8fd3b6; } .kg-hud .small, .kg-result .small { font-size: 12px; }
  body.ended .kg-hud { opacity: 0.25; }
  .kg-hud .title { font-size: 17px; font-weight: 650; margin-bottom: 4px; }
  .kg-hud .row { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
  .kg-hud .crowns { color: #f7b955; font-weight: 650; }
  .kg-hud .pace { font-size: 12px; font-weight: 650; padding: 1px 6px; border-radius: 4px; background: #3a4459; color: #9fc3ff; vertical-align: 2px; }
  .kg-hud .crowns.pop { animation: kg-pop 0.35s ease-out; }
  .kg-hud .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 6px; }
  .kg-hud .chip { font: inherit; color: inherit; border: 0; padding: 4px 8px; border-radius: 6px; background: #2b3242; cursor: pointer; }
  .kg-hud .power { display: flex; align-items: center; gap: 8px; }
  .kg-hud button.pw { font: 700 18px/1 system-ui, sans-serif; width: 36px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  .kg-hud .chip.on { background: #d8693f; }
  .kg-hud .chip.spent { opacity: 0.4; }
  .kg-hud .bar { width: 110px; height: 8px; border-radius: 4px; background: #2b3242; overflow: hidden; }
  .kg-hud .bar i { display: block; height: 100%; background: linear-gradient(90deg, #8fd3b6, #f7b955, #f0806a); }
  .kg-banner { position: fixed; top: 22%; left: 0; right: 0; text-align: center; pointer-events: none; font: 800 44px/1.45 system-ui, sans-serif; letter-spacing: 0.04em; color: #fff; text-shadow: 0 3px 18px rgba(0, 0, 0, 0.45); opacity: 0; }
  .kg-banner.show { animation: kg-banner 1.4s ease-out; }
  .kg-frozen { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); padding: 6px 18px; border-radius: 10px; background: rgba(14, 34, 64, 0.55); border: 1px solid rgba(140, 200, 255, 0.6); color: #e4f2ff; font: 600 20px/1.3 system-ui, sans-serif; letter-spacing: 0.03em; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.15s; z-index: 3; }
  .kg-frozen b { font-weight: 900; letter-spacing: 0.14em; color: #9fd4ff; }
  .kg-frozen kbd { font: inherit; font-size: 0.8em; padding: 0 5px; border: 1px solid rgba(228, 242, 255, 0.6); border-radius: 4px; }
  .kg-frozen.on { opacity: 1; }
  @media (max-width: 640px) { .kg-frozen { top: 110px; font-size: 16px; } } /* under the phone status strip, clear of the docked tray at the bottom (#244) */
  .kg-banner.crack { color: #f0806a; }
  .kg-result { top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 300px; max-height: calc(100vh - 24px); overflow-y: auto; box-sizing: border-box; display: none; padding: 20px 24px; font: 14px/1.45 system-ui, sans-serif; }
  .kg-result.show { display: block; animation: kg-rise 0.3s ease-out; }
  .kg-result .name { font-size: 22px; font-weight: 700; }
  .kg-result .sub { color: #9aa3b8; margin-bottom: 10px; }
  .kg-result .line { display: flex; justify-content: space-between; padding: 3px 0; opacity: 0; animation: kg-slam 0.25s cubic-bezier(.2,1.6,.4,1) forwards; }
  .kg-result .total { border-top: 1px solid #3a4459; margin-top: 6px; padding-top: 8px; font-size: 18px; font-weight: 700; }
  .kg-result .stamp { display: inline-block; margin: 14px 0 4px; padding: 4px 12px; border: 3px solid #f7b955; border-radius: 6px; color: #f7b955; font-size: 24px; font-weight: 900; letter-spacing: 0.08em; transform: rotate(-6deg); opacity: 0; animation: kg-stamp 0.35s cubic-bezier(.2,1.8,.4,1) forwards; }
  .kg-result .stamp.s-bogey, .kg-result .stamp.s-doublebogey, .kg-result .stamp.s-incomplete { border-color: #9aa3b8; color: #9aa3b8; }
  .kg-result .stars { font-size: 30px; color: #f7b955; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-result .gold { margin-top: 2px; font-size: 13px; color: #8a93a6; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-result .gold.got { color: #f7b955; font-weight: 700; }
  .kg-result .lost { margin-top: 2px; font-size: 13px; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-hud .lev .shot { opacity: 0.75; margin-left: 4px; line-height: 1; white-space: nowrap; }
  .kg-result .actions { display: flex; gap: 8px; margin-top: 14px; }
  .kg-result button { font: inherit; padding: 7px 12px; border: 0; border-radius: 6px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  .kg-result button.primary { background: #d8693f; }
  .kg-hud button.bank { font: inherit; padding: 4px 10px; border: 0; border-radius: 6px; background: #d8693f; color: #fff; cursor: pointer; margin-top: 6px; }
  .kg-hud button.skip { font: inherit; padding: 4px 10px; border: 1px solid #ffffff55; border-radius: 6px; background: #ffffff1a; color: #fff; cursor: pointer; margin-top: 6px; }
  .kg-hud button.freeze { font: inherit; padding: 4px 10px; border: 0; border-radius: 6px; background: #3f8fd8; color: #fff; cursor: pointer; margin-top: 6px; }
  .kg-hud .pace.frozen { background: #3f8fd8; color: #fff; }
  .kg-hud .spent { opacity: 0.4; }
  .kg-hud .down { color: #f7b955; }
  .kg-hud .down.none { color: #9aa3b8; }
  .kg-hud .lev { margin-top: 4px; }
  .kg-hud .meter { position: relative; height: 8px; margin: 6px 0 18px; border-radius: 4px; background: #434d63; box-shadow: inset 0 0 0 1px #5d6880; }
  .kg-hud .meter i { display: block; height: 100%; border-radius: 4px; background: #f7b955; transition: width 0.25s ease-out; }
  .kg-hud .meter .tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: #b8c0d0; box-shadow: 0 0 0 1px #1a1f2a; }
  .kg-hud .meter .tick.obj { top: -5px; bottom: -5px; width: 3px; margin-left: -1.5px; background: #e0a84a; }
  .kg-hud .meter .tick b { position: absolute; top: 15px; left: 50%; transform: translateX(-50%); font-size: 11px; line-height: 1; letter-spacing: -1px; white-space: nowrap; color: #b8c0d0; font-weight: 400; }
  .kg-hud .meter .tick.obj b { top: 17px; color: #e0a84a; }
  .kg-hud .meter .tick.got { background: #fff; }
  .kg-hud .meter .tick.got b { color: #f7b955; }
  .kg-hud .acts { justify-content: flex-start; gap: 8px; margin-top: 6px; }
  .kg-hud .acts.kg-tch { display: none; }
  body.kg-touch .kg-hud .acts.kg-tch { display: flex; }
  .kg-hud .acts button { font: inherit; padding: 4px 10px; border: 0; border-radius: 6px; background: #3a4459; color: #e8ebf2; cursor: pointer; box-shadow: inset 0 0 0 1px #5a6680; }
  .kg-banner.hold { opacity: 1; animation: none; }
  .kg-build { top: 52px; right: 12px; max-width: 330px; font: 13px/1.45 system-ui, sans-serif; }
  .kg-build[hidden] { display: none; }
  .kg-build summary { cursor: pointer; font-weight: 650; }
  .kg-build .edit { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .kg-build .buttons { display: flex; flex-wrap: wrap; gap: 5px; }
  .kg-build button { font: inherit; padding: 4px 8px; border: 0; border-radius: 5px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  .kg-build button.on, .kg-build button.go { background: #d8693f; color: #fff; }
  .kg-build button:disabled { color: #6b7387; cursor: default; }
  .kg-build .key { font-size: 10px; color: #9aa3b8; margin-left: 3px; }
  .kg-build button.on .key, .kg-build button.go .key { color: #ffe3d6; }
  .kg-build .snap { font-size: 12px; color: #c9cfdc; }
  .kg-build .out { font-size: 12px; min-height: 1.45em; }
  .kg-build .out.warn { color: #f5b169; }
  body.kg-touch .kg-build .key { display: none; }
  body.kg-touch .kg-build button { min-height: 40px; padding: 6px 10px; }
  @media (max-width: 640px) { .kg-build { top: auto; bottom: 12px; left: 12px; right: 12px; max-width: none; } body.kg-building #help { display: none; } }
  .kg-help button { font: inherit; padding: 0 2px; border: 0; background: none; color: #9fc3ff; cursor: pointer; }
  .kg-help button:hover { text-decoration: underline; }
  @keyframes kg-slam { from { opacity: 0; transform: scale(1.6); } to { opacity: 1; transform: scale(1); } }
  @keyframes kg-stamp { from { opacity: 0; transform: rotate(-6deg) scale(2.4); } to { opacity: 1; transform: rotate(-6deg) scale(1); } }
  @keyframes kg-rise { from { opacity: 0; transform: translate(-50%, -44%); } to { opacity: 1; transform: translate(-50%, -50%); } }
  @keyframes kg-pop { 50% { transform: scale(1.5); } }
  @keyframes kg-banner { 0% { opacity: 0; transform: scale(0.6); } 15% { opacity: 1; transform: scale(1.08); } 70% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1); } }
  @media (max-width: 640px) { .kg-banner { font-size: 30px; } }
  /* Touch (touch.ts; play.ts sets body.kg-touch): key hints go, tap targets grow, and the help says the gestures. */
  .kg-tch { display: none; }
  body.kg-touch .kg-tch { display: inline; }
  body.kg-touch button.kg-tch { display: inline-block; }
  body.kg-touch .kg-desk { display: none; }
  body.kg-touch .kg-hud kbd, body.kg-touch .kg-result kbd, body.kg-touch .kg-door kbd, body.kg-touch .kg-menu kbd { display: none; }
  /* Tap targets at least 44 px (Apple's 44 pt); the touch buttons are lighter than the panel so they read as buttons. */
  body.kg-touch .kg-hud .chip { min-height: 44px; padding: 0 14px; }
  body.kg-touch .kg-hud .chip:not(.on) { background: #3a4459; box-shadow: inset 0 0 0 1px #5a6680; }
  body.kg-touch .kg-hud button.pw { width: 44px; height: 44px; background: #3a4459; box-shadow: inset 0 0 0 1px #5a6680; font-size: 22px; }
  body.kg-touch .kg-hud button.opener, body.kg-touch .kg-hud button.bank, body.kg-touch .kg-hud button.skip, body.kg-touch .kg-hud .acts button { min-height: 44px; padding: 0 14px; margin-bottom: 8px; }
  body.kg-touch .kg-hud button, body.kg-touch .kg-result button { touch-action: manipulation; }
  body.kg-touch .kg-result button { min-height: 44px; padding: 0 16px; }
  body.kg-touch .kg-menu { min-height: 44px; min-width: 64px; }
  /* A phone (upright, or on its side with little height): the HUD compacts; upright, view.ts PORTRAIT_HUD_SHARE frames the structure below it. */
  @media (max-width: 640px), (max-height: 500px) {
    body.kg-touch .kg-hud { font-size: 12.5px; line-height: 1.35; padding: 8px 10px; }
    body.kg-touch .kg-hud .title { font-size: 14px; margin-bottom: 2px; }
    body.kg-touch .kg-hud .chips { gap: 6px; margin: 6px 0; }
    /* The lot sheet keeps its count line; its goals are on the result card (the HUD would cover the structure). */
    body.kg-touch .kg-hud .goals ul { display: none; }
  }
${LOT_CSS}${DUEL_CSS}`;

/**
 * The game page's hint line in play: the few controls a first shot needs, and where the rest are. The HUD
 * already shows the rack's keys, power (Q, E) and Bank (B), so they are left out. HELP_BUDGET caps it.
 */
export const GAME_HELP = 'click: fire · drag: orbit · wheel: zoom · <kbd>U</kbd> undo · <kbd>R</kbd> restart · <kbd>?</kbd> keys';
/** The most characters the hint line may show (its text, keys included): one line at the game page's width. */
export const HELP_BUDGET = 80;
/** Every control, for the game page's ? (and the viewer's help under Keystone rules, which has room). */
export const GAME_KEYS = 'hover: aim · click: fire · drag: orbit (the launcher follows you) · right-drag: pan · wheel: zoom · <kbd>1</kbd>–<kbd>4</kbd> ammo · <kbd>Q</kbd>/<kbd>E</kbd> power · <kbd>W</kbd>/<kbd>S</kbd> launcher up and down · hold <kbd>Space</kbd>: fast · <kbd>K</kbd> skip to the settle · <kbd>F</kbd> fire the first shot (when offered) · <kbd>B</kbd> bank (outcome levels) · <kbd>T</kbd> freeze and resume (Bullet Time levels) · <kbd>U</kbd> or <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo the last shot · <kbd>R</kbd> restart · <kbd>N</kbd>/<kbd>P</kbd> level · <kbd>M</kbd> mute';

/** The help line on a touch screen (body.kg-touch): the gestures of touch.ts; the HUD's Undo and Restart buttons do what U and R do. */
export const TOUCH_HELP = 'drag: aim · lift: fire · two fingers: turn · pinch: zoom · add a finger mid-aim: cancel';

/**
 * The game page's help panel: the desktop hint line, or every key once `?` (or its button) opens them,
 * and the touch line on a touch screen (GAME_CSS picks by body.kg-touch).
 */
export const helpHtml = (all: boolean) => `<span class="kg-desk">${all ? `${GAME_KEYS} <button data-act="keys">fewer</button>` : GAME_HELP.replace('<kbd>?</kbd> keys', '<button data-act="keys"><kbd>?</kbd> keys</button>')}</span><span class="kg-tch">${TOUCH_HELP}</span>`;

/** The help panel as the page opens: the hint line (helpHtml(false)). */
export const HELP_HTML = helpHtml(false);

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
