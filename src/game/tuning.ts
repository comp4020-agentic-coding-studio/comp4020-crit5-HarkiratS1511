// Every feel-affecting number lives here, so Sprint 6 tuning is one file.
// World units are pixels at the reference height below; the camera scales.

export const REFERENCE_HEIGHT = 540;
/** Least horizontal sightline, in world px, any viewport may show. Scaling by
 *  height alone gave the 390x844 phone ~249px — narrower than two gap widths,
 *  with no run-up visible and no way to see a gap coming. Scaling purely by
 *  width instead shrank the figures to specks. So: scale by height, and drop
 *  the scale only as far as this floor demands. Desktop is unaffected. */
export const MIN_SIGHTLINE = 700;

/** Where the ground sits down the screen, as a fraction of viewport height.
 *  Without an explicit vertical anchor the ground floats with the scale — it
 *  sat at 78% on desktop and 20% on the phone, which is how the same build
 *  looked composed at one marked viewport and broken at the other. */
export const GROUND_SCREEN_FRACTION = 0.72;

export const RUN_SPEED = 260;        // px/s, constant and scripted
// Raised from 1500 after auditing the built game: at 1500 the ballistic range
// was long enough that five of eight gaps could be cleared with no ink at all,
// and ramp launches carried even further — so most gaps were not the
// spend-or-save decision the design rests on. Heavier gravity shortens every
// arc and tames the launch.
export const GRAVITY = 1500;         // px/s^2
export const MAX_FALL_SPEED = 1400;  // px/s, prevents tunneling at terminal velocity
export const RUNNER_RADIUS = 12;

// Well under RUN_SPEED: running must build a cushion big enough to spend on
// thinking. At 232 the cushion grew by only 28px/s and the whole skill window
// was half a second per stroke — measured, not guessed.
export const CHASER_SPEED = 170;     // px/s
export const CHASER_RADIUS = 16;

export const MAX_INK = 900;          // px of line the player may draw in total
export const INK_PER_PIXEL = 1;      // cost = polyline length * this
export const PICKUP_AMOUNT = 220;
export const PICKUP_RADIUS = 18;

/** Time scale while the pointer is held. The chaser is exempt (it walks in
 *  real time), so this is purely the price of thinking: lower means finer
 *  drawing control but more ground surrendered per second held. */
export const SLOWMO_SCALE = 0.35;

/** Minimum pointer travel before a new point is appended to a stroke. Keeps
 *  polylines cheap and stops jitter inflating ink cost. */
export const STROKE_POINT_SPACING = 6;

/** How high the runner will hoist itself over an obstruction in its path.
 *  A hand-drawn stroke almost always ends in a small vertical wobble, and
 *  without this the runner stops dead against its own line and stands there
 *  until the chaser arrives — which reads as the game breaking, not as a
 *  mistake the player made. Generous enough to forgive a wobble, too small
 *  to climb a deliberate wall. */
export const STEP_UP_MAX = 16;

/** Falling below this many px under the lowest ground is a loss. Kept small
 *  deliberately: at 400 the runner died far below the view and the losing
 *  screen showed an empty world, giving the player no visible cause of death
 *  in a game that is not allowed to explain itself in words. At this depth
 *  the fall is still legible on screen when it kills. */
export const FALL_KILL_DEPTH = 90;
