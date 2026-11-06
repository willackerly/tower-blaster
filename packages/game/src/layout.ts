// Where the HUD and the result card sit (docs/game/phone-hud.md; agent playtest
// PT3 and PT4). One Advanced setting, Layout, says docked (the default) or
// classic; three URL keys say each part for a visit, and the URL wins:
//   keystone.hud=dock|panel     a phone's HUD: docked (status strip and aim tray upright, a side rail
//                               sideways) or the one panel at the top left as before
//   keystone.card=dock|center   the result card: docked aside (right on a wide screen, bottom upright,
//                               two columns sideways) or centred as before
//   keystone.carddelay=<s>      seconds of wall time from the round's end to the card, the tallying
//                               banner showing meanwhile (0 to 10; docked default 1.2, classic 0)

/** The Layout setting: docked (Will away, PT3 and PT4 recommended), or classic (the panel and the centred card, at once). */
export type LayoutSetting = 'docked' | 'classic';
export const LAYOUT_SETTINGS: readonly LayoutSetting[] = ['docked', 'classic'];

export interface Layout {
  /** A phone's HUD docked (kg-dock: status strip and aim tray, or a side rail) or the panel. */
  hud: 'dock' | 'panel';
  /** The result card docked aside (kg-result dock) or centred. */
  card: 'dock' | 'center';
  /** Wall-time seconds from the round's end (its settle) to the card; the tallying banner shows meanwhile. */
  cardDelay: number;
}

/** The card's wait after the settle when docked: the agent playtest's "about 1.2 s", time to see the debris land. */
export const CARD_DELAY_S = 1.2;
/** The longest card wait a URL may ask for. */
export const MAX_CARD_DELAY_S = 10;

/** The URL keys that say what the Layout setting says, dropped from the URL when the setting changes. */
export const LAYOUT_KEYS = ['keystone.hud', 'keystone.card', 'keystone.carddelay'] as const;

/** What a Layout setting means with no URL keys. */
export function layoutFor(setting: LayoutSetting): Layout {
  return setting === 'docked' ? { hud: 'dock', card: 'dock', cardDelay: CARD_DELAY_S } : { hud: 'panel', card: 'center', cardDelay: 0 };
}

/** The layout in effect: each URL key where it says (a bad value is refused, naming the key), else the setting's. */
export function layoutOf(q: URLSearchParams, setting: LayoutSetting): Layout {
  const out = layoutFor(setting);
  const hud = q.get('keystone.hud'), card = q.get('keystone.card'), delay = q.get('keystone.carddelay');
  if (hud !== null) {
    if (hud !== 'dock' && hud !== 'panel') throw new Error(`keystone.hud must be dock or panel: ${hud}`);
    out.hud = hud;
  }
  if (card !== null) {
    if (card !== 'dock' && card !== 'center') throw new Error(`keystone.card must be dock or center: ${card}`);
    out.card = card;
  }
  if (delay !== null) {
    const s = /^\d+(\.\d+)?$/.test(delay) ? Number(delay) : NaN;
    if (!(s >= 0 && s <= MAX_CARD_DELAY_S)) throw new Error(`keystone.carddelay must be seconds from 0 to ${MAX_CARD_DELAY_S}: ${delay}`);
    out.cardDelay = s;
  }
  return out;
}

/** Screen shares (0..1) along each edge that the HUD covers: what the opening camera keeps the structure clear of. */
export interface ScreenInsets { top: number; bottom: number; left: number; right: number }

/** A box on screen, in CSS px (a DOMRect's fields). */
export interface ScreenBox { x: number; y: number; w: number; h: number }

/**
 * The insets a set of HUD boxes takes from a vw x vh screen (docs/game/phone-hud.md, camera framing). A box at
 * least `wide` of the screen's width is a band across it, at the top or the bottom by its centre; a narrower box
 * touching the left or right quarter is a rail on that side. Each edge's inset is the furthest any box reaches in.
 */
export function hudInsets(boxes: readonly ScreenBox[], vw: number, vh: number, wide = 0.6): ScreenInsets {
  const out: ScreenInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const b of boxes) {
    if (!(b.w > 0 && b.h > 0)) continue;
    if (b.w >= wide * vw) {
      if (b.y + b.h / 2 < vh / 2) out.top = Math.max(out.top, (b.y + b.h) / vh);
      else out.bottom = Math.max(out.bottom, (vh - b.y) / vh);
    } else if (b.x < vw / 4) out.left = Math.max(out.left, (b.x + b.w) / vw);
    else if (b.x + b.w > (3 * vw) / 4) out.right = Math.max(out.right, (vw - b.x) / vw);
  }
  for (const k of ['top', 'bottom', 'left', 'right'] as const) out[k] = Math.min(1, Math.max(0, out[k]));
  return out;
}
