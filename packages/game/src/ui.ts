// The game's HUD, banner and result card styles, scoped to kg-* classes so a
// page with its own styles (the viewer) can host them: one look on both pages.
// A page positions the HUD itself (the game page top left, the viewer in its
// panel column); the banner and the result card place themselves.

import { DUEL_CSS } from './duel-hud.ts';
import { TOUCH_HELP, TOUCH_LOOK } from './hud.ts';
import { LOT_CSS } from './lot-hud.ts';
import { FUSE_CSS } from './fuse-panel.ts';

/** A phone held upright: at most this wide. Sideways: at most this tall. The docked HUD's media queries (DOCK_CSS). */
export const DOCK_PORTRAIT = '(orientation: portrait) and (max-width: 640px)';
export const DOCK_SIDEWAYS = '(orientation: landscape) and (max-height: 500px)';

/**
 * The docked phone HUD (docs/game/phone-hud.md), on a touch screen whose HUD element has kg-dock (the game
 * page's Layout setting, keystone.hud). The HUD element covers the screen without catching a touch; its two
 * groups (hud.ts hudHtml: .st status, .tray aim tray) are the panels. Upright: the status a strip at the top
 * (clear of the Menu button), the tray at the bottom. Sideways: both down a rail on the left. Rows that are
 * not live yet keep their place (lev pre, slot empty), so the HUD keeps one size through the round. The touch
 * hint and the out-of-reach warning sit just outside the tray, so they never change its size either.
 */
export const DOCK_CSS = `
  @media ${DOCK_PORTRAIT}, ${DOCK_SIDEWAYS} {
    body.kg-touch .kg-hud.kg-dock { position: fixed; inset: 0; top: 0; left: 0; min-width: 0; max-width: none; padding: 8px; box-sizing: border-box; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; border-radius: 0; pointer-events: none; display: flex; flex-direction: column; justify-content: space-between; gap: 8px; font-size: 12.5px; line-height: 1.3; }
    body.kg-touch .kg-dock > .st, body.kg-touch .kg-dock > .tray { pointer-events: auto; background: rgba(17, 20, 28, 0.8); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); border-radius: 10px; padding: 5px 10px; box-sizing: border-box; position: relative; }
    body.kg-touch .kg-dock .st .title { font-size: 14px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    body.kg-touch .kg-dock .st .custom, body.kg-touch .kg-dock .slot-row .note { display: none; }
    body.kg-touch .kg-dock .st .lev.pre { display: flex; visibility: hidden; }
    body.kg-touch .kg-dock .st .fit { justify-items: start; }
    body.kg-touch .kg-dock .fit > .sz { display: inline; visibility: hidden; }
    body.kg-touch .kg-dock .ctl .row.held { display: flex; visibility: hidden; }
    body.kg-touch .kg-dock .st .lev > span:last-child { display: inline-block; min-width: 3.4em; }
    body.kg-touch .kg-dock .st .meter { margin: 4px 0 14px; }
    body.kg-touch .kg-dock .st .goals { margin: 0; padding: 0; border: 0; }
    body.kg-touch .kg-dock .st .goals ul { display: none; }
    body.kg-touch .kg-dock .tray { display: flex; flex-direction: column; gap: 5px; flex: none; padding: 5px 8px; }
    /* The chips wrap rather than scroll one out of sight (PT30: the sideways rail's second chip, the trials' racks
       upright). A rack only loses chips as it is spent, so the tray is never taller than at the first frame (hud-size-e2e). */
    body.kg-touch .kg-dock .tray .chips { margin: 0; flex-wrap: wrap; }
    body.kg-touch .kg-dock .tray .chip { flex: none; }
    body.kg-touch .kg-dock .tray .ctl { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 10px; min-height: 44px; }
    body.kg-touch .kg-dock .tray .ctl .row > span:first-child { display: none; }
    body.kg-touch .kg-dock .tray .ctl .row { flex: 1; }
    /* PT37 (J2 #16): Power and Height named on the phone, two −/+ pairs that looked alike (their keys hidden on touch). A caption
       over the middle of each row (above the bar, above the height figure), out of the flow: the tray keeps its size (PT3's 30%). */
    body.kg-touch .kg-dock .tray .ctl > .row { position: relative; }
    /* The two pairs apart by more than the gaps inside each (second opinion: Power's + and Height's − read as one group). */
    body.kg-touch .kg-dock .tray .ctl { column-gap: 22px; }
    body.kg-touch .kg-dock .tray .ctl > .row > span:first-child { display: block; position: absolute; left: 50%; top: 1px; transform: translateX(-50%); pointer-events: none; font-size: 9px; line-height: 10px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: #c2c8d6; white-space: nowrap; }
    body.kg-touch .kg-dock .tray .ctl > .row > span:first-child kbd { display: none; }
    body.kg-touch .kg-dock .tray .ctl .launch { padding-top: 8px; }
    /* PT37 (J3 #21): a rack wider than the tray fades at its edge, with an arrow, while there is more to scroll to (play.ts sets .more). */
    body.kg-touch .kg-dock .tray { position: relative; }
    body.kg-touch .kg-dock .tray .chips.more { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 64px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 64px), transparent); }
    body.kg-touch .kg-dock .tray:has(> .chips.more)::after { content: "›"; position: absolute; right: 6px; top: 16px; width: 22px; height: 22px; border-radius: 11px; background: #3a4459; color: #e8ebf2; font: 700 15px/22px system-ui, sans-serif; text-align: center; pointer-events: none; }
    body.kg-touch .kg-dock .tray .ctl .power { flex: 1; gap: 4px; }
    body.kg-touch .kg-dock .tray .ctl .bar { flex: 1; width: auto; min-width: 48px; }
    body.kg-touch .kg-dock .tray .ctl .launch { flex: 1; text-align: center; white-space: nowrap; }
    body.kg-touch .kg-dock .tray .ctl .quake-panel { flex: 1 1 100%; min-width: 0; margin: 0; gap: 4px; }
    body.kg-touch .kg-dock .tray .ctl .qdials { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 8px; }
    body.kg-touch .kg-dock .tray .ctl .qdials .power { justify-content: space-between; }
    body.kg-touch .kg-dock .tray .ctl .qdials .compass { width: 26px; height: 26px; }
    body.kg-touch .kg-dock .tray .ctl .qv { min-width: 0; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.15; align-self: stretch; }
    /* PT25: the docked dial keeps its labels, each over its value inside the 44 px row (no line added). */
    body.kg-touch .kg-dock .tray .ctl .qv::before { content: attr(data-label); font: 500 10.5px/1.1 system-ui, sans-serif; color: #9aa3b8; }
    body.kg-touch .kg-dock .tray .ctl .qfoot { display: flex; gap: 8px; }
    body.kg-touch .kg-dock .tray .ctl .qfoot .seismo { flex: 1 1 40px; min-width: 0; width: 40px; height: 32px; }
    body.kg-touch .kg-dock .tray .ctl .qfoot .qe .bar { width: 48px; min-width: 48px; flex: none; }
    body.kg-touch .kg-dock .tray .ctl .qfoot .quake-go { min-height: 44px; }
    body.kg-touch .kg-dock .tray .ctl .qlong, body.kg-touch .kg-dock .tray .ctl .qnote { display: none; }
    /* A rack of one quake has no choice to show: its chip goes while the panel stands for it. */
    body.kg-touch .kg-dock .tray .chips.only-quake { display: none; }
    body.kg-touch .kg-dock .slot-row, body.kg-touch .kg-dock .slot-row.idle { display: flex; gap: 8px; margin: 0; }
    body.kg-touch .kg-dock .slot, body.kg-touch .kg-dock .slot.empty { display: flex; flex: 1; min-height: 44px; }
    body.kg-touch .kg-dock .slot button { flex: 1; margin: 0; }
    body.kg-touch .kg-dock .slot .skipping { flex: 1; align-self: center; text-align: center; }
    body.kg-touch .kg-dock .acts button { margin: 0; }
    body.kg-touch .kg-dock .above { position: absolute; left: 0; right: 0; bottom: 100%; margin-bottom: 6px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; pointer-events: none; }
    body.kg-touch .kg-dock .above > * { background: rgba(17, 20, 28, 0.8); border-radius: 6px; padding: 4px 8px; }
    body.kg-touch .kg-dock .tch-hint { display: block; color: #c3cad8; font-size: 12px; }
    body.kg-touch .kg-dock ~ .kg-help { display: none; }
    /*
     * The Build panel (C9, play.ts; PT18) docked: before and after building, its Build button sits under the Menu
     * button in the column the strip leaves free (upright) or at the top right (sideways). While building, the aim
     * tray goes (nothing fires until Play) and the panel takes the bottom (upright) or the right side (sideways),
     * scrolling if its rows need more; the status strip or rail stays.
     */
    body.kg-touch .kg-dock ~ .kg-build { top: 64px; right: 8px; bottom: auto; left: auto; width: auto; max-width: 68px; padding: 6px; border-radius: 10px; font-size: 12.5px; }
    body.kg-touch .kg-dock ~ .kg-build[open] > summary { display: none; }
    body.kg-touch .kg-dock ~ .kg-build[open] .edit { margin-top: 0; }
    body.kg-touch .kg-dock ~ .kg-build button { min-height: 44px; }
    body.kg-touch:not(.kg-building) .kg-dock ~ .kg-build[open] { padding: 0; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.kg-touch:not(.kg-building) .kg-dock ~ .kg-build[open] button { background: rgba(17, 20, 28, 0.85); box-shadow: inset 0 0 0 1px #5a6680; font-weight: 650; }
    body.kg-building.kg-touch .kg-dock > .tray { visibility: hidden; }
    body.kg-building.kg-touch .kg-dock ~ .kg-build { max-width: none; overflow-y: auto; overscroll-behavior: contain; padding: 8px 10px; }
    body.kg-building.kg-touch .kg-dock ~ .kg-build .edit { gap: 5px; }
    body.kg-building.kg-touch .kg-dock ~ .kg-build .buttons { gap: 5px; }
    body.kg-building.kg-touch .kg-dock ~ .kg-build button { padding: 4px 9px; }
  }
  @media ${DOCK_PORTRAIT} {
    body.kg-touch .kg-dock > .st { margin-right: 76px; display: flex; flex-wrap: wrap; column-gap: 12px; flex: none; }
    body.kg-touch .kg-dock .st > * { flex: none; }
    body.kg-touch .kg-dock .st .title, body.kg-touch .kg-dock .st .duel { flex-basis: 100%; }
    /* The Down bar beside "Shot n  Down x%", not under it: a line saved. */
    body.kg-touch .kg-dock .st .meter { flex: 1 1 110px; align-self: flex-start; margin: 5px 0 14px; }
    body.kg-touch .kg-dock .st .row { gap: 4px; justify-content: flex-start; }
    body.kg-touch .kg-dock .st .row > span:first-child { color: #9aa3b8; }
    /* The objective says itself ("bring 40% down"): its label goes, so leverage and freezes share its line. */
    body.kg-touch .kg-dock .st .obj > span:first-child { display: none; }
    body.kg-building.kg-touch .kg-dock ~ .kg-build { top: auto; left: 8px; right: 8px; bottom: 8px; max-height: 46%; }
    body.kg-touch .kg-dock .tray button.qd { width: 44px; height: 44px; }
    /*
     * PT25: while the quake is set and the action slot is idle, the panel's foot (seismograph, energy, Start) and Undo
     * and Restart share one line: the panel and the slot row are laid out as one wrap (display: contents), the idle
     * slot goes. The docked HUD then covers under 30% of an upright phone, as a launcher's does. (Upright only: the
     * sideways rail is too narrow for the foot and the buttons on one line, and has the height for both.)
     */
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) { flex-flow: row wrap; align-items: center; column-gap: 8px; }
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) > .chips { flex: 1 1 100%; }
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) > .ctl, body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) > .ctl > .quake-panel, body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) > .slot-row { display: contents; }
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) .qdials { flex: 1 1 100%; }
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) .qfoot { flex: 1 1 0; min-width: 0; }
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) .slot-row > .slot, body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) .slot-row > .note { display: none; }
    body.kg-touch .kg-dock .tray:has(.quake-panel):has(.slot-row.idle) .slot-row > .acts { flex: none; display: flex; gap: 4px; }
  }
  @media ${DOCK_SIDEWAYS} {
    body.kg-touch .kg-hud.kg-dock { right: auto; width: clamp(200px, 28vw, 250px); }
    body.kg-touch .kg-dock .tray button.qd { width: 34px; height: 34px; font-size: 15px; }
    body.kg-touch .kg-dock .tray .ctl .qdials { grid-template-columns: minmax(0, 1fr); }
    body.kg-touch .kg-dock .tray .qfoot .quake-go { min-height: 36px; }
    body.kg-touch .kg-dock > .st { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
    /* Sideways the hints go at the top, right of the rail, in the sky the opening view keeps free (view.ts TOP_MARGIN; play.ts
       dockedHud adds their box to the top inset), not over the structure's base beside the tray (PT3b). The tray (a
       backdrop-filter, so the containing block) ends 8 px above the screen's bottom: 100% + 16px - 100dvh from its top is 8 px from the screen's. */
    body.kg-touch .kg-dock .above { left: 100%; right: auto; top: calc(100% + 16px - 100vh); top: calc(100% + 16px - 100dvh); bottom: auto; margin: 0 0 0 8px; width: max-content; max-width: 50vw; }
    body.kg-building.kg-touch .kg-dock ~ .kg-build { max-height: calc(100% - 72px); width: min(340px, 42vw); box-sizing: border-box; }
  }
`;

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
  .kg-hud .bar.over i { background: #f0806a; }
  .kg-hud .quake-panel { display: grid; gap: 3px; margin-top: 4px; }
  .kg-hud .qdials { display: grid; gap: 3px; }
  .kg-hud .qfoot { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; }
  .kg-hud .qfoot .seismo { grid-column: 1 / -1; width: 100%; }
  .kg-hud .qe { display: flex; align-items: center; gap: 8px; } .kg-hud .qe b { white-space: nowrap; }
  .kg-hud button.qd { font: 700 16px/1 system-ui, sans-serif; width: 28px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  .kg-hud .qv { min-width: 58px; text-align: center; position: relative; padding-bottom: 5px; }
  .kg-hud .qticks { position: absolute; left: 4px; right: 4px; bottom: 0; width: calc(100% - 8px); height: 6px; overflow: visible; }
  .kg-hud .qticks line { stroke-width: 1.6; vector-effect: non-scaling-stroke; } .kg-hud .qticks .tc { stroke: #f7b955; } .kg-hud .qticks .tp { stroke: #7fc8f0; } .kg-hud .qticks .tv { fill: #e8ebf2; }
  .kg-hud .seismo polyline { fill: none; stroke: #f7b955; stroke-width: 1.4; } .kg-hud .seismo .axis { stroke: #3a4459; stroke-width: 1; } .kg-hud .seismo .head { stroke: #e8ebf2; stroke-width: 1.6; }
  .kg-hud .compass circle { fill: none; stroke: #3a4459; } .kg-hud .compass line { stroke: #f7b955; stroke-width: 2.2; } .kg-hud .compass .tip { fill: #f7b955; stroke: none; }
  .kg-hud button.quake-go { font: 650 14px/1 system-ui, sans-serif; padding: 8px 12px; border: 0; border-radius: 6px; background: #d8693f; color: #fff; cursor: pointer; }
  .kg-hud button.quake-go:disabled { background: #3a4459; color: #8a93a6; cursor: default; }
  body.kg-touch .kg-hud button.qd { width: 40px; height: 40px; }
  .kg-banner { position: fixed; top: 22%; left: 0; right: 0; text-align: center; pointer-events: none; font: 800 44px/1.45 system-ui, sans-serif; letter-spacing: 0.04em; color: #fff; text-shadow: 0 3px 18px rgba(0, 0, 0, 0.45); opacity: 0; }
  .kg-banner.show { animation: kg-banner 1.4s ease-out; }
  .kg-frozen { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); padding: 6px 18px; border-radius: 10px; background: rgba(14, 34, 64, 0.55); border: 1px solid rgba(140, 200, 255, 0.6); color: #e4f2ff; font: 600 20px/1.3 system-ui, sans-serif; letter-spacing: 0.03em; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.15s; z-index: 3; }
  .kg-frozen b { font-weight: 900; letter-spacing: 0.14em; color: #9fd4ff; }
  .kg-frozen kbd { font: inherit; font-size: 0.8em; padding: 0 5px; border: 1px solid rgba(228, 242, 255, 0.6); border-radius: 4px; }
  .kg-frozen.on { opacity: 1; }
  @media (max-width: 640px) { .kg-frozen { top: 110px; font-size: 16px; } } /* under the phone status strip, clear of the docked tray at the bottom (#244) */
  .kg-banner.crack { color: #f0806a; }
  /* z-index: the card is above every panel (PT21: the fuse panel drew over it), under the door (10) and the duel hand-over (30). */
  .kg-result { z-index: 5; top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 300px; max-height: calc(100vh - 24px); overflow-y: auto; box-sizing: border-box; display: none; padding: 20px 24px; font: 14px/1.45 system-ui, sans-serif; }
  .kg-result.show { display: block; animation: kg-rise 0.3s ease-out; }
  /* The docked card (layout.ts, PT4): aside on the right, below the Menu button, sliding in; its buttons stay in view while the rest scrolls. */
  .kg-result.dock { top: 64px; right: 12px; left: auto; transform: none; width: 360px; min-width: 0; max-height: calc(100% - 76px); padding-bottom: 0; }
  .kg-result.dock.show { animation: kg-slide 0.3s ease-out; }
  .kg-result.dock .actions { position: sticky; bottom: 0; margin: 14px -24px 0; padding: 10px 24px 16px; background: rgb(17, 20, 28); flex-wrap: wrap; }
  .kg-result.dock .actions [data-act="save"] { order: 1; }
  .kg-tally { top: 12px; left: 50%; transform: translateX(-50%); display: none; padding: 6px 14px; font: 14px/1.4 system-ui, sans-serif; white-space: nowrap; max-width: calc(100vw - 24px); box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
  .kg-tally.show { display: block; animation: kg-fade 0.25s ease-out; }
  .kg-tally .name { color: #9aa3b8; } .kg-tally .stars { color: #f7b955; } .kg-tally .small { color: #9aa3b8; font-size: 12px; }
  @media ${DOCK_PORTRAIT} {
    .kg-result.dock { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 58%; padding: 14px 16px 0; }
    .kg-result.dock .actions { margin: 10px -16px 0; padding: 8px 16px 12px; }
    .kg-tally { top: 8px; left: 8px; right: 84px; transform: none; max-width: none; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.kg-tallying.kg-touch .kg-dock .st > * { visibility: hidden; }
  }
  @media ${DOCK_SIDEWAYS} {
    .kg-result.dock { top: auto; bottom: 8px; right: 8px; width: min(600px, calc(100vw - 16px)); max-height: calc(100% - 64px); padding: 12px 18px 0; grid-template-columns: 1fr 1fr; column-gap: 22px; align-items: start; }
    .kg-result.dock.show { display: grid; }
    .kg-result.dock .c2 { position: sticky; top: 0; }
    .kg-result.dock .stamp { margin-top: 4px; }
    .kg-result.dock .actions { margin: 10px -18px 0 0; padding: 8px 18px 12px 0; }
  }
  /*
   * The phone strip (layout.ts card strip, PT30): the camera may not move to show the rubble, so the card keeps to the
   * band the docked HUD held (so only where it docks: a touch screen), which the opening view kept the structure out of (PT3b): the tray's band upright, the
   * rail sideways. It shows the name, stamp, stars, the reason and the buttons; Details (.full) opens the whole card,
   * tall enough that nothing in it scrolls behind its buttons. The HUD under it is hidden, not drawn through.
   */
  .kg-result .more { display: none; }
  @media ${DOCK_PORTRAIT}, ${DOCK_SIDEWAYS} {
    body.kg-touch .kg-result.strip .more { display: block; flex: none; margin: 0; }
    body.kg-touch .kg-result.strip .m-less, body.kg-touch .kg-result.strip.full .m-more { display: none; }
    body.kg-touch .kg-result.strip.full .m-less { display: inline; }
    body.kg-touch .kg-result.strip.full .more { float: right; margin: 0 0 4px 10px; }
    body.kg-touch .kg-result.strip.full .c1 > .line { clear: right; }
    /* The strip: the card's parts as one wrapping row of flex items (c1, c2 and the button row dissolve), Details among the buttons. */
    body.kg-touch .kg-result.strip.show:not(.full) { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; max-height: none; overflow: visible; padding: 8px 12px 10px; }
    body.kg-touch .kg-result.strip:not(.full) > .c1, body.kg-touch .kg-result.strip:not(.full) > .c2, body.kg-touch .kg-result.strip:not(.full) .actions { display: contents; }
    body.kg-touch .kg-result.strip:not(.full) > .c1 > :not(.name):not(.reason):not(.more), body.kg-touch .kg-result.strip:not(.full) > .c2 > :not(.stamp):not(.stars):not(.actions) { display: none; }
    body.kg-touch .kg-result.strip:not(.full) .name { order: 0; flex: 1 1 auto; min-width: 0; font-size: 17px; line-height: 1.25; }
    body.kg-touch .kg-result.strip:not(.full) .stamp { order: 2; margin: 0; padding: 1px 8px; border-width: 2px; font-size: 14px; letter-spacing: 0.05em; transform: none; animation: kg-fade 0.25s ease-out 0.1s forwards !important; }
    body.kg-touch .kg-result.strip:not(.full) .stars { order: 3; font-size: 22px; line-height: 1; animation: kg-fade 0.25s ease-out 0.2s forwards !important; }
    body.kg-touch .kg-result.strip:not(.full) .reason { order: 4; flex: 1 1 100%; margin: 0; }
    body.kg-touch .kg-result.strip:not(.full) .actions button, body.kg-touch .kg-result.strip:not(.full) .more { order: 5; flex: 1 1 auto; }
    body.kg-touch .kg-result.strip:not(.full) .more { order: 6; }
    body.kg-touch .kg-result.strip:not(.full) .actions [data-act="save"] { order: 7; }
    body.kg-touch .kg-result.strip.full { max-height: calc(100% - 16px); }
  }
  @media ${DOCK_PORTRAIT} {
    body.kg-touch:has(.kg-result.strip.show) .kg-dock > .tray { visibility: hidden; }
  }
  @media ${DOCK_SIDEWAYS} {
    body.kg-touch:has(.kg-result.strip.show) .kg-dock > * { visibility: hidden; }
    body.kg-touch .kg-result.dock.strip { top: 8px; bottom: auto; left: 8px; right: auto; }
    body.kg-touch .kg-result.dock.strip:not(.full) { width: calc(clamp(200px, 28vw, 250px) - 16px); max-height: calc(100% - 16px); overflow-y: auto; }
    body.kg-touch .kg-result.strip:not(.full) .name { flex-basis: 100%; }
    /* The whole card sideways: wide, its second column split so the lot sheet sits beside the stamp and stars, all of it above the buttons. */
    body.kg-touch .kg-result.dock.strip.full { width: calc(100vw - 104px); grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); }
    body.kg-touch .kg-result.strip.full .c2 { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); grid-template-areas: "stamp lot" "stars lot" "lost lot" "gold lot" "act act"; grid-template-rows: auto auto auto 1fr auto; column-gap: 18px; align-items: start; justify-items: start; }
    body.kg-touch .kg-result.strip.full .c2 > .stamp { grid-area: stamp; } body.kg-touch .kg-result.strip.full .c2 > .stars { grid-area: stars; }
    body.kg-touch .kg-result.strip.full .c2 > .lost { grid-area: lost; } body.kg-touch .kg-result.strip.full .c2 > .gold { grid-area: gold; }
    body.kg-touch .kg-result.strip.full .c2 > .lot { grid-area: lot; justify-self: stretch; } body.kg-touch .kg-result.strip.full .c2 > .actions { grid-area: act; justify-self: stretch; }
  }
  .kg-result .name { font-size: 22px; font-weight: 700; }
  .kg-result .sub { color: #9aa3b8; margin-bottom: 10px; }
  .kg-result .line { display: flex; justify-content: space-between; padding: 3px 0; opacity: 0; animation: kg-slam 0.25s cubic-bezier(.2,1.6,.4,1) forwards; }
  .kg-result .total { border-top: 1px solid #3a4459; margin-top: 6px; padding-top: 8px; font-size: 18px; font-weight: 700; }
  .kg-result .stamp { display: inline-block; margin: 14px 0 4px; padding: 4px 12px; border: 3px solid #f7b955; border-radius: 6px; color: #f7b955; font-size: 24px; font-weight: 900; letter-spacing: 0.08em; transform: rotate(-6deg); opacity: 0; animation: kg-stamp 0.35s cubic-bezier(.2,1.8,.4,1) forwards; }
  .kg-result .stamp.s-bogey, .kg-result .stamp.s-doublebogey, .kg-result .stamp.s-incomplete { border-color: #9aa3b8; color: #9aa3b8; }
  .kg-result .stamp.s-heritagelost { border-color: #f0806a; color: #f0806a; }
  .kg-result .stars { font-size: 30px; color: #f7b955; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-result .gold { margin-top: 2px; font-size: 13px; color: #8a93a6; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-result .gold.got { color: #f7b955; font-weight: 700; }
  .kg-result .reason { margin-top: 8px; font-size: 13px; line-height: 1.35; }
  .kg-result .lost { margin-top: 2px; font-size: 13px; opacity: 0; animation: kg-slam 0.3s ease-out forwards; }
  .kg-hud .lev .shot { opacity: 0.75; margin-left: 4px; line-height: 1; white-space: nowrap; }
  .kg-hud .lev .shot.held { visibility: hidden; }
  .kg-result .actions { display: flex; gap: 8px; margin-top: 14px; }
  .kg-result button { font: inherit; padding: 7px 12px; border: 0; border-radius: 6px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  .kg-result button.primary { background: #d8693f; }
  .kg-hud button.bank { font: inherit; padding: 4px 10px; border: 0; border-radius: 6px; background: #d8693f; color: #fff; cursor: pointer; margin-top: 6px; }
  .kg-hud button.bank.quiet { background: transparent; color: #f2a07e; box-shadow: inset 0 0 0 1.5px #b9623f; }
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
  /* The action slot (hud.ts slotAction): one button where Fire the first shot, Freeze, Resume and Bank take turns. */
  .kg-hud .slot-row { justify-content: flex-start; gap: 10px; }
  .kg-hud .slot-row .note { flex: 1; text-align: right; }
  .kg-hud .slot { display: inline-flex; gap: 8px; align-items: center; }
  .kg-hud .slot button.skip { margin-top: 0; }
  .kg-hud .slot-row.idle, .kg-hud .slot.empty, .kg-hud .lev.pre, .kg-hud .tch-hint { display: none; }
  .h-look, body.kg-nofire .h-fire { display: none; }
  /* The widest-value sizers and held aim rows (PT30) reserve space only in the docked phone HUD (DOCK_CSS), whose size
     the opening view was framed against; the desktop panel keeps its old size, which its fixed WIDE_HUD guess was set for. */
  .kg-hud .fit { display: inline-grid; justify-items: end; } .kg-hud .fit > * { grid-area: 1 / 1; } .kg-hud .fit > .sz { display: none; font-style: normal; }
  .kg-hud .ctl .row.held { display: none; }
  body.kg-nofire .h-look { display: inline; }
  body.kg-touch .kg-hud .slot-row.idle { display: flex; }
  .kg-hud .acts { gap: 8px; }
  .kg-hud .acts.kg-tch { display: none; }
  body.kg-touch .kg-hud .acts.kg-tch { display: flex; }
  .kg-hud .acts button { font: inherit; padding: 4px 10px; border: 0; border-radius: 6px; background: #3a4459; color: #e8ebf2; cursor: pointer; box-shadow: inset 0 0 0 1px #5a6680; }
  .kg-hud .acts button.ico { font: 700 22px/1 system-ui, sans-serif; padding: 0; }
  .kg-hud button:disabled { opacity: 0.35; cursor: default; }
  .kg-banner.hold { opacity: 1; animation: none; }
  .kg-build { top: 52px; right: 12px; max-width: 330px; font: 13px/1.45 system-ui, sans-serif; }
  .kg-build[hidden] { display: none; }
  .kg-build summary { cursor: pointer; font-weight: 650; }
  .kg-build .edit { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .kg-build .buttons { display: flex; flex-wrap: wrap; gap: 5px; }
  .kg-build button { font: inherit; padding: 4px 8px; border: 0; border-radius: 5px; background: #2b3242; color: #e8ebf2; cursor: pointer; }
  /* Play (go) is the one orange button; the tool and item held (on) are filled in the accent, as the door's segmented controls (PT18). */
  .kg-build button.go { background: #d8693f; color: #fff; }
  .kg-build button.on { background: #9fc3ff; color: #11141c; }
  .kg-build button:disabled { color: #6b7387; cursor: default; }
  .kg-build .key { font-size: 10px; color: #9aa3b8; margin-left: 3px; }
  .kg-build button.go .key { color: #ffe3d6; }
  .kg-build button.on .key { color: #3a4459; }
  .kg-build .snap { font-size: 12px; color: #c9cfdc; }
  .kg-build .out { font-size: 12px; min-height: 1.45em; }
  .kg-build .out.warn { color: #f5b169; }
  body.kg-touch .kg-build .key { display: none; }
  body.kg-touch .kg-build button { min-height: 40px; padding: 6px 10px; }
  @media (max-width: 640px) { .kg-build { top: auto; bottom: 12px; left: 12px; right: 12px; max-width: none; } body.kg-building #help { display: none; } }
  .kg-help .h-build, .kg-help .h-mason, body.kg-building .kg-help .h-play, body.kg-building .kg-help .h-mason, body.kg-mason .kg-help .h-play { display: none; }
  body.kg-building:not(.kg-touch) .kg-help .h-build, body.kg-mason:not(.kg-building):not(.kg-touch) .kg-help .h-mason { display: inline; }
  .kg-help button { font: inherit; padding: 0 2px; border: 0; background: none; color: #9fc3ff; cursor: pointer; }
  .kg-help button:hover { text-decoration: underline; }
  @keyframes kg-slam { from { opacity: 0; transform: scale(1.6); } to { opacity: 1; transform: scale(1); } }
  @keyframes kg-stamp { from { opacity: 0; transform: rotate(-6deg) scale(2.4); } to { opacity: 1; transform: rotate(-6deg) scale(1); } }
  @keyframes kg-slide { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
  @keyframes kg-fade { from { opacity: 0; } to { opacity: 1; } }
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
  body.kg-touch .kg-hud button.opener, body.kg-touch .kg-hud button.bank, body.kg-touch .kg-hud button.freeze, body.kg-touch .kg-hud button.skip { min-height: 44px; padding: 0 14px; margin-bottom: 8px; }
  body.kg-touch .kg-hud .acts button { width: 44px; height: 44px; margin-bottom: 8px; }
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
  /* The dud note (PT31, play.ts noteShot): one amber line over where a shot that moved nothing was aimed. */
  .kg-note { position: fixed; z-index: 35; pointer-events: none; transform: translate(-50%, -100%); max-width: min(80vw, 420px); padding: 5px 12px; border-radius: 6px; background: rgba(20, 24, 33, 0.86); border: 1px solid rgba(240, 184, 90, 0.5); font: 600 15px/1.3 system-ui, sans-serif; color: #f4c77a; text-align: center; opacity: 0; }
  .kg-note.show { animation: kg-note 3.2s ease-out; }
  @keyframes kg-note { 0% { opacity: 0; margin-top: 0; } 8% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; margin-top: -24px; } }
${DOCK_CSS}${LOT_CSS}${DUEL_CSS}${FUSE_CSS}`;

/**
 * The game page's hint line in play: the few controls a first shot needs, and where the rest are. The HUD
 * already shows the rack's keys, power (Q, E) and Bank (B), so they are left out. HELP_BUDGET caps it.
 */
export const GAME_HELP = 'click: fire · drag: orbit · wheel: zoom · <kbd>U</kbd> undo · <kbd>R</kbd> restart · <kbd>?</kbd> keys';
/** The hint line while building (C9's build phase, body.kg-building): what the pointer and keys do to pieces. */
export const BUILD_HELP = 'click: place · drag: orbit · <kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>[</kbd>/<kbd>]</kbd> slide · <kbd>Z</kbd> undo · <kbd>Enter</kbd> play';
/** The hint line on a Mason's Trial level out of the build phase (body.kg-mason): nothing fires; F tests, B builds. */
export const MASON_HELP = 'drag: orbit · wheel: zoom · <kbd>F</kbd> test · <kbd>B</kbd> build · <kbd>R</kbd> restart · <kbd>?</kbd> keys';
/** The most characters the hint line may show (its text, keys included): one line at the game page's width. */
export const HELP_BUDGET = 80;
/** Every control, for the game page's ? (and the viewer's help under Keystone rules, which has room). */
export const GAME_KEYS = 'hover: aim · click: fire · drag: orbit (the launcher follows you) · right-drag: pan · wheel: zoom · <kbd>1</kbd>–<kbd>4</kbd> ammo · <kbd>Q</kbd>/<kbd>E</kbd> power · <kbd>W</kbd>/<kbd>S</kbd> launcher up and down · hold <kbd>Space</kbd>: fast · <kbd>K</kbd> skip to the settle · <kbd>F</kbd> fire the first shot (when offered) · <kbd>B</kbd> bank (outcome levels) · <kbd>T</kbd> freeze and resume (Bullet Time levels) · <kbd>U</kbd> or <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo the last shot · building: <kbd>Q</kbd>/<kbd>E</kbd> turn, <kbd>T</kbd> tip, <kbd>[</kbd>/<kbd>]</kbd> slide, <kbd>Z</kbd> undo, <kbd>Enter</kbd> play · <kbd>R</kbd> restart · <kbd>N</kbd>/<kbd>P</kbd> level · <kbd>M</kbd> mute';

/**
 * A Siege Table duel's hint line and keys (PT34): no undo and no restart in a hot-seat match, whose turns are the two
 * players'; R is the result card's Rematch.
 */
export const DUEL_HELP = 'click: fire · drag: orbit · wheel: zoom · <kbd>?</kbd> keys';
export const DUEL_KEYS = 'hover: aim · click: fire · drag: orbit (the launcher follows you) · right-drag: pan · wheel: zoom · <kbd>1</kbd>–<kbd>4</kbd> ammo · <kbd>Q</kbd>/<kbd>E</kbd> power · <kbd>W</kbd>/<kbd>S</kbd> launcher up and down · hold <kbd>Space</kbd>: fast · <kbd>K</kbd> skip to the settle · <kbd>R</kbd> rematch (once the duel is over) · <kbd>M</kbd> mute';

/** The help line on a touch screen (hud.ts, where the docked HUD shows it above its tray until the first shot). */
export { TOUCH_HELP };

/**
 * The game page's help panel: the desktop hint line, or every key once `?` (or its button) opens them,
 * and the touch line on a touch screen (GAME_CSS picks by body.kg-touch). In a duel, its own (DUEL_HELP, DUEL_KEYS).
 */
const keysButton = (h: string) => h.replace('<kbd>?</kbd> keys', '<button data-act="keys"><kbd>?</kbd> keys</button>');
export const helpHtml = (all: boolean, duel = false) => (all
  ? `<span class="kg-desk">${duel ? DUEL_KEYS : fireSpan(GAME_KEYS)} <button data-act="keys">fewer</button></span>`
  // The hint line by what the page is doing (GAME_CSS shows one): playing, building, or a Mason level between builds.
  // A duel neither builds nor tests, so only its own play line (no undo or restart anywhere in it).
  : duel ? `<span class="kg-desk h-play">${keysButton(DUEL_HELP)}</span>`
  : `<span class="kg-desk h-play">${fireSpan(keysButton(GAME_HELP))}</span><span class="kg-desk h-build">${BUILD_HELP}</span><span class="kg-desk h-mason">${keysButton(MASON_HELP)}</span>`) + `<span class="kg-tch"><span class="h-fire">${TOUCH_HELP}</span><span class="h-look">${TOUCH_LOOK}</span></span>`;

/**
 * The help's words about firing, in a span a mode with no shot to fire hides (body.kg-nofire, set from the level's
 * HudProfile.fire: Fuse & Fold, Aftershock, Rube Lab; PT23). The touch line has a second wording for those modes.
 */
const fireSpan = (h: string) => h.replace(/(hover: aim · )?click: fire · /, (m) => `<span class="h-fire">${m}</span>`);

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
