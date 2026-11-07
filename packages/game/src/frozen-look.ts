// Bullet Time's frozen look (playtest PT8: "a frozen world looks exactly like a
// running one; the only sign is a small blue FROZEN chip"). While a shot is
// frozen (key T) and PaceFeel.frozenLook is on (keystone.frozenlook, default 1):
//
//   grade   the renderer's post grade (@tb/render post.ts frozenGrade): colour
//           drained and cooled, an ice-blue rim at the frame's edge, eased in
//           over FROZEN_IN_S and out over FROZEN_OUT_S of wall time.
//   sparks  thinned out as the grade comes in, none drawn at full grade, and
//           hanging (the frame's dt is 0 while frozen), so the breach the
//           player wants to fire into shows; they come back where they hung
//           when the world resumes. Heat glow eases to FROZEN_HEAT of itself.
//   label   a large "FROZEN · aim and fire" at the top of the screen (the
//           bottom on a narrow one, clear of the HUD), with how to resume.
//   keep    (PT33, PaceFeel.frozenAim, keystone.frozenaim, default on) what
//           the player aims at is not graded: crowns, heritage, the fired ball
//           and the aim's preview write a keep mask in the scene's alpha
//           (@tb/render fx.ts KEEP_ALPHA), and play.ts holds the aim while
//           frozen with no pointer (the last spot, else a crown, else the
//           middle of the frame). docs/game/bullet-time-undercut-polish.md.
//
// Alternatives weighed: a CSS filter on the canvas (free, but readback captures,
// the tests and the agent playtests would not show it). For the sparks, the
// judges' "about 30% opacity": additive streaks this far over white do not dim
// that way (a hundredth of their brightness still saturates where they overlap,
// and a twentieth of them at a twentieth of it still covers half of a near
// burst; @tb/render render.test.ts), so they thin to none instead; sparks
// running on in wall time burn out within 1.2 s, but the first second is the
// one the player aims in. The look is drawn only: physics, rules and replays
// are untouched.

/** Seconds the grade takes to come in, and to go when the world resumes. */
export const FROZEN_IN_S = 0.15;
export const FROZEN_OUT_S = 0.12;
/** Heat glow brightness at full grade (judge J2 #7: about 30%). */
export const FROZEN_HEAT = 0.3;

/** The grade after `dt` seconds of easing from `g` toward `target` (0 or 1), linear. */
export function easeGrade(g: number, target: number, dt: number): number {
  return target > g ? Math.min(target, g + dt / FROZEN_IN_S) : Math.max(target, g - dt / FROZEN_OUT_S);
}

/** What the renderer is given for grade `g` (Renderer.freezeFx); keep: what the player aims at stays in colour (PT33, keystone.frozenaim). */
export const freezeFxOf = (g: number, keep = true) => ({ grade: g, sparks: 1 - g, heat: 1 - (1 - FROZEN_HEAT) * g, keep });

/** The label's markup: what to do now, and how to resume (T on a keyboard, the Resume button on a touch screen). */
export const FROZEN_LABEL = '<b>FROZEN</b> · aim and fire<span class="kg-desk"> · <kbd>T</kbd> resumes</span><span class="kg-tch"> · Resume to go on</span>';
