// The campaign: four hand-authored levels, each with its own structural
// character, replacing the single 3550px level. Playtest verdict that drove
// this rewrite: "same levels all across make it different levels, make the
// levels longer" and "the downhill gap feels like a bug" (a gap whose far
// side is lower could sometimes be cleared by falling into it with no ink
// spent at all — see SAFETY below).
//
// COORDINATE CONVENTION (from types.ts / tuning.ts): +x right, +y DOWN.
// "Higher" ground = smaller y. "Lower" ground = larger y. `dy` below always
// means (landingY - takeoffY): positive = landing LOWER, negative = HIGHER.
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
// `downhillWidth(dy, margin)` below. The margin is generous (65-90px) on
// top of R(dy) to absorb the runner's collision radius and the swept-circle
// endpoint capsule (which can catch a falling body slightly before it
// reaches the platform's nominal corner). This was verified empirically,
// not just by the formula: every (width, dy) pair actually used below was
// run through the real physics (createState/step, no strokes) in
// level.test.ts, and none of them reach the far side. That empirical check
// also turned up a SECOND failure mode the formula above misses entirely:
// a gap narrower than roughly the runner's own diameter (2*RUNNER_RADIUS)
// can never fail to be "touching" ground, flat or not, because the circle
// is wider than the hole — so every real gap here (even flat dy=0 ones) is
// also kept comfortably above that diameter floor with margin to spare.
// -----------------------------------------------------------------------
//
// -----------------------------------------------------------------------
// CLIMB LIMIT (requirement: every gap must ALSO be crossable WITH a line)
// -----------------------------------------------------------------------
// The SAFETY section above only proved gaps can't be crossed for free. A
// later integration pass found the missing inverse: several of Level 3's
// uphill (dy<0) gaps could not be crossed even by a hand-drawn line, because
// the straight edge-to-edge bridge was steeper than the runner can actually
// climb. The auto-run rule (advance() in world.ts sets vel.x = RUN_SPEED
// every grounded frame, independent of slope) plus gravity plus the
// STEP_UP_MAX assist together impose a real, empirically-measured ceiling
// on climbable slope that has no clean closed form (it is NOT simply
// "45 degrees" or "width >= rise" — that was a guess, and wrong).
//
// Measured directly (scratch harness: an isolated two-platform level with a
// single pre-drawn bridging stroke at a given (width, rise), run through
// the real createState/step loop, binary-searching the critical angle):
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
// Every climbing (dy<0) gap in this file is built with rise/width well
// below 1.73205 -- the four gaps rebuilt below sit around ratio 1.12-1.15
// (~48-49 degrees), roughly a third of the way inside the limit with margin
// to spare for anything a real physics tick or a human's imperfect line
// might add, while still reading as a steep "cliff face", not a ramp. Every
// (width, rise) pair actually used below is confirmed climbable by direct
// simulation in level.test.ts (given exactly the straight bridging line,
// the runner reaches the far side), in addition to the SAFETY check above
// (without any line, it always falls).
// -----------------------------------------------------------------------

// MAX_INK appears throughout the ink-arithmetic comments below; only
// PICKUP_AMOUNT is needed at runtime.
import { PICKUP_AMOUNT } from "./tuning";
import type { Level, Pickup, Segment, Stroke, Vec2 } from "./types";

export const LEVEL_COUNT = 4;

const GROUND_Y = 420; // baseline spawn ground height, shared by all levels

function seg(ax: number, ay: number, bx: number, by: number): Segment {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

function pickup(x: number, y: number): Pickup {
  return { pos: { x, y }, amount: PICKUP_AMOUNT, taken: false };
}

// =========================================================================
// LEVEL 0 — "The Lesson": long flat runs with a FEW wide chasms.
// Also the only level carrying the teaching apparatus (requirement 4).
// =========================================================================
//
// Layout (world x):
//   chaserStartX  startX          NOTCH        GAP1  GAP2   GAP3    GAP4     GAP5      GAP6      finish
//     -470          0    --650px run-up--    650-680 900-  1350- 2160-   3180-    4440-     5960-      6850
//                        (no hazard yet)      (30,   950   1440  2320    4860      6530
//                                              stub)  (50)  (90)  (160)   (260)     (420)     (570)
//
// Gaps 1-2 are flat (dy=0) and narrow: the stranger's first real decisions
// are forgiving. From gap 3 on, width climbs steeply (160 -> 570) while
// staying flat — the level's identity is "long, calm running punctuated by
// a shrinking number of increasingly expensive, wide, but straightforward
// (non-diagonal) chasms."
function buildLevel0(): Level {
  const startX = 0;
  const chaserStartX = -170;

  const groundSegments: Segment[] = [
    seg(chaserStartX - 300, GROUND_Y, 650, GROUND_Y), // chaser spawn + 650px run-up, no hazard
    // -- teaching notch, 650..680 (30px): bridged only by `stub` below --
    seg(680, GROUND_Y, 900, GROUND_Y),
    // -- gap 1, 900..950 (50px, flat): narrow, forgiving --
    seg(950, GROUND_Y, 1350, GROUND_Y),
    // -- gap 2, 1350..1440 (90px, flat): still forgiving --
    seg(1440, GROUND_Y, 2160, GROUND_Y),
    // -- gap 3, 2160..2320 (160px, flat) --
    seg(2320, GROUND_Y, 3180, GROUND_Y),
    // -- gap 4, 3180..3440 (260px, flat); pickup on the run-in funds it --
    seg(3440, GROUND_Y, 4440, GROUND_Y),
    // -- gap 5, 4440..4860 (420px, flat): a wide chasm --
    seg(4860, GROUND_Y, 5960, GROUND_Y),
    // -- gap 6, 5960..6530 (570px, flat): the widest chasm, near the end;
    //    pickup on the run-in funds it --
    seg(6530, GROUND_Y, 6850, GROUND_Y),
  ];

  // Teaching stub: a small pre-drawn bump across the notch, so the player
  // SEES the shape and effect of a drawn line before ever being asked to
  // draw one themselves. The notch (30px) is narrower than every real gap
  // (50px minimum), so even without the stub it would be a near-miss, not
  // a real threat — and per the SAFETY note above, its flat 30px would
  // still require a line regardless (30 is comfortably clear of the
  // ~27px diameter-crossing floor empirically measured for dy=0).
  const stubPoints: Vec2[] = [
    { x: 650, y: GROUND_Y },
    { x: 665, y: GROUND_Y - 10 },
    { x: 680, y: GROUND_Y },
  ];
  const stub: Stroke = {
    points: stubPoints,
    segments: [
      { a: stubPoints[0], b: stubPoints[1] },
      { a: stubPoints[1], b: stubPoints[2] },
    ],
  };

  const pickups: Pickup[] = [
    pickup(2800, GROUND_Y - 20), // on the run-in to gap 4 (260px)
    pickup(5400, GROUND_Y - 20), // on the run-in to gap 6 (570px, the big one)
  ];

  return {
    groundSegments,
    pickups,
    startX,
    chaserStartX,
    finishX: 6850,
    index: 0,
    groundY: GROUND_Y,
    stub,
  };
}
/*
 * LEVEL 0 INK ARITHMETIC (MAX_INK = 1450, PICKUP_AMOUNT = 260)
 * All 6 real gaps are flat (dy=0), so the cheapest bridge is a straight
 * horizontal line costing exactly `width`:
 *   gap  width  cost
 *    1     50    50.0
 *    2     90    90.0
 *    3    160   160.0
 *    4    260   260.0
 *    5    420   420.0
 *    6    570   570.0
 *              -------
 *               1550.0  minimal total ink for all 6 real gaps
 * 1550 > MAX_INK (1450): the level is NOT beatable on starting ink alone —
 * the two pickups are not decoration. 2 pickups * 260 = 520.
 * 1450 + 520 = 1970 >= 1550, with 420px of slack (~27%) over the
 * theoretical minimum — real headroom for a human who draws nowhere near
 * an optimal line, not just enough to survive a perfect one.
 * Skipping either pickup leaves only 1450+260=1710 >= 1550: the level stays
 * technically beatable missing one pickup (this level's margin is generous
 * on purpose), but starting ink alone (1450 < 1550) is still not enough —
 * pickups still matter. Length: finishX(6850) - startX(0) = 6850px, well
 * within the 6000-9000 target and nearly double the old single level
 * (3550px).
 */

// =========================================================================
// LEVEL 1 — "The Staircase": stepped ascending platforms.
// =========================================================================
//
// Every real gap lands HIGHER than it took off (dy < 0), so this level is
// immune to the downhill free-fall bug by construction (gravity can never
// carry the runner up). The climb steepens gap over gap: width and height
// both grow every step, so a flat line stops being an option (it would
// undershoot) well before the level ends.
function buildLevel1(): Level {
  const startX = 0;
  const chaserStartX = -150;

  const groundSegments: Segment[] = [
    seg(chaserStartX - 300, GROUND_Y, 980, GROUND_Y),
    // -- gap, 980..1035 (55px, climbs 20px) --
    seg(1035, 400, 1475, 400),
    // -- gap, 1475..1543 (68px, climbs 32px) --
    seg(1543, 368, 2003, 368),
    // -- gap, 2003..2085 (82px, climbs 46px) --
    seg(2085, 322, 2565, 322),
    // -- gap, 2565..2661 (96px, climbs 60px) --
    seg(2661, 262, 3161, 262),
    // -- gap, 3161..3273 (112px, climbs 78px); pickup on the run-in --
    seg(3273, 184, 3793, 184),
    // -- gap, 3793..3921 (128px, climbs 96px) --
    seg(3921, 88, 4461, 88),
    // -- gap, 4461..4606 (145px, climbs 116px) --
    seg(4606, -28, 5166, -28),
    // -- gap, 5166..5328 (162px, climbs 136px) --
    seg(5328, -164, 5908, -164),
    // -- gap, 5908..6088 (180px, climbs 158px); pickup on the run-in --
    seg(6088, -322, 6688, -322),
    // -- gap, 6688..6888 (200px, climbs 182px): the steepest step --
    seg(6888, -504, 7308, -504),
  ];

  const pickups: Pickup[] = [
    pickup(3500, 184 - 18), // on the run-in to the 112px/78px-climb gap
    pickup(6400, -322 - 18), // on the run-in to the final, steepest step
  ];

  return {
    groundSegments,
    pickups,
    startX,
    chaserStartX,
    finishX: 7308,
    index: 1,
    groundY: GROUND_Y,
    stub: null,
  };
}
/*
 * LEVEL 1 INK ARITHMETIC (MAX_INK = 1450, PICKUP_AMOUNT = 260)
 * Every real gap climbs (dy<0); minimal bridge cost per gap is
 * hypot(width, |dy|). The steepest, ratio 182/200 = 0.91 (~42.4 degrees),
 * sits well inside the empirically measured 60-degree climb limit (see the
 * CLIMB LIMIT note at the top of the file) with plenty to spare, so this
 * level was never at risk of the Level-3 defect:
 *   width   |dy|   cost
 *    55      20    58.5
 *    68      32    75.2
 *    82      46    94.0
 *    96      60   113.2
 *   112      78   136.5
 *   128      96   160.0
 *   145     116   185.7
 *   162     136   211.5
 *   180     158   239.5
 *   200     182   270.4
 *                --------
 *                 1544.5  minimal total ink for all 10 real gaps
 * 1544.5 > MAX_INK (1450): starting ink alone is not enough. 2 pickups *
 * 260 = 520. 1450 + 520 = 1970 >= 1544.5, with 425.5px of slack (~27.5%)
 * over the theoretical minimum. Skipping either pickup leaves 1450+260=1710
 * >= 1544.5 (still technically beatable), but starting ink alone
 * (1450 < 1544.5) is not enough — pickups still matter.
 * Length: 7308 - 0 = 7308px.
 */

// =========================================================================
// LEVEL 2 — "The Sprint": tight rapid-fire small gaps.
// =========================================================================
//
// 26 gaps, mostly flat with a handful of small climbs woven in at an
// irregular rhythm (short flat buffer, long flat buffer, short, long...) so
// the beats never settle into level 0's steady cadence or level 1's uniform
// steps. Every gap is deliberately kept small, but never below the safety
// floor found empirically (dy=0 needs >~27px; small climbs need a few px
// more) — see the SAFETY note at the top of the file and level.test.ts.
function buildLevel2(): Level {
  const startX = 0;
  const chaserStartX = -130;

  const groundSegments: Segment[] = [
    seg(chaserStartX - 300, GROUND_Y, 550, GROUND_Y),
    seg(590, 420, 720, 420),
    seg(764, 420, 824, 420),
    seg(866, 406, 1036, 406),
    seg(1082, 406, 1137, 406),
    seg(1187, 406, 1377, 406), // pickup here
    seg(1421, 388, 1496, 388),
    seg(1550, 388, 1690, 388),
    seg(1748, 388, 1808, 388),
    seg(1856, 366, 2036, 366),
    seg(2098, 366, 2168, 366),
    seg(2234, 366, 2384, 366),
    seg(2440, 340, 2520, 340),
    seg(2590, 340, 2750, 340), // pickup here
    seg(2824, 340, 2899, 340),
    seg(2961, 310, 3151, 310),
    seg(3229, 310, 3314, 310),
    seg(3396, 310, 3566, 310),
    seg(3634, 276, 3724, 276),
    seg(3810, 276, 3990, 276), // pickup here
    seg(4080, 276, 4175, 276),
    seg(4251, 238, 4441, 238),
    seg(4535, 238, 4635, 238),
    seg(4733, 238, 4933, 238),
    seg(5017, 196, 5122, 196),
    seg(5224, 196, 5484, 196),
    seg(5590, 196, 6190, 196),
  ];

  const pickups: Pickup[] = [
    pickup(1280, 406 - 18),
    pickup(2670, 340 - 18),
    pickup(3900, 276 - 18),
  ];

  return {
    groundSegments,
    pickups,
    startX,
    chaserStartX,
    finishX: 6190,
    index: 2,
    groundY: GROUND_Y,
    stub: null,
  };
}
/*
 * LEVEL 2 INK ARITHMETIC (MAX_INK = 1450, PICKUP_AMOUNT = 260)
 * 26 gaps, cost = hypot(width, |dy|) each. Every climb here is tiny
 * (steepest ratio 42/84 = 0.5, ~26.6 degrees) — nowhere near the
 * empirically measured 60-degree climb limit (see CLIMB LIMIT note at top):
 *   40, 44, 44.3, 46, 50, 47.5, 54, 58, 52.8, 62, 66, 61.7, 70, 74, 68.9,
 *   78, 82, 76.0, 86, 90, 85.0, 94, 98, 93.9, 102, 106
 * Sum = 1830.1  minimal total ink for all 26 real gaps.
 * 1830.1 > MAX_INK (1450). 3 pickups * 260 = 780. 1450 + 780 = 2230 >=
 * 1830.1, with 399.9px of slack (~21.8% over the theoretical minimum) —
 * the tightest margin of the four levels but still comfortably over the
 * 20% floor, fitting for a level whose challenge is volume and rationing
 * rather than any single hard read. Skipping even one pickup leaves
 * 1970 >= 1830.1 (still beatable), but starting ink alone (1450 < 1830.1)
 * is not enough — pickups still matter. Length: 6190 - 0 = 6190px.
 */

// =========================================================================
// LEVEL 3 — "The Cliffs": big height swings. The finale.
// =========================================================================
//
// 9 gaps alternating a big drop (dy>0, width sized well past the ballistic
// safety floor for that drop) with a steep climb back up (dy<0). Both dy
// magnitude and drop-gap width grow across the level, so the very last gap
// is also the widest, most expensive single crossing in the campaign — the
// "efficient single arc" finale the design calls for: by then most of the
// ink budget is spent, and only a clean, near-minimal diagonal line still
// fits.
//
// Integration testing found that the original climbs (46-52px wide for
// 135-170px of rise, ratio ~3.0-3.3, ~72 degrees) were steeper than the
// runner can actually climb — see the CLIMB LIMIT note at the top of this
// file for the empirically measured 60-degree ceiling. The climbs below
// are rebuilt at the SAME rises (character preserved: this is still the
// level with the biggest height swings in the campaign) but widened so
// their ratio sits around 1.12-1.15 (~48-49 degrees), roughly a third of
// the way inside the 60-degree limit — steep enough to still read as a
// cliff face, nowhere near the edge that broke. The drops are untouched:
// a downhill line is never too steep to descend (gravity only pulls down),
// so widening/flattening them was never necessary.
function buildLevel3(): Level {
  const startX = 0;
  const chaserStartX = -110;

  const groundSegments: Segment[] = [
    seg(chaserStartX - 300, GROUND_Y, 890, GROUND_Y), // pickup on this run-in
    // -- gap, 890..1050 (160px, DROPS 105px) --
    seg(1050, 525, 1510, 525),
    // -- gap, 1510..1635 (125px, climbs 140px; ratio 1.12, ~48.2deg) --
    seg(1635, 385, 2125, 385),
    // -- gap, 2125..2298 (173px, DROPS 150px) --
    seg(2298, 535, 2818, 535), // pickup on this run-in
    // -- gap, 2818..2968 (150px, climbs 170px; ratio 1.13, ~48.6deg) --
    seg(2968, 365, 3518, 365),
    // -- gap, 3518..3697 (179px, DROPS 170px) --
    seg(3697, 535, 4277, 535), // pickup on this run-in
    // -- gap, 4277..4397 (120px, climbs 135px; ratio 1.13, ~48.4deg) --
    seg(4397, 400, 5007, 400),
    // -- gap, 5007..5182 (175px, DROPS 155px) --
    seg(5182, 555, 5822, 555), // pickup on this run-in
    // -- gap, 5822..5962 (140px, climbs 160px; ratio 1.14, ~48.8deg) --
    seg(5962, 395, 6632, 395),
    // -- gap, 6632..6818 (186px, DROPS 200px): the finale --
    seg(6818, 595, 7238, 595),
  ];

  const pickups: Pickup[] = [
    pickup(700, GROUND_Y - 18), // funds the first drop + climb
    pickup(2758, 535 - 18), // funds the second climb (170px rise)
    pickup(4217, 535 - 18), // funds the third climb (135px rise)
    pickup(5762, 555 - 18), // funds the fourth climb (160px rise)
  ];

  return {
    groundSegments,
    pickups,
    startX,
    chaserStartX,
    finishX: 7238,
    index: 3,
    groundY: GROUND_Y,
    stub: null,
  };
}
/*
 * LEVEL 3 INK ARITHMETIC (MAX_INK = 1450, PICKUP_AMOUNT = 260)
 * cost = hypot(width, |dy|) per gap. Every climb ratio is checked against
 * the empirically measured 60-degree (ratio 1.732) climb limit at the top
 * of the file — all four sit at ~48-49 degrees, comfortably inside it:
 *   width  dy    ratio   cost
 *    160   105   0.66   191.4
 *    125  -140   1.12   187.7
 *    173   150   0.87   229.0
 *    150  -170   1.13   226.7
 *    179   170   0.95   246.9
 *    120  -135   1.13   180.6
 *    175   155   0.89   233.8
 *    140  -160   1.14   212.6
 *    186   200   1.08   273.1
 *                       -------
 *                       1981.7  minimal total ink for all 9 real gaps
 * 1981.7 > MAX_INK (1450): starting ink alone is not enough. 4 pickups *
 * 260 = 1040. 1450 + 1040 = 2490 >= 1981.7, with 508.3px of slack (~25.7%
 * over the theoretical minimum) — comfortably over the 20% floor, unlike
 * the old (pre-fix) geometry which left only ~6% and also happened to be
 * uncrossable regardless of ink. Skipping one pickup leaves 2230 >= 1981.7
 * (still beatable); skipping two leaves 1970 < 1981.7 (not enough) — most
 * of the four are genuinely required. The finale gap alone (273.1) is
 * still nearly a seventh of the whole level's budget — by the time the
 * player reaches it, the remaining ink margin is thin enough that only a
 * disciplined, near-diagonal stroke still fits, the "single efficient arc"
 * the brief asks the campaign to end on.
 * Length: 7238 - 0 = 7238px.
 *
 * Every dy>0 (downhill) width here was chosen well above the ballistic
 * safety floor R(dy) (see SAFETY note at top) with margin to spare, and
 * every dy<0 (uphill) pair was chosen well inside the climb limit (see
 * CLIMB LIMIT note at top) with margin to spare — both confirmed by direct
 * simulation in level.test.ts.
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
