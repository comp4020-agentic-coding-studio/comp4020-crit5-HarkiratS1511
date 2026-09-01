// The one hand-authored level. Every number here is a design decision, not
// an arbitrary placeholder — see the comment blocks below for the reasoning
// (run-up length, the teaching notch, the difficulty ramp, and the ink
// arithmetic that makes the level beatable-but-not-free).
//
// COORDINATE CONVENTION (from types.ts / tuning.ts): +x right, +y DOWN.
// "Higher" ground = smaller y. "Lower" ground = larger y.

import { PICKUP_AMOUNT } from "./tuning";
import type { Level, Pickup, Segment, Stroke, Vec2 } from "./types";

function seg(ax: number, ay: number, bx: number, by: number): Segment {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

// ---------------------------------------------------------------------------
// LAYOUT (all x in world px)
//
//   chaserStartX          startX                 NOTCH        GAP 1   GAP 2
//      -650                 0    ------700px------ 700-730   1080-1120 1350-1405
//      (off-screen,      (spawns          (run-up:         (40px,   (55px,
//       on P0)            running,         teaches          flat)    flat)
//                         no hazard        nothing is
//                         yet)             required yet)
//
//   ...GAP 3        GAP 4          GAP 5          GAP 6          GAP 7      finishX
//   1650-1725     1980-2080      2350-2480      2760-2920      3210-3400    3550
//   (75px,        (100px,        (130px,        (160px,        (190px,   (150px
//    lands 40      lands 55       lands 50       lands 70       lands 35   run-out
//    LOWER)        HIGHER)        LOWER)         HIGHER)        LOWER)     past
//                                                                          gap 7)
//
// From gap 3 onward the landing platform is deliberately not level with the
// take-off platform (requirement 4 — the strategic fork): a flat line stops
// being the free, obviously-correct answer and a higher/longer arc becomes
// a real tradeoff against the chaser, who only ever walks this static
// ground and cannot follow the player's drawn shortcuts.
// ---------------------------------------------------------------------------

const GROUND_Y = 420; // reference/spawn ground height

export function buildLevel(): Level {
  const startX = 0;

  // Platform heights. Gaps 1-2 are flat on both sides (teaching-adjacent,
  // forgiving); gaps 3-7 alternate which side is higher so the player meets
  // both "cheap descent" and "costly climb" more than once.
  const yP0 = GROUND_Y; //  -750 .. 700   spawn, run-up, and the chaser's start
  const yP1 = GROUND_Y; //   730 .. 1080  post-notch buffer
  const yP2 = GROUND_Y; //  1120 .. 1350
  const yP3 = GROUND_Y; //  1405 .. 1650
  const yP4 = 460; //       1725 .. 1980  gap 3 lands LOWER  (420 -> 460, +40)
  const yP5 = 405; //       2080 .. 2350  gap 4 lands HIGHER (460 -> 405, -55)
  const yP6 = 455; //       2480 .. 2760  gap 5 lands LOWER  (405 -> 455, +50)
  const yP7 = 385; //       2920 .. 3210  gap 6 lands HIGHER (455 -> 385, -70)
  const yP8 = GROUND_Y; //  3400 .. 3600  gap 7 lands back near baseline (385 -> 420, +35)

  const groundSegments: Segment[] = [
    seg(-750, yP0, 700, yP0), // run-up (700px before any hazard) + chaser start platform
    // -- teaching notch, 700..730 (30px): bridged only by `stub` below --
    seg(730, yP1, 1080, yP1),
    // -- gap 1, 1080..1120 (40px, flat): narrow, forgiving, pickup nearby --
    seg(1120, yP2, 1350, yP2),
    // -- gap 2, 1350..1405 (55px, flat): still forgiving, pickup nearby --
    seg(1405, yP3, 1650, yP3),
    // -- gap 3, 1650..1725 (75px, 420 -> 460): fork begins --
    seg(1725, yP4, 1980, yP4),
    // -- gap 4, 1980..2080 (100px, 460 -> 405) --
    seg(2080, yP5, 2350, yP5),
    // -- gap 5, 2350..2480 (130px, 405 -> 455) --
    seg(2480, yP6, 2760, yP6),
    // -- gap 6, 2760..2920 (160px, 455 -> 385): demands an efficient arc --
    seg(2920, yP7, 3210, yP7),
    // -- gap 7, 3210..3400 (190px, 385 -> 420): demands an efficient arc --
    seg(3400, yP8, 3600, yP8), // landing platform + finish run-out
  ];

  // Teaching stub: a small pre-drawn bump across the notch, so the player
  // SEES the shape and effect of a drawn line before ever being asked to
  // draw one themselves (a Super Mario 1-1 style affordance). The notch
  // (30px) is narrower than every real gap (40px minimum), so even without
  // the stub a fall here would be a near-miss, not a real threat.
  const stubPoints: Vec2[] = [
    { x: 700, y: yP0 },
    { x: 715, y: yP0 - 10 },
    { x: 730, y: yP1 },
  ];
  const stub: Stroke = {
    points: stubPoints,
    segments: [
      { a: stubPoints[0], b: stubPoints[1] },
      { a: stubPoints[1], b: stubPoints[2] },
    ],
  };

  // Ink pickups: placed only near the first two (flattest, most forgiving)
  // gaps, so a player who over-draws early can claw back some ink — but the
  // recovery is front-loaded and finite, not a general safety net for
  // inefficiency on the harder, later gaps (see arithmetic below).
  const pickups: Pickup[] = [
    { pos: { x: 1000, y: yP1 - 20 }, amount: PICKUP_AMOUNT, taken: false },
    { pos: { x: 1300, y: yP2 - 20 }, amount: PICKUP_AMOUNT, taken: false },
  ];

  const finishX = 3550; // 150px run-out past gap 7's landing edge (3400)

  return {
    groundSegments,
    pickups,
    startX,
    chaserStartX: -650, // off-screen behind spawn; enters play visibly, gaining
    finishX,
    groundY: GROUND_Y,
    stub,
  };
}

/*
 * INK ARITHMETIC — is the level beatable? (MAX_INK = 900px, see tuning.ts)
 * -------------------------------------------------------------------------
 * A line bridging a gap need not be flat. With a landing-height change of
 * `dy` across a gap of width `w`, the CHEAPEST possible bridge is the
 * straight diagonal from take-off edge to landing edge, costing exactly
 * hypot(w, dy) ink. That's the "disciplined" baseline this level is tuned
 * against — any curve drawn for extra clearance from the chaser costs more
 * than this.
 *
 *   gap    width   |dy|    minimal cost = hypot(width, dy)
 *    1       40      0       40.00
 *    2       55      0       55.00
 *    3       75     40       85.00   (75-40-85 is an exact Pythagorean triple)
 *    4      100     55      114.13
 *    5      130     50      139.28
 *    6      160     70      174.64
 *    7      190     35      193.20
 *                           --------
 *                            801.25   total minimal ink for all 7 real gaps
 *
 * 900 (MAX_INK) - 801.25 = 98.75px of slack across the WHOLE level if
 * playing near-optimally throughout. That's enough for a little extra
 * curvature here and there (a safety arc to clear the chaser on one or two
 * gaps) but nowhere near enough to draw generously on every gap. A player
 * who habitually over-draws (loopy strokes, redundant points, arcing high
 * "just in case" on every crossing) will run dry before gap 6 or 7 — which
 * is exactly where the design wants a single efficient arc to be the only
 * honest answer, rather than several stitched-together panic strokes.
 *
 * The two pickups (PICKUP_AMOUNT = 220 each, 440 total), sitting only near
 * gaps 1-2, let a player who badly overspent on the easy opening gaps claw
 * back real ink (recoverable, not trivial: 440 is under half the total
 * budget). They do nothing for inefficiency on gaps 3-7, so the late-level
 * squeeze — the thing that forces an efficient arc rather than a panicky
 * one — holds regardless of how the pickups were spent.
 */
