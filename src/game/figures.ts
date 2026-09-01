// Procedural figure rendering. Rendering only — this module never reads or
// writes physics state beyond the read-only bodies handed to it.
//
// The rig is a skeleton, not a set of stamped poses: a hip, a curved spine up
// to a shoulder, a head, and four limbs. Legs are solved by two-bone inverse
// kinematics from a foot target; arms swing FORWARD-kinematically from the
// shoulder, because an arm is driven by the shoulder and a leg is driven by
// the ground, and solving both the same way is what made the old rig scissor.
//
// PHASE IS DISTANCE, NEVER TIME. The caller advances phase by ground covered
// over STRIDE_PX (see world.ts), so the legs keep pace with the floor and slow
// motion slows the stride for free. Nothing here may read a clock. The one
// exception is the ghost's death, which has no distance to be driven by: the
// simulation freezes the ghost's position the moment it dies, so its plunge is
// synthesised here from `goneFor` under a ballistic curve. That is a one-shot
// death animation, not a gait.
//
// WHY THE FIGURES ARE BUILT THIS WAY
//
// At the phone viewport the world scale is 0.557 (height/540 clamped by the
// 700px minimum sightline), against 2.0 on desktop — a factor of 3.6. The old
// rig was ~67 world px tall with 3.4px bones, so on the phone it was a 37px
// figure drawn in 1.9px hairlines: a scratch, not a person. Two fixes, both
// needed:
//
//   1. MASS. The rig is ~90 world px tall and every bone is a filled tapered
//      capsule rather than a stroked line, so the silhouette survives being
//      shrunk. Limbs on the far side are drawn paler than the near ones, which
//      is what lets you read WHICH leg is forward at 50px tall.
//   2. A RIM. Figures stand on terrain, and terrain and ink are near-identical
//      values on three of the four palettes — feet vanished into the ground.
//      Every shape is stroked in `paper` before anything is filled, so the
//      figure carries its own separation from whatever it stands on. On the
//      inverted night palette this reverses for free, because the rim is a
//      palette role rather than a colour.
//
// STRIDE LENGTH IS NOT A FREE PARAMETER. The ground passes at STRIDE_PX per
// gait cycle. A planted foot must therefore travel backward at exactly that
// rate, and can only stay planted for as long as its sweep lasts: stance is
// STEP_W/STRIDE_PX of the cycle, no more. The old rig held each foot down for
// half the cycle while sweeping it only a quarter of the distance the ground
// moved, so both feet skated backward at half ground speed the entire time.
// Deriving stance from the sweep removes the skate outright, and hands back
// the flight phases that separate a run from a walk for free.

import { at, type Palette } from "./palette";
import { STRIDE_PX } from "./tuning";
import type { Chaser, Ghost, Runner, Vec2 } from "./types";

// --- tuning: limb lengths, in local units at rig size 1 ----------------------
export const THIGH = 23;
export const SHIN = 23;
export const UPPER_ARM = 15;
export const FOREARM = 14;
export const TORSO = 33;
export const NECK = 5;
export const HEAD_R = 8.5;
export const FOOT_LEN = 10;

/** Foot sweep: how far the foot travels, hip-relative, while planted. */
export const STEP_W = 44;
/** Peak lift of the foot during swing. */
export const STEP_H = 22;
/** The sweep is centred this far ahead of the hip. */
export const STEP_AHEAD = 3;

/** Neutral hip height above the floor. Deliberately under THIGH + SHIN so the
 *  knee is never straight-locked, and over the sweep half-width so the leg can
 *  reach the ground at both ends of the stance without the IK clamping. */
export const HIP_HEIGHT = 37;

/** Peak hip drop at mid-stance. The rise through flight is derived from it. */
export const HIP_DIP = 4.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return ((v % 1) + 1) % 1;
}

/** Fraction of the gait cycle one foot spends planted.
 *
 *  Derived, not chosen. The sweep is STEP_W * size world px and the ground
 *  passes at STRIDE_PX per cycle, so a foot that does not slip is down for
 *  exactly that fraction and no longer. A bigger figure covers the same ground
 *  in fewer, longer strides, so the chaser gets more contact and less flight
 *  than the runner without a single number being tuned for it — which is
 *  precisely what "heavier" looks like. */
export function stanceFraction(size = 1): number {
  return clamp((STEP_W * size) / STRIDE_PX, 0.12, 0.46);
}

/** Cubic Hermite through (0,p0) and (1,p1) with end tangents m0, m1. */
function hermite(t: number, p0: number, p1: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * m1
  );
}

/** Foot position at gait `phase`, in local (facing +x, +y down) space measured
 *  from the NEUTRAL hip — the hip's own bob is applied separately by
 *  `hipOffset`, so a planted foot stays planted while the body rides over it.
 *
 *  Stance is linear: the foot travels backward at exactly the rate the ground
 *  travels, which is the whole reason it looks planted rather than skating.
 *  Swing is a Hermite whose end tangents MATCH that stance rate at both the
 *  toe-off and the touchdown, so the foot's velocity is continuous across both
 *  handovers as well as its position. Those matched tangents are what produce
 *  the heel kicking back behind the figure after toe-off and the foot reaching
 *  ahead and then pawing back before contact — neither is posed, both fall out
 *  of asking for continuity.
 *
 *  The lift profile peaks at one third of the swing (heel up fast under the
 *  hip, then a long low reach) and returns to EXACTLY floor height at both
 *  ends. The obvious formulation — an ellipse centred on the hip — is wrong
 *  and was caught by the continuity test: it returned hip height rather than
 *  floor height at the handover, so the foot popped half a step-height into
 *  the air once per stride. Floor height is a single named quantity here for
 *  that reason. */
export function footOffset(phase: number, size = 1): Vec2 {
  const p = wrap01(phase);
  const stance = stanceFraction(size);
  const front = STEP_AHEAD + STEP_W / 2;
  const back = STEP_AHEAD - STEP_W / 2;
  // Ground speed in local units per unit phase. Negative: the floor runs back.
  const sweep = -STEP_W / stance;

  if (p <= stance) {
    return { x: front + sweep * p, y: HIP_HEIGHT };
  }
  const t = (p - stance) / (1 - stance);
  const m = sweep * (1 - stance);
  return {
    x: hermite(t, back, front, m, m),
    // 6.75 * t * (1-t)^2 peaks at exactly 1 when t = 1/3, and is zero with a
    // finite slope at both ends — no pop at toe-off, no snatch at touchdown.
    y: HIP_HEIGHT - STEP_H * 6.75 * t * (1 - t) * (1 - t),
  };
}

/** The hip's own path: down through stance as the leg absorbs, up through
 *  flight as the body is thrown off the toe. Two per cycle, because there are
 *  two steps in a cycle. The rise is derived from the dip and the ratio of
 *  flight to stance, so the two halves meet moving in the same direction and
 *  at nearly the same rate — a figure with more stance and less flight (the
 *  chaser) heaves less and trudges, which is again free. */
export function hipOffset(phase: number, size = 1, amount = 1): Vec2 {
  const stance = stanceFraction(size);
  const flight = 0.5 - stance;
  const q = wrap01(phase) % 0.5;
  const dip = HIP_DIP * amount;
  if (q <= stance) {
    return { x: 0, y: dip * Math.sin((Math.PI * q) / stance) };
  }
  const rise = flight <= 1e-6 ? 0 : dip * (flight / stance);
  return { x: 0, y: -rise * Math.sin((Math.PI * (q - stance)) / flight) };
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

/** Pull a limb target inside the limb's reach. Without this the IK clamps but
 *  the DRAWN bone still runs all the way to the unreachable target, so the
 *  shin stretches like elastic — the single ugliest thing an air pose can do. */
export function reachClamp(from: Vec2, target: Vec2, maxLen: number): Vec2 {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxLen || d < 1e-6) return target;
  const k = maxLen / d;
  return { x: from.x + dx * k, y: from.y + dy * k };
}

// --- rigs --------------------------------------------------------------------

/** Everything that separates one figure from another. The old rig differed by
 *  a size and a lean, which is why the chaser read as the runner standing
 *  closer to the camera. */
export type Rig = {
  /** Overall size multiplier against the constants above. */
  size: number;
  /** Forward pitch of the torso, radians. */
  lean: number;
  /** Bone thickness multiplier. */
  weight: number;
  /** Gait asymmetry: 0 for the runner, a limp for the chaser. */
  ragged: number;
  /** Shoulder swing amplitude, radians. */
  armAmp: number;
  /** Arm length multiplier — long arms read as predatory. */
  armLen: number;
  /** Shoulder mass multiplier. */
  shoulderW: number;
  /** Neck length multiplier. Near zero sinks the head between the shoulders. */
  neck: number;
  /** Head size multiplier. */
  headScale: number;
  /** Hip heave multiplier. */
  bob: number;
  /** How far the spine bows backward: a hunch rather than a straight stick. */
  hunch: number;
  /** Spines along the back. The chaser is the loss condition given a body; it
   *  needs an outline you would not want to be caught by. */
  spikes: number;
  /** Hands become claws. */
  claws: boolean;
};

/** Light, urgent, forward: narrow bones, a long free arm swing, head up. */
export const RUNNER_RIG: Rig = {
  size: 1,
  lean: 0.34,
  weight: 0.95,
  ragged: 0,
  armAmp: 1.1,
  armLen: 1,
  shoulderW: 1,
  neck: 1.2,
  headScale: 1,
  bob: 1,
  hunch: 0.18,
  spikes: 0,
  claws: false,
};

/** Heavier and hunting: bigger, thicker, bowed forward over long clawed arms,
 *  the head carried low between spined shoulders. Every one of those is a
 *  silhouette difference rather than a size difference, because a glance at
 *  50px tall gets the outline and nothing else. */
export const CHASER_RIG: Rig = {
  size: 1.3,
  lean: 0.5,
  weight: 1.35,
  ragged: 1,
  armAmp: 0.62,
  armLen: 1.3,
  shoulderW: 1.5,
  neck: 0.6,
  headScale: 1.08,
  bob: 1.15,
  hunch: 0.62,
  spikes: 4,
  claws: true,
};

// --- posing ------------------------------------------------------------------

export type Limb = { root: Vec2; joint: Vec2; end: Vec2; tip: Vec2 };

export type Pose = {
  hip: Vec2;
  spine: Vec2;
  shoulder: Vec2;
  neck: Vec2;
  head: Vec2;
  headR: number;
  lean: number;
  /** Index 0 is the far side, 1 the near side: paint order, and the reason a
   *  glance can tell which leg is which. */
  legs: Limb[];
  arms: Limb[];
  /** Toe pitch per leg, radians, positive toes-down. */
  toePitch: number[];
};

export type PoseOptions = {
  /** 0 grounded, 1 fully airborne. Blended so leaving the ground never snaps. */
  airborne?: number;
  /** Vertical speed, px/s. Sign chooses gathering (up) or reaching (down). */
  vy?: number;
  /** 0..1 landing compression, decaying over the strides after an impact. */
  absorb?: number;
  /** Death throes. `angle` advances with DISTANCE FALLEN, never with a clock,
   *  and `amount` blends it over the running pose so panic can set in while
   *  the figure is still on its way down rather than snapping on at the
   *  moment it is declared dead. Ghost only. */
  flail?: { angle: number; amount: number } | null;
};

function dir(angle: number, len: number): Vec2 {
  // Angle measured from straight down, positive toward +x (forward).
  return { x: Math.sin(angle) * len, y: Math.cos(angle) * len };
}

/** `len` along the body's own up-axis at `lean`: up the page and forward. */
function up(lean: number, len: number): Vec2 {
  return { x: Math.sin(lean) * len, y: -Math.cos(lean) * len };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixV(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
}

/** Build the whole skeleton for a phase. Pure: same inputs, same pose, no
 *  clock, no globals. Exported so the invariants (bones never stretch, feet
 *  never slip, the two figures never share a silhouette) are testable without
 *  a canvas. */
export function posture(phase: number, rig: Rig, opts: PoseOptions = {}): Pose {
  const k = rig.size;
  const air = clamp(opts.airborne ?? 0, 0, 1);
  const vy = opts.vy ?? 0;
  const absorb = clamp(opts.absorb ?? 0, 0, 1);
  const flail = opts.flail ?? null;
  const thrash = flail ? clamp(flail.amount, 0, 1) : 0;
  const p = wrap01(phase);

  const gather = clamp(-vy / 520, 0, 1) * air;
  const reach = clamp(vy / 520, 0, 1) * air;

  const legLen = (THIGH + SHIN) * k;

  // --- hip and spine ---------------------------------------------------------
  const bob = hipOffset(p, k, rig.bob);
  const hip: Vec2 = {
    x: 0,
    // Airborne the hip rides high (no leg under it); landing drives it down.
    y: bob.y * k * (1 - air) - air * 3 * k + absorb * 7 * k,
  };

  // Lean: further forward while gathering or absorbing, more upright reaching
  // for the ground. The torso is the first thing that reads at 50px tall, so
  // it carries most of the pose.
  const lean = rig.lean + gather * 0.24 - reach * 0.08 + absorb * 0.26;

  // Shoulders counter-rotate against the hips. In a side view that reads as
  // the chest shuttling a little fore and aft against the stride.
  const twist = Math.cos(2 * Math.PI * p) * 1.6 * k * (1 - air * 0.6);
  const shoulderBase = add(hip, up(lean, TORSO * k));
  const shoulder: Vec2 = { x: shoulderBase.x + twist, y: shoulderBase.y };
  // Mid-spine, bowed backward: a hunch, not a broom handle.
  const spine: Vec2 = {
    x: mix(hip.x, shoulder.x, 0.55) - Math.cos(lean) * rig.hunch * 6 * k,
    y: mix(hip.y, shoulder.y, 0.55) - Math.sin(lean) * rig.hunch * 2 * k,
  };

  const neck = add(shoulder, up(lean, NECK * rig.neck * k));
  const headR = HEAD_R * rig.headScale * k;
  // The head is the slowest thing on the body: it keeps only a fraction of the
  // hip's heave and lags the shoulders' twist. Cancelling most of the bob here
  // is what stops the whole figure pogoing as one rigid piece.
  const headBase = add(neck, up(lean, headR * 0.95));
  const head: Vec2 = {
    x: headBase.x - twist * 0.8,
    y: headBase.y - bob.y * k * (1 - air) * 0.45,
  };

  // --- legs ------------------------------------------------------------------
  const legs: Limb[] = [];
  const toePitch: number[] = [];
  const stance = stanceFraction(k);
  for (const side of [0, 1]) {
    // side 0 is the far leg. The chaser's far leg drags slightly out of time:
    // a limp is asymmetry in the RHYTHM, not in the geometry, so the foot is
    // still planted flat — it just lands a beat late.
    const lp = wrap01(p + side * 0.5 + (side === 0 ? rig.ragged * 0.05 : 0));
    const local = footOffset(lp, k);
    let foot: Vec2 = { x: local.x * k, y: local.y * k };

    // Toes point down through the swing and lie flat through the stance.
    let pitch = 0.06;
    if (lp > stance) {
      const t = (lp - stance) / (1 - stance);
      pitch = 0.06 + 0.7 * Math.sin(Math.PI * t);
    }

    if (air > 0) {
      // A real arc, and never a symmetric one: one leg always leads.
      //   rising  — gathered. Lead knee driven up in front, trailing heel
      //             folded up behind. The body makes itself small.
      //   falling — reaching. Lead leg stretched down and forward for the
      //             ground it can see coming, trailing leg still trailing.
      const lead = side === 1;
      const gathered: Vec2 = lead
        ? { x: STEP_AHEAD + 13, y: HIP_HEIGHT - 27 }
        : { x: STEP_AHEAD - 17, y: HIP_HEIGHT - 25 };
      const reaching: Vec2 = lead
        ? { x: STEP_AHEAD + 24, y: HIP_HEIGHT + 2 }
        : { x: STEP_AHEAD - 23, y: HIP_HEIGHT - 16 };
      // Between the two extremes sits the apex: legs still folded, opening.
      const blend = clamp(0.5 + (reach - gather) * 0.5, 0, 1);
      const target: Vec2 = {
        x: mix(gathered.x, reaching.x, blend) * k,
        y: mix(gathered.y, reaching.y, blend) * k,
      };
      foot = mixV(foot, target, air);
      pitch = mix(pitch, mix(0.7, 0.2, blend), air);
    }

    if (thrash > 0 && flail) {
      const a = flail.angle * 1.1 + side * 2.6;
      const kick: Vec2 = {
        x: (STEP_AHEAD + 17 * Math.cos(a)) * k,
        y: (HIP_HEIGHT - 8 + 15 * Math.sin(a)) * k,
      };
      foot = mixV(foot, kick, thrash);
      pitch = mix(pitch, 0.9 * Math.sin(a * 1.7), thrash);
    }

    foot = reachClamp(hip, foot, legLen * 0.995);
    const knee = solveJoint(hip, foot, THIGH * k, SHIN * k, 1);
    const toe = add(foot, {
      x: Math.cos(pitch) * FOOT_LEN * k,
      y: Math.sin(pitch) * FOOT_LEN * k,
    });
    legs.push({ root: hip, joint: knee, end: foot, tip: toe });
    toePitch.push(pitch);
  }

  // --- arms: swung from the shoulder, not solved from the hand ---------------
  const arms: Limb[] = [];
  for (const side of [0, 1]) {
    // Opposite the same-side leg. The chaser's swing wanders off the beat.
    const jitter = rig.ragged ? Math.sin(2 * Math.PI * p * 3 + side) * 0.07 * rig.ragged : 0;
    const ap = p + side * 0.5 + 0.5;
    const swing = Math.cos(2 * Math.PI * ap);
    let upper = rig.armAmp * swing + jitter;
    // The elbow CLOSES on the way forward and OPENS on the drive back, so the
    // hand travels from behind the hip up to the chin and back. A constant
    // flex keeps both hands parked on the chest whatever the shoulder does,
    // which is what made the old arms read as stubs.
    let flex = 1.25 + 0.78 * swing;

    if (air > 0) {
      // Never the same on both sides: two arms doing one thing is a mannequin
      // falling, not a person. Rising, both come up but one leads; falling,
      // one is flung back for balance while the other crosses the body.
      const rising = { far: 0.7, near: 1.15 }[side === 0 ? "far" : "near"];
      const falling = { far: -0.95, near: 0.25 }[side === 0 ? "far" : "near"];
      upper = mix(upper, mix(falling, rising, gather), air);
      flex = mix(flex, mix(side === 0 ? 0.5 : 1.15, 1.9, gather), air);
    }
    if (absorb > 0) {
      upper = mix(upper, -0.75, absorb * 0.6);
      flex = mix(flex, 1.6, absorb * 0.6);
    }
    if (thrash > 0 && flail) {
      const a = flail.angle * 1.6 + side * 2.1;
      upper = mix(upper, 2.3 * Math.sin(a), thrash);
      flex = mix(flex, 1.0 + 0.9 * Math.sin(a * 1.3 + 1), thrash);
    }

    const root = { x: shoulder.x, y: shoulder.y };
    const elbow = add(root, dir(upper, UPPER_ARM * rig.armLen * k));
    const hand = add(elbow, dir(upper + flex, FOREARM * rig.armLen * k));
    arms.push({ root, joint: elbow, end: hand, tip: hand });
  }

  return { hip, spine, shoulder, neck, head, headR, lean, legs, arms, toePitch };
}

// --- painting ----------------------------------------------------------------

type Shape = () => void;

/** A tapered capsule: the bone as a solid with round ends. Filled rather than
 *  stroked, because a stroked line has one width and a limb does not — and
 *  because a fill keeps its shape when the whole figure is shrunk to a third
 *  of its desktop size. */
function capsule(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, wa: number, wb: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const ang = d < 1e-6 ? 0 : Math.atan2(dy, dx);
  const ra = Math.max(wa, 0.2) / 2;
  const rb = Math.max(wb, 0.2) / 2;
  const H = Math.PI / 2;
  ctx.beginPath();
  ctx.arc(a.x, a.y, ra, ang + H, ang + 3 * H);
  ctx.arc(b.x, b.y, rb, ang + 3 * H, ang + 5 * H);
  ctx.closePath();
}

function disc(ctx: CanvasRenderingContext2D, c: Vec2, r: number): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(r, 0.2), 0, Math.PI * 2);
  ctx.closePath();
}

/** Paint one figure. The shapes are collected first and painted in passes —
 *  rim under everything, then the far limbs, then the near body over the top.
 *  Rimming each shape as it goes would outline every limb against the torso
 *  and turn the figure into a diagram of itself. */
function paint(
  ctx: CanvasRenderingContext2D,
  pose: Pose,
  rig: Rig,
  palette: Palette,
  alpha: number,
): void {
  const k = rig.size;
  const w = rig.weight * k;

  const legShapes = (i: number): Shape[] => {
    const leg = pose.legs[i];
    return [
      () => capsule(ctx, leg.root, leg.joint, 9 * w, 6.6 * w),
      () => capsule(ctx, leg.joint, leg.end, 6.6 * w, 4.4 * w),
      () => capsule(ctx, leg.end, leg.tip, 5.4 * w, 2.8 * w),
    ];
  };

  const armShapes = (i: number): Shape[] => {
    const arm = pose.arms[i];
    const out: Shape[] = [
      () => capsule(ctx, arm.root, arm.joint, 6.4 * w, 5 * w),
      () => capsule(ctx, arm.joint, arm.end, 5 * w, 3.4 * w),
      () => disc(ctx, arm.end, 3.1 * w),
    ];
    if (rig.claws) {
      // Three short hooks off the hand, splayed along the forearm's line.
      const dx = arm.end.x - arm.joint.x;
      const dy = arm.end.y - arm.joint.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      for (const s of [-0.55, 0, 0.55]) {
        const cs = Math.cos(s);
        const sn = Math.sin(s);
        const tipX = arm.end.x + (ux * cs - uy * sn) * 7 * k;
        const tipY = arm.end.y + (ux * sn + uy * cs) * 7 * k;
        out.push(() => capsule(ctx, arm.end, { x: tipX, y: tipY }, 3.2 * w, 1.2 * w));
      }
    }
    return out;
  };

  const chest = 9.5 * w * (0.72 + 0.28 * rig.shoulderW);
  const body: Shape[] = [
    () => capsule(ctx, pose.hip, pose.spine, 9 * w, chest),
    () => capsule(ctx, pose.spine, pose.shoulder, chest, 7 * w),
    // Shoulder mass. On the chaser this is the hump that reads before the head
    // does, and it is the single clearest way the two silhouettes differ. It
    // has to stay under the head, though: at full shoulder width it ate the
    // skull and the figure became a boulder with legs.
    () => disc(ctx, pose.shoulder, 4.2 * w * rig.shoulderW),
    () => disc(ctx, pose.hip, 6 * w),
    () => capsule(ctx, pose.shoulder, pose.neck, 6 * w, 5 * w),
    () => disc(ctx, pose.head, pose.headR),
  ];

  if (rig.spikes > 0) {
    // Spines along the bowed back. Rooted on the BACK EDGE of the torso rather
    // than on the spine itself, or the mass swallows them whole.
    const n = Math.round(rig.spikes);
    const a = pose.lean;
    const bx = -Math.cos(a);
    const by = -Math.sin(a);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const edge = chest * 0.45;
      const rx = mix(pose.hip.x, pose.shoulder.x, 0.12 + t * 0.82) + bx * edge;
      const ry = mix(pose.hip.y, pose.shoulder.y, 0.12 + t * 0.82) + by * edge;
      const len = (3 + 6 * Math.sin(Math.PI * t)) * k;
      const tip = { x: rx + bx * len * 0.75, y: ry + by * len * 0.75 - len * 0.8 };
      body.push(() => capsule(ctx, { x: rx, y: ry }, tip, 4.4 * w, 0.9 * w));
    }
  }

  if (rig.claws) {
    // A heavy jaw pushed out ahead of the skull: menace is mostly profile.
    const a = pose.lean;
    const jaw = {
      x: pose.head.x + Math.cos(a) * pose.headR * 1.15,
      y: pose.head.y + Math.sin(a) * pose.headR * 0.9 + pose.headR * 0.42,
    };
    body.push(() => capsule(ctx, pose.head, jaw, pose.headR * 1.5, pose.headR * 0.7));
  } else {
    // A short tuft thrown back off the crown: cheap, and the only part of the
    // runner that says which way the wind is going. Kept small — at head-sized
    // it stopped being hair and became a hat.
    const a = pose.lean;
    const tip = {
      x: pose.head.x - Math.cos(a) * pose.headR * 1.35,
      y: pose.head.y - Math.sin(a) * pose.headR * 1.35 - pose.headR * 0.15,
    };
    body.push(() => capsule(ctx, pose.head, tip, pose.headR * 0.8, 1.1 * w));
  }

  const far: Shape[] = [...legShapes(0), ...armShapes(0)];
  const near: Shape[] = [...body, ...legShapes(1), ...armShapes(1)];
  const all = [...far, ...near];

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Pass 1: the rim, under everything. Paper is the colour BEHIND the world on
  // every palette including the inverted one, so a paper rim always reads as
  // "this figure is in front of that", never as an outline drawn in ink.
  ctx.strokeStyle = at(palette.paper, 0.62 * alpha);
  ctx.lineWidth = 4.2 * k;
  for (const s of all) {
    s();
    ctx.stroke();
  }

  // Pass 2: the far limbs, held back so the near side reads as the near side.
  ctx.fillStyle = at(palette.ink, 0.68 * alpha);
  for (const s of far) {
    s();
    ctx.fill();
  }

  // Pass 3: the body and the near limbs, full strength.
  ctx.fillStyle = at(palette.ink, alpha);
  for (const s of near) {
    s();
    ctx.fill();
  }
}

// --- placement ---------------------------------------------------------------

type Body = { pos: Vec2; vel: Vec2; radius: number; grounded: boolean };

/** Landing memory. Physics gives no "just landed" flag and vertical speed is
 *  zeroed by the collision in the same frame the ground is met, so absorption
 *  cannot be read off the body alone. This keeps a per-body scrap of purely
 *  VISUAL state — never written back to the simulation — and decays it by
 *  PHASE, i.e. by ground covered, so a landing unwinds over a fixed number of
 *  strides and slow motion stretches it exactly as it stretches the stride. */
type Memo = { phase: number; airborne: number; absorb: number };
const memo = new WeakMap<object, Memo>();

/** Strides over which a landing's compression unwinds. */
const ABSORB_STRIDES = 0.55;

function landing(body: Body, phase: number, airborne: number): number {
  const prev = memo.get(body);
  const p = wrap01(phase);
  let absorb = 0;
  if (prev) {
    let d = p - prev.phase;
    if (d < 0) d += 1;
    if (d > 0.5) d = 0; // a jump in phase is a restart, not a stride
    absorb = Math.max(0, prev.absorb - d / ABSORB_STRIDES);
    if (prev.airborne > 0.25 && airborne === 0) {
      absorb = Math.max(absorb, clamp(prev.airborne, 0, 1));
    }
  }
  memo.set(body, { phase: p, airborne, absorb });
  return absorb;
}

/** Place, orient and draw a figure. `slope` rotates the whole body so it
 *  stands square to the ground it is on; `facing` mirrors it. */
function drawFigure(
  ctx: CanvasRenderingContext2D,
  body: Body,
  phase: number,
  rig: Rig,
  palette: Palette,
  alpha: number,
  extra: PoseOptions = {},
): void {
  const slope = body.grounded
    ? clamp(Math.atan2(body.vel.y, Math.abs(body.vel.x) || 1), -0.5, 0.5)
    : 0;
  const facing = body.vel.x < -1 ? -1 : 1;
  // Blend rather than switch, so leaving and rejoining the ground is smooth.
  const airborne = body.grounded ? 0 : clamp(Math.abs(body.vel.y) / 260, 0, 1);
  const absorb = landing(body, phase, airborne);

  const pose = posture(phase, rig, { airborne, vy: body.vel.y, absorb, ...extra });

  ctx.save();
  // Feet sit at the bottom of the collision circle; the hip rides above them.
  ctx.translate(body.pos.x, body.pos.y + body.radius);
  ctx.rotate(slope);
  ctx.scale(facing, 1);
  ctx.translate(0, -HIP_HEIGHT * rig.size);
  paint(ctx, pose, rig, palette, alpha);
  ctx.restore();
}

export function drawRunner(
  ctx: CanvasRenderingContext2D,
  runner: Runner,
  phase: number,
  palette: Palette,
): void {
  drawFigure(ctx, runner, phase, RUNNER_RIG, palette, 1);
}

export function drawChaser(
  ctx: CanvasRenderingContext2D,
  chaser: Chaser,
  phase: number,
  palette: Palette,
): void {
  drawFigure(ctx, chaser, phase, CHASER_RIG, palette, 1);
}

/** How far the ghost has plunged, `t` seconds after it lost the ground.
 *
 *  The simulation freezes the ghost the instant it dies, so there is no
 *  distance to drive this from and no other state that exists. A brief hang
 *  and then an accelerating drop: the hang is what makes the flail legible at
 *  all before it clears the frame, and the acceleration is what makes it read
 *  as a fall rather than a descent. */
export function ghostFallDepth(t: number): number {
  const s = Math.max(0, t);
  return 55 * s + 0.5 * 620 * s * s;
}

export function drawGhost(
  ctx: CanvasRenderingContext2D,
  ghost: Ghost,
  phase: number,
  palette: Palette,
): void {
  if (ghost.goneFor <= 0) {
    // Still alive — but if it is dropping, the panic starts HERE, on the way
    // down, not at the instant the simulation declares it gone. By the time
    // `goneFor` ticks the ghost is already 54px under the lowest ground and
    // most of the way out of frame, so a fall that only begins to read at
    // that point has almost no frames left to teach in.
    const panic = ghost.grounded ? 0 : clamp((ghost.vel.y - 240) / 420, 0, 1);
    drawFigure(ctx, ghost, phase, RUNNER_RIG, palette, 0.5, {
      // Driven by how far it has fallen, so it thrashes harder the longer the
      // drop — and so nothing here reads a clock.
      flail: panic > 0 ? { angle: ghost.pos.y / 9, amount: panic } : null,
    });
    return;
  }

  // Falling out of the world. This is the game's entire wordless tutorial —
  // the only thing that tells a new player anything is required of them — so
  // it has to read as a death, not as a figure calmly rotating. Three things
  // sell it: it accelerates, it thrashes, and it smears.
  const fade = clamp(1 - ghost.goneFor / 2.5, 0, 1);

  // Motion smear: the same body a moment further up its own arc, fainter each
  // time. Cheap, and it turns a falling figure into a falling BLUR.
  const trail = [0.11, 0.055, 0];
  for (const back of trail) {
    const depth = ghostFallDepth(Math.max(0, ghost.goneFor - back));
    const lead = back === 0;
    const alpha = 0.58 * fade * (lead ? 1 : 0.28);
    if (alpha <= 0.002) continue;
    // Tumble accelerates with the fall, because it is driven by how far it has
    // dropped rather than by how long it has been dropping.
    const spin = depth / 46;
    const pose = posture(0, RUNNER_RIG, { flail: { angle: depth / 9, amount: 1 } });
    ctx.save();
    ctx.translate(ghost.pos.x, ghost.pos.y + ghost.radius + depth);
    ctx.rotate(spin);
    ctx.translate(0, -HIP_HEIGHT);
    paint(ctx, pose, RUNNER_RIG, palette, alpha);
    ctx.restore();
  }
}
