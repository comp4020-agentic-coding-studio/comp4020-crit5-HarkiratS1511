// Procedural stick-figure rendering. Rendering only — this module never reads
// or writes physics state beyond the read-only bodies handed to it.
//
// The rig is a skeleton, not a set of stamped poses: a hip, a torso up to a
// shoulder, a head, and four two-bone limbs solved by inverse kinematics from
// a target. Feet follow an ellipse that is wider than it is tall, centred
// slightly ahead of the hip, with the ground half FLATTENED so a planted foot
// tracks level instead of curving through the floor — that flattening is what
// separates a run from a scissoring pair of sticks.
//
// Phase is supplied by the caller and advances on distance travelled (see
// STRIDE_PX), so the legs keep pace with the ground and slow motion slows the
// stride without anything here knowing about time at all.

import type { Chaser, Ghost, Runner, Vec2 } from "./types";

// --- tuning: limb lengths and the foot ellipse ------------------------------
export const THIGH = 15;
export const SHIN = 15;
export const UPPER_ARM = 11;
export const FOREARM = 11;
export const TORSO = 20;
export const NECK = 4;
export const HEAD_R = 5.4;

/** Foot ellipse: wider than tall, centred a little ahead of the hip. */
export const STEP_W = 41;
export const STEP_H = 13;
export const STEP_AHEAD = 3;

/** How far the hip sits above the feet when standing. */
export const HIP_HEIGHT = 27;

const INK = "#1a1a2e";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Foot offset from the hip at gait `phase`, in local (facing +x) space.
 *
 *  Bottom half of the cycle is stance: the foot holds at ground level and
 *  sweeps backward, which is what makes it appear planted while the body
 *  moves over it. Top half is swing: it lifts and travels forward. */
export function footOffset(phase: number): Vec2 {
  const a = phase * Math.PI * 2;
  const x = STEP_AHEAD + (STEP_W / 2) * Math.cos(a);
  const s = Math.sin(a);
  // +y is down. Stance (s >= 0) holds the foot flat on the floor; swing lifts
  // it from exactly that height, so the two halves meet without a step.
  //
  // The obvious formula — HIP + (STEP_H / 2) * s — is wrong and was caught by
  // the continuity test: it returns HIP at the handover, not the floor, so the
  // foot popped half a step-height into the air once per stride.
  const floor = HIP_HEIGHT + STEP_H / 2;
  const y = s >= 0 ? floor : floor + STEP_H * s;
  return { x, y };
}

/** Two-bone IK. Returns the joint between `from` and `target`, bent to the
 *  side given by `bend`. If the target is out of reach the limb is left
 *  straight and pointed at it rather than allowed to break. */
export function solveJoint(
  from: Vec2,
  target: Vec2,
  l1: number,
  l2: number,
  bend: number,
): Vec2 {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: from.x + l1, y: from.y };

  const reach = clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const ux = dx / d;
  const uy = dy / d;
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  return {
    x: from.x + ux * a - uy * h * bend,
    y: from.y + uy * a + ux * h * bend,
  };
}

type Rig = {
  /** Overall size multiplier against the constants above. */
  size: number;
  /** Forward pitch of the torso, radians. */
  lean: number;
  /** Stroke weight multiplier. */
  weight: number;
  /** Extra ragged-ness in the gait: 0 for the runner, higher for the chaser. */
  ragged: number;
};

const RUNNER_RIG: Rig = { size: 1, lean: 0.26, weight: 1, ragged: 0 };
const CHASER_RIG: Rig = { size: 1.24, lean: 0.46, weight: 1.5, ragged: 1 };

function bone(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, w: number): void {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** Draw the skeleton in local space: hip at the origin, facing +x. */
function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  phase: number,
  rig: Rig,
  airborne: number,
  vy: number,
): void {
  const k = rig.size;
  const hip: Vec2 = { x: 0, y: 0 };

  // Ragged figures break the symmetry of their stride slightly.
  const jitter = rig.ragged
    ? Math.sin(phase * Math.PI * 6) * 0.06 * rig.ragged
    : 0;

  const shoulder: Vec2 = {
    x: hip.x + Math.sin(rig.lean) * TORSO * k,
    y: hip.y - Math.cos(rig.lean) * TORSO * k,
  };

  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const legW = 3.4 * k * rig.weight;
  const armW = 2.7 * k * rig.weight;

  // --- legs ----------------------------------------------------------------
  for (const side of [0, 1]) {
    const p = (phase + side * 0.5) % 1;
    let foot = footOffset(p);
    foot = { x: foot.x * k, y: foot.y * k };

    if (airborne > 0) {
      // Airborne: legs gather when rising, reach when falling. Blended in, so
      // the ground-to-air transition never snaps.
      const reach = clamp(vy / 700, -1, 1);
      const air: Vec2 = {
        x: (STEP_AHEAD + reach * 12 - (1 - side) * 5) * k,
        y: (HIP_HEIGHT - 9 + reach * 9) * k,
      };
      foot = {
        x: foot.x + (air.x - foot.x) * airborne,
        y: foot.y + (air.y - foot.y) * airborne,
      };
    }

    // Knees bend forward: +1 in this local space.
    const knee = solveJoint(hip, foot, THIGH * k, SHIN * k, 1);
    bone(ctx, hip, knee, legW);
    bone(ctx, knee, foot, legW * 0.86);
  }

  // --- arms: opposite the same-side leg -------------------------------------
  for (const side of [0, 1]) {
    const p = (phase + side * 0.5 + 0.5) % 1 + jitter;
    const a = p * Math.PI * 2;
    const swing = Math.cos(a);
    const hand: Vec2 = {
      x: shoulder.x + (6 + swing * 17) * k,
      y: shoulder.y + (13 - Math.abs(swing) * 3) * k,
    };
    // Elbows bend backward: -1.
    const elbow = solveJoint(shoulder, hand, UPPER_ARM * k, FOREARM * k, -1);
    bone(ctx, shoulder, elbow, armW);
    bone(ctx, elbow, hand, armW * 0.86);
  }

  // --- torso and head -------------------------------------------------------
  bone(ctx, hip, shoulder, 4.2 * k * rig.weight);
  const head: Vec2 = {
    x: shoulder.x + Math.sin(rig.lean) * NECK * k,
    y: shoulder.y - Math.cos(rig.lean) * NECK * k - HEAD_R * k,
  };
  ctx.beginPath();
  ctx.arc(head.x, head.y, HEAD_R * k, 0, Math.PI * 2);
  ctx.fill();
}

type Body = { pos: Vec2; vel: Vec2; radius: number; grounded: boolean };

/** Place, orient and draw a figure. `slopeAngle` rotates the whole body so it
 *  stands square to the ground it is on; `facing` mirrors it. */
function drawFigure(
  ctx: CanvasRenderingContext2D,
  body: Body,
  phase: number,
  rig: Rig,
  alpha: number,
): void {
  // Square to the surface while grounded; upright in the air.
  const slope = body.grounded
    ? clamp(Math.atan2(body.vel.y, Math.abs(body.vel.x) || 1), -0.6, 0.6)
    : 0;
  const facing = body.vel.x < -1 ? -1 : 1;
  // Blend rather than switch, so leaving and rejoining the ground is smooth.
  const airborne = body.grounded ? 0 : clamp(Math.abs(body.vel.y) / 260, 0, 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  // Feet sit at the bottom of the collision circle; the hip rides above them.
  ctx.translate(body.pos.x, body.pos.y + body.radius);
  ctx.rotate(slope);
  ctx.scale(facing, 1);
  ctx.translate(0, -(HIP_HEIGHT + STEP_H / 2) * rig.size);
  drawSkeleton(ctx, phase, rig, airborne, body.vel.y);
  ctx.restore();
}

export function drawRunner(
  ctx: CanvasRenderingContext2D,
  runner: Runner,
  phase: number,
): void {
  drawFigure(ctx, runner, phase, RUNNER_RIG, 1);
}

export function drawChaser(
  ctx: CanvasRenderingContext2D,
  chaser: Chaser,
  phase: number,
): void {
  drawFigure(ctx, chaser, phase, CHASER_RIG, 1);
}

export function drawGhost(
  ctx: CanvasRenderingContext2D,
  ghost: Ghost,
  phase: number,
): void {
  if (ghost.goneFor <= 0) {
    drawFigure(ctx, ghost, phase, RUNNER_RIG, 0.34);
    return;
  }
  // Falling out of the world: tumble and fade. This is the game's opening
  // lesson about what a gap costs, so it has to read as a genuine fall.
  const fade = clamp(1 - ghost.goneFor / 2.5, 0, 1);
  ctx.save();
  ctx.globalAlpha = 0.34 * fade;
  ctx.translate(ghost.pos.x, ghost.pos.y + ghost.radius);
  ctx.rotate(ghost.goneFor * 4.2);
  ctx.translate(0, -(HIP_HEIGHT + STEP_H / 2));
  drawSkeleton(ctx, (ghost.goneFor * 3) % 1, RUNNER_RIG, 1, 400);
  ctx.restore();
}
