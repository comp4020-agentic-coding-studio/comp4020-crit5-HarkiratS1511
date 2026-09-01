// Articulated human silhouettes for the runner, the chaser and the ghost.
//
// The brief from the playtest was blunt: the old figures were crude sticks.
// The target is Vector (2012): a smooth black silhouette of a real body,
// running and jumping with weight and momentum. So instead of drawing a
// handful of straight strokes per frame, this module builds an actual
// skeleton — hip, knee, ankle, shoulder, elbow, wrist, neck, head — and fills
// tapered capsule links between the joints. Every joint angle is a pure
// function of time (or of physical state, for the airborne poses), so the
// whole file is deterministic and side-effect free: read the entity, compute
// angles, draw, restore.
//
// POSE SYSTEM, in one pass:
//
// 1. Gait timing. `gaitFrequency` turns a travel speed and a chosen stride
//    length into a cadence (cycles/sec); `gaitPhase` turns elapsed time into
//    a phase in [0, 2*PI). Tying frequency to RUN_SPEED / CHASER_SPEED is
//    what stops the feet skating: see (2).
//
// 2. Foot placement, not joint angles. A naive run cycle animates hip/knee
//    angles directly and the planted foot visibly slides along the ground,
//    because nothing ties the swing of the leg to how far the body actually
//    travels while that foot is down. Instead `legFootOffset` computes the
//    foot's target position relative to the hip: during the stance half of
//    the cycle the foot sweeps backward (relative to the hip) at exactly the
//    rate the hip itself is sweeping forward through the world, so the two
//    cancel and the foot's world position is constant while it's grounded —
//    the geometric definition of "planted". During the swing half it arcs
//    forward through the air with a lift profile. `twoBoneIK` then solves the
//    thigh/shin angles that reach that target, via the standard law-of-
//    cosines two-bone solver, clamped so it is always finite.
//
// 3. Everything else (arm swing, elbow bend, body bob, torso counter-
//    rotation) is a small periodic function of the same phase, combined with
//    contralateral pairing (each arm takes the opposite leg's phase, as in a
//    real gait) so hips and shoulders visibly counter-rotate.
//
// 4. Grounded figures keep their legs in a world-aligned frame (so feet land
//    exactly at the bottom of the collision circle regardless of the body's
//    lean) while the torso, neck, head and arms pivot forward from the hip —
//    a runner's legs work against the ground; their upper body leans into
//    the run. Airborne figures abandon foot-planting entirely and blend
//    between a tucked "rising" silhouette and a reaching "falling" one,
//    driven continuously by vel.y so the grounded/airborne cut is a smooth
//    read rather than a snap between two frozen poses.
//
// 5. The chaser reuses the identical rig with different knobs: bigger,
//    heavier (larger height and width multipliers), lower and more forward-
//    pitched (a crouched hip fraction and a steeper lean), longer reaching
//    arms (an arm-length multiplier and a straighter elbow), and a faster,
//    ragged gait (a shorter stride length for a higher cadence, plus small
//    odd-harmonic jitter on the legs and torso so its cycle never looks as
//    clean as the runner's).
//
// 6. The ghost draws the same rig, ghosted (low, uniform alpha with a faint
//    stroked outline on every link). Once it is falling out of the world
//    (`goneFor > 0`) it switches to a tumbling pose: a whole-body rotation
//    (legs included, unlike the grounded gait) driven by goneFor, with limbs
//    flailing at a fast, uncoordinated frequency instead of the clean gait —
//    deliberately NOT a run cycle, so it reads as a loss of control — fading
//    out over GHOST_FADE_SECONDS.

import type { Runner, Chaser, Ghost, Vec2 } from "./types";
import { RUNNER_RADIUS, CHASER_RADIUS, RUN_SPEED, CHASER_SPEED } from "./tuning";

const INK = "#1a1a2e";

// ---------------------------------------------------------------------------
// Small math helpers.
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Pure pose helpers. Exported so the pose system itself — not just "does
// drawing throw" — is unit tested: periodic in phase, finite for any input.
// ---------------------------------------------------------------------------

/** Cadence, in cycles/sec, for a body covering ground at `speed` px/s while
 *  one full gait cycle spans `strideLength` px of travel. This is the one
 *  place RUN_SPEED / CHASER_SPEED feed the animation, which is what keeps
 *  the stance foot's math (see legFootOffset) consistent with how fast the
 *  body is actually moving — the mechanism that prevents visible foot skate. */
export function gaitFrequency(speed: number, strideLength: number): number {
  const len = Math.max(1e-3, Math.abs(strideLength));
  return Math.abs(speed) / len;
}

/** Elapsed time -> phase in [0, 2*PI). Periodic in `t` with period
 *  1/frequency, by construction (modulo wrap of a linear ramp). */
export function gaitPhase(t: number, frequency: number): number {
  const twoPi = Math.PI * 2;
  const raw = t * frequency * twoPi;
  const wrapped = raw % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}

/**
 * Foot position relative to the hip, in a world-aligned frame (x: forward
 * offset, y: downward offset), for one leg at the given phase.
 *
 * Phase in [0, PI): stance. The foot sweeps from +stepHalf to -stepHalf at a
 * CONSTANT rate over half the cycle. Because the hip itself advances through
 * the world at the body's travel speed, and gaitFrequency was chosen so that
 * one full stride (4*stepHalf of hip travel) takes exactly one gait period,
 * the foot's rate of travel relative to the hip during stance exactly
 * cancels the hip's rate of travel through the world — the foot's WORLD
 * position holds still while planted. That is the whole trick against
 * skating; RUN_SPEED/CHASER_SPEED feed it via gaitFrequency above.
 *
 * Phase in [PI, 2*PI): swing. The foot eases (smoothstep) from -stepHalf
 * back to +stepHalf while lifting off the ground line by up to liftHeight,
 * peaking at mid-swing.
 */
export function legFootOffset(phase: number, stepHalf: number, liftHeight: number): Vec2 {
  const twoPi = Math.PI * 2;
  const p = ((phase % twoPi) + twoPi) % twoPi;
  if (p < Math.PI) {
    const s = p / Math.PI; // 0..1 across stance
    return { x: stepHalf * (1 - 2 * s), y: 0 };
  }
  const s = (p - Math.PI) / Math.PI; // 0..1 across swing
  const smooth = s * s * (3 - 2 * s); // smoothstep: eases in/out of the plant
  return { x: -stepHalf + 2 * stepHalf * smooth, y: -liftHeight * Math.sin(Math.PI * s) };
}

/**
 * Two-bone IK: given a target relative to the hip and two link lengths,
 * returns the knee position and the thigh's angle from straight-down
 * (positive = swung toward the target's +x side). Standard law-of-cosines
 * solve; every intermediate value is clamped so the result is always
 * finite, even for a target beyond reach or almost on top of the hip.
 */
export function twoBoneIK(target: Vec2, l1: number, l2: number): { knee: Vec2; thighAngle: number } {
  const len1 = Math.max(1e-3, l1);
  const len2 = Math.max(1e-3, l2);
  const rawD = Math.hypot(target.x, target.y);
  const maxD = Math.max(1e-3, len1 + len2 - 1e-3);
  const d = clamp(rawD, 1e-3, maxD);
  const angleToTarget = Math.atan2(target.x, target.y); // 0 = straight down
  const cosHipOffset = clamp((len1 * len1 + d * d - len2 * len2) / (2 * len1 * d), -1, 1);
  const hipOffset = Math.acos(cosHipOffset);
  const thighAngle = angleToTarget - hipOffset;
  return { knee: { x: len1 * Math.sin(thighAngle), y: len1 * Math.cos(thighAngle) }, thighAngle };
}

/** Shoulder swing angle from straight-down, driven by the SAME phase family
 *  as the legs but assigned contralaterally by the caller (each arm gets the
 *  opposite leg's phase), which is what makes hips and shoulders visibly
 *  counter-rotate. */
export function armSwingAngle(phase: number, amplitude: number): number {
  return amplitude * Math.sin(phase);
}

/** Elbow flexion added on top of the shoulder angle: near-straight when the
 *  arm swings forward, most bent as it swings back through the body. */
export function elbowBendAngle(phase: number, base: number, amplitude: number): number {
  return base + amplitude * (0.5 + 0.5 * Math.sin(phase - Math.PI / 2));
}

/** Vertical bob of the whole body, twice per gait cycle (once per foot
 *  strike), always >= 0 so it reads as "settling" rather than sinking below
 *  the nominal stand height. */
export function bodyBobOffset(phase: number, amplitude: number): number {
  return (amplitude * (1 - Math.cos(2 * phase))) / 2;
}

/** Small torso rotation counter to the hip swing — the visible "twist" half
 *  of hip/shoulder counter-rotation in a 2D side view. */
export function torsoCounterRotation(phase: number, amplitude: number): number {
  return amplitude * Math.sin(phase);
}

// ---------------------------------------------------------------------------
// Drawing primitives.
// ---------------------------------------------------------------------------

/** A single tapered, rounded limb link: a filled trapezoid between two
 *  joints, thick at width w1 and thin at width w2, with the joints rounded
 *  off by filled circles so consecutive links (thigh->shin, upper arm-
 *  >forearm) read as one continuous rounded limb rather than a faceted
 *  plank — the "smooth silhouette" the brief asks for instead of uniform
 *  stick lines. */
function drawTaperedLink(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  w1: number,
  x2: number,
  y2: number,
  w2: number,
  strokeAlso: boolean
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / len;
  const ny = dx / len;

  ctx.beginPath();
  ctx.moveTo(x1 + nx * w1, y1 + ny * w1);
  ctx.lineTo(x2 + nx * w2, y2 + ny * w2);
  ctx.lineTo(x2 - nx * w2, y2 - ny * w2);
  ctx.lineTo(x1 - nx * w1, y1 - ny * w1);
  ctx.closePath();
  ctx.fill();
  if (strokeAlso) ctx.stroke();

  ctx.beginPath();
  ctx.arc(x1, y1, w1, 0, Math.PI * 2);
  ctx.fill();
  if (strokeAlso) ctx.stroke();

  ctx.beginPath();
  ctx.arc(x2, y2, w2, 0, Math.PI * 2);
  ctx.fill();
  if (strokeAlso) ctx.stroke();
}

/** Everything needed to pose and draw one figure. Callers (drawRunner /
 *  drawChaser / drawGhost) are responsible for turning entity state + t into
 *  these numbers; this function only lays out and fills the body. */
interface FigureParams {
  cx: number;
  cy: number;
  radius: number;
  facing: 1 | -1;
  /** Total standing height, feet to crown, in world px (~4-5x radius). */
  H: number;
  /** Hip height as a fraction of H — lower = a crouched, predatory stance. */
  hipFrac: number;
  /** Overall girth multiplier applied to every limb/torso width. */
  widthMult: number;
  /** Multiplier on arm segment lengths (the chaser reaches further). */
  armLenMult: number;
  /** Forward tilt applied to the torso/head/arm group only. */
  lean: number;
  /** Extra rotation applied to the ENTIRE figure (legs included) around the
   *  hip — zero for a normal grounded gait (legs stay world-aligned so feet
   *  land where physics expects), nonzero for the ghost's tumble. */
  bodyRotation: number;
  /** Foot targets relative to the hip, in a WORLD-ALIGNED (unrotated, but
   *  already facing-adjusted) frame: x forward, y downward. */
  legTargets: [Vec2, Vec2];
  /** Shoulder swing angle per arm (unsigned; facing is applied here). */
  armAngles: [number, number];
  /** Elbow flexion added on top of each shoulder angle. */
  elbowBends: [number, number];
  alpha: number;
  /** Ghost mode: also stroke a faint outline on every filled link. */
  strokeAlso?: boolean;
}

function drawArticulatedFigure(ctx: CanvasRenderingContext2D, p: FigureParams): void {
  const H = Math.max(1e-3, p.H);
  const hipHeight = p.hipFrac * H;
  const thighLen = 0.28 * H;
  const shinLen = 0.26 * H;
  const shoulderUp = 0.3 * H;
  const neckUp = shoulderUp + 0.04 * H;
  const headRadius = 0.085 * H * (0.9 + 0.1 * p.widthMult);
  const headUp = neckUp + headRadius;
  const upperArmLen = 0.17 * H * p.armLenMult;
  const forearmLen = 0.16 * H * p.armLenMult;
  const wm = p.widthMult;
  const strokeAlso = !!p.strokeAlso;

  const feetY = p.cy + p.radius; // bottom of the collision circle
  const hipWorldX = p.cx;
  const hipWorldY = feetY - hipHeight;

  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(0.5, 0.6 * (H / 55));
  ctx.globalAlpha = p.alpha;

  ctx.save();
  ctx.translate(hipWorldX, hipWorldY);
  ctx.rotate(p.bodyRotation);

  // Legs, drawn in this (world-aligned unless tumbling) frame so a planted
  // foot lands exactly where legFootOffset placed it.
  for (const foot of p.legTargets) {
    const { knee } = twoBoneIK(foot, thighLen, shinLen);
    drawTaperedLink(ctx, 0, 0, 0.075 * H * wm, knee.x, knee.y, 0.045 * H * wm, strokeAlso);
    drawTaperedLink(ctx, knee.x, knee.y, 0.04 * H * wm, foot.x, foot.y, 0.022 * H * wm, strokeAlso);
    // A short foot/shoe stub continuing forward from the ankle so the
    // silhouette reads as a foot rather than a line simply stopping.
    const footLen = 0.11 * H * p.facing;
    drawTaperedLink(
      ctx,
      foot.x,
      foot.y,
      0.03 * H * wm,
      foot.x + footLen,
      foot.y,
      0.012 * H * wm,
      strokeAlso
    );
  }

  // Torso, neck, head and arms pivot forward from the hip by `lean`, on top
  // of whatever whole-body rotation is already applied.
  ctx.save();
  ctx.rotate(p.lean);

  drawTaperedLink(ctx, 0, 0, 0.085 * H * wm, 0, -shoulderUp, 0.11 * H * wm, strokeAlso);
  drawTaperedLink(ctx, 0, -shoulderUp, 0.045 * H * wm, 0, -neckUp, 0.04 * H * wm, strokeAlso);

  ctx.beginPath();
  ctx.arc(0, -headUp, headRadius, 0, Math.PI * 2);
  ctx.fill();
  if (strokeAlso) ctx.stroke();

  const shoulderY = -shoulderUp;
  for (let i = 0; i < 2; i++) {
    const shAngle = p.armAngles[i];
    const elAngle = shAngle + p.elbowBends[i];
    const ex = upperArmLen * Math.sin(shAngle) * p.facing;
    const ey = shoulderY + upperArmLen * Math.cos(shAngle);
    const hx = ex + forearmLen * Math.sin(elAngle) * p.facing;
    const hy = ey + forearmLen * Math.cos(elAngle);
    drawTaperedLink(ctx, 0, shoulderY, 0.055 * H * wm, ex, ey, 0.032 * H * wm, strokeAlso);
    drawTaperedLink(ctx, ex, ey, 0.032 * H * wm, hx, hy, 0.02 * H * wm, strokeAlso);
  }

  ctx.restore(); // torso/head/arm lean
  ctx.restore(); // hip translate + bodyRotation
}

/** Shared base for the two airborne poses (rising vs falling), so a runner
 *  and a chaser both get "the transition matters more than either pose": a
 *  single continuous blend driven by vel.y, rather than two frozen poses
 *  with a snap between them at takeoff/landing. */
interface AirborneBase {
  pos: Vec2;
  vel: Vec2;
  radius: number;
  facing: 1 | -1;
  H: number;
  hipFrac: number;
  widthMult: number;
  armLenMult: number;
  lean: number;
  alpha: number;
  strokeAlso?: boolean;
}

const AIR_REFERENCE_SPEED = 480; // px/s of vel.y treated as "fully" rising/falling

function drawAirbornePose(ctx: CanvasRenderingContext2D, base: AirborneBase, t: number): void {
  const H = base.H;
  const legLen = 0.54 * H;

  // +1 = rising fast, -1 = falling fast, continuous through the apex.
  const rising = clamp(-base.vel.y / AIR_REFERENCE_SPEED, -1, 1);
  const riseAmt = (rising + 1) / 2; // 0 falling .. 1 rising

  // Rising: legs gathered, knees driven up close to the hip.
  const tuck = { x: 0.3 * legLen, y: 0.42 * legLen };
  // Falling: legs trailing/reaching, extended down and forward for landing.
  const reach = { x: 0.62 * legLen, y: 0.98 * legLen };

  const wobble = Math.sin(t * 9) * 0.05 * legLen; // a little life, not ground-locked
  const baseX = lerp(reach.x, tuck.x, riseAmt);
  const baseY = lerp(reach.y, tuck.y, riseAmt);
  const legTargets: [Vec2, Vec2] = [
    { x: (baseX + wobble) * base.facing, y: baseY },
    { x: (baseX - wobble * 0.6) * base.facing, y: baseY * 0.92 },
  ];

  // Arms up for balance in both states; rising tucks them in a touch more,
  // falling throws them further back for bracing.
  const armBase = lerp(2.0, 2.6, riseAmt);
  const armAngles: [number, number] = [
    armBase + Math.sin(t * 9) * 0.12,
    armBase - Math.sin(t * 9 + 1) * 0.12,
  ];
  const elbowBends: [number, number] = [0.5, 0.5];

  drawArticulatedFigure(ctx, {
    cx: base.pos.x,
    cy: base.pos.y,
    radius: base.radius,
    facing: base.facing,
    H,
    hipFrac: base.hipFrac,
    widthMult: base.widthMult,
    armLenMult: base.armLenMult,
    lean: base.lean * (0.6 + 0.4 * riseAmt),
    bodyRotation: 0,
    legTargets,
    armAngles,
    elbowBends,
    alpha: base.alpha,
    strokeAlso: base.strokeAlso,
  });
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

const RUNNER_STRIDE_LENGTH = 90; // world px per full gait cycle
const RUNNER_HEIGHT_MULT = 4.6; // ~4-5x collision radius, per spec
const RUNNER_HIP_FRAC = 0.5;
const RUNNER_LEAN = 0.22;

export function drawRunner(ctx: CanvasRenderingContext2D, runner: Runner, t: number): void {
  const radius = runner.radius || RUNNER_RADIUS;
  const H = radius * RUNNER_HEIGHT_MULT;
  const facing: 1 | -1 = runner.vel.x < 0 ? -1 : 1;

  ctx.save();
  if (runner.grounded) {
    const stepHalf = RUNNER_STRIDE_LENGTH / 4;
    const freq = gaitFrequency(RUN_SPEED, RUNNER_STRIDE_LENGTH);
    const phase = gaitPhase(t, freq);
    const hipHeight = RUNNER_HIP_FRAC * H;
    const bob = bodyBobOffset(phase, 0.03 * H);
    const lift = 0.16 * H;

    const legPhases: [number, number] = [phase, phase + Math.PI];
    const legTargets: [Vec2, Vec2] = legPhases.map((ph) => {
      const off = legFootOffset(ph, stepHalf, lift);
      return { x: off.x * facing, y: hipHeight + bob + off.y };
    }) as [Vec2, Vec2];

    // Contralateral: each arm takes the OTHER leg's phase.
    const armPhases: [number, number] = [phase + Math.PI, phase];
    const armAngles: [number, number] = [
      armSwingAngle(armPhases[0], 0.9),
      armSwingAngle(armPhases[1], 0.9),
    ];
    const elbowBends: [number, number] = [
      elbowBendAngle(armPhases[0], 0.35, 0.55),
      elbowBendAngle(armPhases[1], 0.35, 0.55),
    ];
    const twist = torsoCounterRotation(phase, 0.05);

    drawArticulatedFigure(ctx, {
      cx: runner.pos.x,
      cy: runner.pos.y,
      radius,
      facing,
      H,
      hipFrac: RUNNER_HIP_FRAC,
      widthMult: 1,
      armLenMult: 1,
      lean: RUNNER_LEAN + twist,
      bodyRotation: 0,
      legTargets,
      armAngles,
      elbowBends,
      alpha: 1,
    });
  } else {
    drawAirbornePose(
      ctx,
      {
        pos: runner.pos,
        vel: runner.vel,
        radius,
        facing,
        H,
        hipFrac: RUNNER_HIP_FRAC,
        widthMult: 1,
        armLenMult: 1,
        lean: RUNNER_LEAN,
        alpha: 1,
      },
      t
    );
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Chaser: same rig, tuned to read as a predator on sight — bigger, heavier,
// lower and more forward-pitched than the runner, with longer reaching arms
// and a faster, more ragged gait. There is no colour or word available in a
// monochrome, wordless game, so "denser, darker mass" is read entirely
// through bulk (widthMult) and posture (crouch + steep lean), not hue.
// ---------------------------------------------------------------------------

const CHASER_STRIDE_LENGTH = 62; // shorter than the runner's -> higher cadence
const CHASER_HEIGHT_MULT = 5.0; // top of the 4-5x band: reads bigger even before CHASER_RADIUS > RUNNER_RADIUS is factored in
const CHASER_HIP_FRAC = 0.4; // crouched, low predatory stance
const CHASER_LEAN = 0.42; // steep forward pitch
const CHASER_WIDTH_MULT = 1.4; // heavier mass
const CHASER_ARM_MULT = 1.35; // longer reach
const CHASER_RAGGED = 0.35; // odd-harmonic jitter amplitude: an uneven, scrabbling cycle

export function drawChaser(ctx: CanvasRenderingContext2D, chaser: Chaser, t: number): void {
  const radius = chaser.radius || CHASER_RADIUS;
  const H = radius * CHASER_HEIGHT_MULT;
  const facing: 1 | -1 = chaser.vel.x < 0 ? -1 : 1;

  ctx.save();
  if (chaser.grounded) {
    const stepHalf = CHASER_STRIDE_LENGTH / 4;
    const freq = gaitFrequency(CHASER_SPEED, CHASER_STRIDE_LENGTH);
    const phase = gaitPhase(t, freq);
    const hipHeight = CHASER_HIP_FRAC * H;
    const bob = bodyBobOffset(phase, 0.05 * H); // heavier, rougher bob than the runner's
    const lift = 0.2 * H;

    const legPhases: [number, number] = [phase, phase + Math.PI];
    const legTargets: [Vec2, Vec2] = legPhases.map((ph, i) => {
      // Ragged: the two legs don't swing with identical amplitude — a
      // scrabbling unevenness rather than a clean, jogged cycle.
      const jitter = 1 + CHASER_RAGGED * 0.15 * Math.sin(3 * ph) * (i === 0 ? 1 : -1);
      const off = legFootOffset(ph, stepHalf * jitter, lift * jitter);
      return { x: off.x * facing, y: hipHeight + bob + off.y };
    }) as [Vec2, Vec2];

    const armPhases: [number, number] = [phase + Math.PI, phase];
    const armAngles: [number, number] = [
      armSwingAngle(armPhases[0], 1.15),
      armSwingAngle(armPhases[1], 1.15),
    ];
    // A shallower elbow bend than the runner's: straighter, longer-reaching arms.
    const elbowBends: [number, number] = [
      elbowBendAngle(armPhases[0], 0.25, 0.45),
      elbowBendAngle(armPhases[1], 0.25, 0.45),
    ];
    const twist = torsoCounterRotation(phase, 0.08) + CHASER_RAGGED * 0.06 * Math.sin(5 * phase);

    drawArticulatedFigure(ctx, {
      cx: chaser.pos.x,
      cy: chaser.pos.y,
      radius,
      facing,
      H,
      hipFrac: CHASER_HIP_FRAC,
      widthMult: CHASER_WIDTH_MULT,
      armLenMult: CHASER_ARM_MULT,
      lean: CHASER_LEAN + twist,
      bodyRotation: 0,
      legTargets,
      armAngles,
      elbowBends,
      alpha: 1,
    });
  } else {
    drawAirbornePose(
      ctx,
      {
        pos: chaser.pos,
        vel: chaser.vel,
        radius,
        facing,
        H,
        hipFrac: CHASER_HIP_FRAC,
        widthMult: CHASER_WIDTH_MULT,
        armLenMult: CHASER_ARM_MULT,
        lean: CHASER_LEAN,
        alpha: 1,
      },
      t
    );
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Ghost: the runner's body, ghosted, that runs ahead and falls into the
// first gap in plain view — the game's only tutorial, so the fall has to
// read as a real loss of control, not a variant jump.
// ---------------------------------------------------------------------------

const GHOST_ALPHA = 0.3;
const GHOST_FADE_SECONDS = 2.5;

export function drawGhost(ctx: CanvasRenderingContext2D, ghost: Ghost, t: number): void {
  const radius = ghost.radius || RUNNER_RADIUS;
  const H = radius * RUNNER_HEIGHT_MULT;
  const facing: 1 | -1 = ghost.vel.x < 0 ? -1 : 1;
  const falling = ghost.goneFor > 0;
  const fadeMult = falling ? clamp(1 - ghost.goneFor / GHOST_FADE_SECONDS, 0, 1) : 1;

  ctx.save();
  if (fadeMult > 0) {
    if (falling) {
      // Tumbling: a whole-body rotation (legs included — this is the one
      // case bodyRotation is nonzero) driven by goneFor, with limbs
      // flailing at a fast, uncoordinated frequency instead of the clean
      // run gait, so it reads as a genuine loss of control.
      const tumbleAngle = ghost.goneFor * 5.5 * facing;
      const flail = t * 14;
      const H2 = H;
      const legTargets: [Vec2, Vec2] = [
        {
          x: Math.sin(flail) * 0.5 * H2 * facing,
          y: 0.5 * H2 + Math.cos(flail * 1.3) * 0.3 * H2,
        },
        {
          x: Math.sin(flail + Math.PI * 0.7) * 0.5 * H2 * facing,
          y: 0.5 * H2 + Math.cos(flail * 1.3 + 1.1) * 0.3 * H2,
        },
      ];
      const armAngles: [number, number] = [
        armSwingAngle(flail * 1.3, 1.4),
        armSwingAngle(flail * 1.3 + Math.PI * 0.8, 1.4),
      ];
      const elbowBends: [number, number] = [
        elbowBendAngle(flail * 1.3, 0.6, 0.7),
        elbowBendAngle(flail * 1.3 + Math.PI * 0.8, 0.6, 0.7),
      ];

      drawArticulatedFigure(ctx, {
        cx: ghost.pos.x,
        cy: ghost.pos.y,
        radius,
        facing,
        H,
        hipFrac: RUNNER_HIP_FRAC,
        widthMult: 1,
        armLenMult: 1,
        lean: 0,
        bodyRotation: tumbleAngle,
        legTargets,
        armAngles,
        elbowBends,
        alpha: GHOST_ALPHA * fadeMult,
        strokeAlso: true,
      });
    } else if (ghost.grounded) {
      const stepHalf = RUNNER_STRIDE_LENGTH / 4;
      const freq = gaitFrequency(RUN_SPEED, RUNNER_STRIDE_LENGTH);
      const phase = gaitPhase(t, freq);
      const hipHeight = RUNNER_HIP_FRAC * H;
      const bob = bodyBobOffset(phase, 0.03 * H);
      const lift = 0.16 * H;

      const legPhases: [number, number] = [phase, phase + Math.PI];
      const legTargets: [Vec2, Vec2] = legPhases.map((ph) => {
        const off = legFootOffset(ph, stepHalf, lift);
        return { x: off.x * facing, y: hipHeight + bob + off.y };
      }) as [Vec2, Vec2];

      const armPhases: [number, number] = [phase + Math.PI, phase];
      const armAngles: [number, number] = [
        armSwingAngle(armPhases[0], 0.9),
        armSwingAngle(armPhases[1], 0.9),
      ];
      const elbowBends: [number, number] = [
        elbowBendAngle(armPhases[0], 0.35, 0.55),
        elbowBendAngle(armPhases[1], 0.35, 0.55),
      ];
      const twist = torsoCounterRotation(phase, 0.05);

      drawArticulatedFigure(ctx, {
        cx: ghost.pos.x,
        cy: ghost.pos.y,
        radius,
        facing,
        H,
        hipFrac: RUNNER_HIP_FRAC,
        widthMult: 1,
        armLenMult: 1,
        lean: RUNNER_LEAN + twist,
        bodyRotation: 0,
        legTargets,
        armAngles,
        elbowBends,
        alpha: GHOST_ALPHA * fadeMult,
        strokeAlso: true,
      });
    } else {
      drawAirbornePose(
        ctx,
        {
          pos: ghost.pos,
          vel: ghost.vel,
          radius,
          facing,
          H,
          hipFrac: RUNNER_HIP_FRAC,
          widthMult: 1,
          armLenMult: 1,
          lean: RUNNER_LEAN,
          alpha: GHOST_ALPHA * fadeMult,
          strokeAlso: true,
        },
        t
      );
    }
  }
  ctx.restore();
}
