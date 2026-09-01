// Every feel-affecting number lives here, so Sprint 6 tuning is one file.
// World units are pixels at the reference height below; the camera scales.

export const REFERENCE_HEIGHT = 540;

export const RUN_SPEED = 260;        // px/s, constant and scripted
export const GRAVITY = 1500;         // px/s^2
export const MAX_FALL_SPEED = 1400;  // px/s, prevents tunneling at terminal velocity
export const RUNNER_RADIUS = 12;

export const CHASER_SPEED = 232;     // px/s, slightly under RUN_SPEED so clean play gains
export const CHASER_RADIUS = 16;

export const MAX_INK = 900;          // px of line the player may draw in total
export const INK_PER_PIXEL = 1;      // cost = polyline length * this
export const PICKUP_AMOUNT = 220;
export const PICKUP_RADIUS = 18;

/** Time scale while the pointer is held. The world still moves, so camping
 *  loses ground to the chaser rather than being free thinking time. */
export const SLOWMO_SCALE = 0.18;

/** Minimum pointer travel before a new point is appended to a stroke. Keeps
 *  polylines cheap and stops jitter inflating ink cost. */
export const STROKE_POINT_SPACING = 6;

/** Falling below this many px under the lowest ground is a loss. */
export const FALL_KILL_DEPTH = 400;
