// Every feel-affecting number lives here, so Sprint 6 tuning is one file.
// World units are pixels at the reference height below; the camera scales.

export const REFERENCE_HEIGHT = 540;
/** Horizontal sightline, in world px, that every viewport must show. Scaling
 *  by height alone gave the 390x844 phone only ~249px of world width — less
 *  than two gap widths, with no run-up visible. Scaling by width instead
 *  keeps the sightline constant and leaves 1920x1080 pixel-identical. */
export const REFERENCE_WIDTH = 960;

export const RUN_SPEED = 260;        // px/s, constant and scripted
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

/** Falling below this many px under the lowest ground is a loss. */
export const FALL_KILL_DEPTH = 400;
