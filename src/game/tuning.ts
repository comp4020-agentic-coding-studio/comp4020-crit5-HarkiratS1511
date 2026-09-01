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

// Slowed from 260. The old pace read as one flat sprint with no beats, made
// the ballistic range long enough that downhill gaps cost no ink at all, and
// left no room for the chaser to sit close without being lethal.
export const RUN_SPEED = 185;        // px/s, constant and scripted
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
// Just under RUN_SPEED. Clean running regains ground slowly, drawing
// surrenders it, and a well-angled launch is the real recovery. Close enough
// that the chaser is on screen and meant.
export const CHASER_SPEED = 172;     // px/s
export const CHASER_RADIUS = 16;

// Raised from 1150. At 1150 the levels demanded near-optimal drawing: the
// minimum possible line set left 5-7% slack, and a scripted player drawing
// only 16px wider per gap than theoretical ran dry on every level. A person
// draws nowhere near the minimum.
// Raised again for spike fields: clearing one needs a ramp up, a span over,
// and a way down, which costs roughly 300px of line that the gap arithmetic
// never accounted for. Without this, levels 1 and 3 became unwinnable the
// moment hazards appeared.
export const MAX_INK = 2050;         // px of line the player may draw in total
export const INK_PER_PIXEL = 1;      // cost = polyline length * this
export const PICKUP_AMOUNT = 260;
export const PICKUP_RADIUS = 26;

/** Time scale while the pointer is held. The chaser is exempt (it walks in
 *  real time), so this is purely the price of thinking: lower means finer
 *  drawing control but more ground surrendered per second held. */
export const SLOWMO_SCALE = 0.16;

/** Minimum pointer travel before a new point is appended to a stroke. Keeps
 *  polylines cheap and stops jitter inflating ink cost. */
export const STROKE_POINT_SPACING = 6;

/** How high the runner will hoist itself over an obstruction in its path.
 *  A hand-drawn stroke almost always ends in a small vertical wobble, and
 *  without this the runner stops dead against its own line and stands there
 *  until the chaser arrives — which reads as the game breaking, not as a
 *  mistake the player made. Generous enough to forgive a wobble, too small
 *  to climb a deliberate wall. */
export const STEP_UP_MAX = 7;

/** Falling below this many px under the lowest ground is a loss. Kept small
 *  deliberately: at 400 the runner died far below the view and the losing
 *  screen showed an empty world, giving the player no visible cause of death
 *  in a game that is not allowed to explain itself in words. At this depth
 *  the fall is still legible on screen when it kills. */
export const FALL_KILL_DEPTH = 90;

/** No forward progress for this long, while grounded, means the runner has
 *  wedged against something and is never getting out. It dies instead of
 *  standing there waiting for the chaser, which the player reads as the game
 *  hanging rather than as a mistake they made. */
export const STUCK_SECONDS = 0.9;

/** How far ahead of the player the demonstrating ghost begins. */
export const GHOST_LEAD = 300;

/** The chaser is held in a band behind the runner rather than run at a fixed
 *  speed. A fixed speed cannot satisfy both halves of what a chase needs: fast
 *  enough to stay on screen and be meant, and slow enough that the run is not
 *  over in two strokes. Measured: at a flat 172px/s with a 170px head start,
 *  a single 0.9s draw costs 128px, so the second draw was fatal.
 *
 *  Outside the band the chaser closes or eases to return to it. Inside it, it
 *  simply runs. The band never applies while the player is drawing — slow
 *  motion is real time for the chaser, with no reprieve — so sustained
 *  dithering still kills, which is the whole point of it. */
export const CHASE_BAND_FAR = 330;   // px: further than this, it sprints in

/** Cruise speed as a fraction of RUN_SPEED, while the player is simply
 *  running. Well under 1 so that clean running genuinely buys back the ground
 *  a draw costs: at the old 172px/s the player regained 13px/s but surrendered
 *  142px/s while drawing, so the sum could only ever go one way. */
export const CHASE_CRUISE = 0.8;

/** Sprint fraction, used only when it has fallen outside the band. This is
 *  what stops it becoming the distant rumour the playtester never saw. */
export const CHASE_SPRINT = 1.2;

/** The chaser's own time scale while the player draws, against the world's
 *  SLOWMO_SCALE. Higher than the world's, so the chaser visibly gains ground
 *  during a draw; far below 1, so it does not devour the run.
 *
 *  Measured the hard way: with the chaser on FULL real time a 0.9s stroke cost
 *  128px of ground while gaps sit ~250px apart, and level 2 has 26 gaps —
 *  3300px surrendered over a level, which no cruise speed can buy back. The
 *  second stroke of the game was fatal. At this scale a stroke costs about a
 *  third of that, and clean running between gaps genuinely repays it. */
export const CHASE_DRAW_SCALE = 0.45;

/** Seconds the frozen world stays visible after a run ends, before the end
 *  screen begins. Without it the losing overlay flooded the frame inside a
 *  tenth of a second and the player never saw the chaser actually reach them,
 *  so the death read as arbitrary and early. The simulation is already stopped
 *  during this hold, so it is purely the moment of contact, held. */
export const IMPACT_HOLD = 0.55;

/** Contact is judged at this fraction of the summed collision radii. The
 *  drawn bodies are narrower than their collision circles, so touching at the
 *  full sum registered while a visible sliver of daylight remained between
 *  them. */
export const CONTACT_TIGHTEN = 0.72;

/** How long the chaser tolerates being blocked before it stops respecting the
 *  player's ink and walks straight through it.
 *
 *  Found in playtest: because the chaser follows the player's drawn path, a
 *  vertical stroke behind you walls it in permanently, and the rest of the
 *  course can be walked at leisure. Since it collides with strokes exactly as
 *  the runner does, anything that blocks the runner blocks it too — so the
 *  fix cannot be geometric. It breaks through instead: your ink stops it for
 *  a moment, never for good. */
export const CHASER_BREAK_SECONDS = 1.1;

/** Forward progress, in px, that clears a stall timer. Generous on purpose:
 *  a body pinned against a wall bounces, and with a small epsilon that jitter
 *  reads as progress and resets the very timer meant to catch it. Measured: a
 *  penned chaser oscillated ~5px per frame and sat at 0.4-0.7s forever against
 *  a 4px threshold. Anything genuinely moving covers well over 100px in a
 *  stall window, so a coarse threshold costs nothing. */
export const STALL_PROGRESS_EPS = 24;

/** How tall a spike field stands above the ground it sits on. The runner's
 *  centre rides RUNNER_RADIUS above the surface, so anything taller than that
 *  cannot be walked through and must be drawn over. */
export const SPIKE_HEIGHT = 30;
