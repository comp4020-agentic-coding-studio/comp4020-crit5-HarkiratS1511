// The campaign: four hand-authored levels, each with its own silhouette.
//
// Playtest verdict that drove the previous rewrite: "same levels all across
// make it different levels, make the levels longer" and "the downhill gap
// feels like a bug". Playtest verdict that drove THIS one: the world "reads
// as one flat strip". It did. Every platform was authored flat, at one of a
// handful of heights, and the only shape in the terrain was a 15px sine
// ripple laid over a 420px baseline — a straight line with a wobble. The
// answer here is not a bigger ripple. It is authored relief: ramps, terraces,
// ledges and towers, so the ground itself climbs and falls by hundreds of
// pixels and the player is drawing UPHILL RAMPS and DOWNHILL BRIDGES rather
// than one flat span after another.
//
// COORDINATE CONVENTION (from types.ts / tuning.ts): +x right, +y DOWN.
// "Higher" ground = smaller y. "Lower" ground = larger y. `dy` below always
// means (landingY - takeoffY): positive = landing LOWER, negative = HIGHER.
//
// -----------------------------------------------------------------------
// THE CAMERA BAND (why the relief is 400px and not 4000px)
// -----------------------------------------------------------------------
// render.ts pins the camera vertically: cameraYFor() returns
// `level.groundY - viewHeightWorld * GROUND_SCREEN_FRACTION` — it does NOT
// follow the runner up or down. At the marked desktop viewport (1920x1080)
// worldScale is 2 and the view is 540 world px tall, so the visible band is
//
//   [groundY - 389, groundY + 151]
//
// and the ink bar sits over the top ~20 world px of it. Terrain outside that
// band is terrain the player cannot see. (The levels this replaces ran to
// y = -504 and y = 595 against groundY = 420: the whole back half of level 1
// was drawn above the top of the screen.) So every level here is authored
// inside
//
//   CEILING = GROUND_Y - 280 = 140   ...   FLOOR = GROUND_Y + 125 = 545
//
// which is a 405px window: wide enough for real climbs and real pits, and
// entirely on screen at both marked viewports. Two consequences worth
// stating, because both are load-bearing:
//   * `groundY` is the camera anchor AND the spawn height AND (in
//     scenery.ts) the height the finish flag is planted at. So every level
//     starts and ends on ground at exactly GROUND_Y — the flag stands on the
//     ground it is drawn on, and the runner spawns on solid ground.
//   * Relief is cheap and gaps are expensive. Elevation delivered by a
//     terrain ramp inside a platform costs the player nothing; elevation
//     delivered by a gap has to be paid for in ink. Both are used, but the
//     ink arithmetic below only ever has to account for the second.
// -----------------------------------------------------------------------
//
// -----------------------------------------------------------------------
// SAFETY (requirement: no gap may be crossable without drawing)
// -----------------------------------------------------------------------
// The runner leaves a ledge at RUN_SPEED horizontally with ~0 vertical
// speed (any residual vertical speed is zeroed by ground contact the frame
// before) and then falls under GRAVITY. A gap whose far side is LOWER can,
// in principle, be crossed ballistically for free if the fall carries the
// runner across the width before it drops below the landing height. A gap
// whose far side is level or HIGHER can never be crossed this way (gravity
// only pulls down), so only the "landing is lower" case (dy > 0) needs a
// deliberate width margin.
//
// The free-fall horizontal range to drop a height `dy` is, from
// y = 0.5*GRAVITY*t^2 and x = RUN_SPEED*t:
//
//   R(dy) = RUN_SPEED * sqrt(2*dy / GRAVITY)
//
// Every dy>0 gap in this file is built with width well above R(dy) using
// `downhillWidth(dy, margin)` below (exported, and re-checked against every
// authored drop in level.test.ts). The margin is generous — 70-90px on top
// of R(dy) — to absorb the runner's collision radius and the swept-circle
// endpoint capsule (which can catch a falling body slightly before it
// reaches the platform's nominal corner). This is verified empirically, not
// just by the formula: every (width, dy) pair used below is run through the
// real physics (createState/step, no strokes) in level.test.ts, twice —
// once in isolation, and once ON THE REAL LEVEL, entering the gap over
// whatever terrain actually precedes it. That second check is new and it
// matters here: this file now has ramps, and a ramp is a launcher.
//
// That empirical check also turned up a SECOND failure mode the formula
// above misses entirely: a gap narrower than roughly the runner's own
// diameter (2*RUNNER_RADIUS = 24px, measured floor ~27px) can never fail to
// be "touching" ground, flat or not, because the circle is wider than the
// hole. Every real gap here is at least 90px wide, and the one 30px notch
// in level 0 is pre-bridged by the teaching stub.
//
// THE FLAT LIP RULE. Both simulations above are only representative if the
// runner arrives at a lip the way the test drives it: level, at RUN_SPEED,
// with no vertical velocity. A ramp running straight off a lip would break
// that — an uphill ramp launches the runner UPWARD, which extends the arc
// well past R(dy). So every gap in this file has at least LIP_FLAT = 140px
// of dead-flat ground immediately before its takeoff edge and immediately
// after its landing edge. All relief happens in the interior of a platform,
// never at its ends. level.test.ts asserts this directly for every gap.
// -----------------------------------------------------------------------
//
// -----------------------------------------------------------------------
// CLIMB LIMIT (requirement: every gap must ALSO be crossable WITH a line)
// -----------------------------------------------------------------------
// The SAFETY section above only proved gaps can't be crossed for free. A
// later integration pass found the missing inverse: several uphill (dy<0)
// gaps could not be crossed even by a hand-drawn line, because the straight
// edge-to-edge bridge was steeper than the runner can actually climb. The
// auto-run rule (advance() in world.ts sets vel.x = RUN_SPEED every grounded
// frame, independent of slope) plus gravity plus the STEP_UP_MAX assist
// together impose a real, empirically-measured ceiling on climbable slope
// that has no clean closed form (it is NOT simply "45 degrees" or
// "width >= rise" — that was a guess, and wrong).
//
// Measured directly (an isolated two-platform level with a single pre-drawn
// bridging stroke at a given (width, rise), run through the real
// createState/step loop, binary-searching the critical angle — the
// measurement is re-run on every test run, in level.test.ts, rather than
// trusted as a constant):
//
//   CRITICAL ANGLE = 60.00000 degrees, i.e. rise/width = tan(60) = sqrt(3)
//                    ~= 1.73205, and this is INVARIANT across gap widths
//                    from 40px to 200px (checked at 40, 46, 50, 60, 80,
//                    100, 130, 160, 200 -- identical to 5 decimal places).
//
// Above this ratio the runner's forward progress collapses to zero and the
// STUCK_SECONDS watchdog in world.ts kills it in place -- exactly the
// "pins against the line until the chaser arrives" bug that was reported.
// Below it, crossing time degrades gracefully (no cliff-edge slowdown right
// up to the limit), so the risk is purely "did we exceed 60 degrees", not
// "is a safe-looking angle secretly too slow."
//
// Every climbing (dy<0) gap in this file is built well below 1.73205. The
// campaign uses the ratio as a difficulty dial, and it escalates:
//
//   level 0   no climbing gaps at all (its relief is all terrain ramp)
//   level 1   0.65 - 0.67   (~33 degrees: a walkable ramp)
//   level 2   1.14 - 1.23   (~49-51 degrees: a scramble up a tower face)
//   level 3   1.19 - 1.22   (~50 degrees, but 2.5x the rise of level 1)
//
// The steepest thing the campaign ever asks for is ratio 1.23, which is 71%
// of the measured limit — steep enough to read as a cliff face, with a third
// of the limit still in hand for whatever a real physics tick or a human's
// imperfect line adds. Every (width, rise) pair used below is confirmed
// climbable by direct simulation in level.test.ts (given exactly the
// straight bridging line, the runner reaches the far side).
//
// Terrain ramps INSIDE platforms are held far below all of this — nothing
// authored here exceeds 0.48 (~26 degrees) uphill — because a terrain ramp
// is scenery the runner must walk unaided, not a problem it is being asked
// to solve.
// -----------------------------------------------------------------------

import { GRAVITY, PICKUP_AMOUNT, RUN_SPEED } from "./tuning";
import type { Hazard, Level, Pickup, Segment, Stroke, Vec2 } from "./types";

export const LEVEL_COUNT = 4;

/** Baseline: spawn height, finish height, and the camera's vertical anchor.
 *  Every level starts and ends here (see THE CAMERA BAND above). */
const GROUND_Y = 420;

/** The authored relief window. Terrain outside it is off screen at the
 *  marked desktop viewport; see THE CAMERA BAND above. */
export const CEILING_Y = GROUND_Y - 280; // 140: highest ground the campaign uses
export const FLOOR_Y = GROUND_Y + 125; // 545: lowest ground the campaign uses

/** Dead-flat ground required immediately either side of every gap edge, so
 *  the runner always takes off and lands level. See THE FLAT LIP RULE. */
export const LIP_FLAT = 140;

/** Free-fall horizontal range for a drop of `dy`: R(dy) above. */
export function ballisticRange(dy: number): number {
  return dy <= 0 ? 0 : RUN_SPEED * Math.sqrt((2 * dy) / GRAVITY);
}

/** The narrowest a dy>0 gap may be and still be uncrossable without ink:
 *  the ballistic range plus a margin for the runner's radius and the swept
 *  capsule. Every drop authored below is at or above downhillWidth(dy, 70),
 *  which level.test.ts re-checks alongside the simulation. */
export function downhillWidth(dy: number, margin: number): number {
  return ballisticRange(dy) + margin;
}

// ---------------------------------------------------------------------------
// AUTHORING HELPERS
//
// A platform is a polyline of nodes with strictly increasing x. Consecutive
// nodes become ground segments, so a platform can climb, fall and level off
// inside itself; the space between the last node of one platform and the
// first node of the next is a gap. This replaces the previous
// "flat segments + a sine transform applied afterwards" scheme, which could
// only ever produce a rippled strip, and which moved the ground out from
// under hazards and pickups after they had been placed.
// ---------------------------------------------------------------------------
type Node = Vec2;

function pt(x: number, y: number): Node {
  return { x, y };
}

function chain(nodes: Node[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < nodes.length - 1; i++) out.push({ a: nodes[i], b: nodes[i + 1] });
  return out;
}

function ground(platforms: Node[][]): Segment[] {
  return platforms.flatMap(chain);
}

/** A gentle rise and fall across [x0,x1] on base `y`, cresting `amp` above
 *  it. Texture for a long flat run, never an obstacle: the steepest section
 *  is amp*0.62 over a quarter of the span, which at the amplitudes used here
 *  is under 0.12 (~7 degrees). Both endpoints sit exactly on `y`, so a swell
 *  can be spliced into a platform without moving anything either side of it.
 *  Kept clear of gap lips and hazard pads by LIP_FLAT. */
function swell(x0: number, x1: number, y: number, amp: number): Node[] {
  const w = x1 - x0;
  return [
    pt(x0, y),
    pt(x0 + w * 0.25, y - amp * 0.62),
    pt(x0 + w * 0.5, y - amp),
    pt(x0 + w * 0.75, y - amp * 0.58),
    pt(x1, y),
  ];
}

/** A spike field standing on flat ground at `y`. Authored explicitly (the
 *  old scanner guessed at "long flat segments", which silently produced no
 *  hazards at all the moment platforms stopped being long and flat). Every
 *  field below sits on a pad with at least LIP_FLAT of flat ground either
 *  side of it and well clear of any gap edge, so the line that clears it —
 *  ramp up, span over, ramp down — always has level ground to start and
 *  finish on. Asserted in level.test.ts. */
function spikes(x: number, y: number, width = 92): Hazard {
  return { x, width, y };
}

function pickup(x: number, y: number): Pickup {
  // 18px of clearance: inside the 38px collection reach (RUNNER_RADIUS +
  // PICKUP_RADIUS) with room to spare, and visibly sitting on the ground.
  return { pos: { x, y: y - 18 }, amount: PICKUP_AMOUNT, taken: false };
}

// =========================================================================
// LEVEL 0 — "The Terrace": gentle, teaching. Wide flat run-ins, a handful
// of forgiving flat chasms, and relief delivered entirely by long, shallow
// terrain ramps between terraces.
// =========================================================================
//
// Silhouette: a staircase of broad terraces, dropping once to a low shelf
// (480) and then stepping up to a high terrace (280) before returning to
// the baseline for the finish. 200px of elevation across the level, all of
// it walked rather than drawn: the player's own strokes here are seven
// straightforward flat spans and one shallow downhill bridge, which is the
// whole point of the opening level.
//
// It is also the only level carrying the teaching apparatus:
//   * the pre-drawn `stub` over a 30px notch at 660, so the player SEES a
//     drawn line and its effect before being asked to make one;
//   * the demonstrating ghost (world.ts spawns it on level 0 only), which
//     runs 300px ahead, crosses the stub, and falls into the first real gap
//     at 1010 in plain view;
//   * render.ts's drawDemoStroke, which traces the answer across that same
//     first unbridged gap. Both depend on the first real gap being early,
//     flat and visible: it is at 1010, 55px wide, dy 0, with 320px of flat
//     run-in — the ghost dies there when the runner is at x=710, i.e. 300px
//     short of the lip and well inside drawDemoStroke's 620px window.
function buildLevel0(): Level {
  const startX = 0;
  const chaserStartX = -170;

  const platforms: Node[][] = [
    // Run-up: 660px of it before the notch, flat where the ghost and the
    // demonstration need it, with one shallow swell for texture.
    [pt(-770, 420), ...swell(60, 510, 420, 18), pt(660, 420)],
    // -- teaching notch, 660..690 (30px): bridged by `stub` below --
    [pt(690, 420), pt(1010, 420)],
    // -- gap 1, 1010..1065 (55px, flat): the first real decision --
    [pt(1065, 420), pt(1245, 420), pt(1585, 352), pt(1745, 352)], // climbs 68 over 340 (0.20)
    // -- gap 2, 1745..1855 (110px, flat) --
    [pt(1855, 352), pt(2035, 352), pt(2415, 480), pt(2615, 480)], // falls 128 over 380 (0.34)
    // -- gap 3, 2615..2815 (200px, flat), onto the low shelf --
    [pt(2815, 480), pt(3315, 480), pt(3655, 376), pt(3915, 376)], // spike field; climbs 104 over 340 (0.31)
    // -- gap 4, 3915..4175 (260px, flat) --
    [pt(4175, 376), pt(4355, 376), pt(4675, 280), pt(4975, 280)], // climbs 96 over 320 (0.30)
    // -- gap 5, 4975..5275 (300px, DROPS 70): the one downhill bridge --
    [pt(5275, 350), pt(5495, 350), pt(5855, 420), pt(6215, 420)], // falls 70 over 360 (0.19)
    // -- gap 6, 6215..6575 (360px, flat) --
    [pt(6575, 420), pt(7055, 420)],
    // -- gap 7, 7055..7575 (520px, flat): the widest chasm in the campaign
    //    that is only a chasm — no height to read, just ink to commit --
    [pt(7575, 420), pt(8000, 420)],
  ];

  // Teaching stub: a small pre-drawn bump across the notch, so the player
  // SEES the shape and effect of a drawn line before ever being asked to
  // draw one themselves. The notch (30px) is narrower than every real gap
  // (55px minimum), so even without the stub it would be a near-miss rather
  // than a threat — though per the SAFETY note above its flat 30px is still
  // over the ~27px diameter-crossing floor, so it would genuinely need a
  // line.
  const stubPoints: Vec2[] = [
    { x: 660, y: 420 },
    { x: 675, y: 410 },
    { x: 690, y: 420 },
  ];
  const stub: Stroke = {
    points: stubPoints,
    segments: [
      { a: stubPoints[0], b: stubPoints[1] },
      { a: stubPoints[1], b: stubPoints[2] },
    ],
  };

  return {
    groundSegments: ground(platforms),
    hazards: [spikes(3020, 480)], // mid-pad on the 500px low shelf, 205px clear of the lip
    pickups: [
      pickup(3800, 376), // on the run-in to gap 4 (260px)
      pickup(6050, 420), // on the run-in to gap 6 (360px)
      pickup(6800, 420), // on the run-in to gap 7 (520px, the big one)
    ],
    startX,
    chaserStartX,
    finishX: 7960,
    index: 0,
    groundY: GROUND_Y,
    stub,
  };
}
/*
 * LEVEL 0 INK ARITHMETIC (MAX_INK = 2050, PICKUP_AMOUNT = 260)
 * Cheapest bridge per gap is the straight edge-to-edge line, hypot(w, dy):
 *   gap  width   dy   cost
 *    1     55     0     55.0
 *    2    110     0    110.0
 *    3    200     0    200.0
 *    4    260     0    260.0
 *    5    300   +70    308.1
 *    6    360     0    360.0
 *    7    520     0    520.0
 *                     -------
 *                      1813.1
 * Spike fields cost ink too, and the cheapest shape that clears one is a
 * ramp up, a span over and a ramp down: 2*hypot(100, SPIKE_HEIGHT+10) +
 * width + 12 = 2*107.7 + 92 + 12 = 319.4 per field. One field here:
 *   1813.1 + 319.4 = 2132.5  minimal total ink for the level
 * 2132.5 > MAX_INK (2050): the level is NOT beatable on starting ink alone,
 * so the three pickups are not decoration. 3 * 260 = 780, and the teaching
 * stub is charged against the player's well at spawn (createState), costing
 * 36.1, so the real budget is 2050 - 36.1 + 780 = 2793.9.
 *   headroom = 2793.9 - 2132.5 = 661.4, i.e. 31% over the theoretical
 *   minimum line set.
 * That headroom is the point, not slack: nobody draws the minimum. Charging
 * a realistic hand — every line 15% longer than optimal plus 20px of
 * overshoot at each end — costs 1.15*2132.5 + 8*20 = 2612.4, which still
 * fits inside 2793.9 with 181 to spare. level.test.ts checks exactly that
 * sum for every level. Length: 7960 - 0 = 7960px.
 * Elevation: 280 (high terrace) .. 480 (low shelf) = 200px of relief.
 */

// =========================================================================
// LEVEL 1 — "The Stair": a staircase up to a high plateau, a long span
// across the top, then a staircase back down.
// =========================================================================
//
// Silhouette: unmistakable — five flat plateaus stepping UP (420 -> 160),
// a long level run at altitude, then four stepping DOWN (160 -> 420). No
// ramps anywhere: every change in height is a step the player has to draw,
// so this is the level that teaches the two diagonal strokes the rest of
// the campaign is built from. The ascent is gentle (ratio 0.65-0.67, ~33
// degrees, half the measured climb limit); the descent introduces the
// downhill bridge, where the danger is not the slope but the SAFETY floor —
// each drop is sized well past R(dy) so falling into it is never a shortcut.
//
// The 480px span across the high plateau (gap 5) is the campaign's first
// ink-economy problem: a single stroke costing more than a quarter of the
// starting well, with no height to help and nothing to do but commit.
function buildLevel1(): Level {
  const startX = 0;
  const chaserStartX = -150;

  const platforms: Node[][] = [
    [pt(-750, 420), ...swell(120, 610, 420, 16), pt(760, 420)],
    // -- gap 1, 760..850 (90px, CLIMBS 60; ratio 0.67) --
    [pt(850, 360), pt(1350, 360)], // spike field at 1050
    // -- gap 2, 1350..1445 (95px, CLIMBS 65; ratio 0.68) --
    [pt(1445, 295), pt(1845, 295)],
    // -- gap 3, 1845..1945 (100px, CLIMBS 65; ratio 0.65) --
    [pt(1945, 230), pt(2445, 230)], // spike field at 2130
    // -- gap 4, 2445..2550 (105px, CLIMBS 70; ratio 0.67) --
    [pt(2550, 160), pt(3200, 160)], // the high plateau, dead level
    // -- gap 5, 3200..3680 (480px, flat, at altitude): the ink problem --
    [pt(3680, 160), pt(4180, 160)],
    // -- gap 6, 4180..4330 (150px, DROPS 70) --
    [pt(4330, 230), pt(4780, 230)],
    // -- gap 7, 4780..4940 (160px, DROPS 70) --
    [pt(4940, 300), pt(5390, 300)],
    // -- gap 8, 5390..5560 (170px, DROPS 60) --
    [pt(5560, 360), pt(6010, 360)],
    // -- gap 9, 6010..6190 (180px, DROPS 60): back to the baseline --
    [pt(6190, 420), pt(6700, 420)],
  ];

  return {
    groundSegments: ground(platforms),
    hazards: [spikes(1050, 360), spikes(2130, 230)],
    pickups: [
      pickup(1700, 295), // on the second step
      pickup(2900, 160), // on the high plateau, funding the 480px span
      pickup(3950, 160), // on the far side of it, funding the descent
      pickup(5150, 300), // midway down the stair
    ],
    startX,
    chaserStartX,
    finishX: 6640,
    index: 1,
    groundY: GROUND_Y,
    stub: null,
  };
}
/*
 * LEVEL 1 INK ARITHMETIC (MAX_INK = 2050, PICKUP_AMOUNT = 260)
 *   gap  width   dy    ratio   cost
 *    1     90   -60     0.67   108.2
 *    2     95   -65     0.68   115.1
 *    3    100   -65     0.65   119.3
 *    4    105   -70     0.67   126.2
 *    5    480     0      —     480.0
 *    6    150   +70      —     165.5
 *    7    160   +70      —     174.6
 *    8    170   +60      —     180.3
 *    9    180   +60      —     189.7
 *                             -------
 *                              1658.9
 * Every climb ratio is at most 0.68, 39% of the measured 1.732 limit.
 * Every drop is far past its ballistic floor: R(70) = 56.5 against 150 and
 * 160 wide; R(60) = 52.3 against 170 and 180 wide — 94-128px of margin.
 * Two spike fields at 319.4 each = 638.8:
 *   1658.9 + 638.8 = 2297.7  minimal total ink
 * 2297.7 > MAX_INK (2050): starting ink alone is not enough. 4 * 260 = 1040
 * gives a budget of 3090, i.e. 792.3 of headroom (34% over the minimum).
 * A realistic hand (15% longer lines, 20px overshoot each): 1.15*2297.7 +
 * 11*20 = 2862.4, inside 3090 with 228 to spare.
 * Length: 6640px. Elevation: 160 (plateau) .. 420 (baseline) = 260px.
 */

// =========================================================================
// LEVEL 2 — "The Towers": three towers climbed in two steep steps each,
// with the ink on top and long flat ground in between.
// =========================================================================
//
// Silhouette: a skyline. Three narrow high ledges (180, 165, 150 — the
// highest ground in the campaign) rising off a low plain at 445, each
// reached by two consecutive steep climbing gaps (ratio 1.14-1.23, roughly
// 50 degrees: this is the level where a drawn line stops being a ramp and
// becomes a cliff face), and left by walking down the tower's far shoulder
// and bridging one wide drop back to the plain.
//
// The tower tops carry the ink. That is the level's whole risk argument:
// the climb is two expensive diagonals and a big drop off the far side —
// roughly 585 of ink per tower — and the pickup at the top is worth 260,
// so the high line is not free money, it is the line that keeps you solvent
// on a level that cannot be finished on its starting well. Between towers
// the plain runs long and flat, with a short gap and (once) a 320px span to
// keep the ink draining while nothing is happening vertically.
function buildLevel2(): Level {
  const startX = 0;
  const chaserStartX = -130;

  const platforms: Node[][] = [
    [pt(-730, 420), pt(240, 420), pt(540, 445), pt(700, 445)], // eases down onto the plain
    // -- gap 1, 700..810 (110px, CLIMBS 125; ratio 1.14) --
    [pt(810, 320), pt(1120, 320)], // tower 1, first ledge
    // -- gap 2, 1120..1235 (115px, CLIMBS 140; ratio 1.22) --
    [pt(1235, 180), pt(1565, 180), pt(1855, 320), pt(2005, 320)], // tower 1 top, then down its shoulder
    // -- gap 3, 2005..2205 (200px, DROPS 125): off the shoulder --
    [pt(2205, 445), pt(2705, 445)], // spike field at 2400
    // -- gap 4, 2705..2805 (100px, flat) --
    [pt(2805, 445), pt(3105, 445)],
    // -- gap 5, 3105..3425 (320px, flat): the span across the plain --
    [pt(3425, 445), pt(3685, 445)],
    // -- gap 6, 3685..3797 (112px, CLIMBS 130; ratio 1.16) --
    [pt(3797, 315), pt(4087, 315)], // tower 2, first ledge
    // -- gap 7, 4087..4209 (122px, CLIMBS 150; ratio 1.23) --
    [pt(4209, 165), pt(4549, 165), pt(4839, 315), pt(4989, 315)], // tower 2 top
    // -- gap 8, 4989..5189 (200px, DROPS 130) --
    [pt(5189, 445), pt(5689, 445)], // spike field at 5380
    // -- gap 9, 5689..5839 (150px, flat) --
    [pt(5839, 445), pt(6089, 445)],
    // -- gap 10, 6089..6204 (115px, CLIMBS 135; ratio 1.17) --
    [pt(6204, 310), pt(6494, 310)], // tower 3, first ledge
    // -- gap 11, 6494..6624 (130px, CLIMBS 160; ratio 1.23): the steepest
    //    line the campaign ever asks for, still 71% of the limit --
    [pt(6624, 150), pt(6984, 150), pt(7274, 310), pt(7424, 310)], // tower 3 top, the campaign's high point
    // -- gap 12, 7424..7629 (205px, DROPS 135) --
    [pt(7629, 445), pt(7769, 445), pt(8049, 420), pt(8249, 420)], // back to baseline for the flag
  ];

  return {
    groundSegments: ground(platforms),
    hazards: [spikes(2400, 445), spikes(5380, 445)],
    pickups: [
      pickup(940, 320), // tower 1, first ledge
      pickup(1400, 180), // tower 1 top
      pickup(2620, 445), // on the plain, before the short gap
      pickup(3000, 445), // on the run-in to the 320px span
      pickup(3900, 315), // tower 2, first ledge
      pickup(4380, 165), // tower 2 top
      pickup(5600, 445), // on the plain
      pickup(6350, 310), // tower 3, first ledge
      pickup(6800, 150), // tower 3 top: the highest ink in the campaign
    ],
    startX,
    chaserStartX,
    finishX: 8200,
    index: 2,
    groundY: GROUND_Y,
    stub: null,
  };
}
/*
 * LEVEL 2 INK ARITHMETIC (MAX_INK = 2050, PICKUP_AMOUNT = 260)
 *   gap  width   dy    ratio   cost
 *    1    110  -125     1.14   166.4
 *    2    115  -140     1.22   181.2
 *    3    200  +125      —     235.8
 *    4    100     0      —     100.0
 *    5    320     0      —     320.0
 *    6    112  -130     1.16   171.6
 *    7    122  -150     1.23   193.3
 *    8    200  +130      —     238.5
 *    9    150     0      —     150.0
 *   10    115  -135     1.17   177.4
 *   11    130  -160     1.23   206.2
 *   12    205  +135      —     245.5
 *                             -------
 *                              2385.9
 * Climbs top out at 1.23 (71% of the 1.732 limit). Drops clear their
 * ballistic floors by 123-127px: R(125) = 75.5 vs 200 wide, R(130) = 77.0
 * vs 200, R(135) = 78.5 vs 205.
 * Two spike fields at 319.4 = 638.8:
 *   2385.9 + 638.8 = 3024.7  minimal total ink
 * 3024.7 > MAX_INK (2050) by 974.7 — the largest shortfall in the campaign,
 * which is why this level carries nine pickups and puts three of them on
 * tower tops. 9 * 260 = 2340, budget 4390, headroom 1365.3 (45% over the
 * minimum). A realistic hand: 1.15*3024.7 + 14*20 = 3758.4, inside 4390.
 *
 * That formula uses a straight edge-to-edge bridge; the real scripted-hand
 * playthrough in level.test.ts draws a slightly longer line (aimed past
 * both lips, per bridgeLine's OVERSHOOT) and THEN applies the 15% surcharge
 * on top of that already-longer line, which compounds to a few px more per
 * stroke than this formula estimates. At the original seven pickups that
 * compounding was enough to run the level dry (verified by simulation, not
 * just this arithmetic) — the two extra pickups here (tower 2's first
 * ledge, tower 3's first ledge) closed exactly that gap and are sized from
 * the real playthrough, not from this formula alone.
 * Missing all three tower-top pickups leaves 2050 + 1560 = 3610 > 3024.7,
 * so the low line is survivable on the theoretical minimum and nothing
 * else: that is the intended squeeze, not an oversight.
 * Length: 8200px. Elevation: 150 (tower 3) .. 445 (the plain) = 295px.
 */

// =========================================================================
// LEVEL 3 — "The Cliffs": alternating deep drops and steep climbs, ending
// on one long span. The finale.
// =========================================================================
//
// Silhouette: a sawtooth, and the widest one in the campaign — 365px from
// the pit floors (545, the lowest ground anywhere) to the last ledge (180).
// Nine gaps alternate strictly: drop, climb, drop, climb... each swinging
// 125-165px of height, with terrain ramps between them stealing back extra
// altitude for free so the sawtooth climbs as it goes. Then everything
// stops for gap 10: a 480px flat span at the baseline, the campaign's last
// stroke, drawn on whatever ink is left.
//
// Both hazards sit at the bottom of pits, where the player has just landed
// a downhill bridge and has the least room to think.
function buildLevel3(): Level {
  const startX = 0;
  const chaserStartX = -110;

  const platforms: Node[][] = [
    [pt(-710, 420), pt(700, 420)],
    // -- gap 1, 700..850 (150px, DROPS 125): straight into the first pit --
    [pt(850, 545), pt(1350, 545)], // pit floor: the lowest ground in the campaign
    // -- gap 2, 1350..1480 (130px, CLIMBS 155; ratio 1.19) --
    [pt(1480, 390), pt(1880, 390)],
    // -- gap 3, 1880..2040 (160px, DROPS 130) --
    [pt(2040, 520), pt(2480, 520)],
    // -- gap 4, 2480..2600 (120px, CLIMBS 145; ratio 1.21) --
    [pt(2600, 375), pt(2900, 375), pt(3190, 285), pt(3340, 285)], // free altitude: 90 over 290 (0.31)
    // -- gap 5, 3340..3505 (165px, DROPS 140) --
    [pt(3505, 425), pt(4005, 425)], // spike field at 3700
    // -- gap 6, 4005..4130 (125px, CLIMBS 150; ratio 1.20) --
    [pt(4130, 275), pt(4430, 275), pt(4720, 195), pt(4870, 195)], // free altitude: 80 over 290 (0.28)
    // -- gap 7, 4870..5040 (170px, DROPS 150) --
    [pt(5040, 345), pt(5540, 345)], // spike field at 5290
    // -- gap 8, 5540..5675 (135px, CLIMBS 165; ratio 1.22): the last climb --
    [pt(5675, 180), pt(6075, 180)], // the high ledge, and the ink on it
    // -- gap 9, 6075..6250 (175px, DROPS 165): the deepest single fall --
    [pt(6250, 345), pt(6650, 345), pt(6950, 420), pt(7150, 420)], // eases back to the baseline
    // -- gap 10, 7150..7630 (480px, flat): the finale, on the ink you have
    //    left --
    [pt(7630, 420), pt(8050, 420)],
  ];

  return {
    groundSegments: ground(platforms),
    hazards: [spikes(3700, 425), spikes(5290, 345)],
    pickups: [
      pickup(1050, 545), // the first pit floor, before the first climb
      pickup(1700, 390), // after the first climb
      pickup(2200, 520), // on the run-in to the second pit's far wall
      pickup(2350, 520), // at the bottom of the second pit
      pickup(3250, 285), // top of the first free-altitude ramp
      pickup(4790, 195), // top of the second, the riskiest line on the level
      pickup(5350, 345),
      pickup(5900, 180), // the high ledge: funds the finale
      pickup(7050, 420), // the last well before the 480px span
    ],
    startX,
    chaserStartX,
    finishX: 8010,
    index: 3,
    groundY: GROUND_Y,
    stub: null,
  };
}
/*
 * LEVEL 3 INK ARITHMETIC (MAX_INK = 2050, PICKUP_AMOUNT = 260)
 *   gap  width   dy    ratio   cost
 *    1    150  +125      —     195.3
 *    2    130  -155     1.19   202.3
 *    3    160  +130      —     206.2
 *    4    120  -145     1.21   188.2
 *    5    165  +140      —     216.4
 *    6    125  -150     1.20   195.3
 *    7    170  +150      —     226.7
 *    8    135  -165     1.22   213.2
 *    9    175  +165      —     240.5
 *   10    480     0      —     480.0
 *                             -------
 *                              2364.1
 * Drops vs their ballistic floors: R(125)=75.5 vs 150, R(130)=77.0 vs 160,
 * R(140)=79.9 vs 165, R(150)=82.7 vs 170, R(165)=86.8 vs 175 — 74-88px of
 * margin on every one, the tightest in the campaign and still comfortably
 * past the empirically verified floor. Climbs peak at 1.22 (70% of limit).
 * Two spike fields at 319.4 = 638.8:
 *   2364.1 + 638.8 = 3002.9  minimal total ink
 * 3002.9 > MAX_INK (2050). 9 * 260 = 2340, budget 4390, headroom 1387.1
 * (46% over the minimum). A realistic hand: 1.15*3002.9 + 12*20 = 3693.3,
 * inside 4390.
 *
 * As in level 2, that formula understates the real scripted-hand cost: the
 * playthrough draws a longer aimed-past-both-lips line (bridgeLine's
 * OVERSHOOT) and charges the 15% surcharge on top of that longer line,
 * which compounds beyond this formula by a few px per stroke — enough,
 * across nine strokes on the level with the thinnest original margin, to
 * run dry twice over by simulation (first at the second pit, then again
 * past the second free-altitude ramp once the first shortfall was
 * covered). The two extra pickups here (the first pit floor, the run-in to
 * the second pit's far wall) were placed and sized from that simulation,
 * not from the formula.
 * Length: 8010px. Elevation: 180 (high ledge) .. 545 (pit floor) = 365px,
 * the widest in the campaign and the full authored relief window.
 */

const BUILDERS: readonly (() => Level)[] = [buildLevel0, buildLevel1, buildLevel2, buildLevel3];

/** Build level `index`. Total: any finite integer (or non-integer, or
 *  NaN/Infinity) is coerced and wrapped into [0, LEVEL_COUNT) rather than
 *  throwing, so callers can never crash the world by passing a bad index. */
export function buildLevel(index: number): Level {
  const n = Number.isFinite(index) ? Math.trunc(index) : 0;
  const wrapped = ((n % LEVEL_COUNT) + LEVEL_COUNT) % LEVEL_COUNT;
  return BUILDERS[wrapped]();
}
