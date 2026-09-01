import { describe, expect, it } from "vitest";
import {
  CHASER_RIG,
  FOREARM,
  HIP_HEIGHT,
  RUNNER_RIG,
  SHIN,
  STEP_AHEAD,
  STEP_H,
  STEP_W,
  THIGH,
  UPPER_ARM,
  drawChaser,
  drawGhost,
  drawRunner,
  footOffset,
  ghostFallDepth,
  hipOffset,
  posture,
  reachClamp,
  solveJoint,
  stanceFraction,
} from "./figures";
import { STRIDE_PX } from "./tuning";
import { paletteFor } from "./palette";
import type { Chaser, Ghost, Runner } from "./types";

function mockCtx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  return {
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    beginPath: noop, closePath: noop, arc: noop, fill: noop, stroke: noop,
  } as unknown as CanvasRenderingContext2D;
}

const runner = (over: Partial<Runner> = {}): Runner => ({
  pos: { x: 100, y: 400 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true, ...over,
});

describe("stanceFraction", () => {
  it("is the sweep-over-stride ratio when that ratio sits inside the clamp", () => {
    // At size 1 the sweep (STEP_W) over the stride (STRIDE_PX) sits inside
    // [0.12, 0.46], so the clamp is inert and the formula is exact.
    expect(stanceFraction(1)).toBeCloseTo(STEP_W / STRIDE_PX, 10);
  });

  it("grows with size, since a bigger figure sweeps a bigger foot", () => {
    expect(stanceFraction(1.3)).toBeGreaterThan(stanceFraction(1));
  });

  it("never leaves the clamp band, however extreme the size", () => {
    expect(stanceFraction(0.0001)).toBeGreaterThanOrEqual(0.12);
    expect(stanceFraction(50)).toBeLessThanOrEqual(0.46);
  });
});

describe("footOffset", () => {
  it("is finite everywhere, at every size", () => {
    for (const size of [0.5, 1, 1.3, 2]) {
      for (let i = 0; i <= 200; i++) {
        const f = footOffset(i / 200, size);
        expect(Number.isFinite(f.x)).toBe(true);
        expect(Number.isFinite(f.y)).toBe(true);
      }
    }
  });

  it("holds the foot exactly at floor height through the whole linear stance", () => {
    // Stance is a straight line at HIP_HEIGHT — no lift, no curve. That flat
    // hold is what a planted foot looks like; the moment it curves it reads
    // as skating.
    const stance = stanceFraction(1);
    for (let i = 0; i <= 40; i++) {
      const p = (i / 40) * stance;
      expect(footOffset(p, 1).y).toBeCloseTo(HIP_HEIGHT, 9);
    }
  });

  it("sweeps backward at a constant rate through stance", () => {
    const stance = stanceFraction(1);
    const a = footOffset(0, 1).x;
    const b = footOffset(stance * 0.5, 1).x;
    const c = footOffset(stance, 1).x;
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    // Constant rate: equal steps in phase move the foot by equal amounts.
    expect(a - b).toBeCloseTo(b - c, 6);
  });

  it("lifts off the floor during swing and peaks at STEP_H above it", () => {
    const stance = stanceFraction(1);
    let minY = Infinity;
    for (let i = 0; i <= 200; i++) {
      const p = stance + ((1 - stance) * i) / 200;
      minY = Math.min(minY, footOffset(p, 1).y);
    }
    // The lift profile (6.75 t(1-t)^2) peaks at exactly 1, so the highest
    // point of swing sits STEP_H above the floor, not merely "somewhere above
    // it" — the whole point of naming the peak in the source.
    expect(minY).toBeCloseTo(HIP_HEIGHT - STEP_H, 1);
  });

  it("returns to exactly floor height at touchdown, both ends of the cycle", () => {
    expect(footOffset(0, 1).y).toBeCloseTo(HIP_HEIGHT, 9);
    expect(footOffset(0.999999, 1).y).toBeCloseTo(HIP_HEIGHT, 3);
  });

  it("overshoots the sweep width — a heel kick-back and a paw before contact", () => {
    // Continuity of VELOCITY at both handovers (not just position) is what the
    // module promises, and it is exactly what makes the swing overshoot the
    // plain front/back sweep: the foot keeps travelling backward for a moment
    // after toe-off, and is still closing backward as it touches down. A
    // model that clips to the sweep width (the old ellipse) would fail this.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const x = footOffset(i / 400, 1).x;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    expect(hi - lo).toBeGreaterThan(STEP_W);
    // Bounded, so a runaway tangent can never throw the foot arbitrarily far.
    expect(hi - lo).toBeLessThan(STEP_W * 2);
  });

  it("wraps continuously across the cycle boundary", () => {
    const a = footOffset(0.999999, 1);
    const b = footOffset(0, 1);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.5);
  });

  it("is centred STEP_AHEAD of the hip at the dead centre of stance", () => {
    const stance = stanceFraction(1);
    expect(footOffset(stance / 2, 1).x).toBeCloseTo(STEP_AHEAD, 6);
  });
});

describe("hipOffset", () => {
  it("is finite everywhere", () => {
    for (let i = 0; i <= 200; i++) {
      const h = hipOffset(i / 200, 1, 1);
      expect(Number.isFinite(h.x)).toBe(true);
      expect(Number.isFinite(h.y)).toBe(true);
    }
  });

  it("dips down through the first half-cycle, rises through the second", () => {
    const stance = stanceFraction(1);
    expect(hipOffset(stance / 2, 1, 1).y).toBeGreaterThan(0); // +y is down: a dip
    const flightMid = 0.5 - (0.5 - stance) / 2;
    expect(hipOffset(flightMid, 1, 1).y).toBeLessThan(0); // rise
  });

  it("returns to zero at the seam between stance and flight, both halves", () => {
    const stance = stanceFraction(1);
    expect(hipOffset(0, 1, 1).y).toBeCloseTo(0, 6);
    expect(hipOffset(stance, 1, 1).y).toBeCloseTo(0, 6);
    expect(hipOffset(0.5, 1, 1).y).toBeCloseTo(0, 6);
  });

  it("scales linearly with amount", () => {
    const stance = stanceFraction(1);
    const base = hipOffset(stance / 2, 1, 1).y;
    expect(hipOffset(stance / 2, 1, 2).y).toBeCloseTo(base * 2, 6);
    expect(hipOffset(stance / 2, 1, 0).y).toBeCloseTo(0, 9);
  });
});

describe("solveJoint", () => {
  const from = { x: 0, y: 0 };

  it("places the joint at both bone lengths from its ends", () => {
    const target = { x: 14, y: 18 };
    const j = solveJoint(from, target, THIGH, SHIN, 1);
    expect(Math.hypot(j.x - from.x, j.y - from.y)).toBeCloseTo(THIGH, 3);
    expect(Math.hypot(j.x - target.x, j.y - target.y)).toBeCloseTo(SHIN, 3);
  });

  it("bends to opposite sides for opposite signs", () => {
    const target = { x: 0, y: 24 };
    const a = solveJoint(from, target, THIGH, SHIN, 1);
    const b = solveJoint(from, target, THIGH, SHIN, -1);
    expect(Math.sign(a.x)).toBe(-Math.sign(b.x));
  });

  it("stays straight rather than breaking when the target is out of reach", () => {
    const target = { x: 500, y: 0 };
    const j = solveJoint(from, target, THIGH, SHIN, 1);
    expect(Number.isFinite(j.x)).toBe(true);
    expect(Number.isFinite(j.y)).toBe(true);
    expect(Math.hypot(j.x, j.y)).toBeCloseTo(THIGH, 3);
    expect(Math.abs(j.y)).toBeLessThan(THIGH * 0.05);
  });

  it("survives a degenerate zero-length target", () => {
    const j = solveJoint(from, { x: 0, y: 0 }, THIGH, SHIN, 1);
    expect(Number.isFinite(j.x) && Number.isFinite(j.y)).toBe(true);
  });

  it("is deterministic", () => {
    const t = { x: 9, y: 21 };
    expect(solveJoint(from, t, THIGH, SHIN, 1)).toEqual(solveJoint(from, t, THIGH, SHIN, 1));
  });
});

describe("reachClamp", () => {
  const from = { x: 0, y: 0 };

  it("passes a reachable target through unchanged", () => {
    const target = { x: 10, y: 10 };
    expect(reachClamp(from, target, 50)).toEqual(target);
  });

  it("pulls an unreachable target to exactly maxLen away, on the same ray", () => {
    const target = { x: 300, y: 0 };
    const p = reachClamp(from, target, 40);
    expect(Math.hypot(p.x - from.x, p.y - from.y)).toBeCloseTo(40, 6);
    expect(p.y).toBeCloseTo(0, 6); // same direction as the target
  });

  it("survives a degenerate zero-length gap", () => {
    const p = reachClamp(from, from, 40);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe("posture", () => {
  it("is pure: identical inputs produce identical output", () => {
    const a = posture(0.37, RUNNER_RIG, { airborne: 0.4, vy: 120, absorb: 0.2 });
    const b = posture(0.37, RUNNER_RIG, { airborne: 0.4, vy: 120, absorb: 0.2 });
    expect(a).toEqual(b);
  });

  it("returns exactly two legs, two arms and two toe pitches", () => {
    const pose = posture(0.2, RUNNER_RIG);
    expect(pose.legs).toHaveLength(2);
    expect(pose.arms).toHaveLength(2);
    expect(pose.toePitch).toHaveLength(2);
  });

  it.each([
    ["runner, grounded", RUNNER_RIG, {}],
    ["runner, airborne rising", RUNNER_RIG, { airborne: 1, vy: -400 }],
    ["runner, airborne falling", RUNNER_RIG, { airborne: 1, vy: 900 }],
    ["runner, landing absorb", RUNNER_RIG, { absorb: 1 }],
    ["chaser, grounded", CHASER_RIG, {}],
    ["chaser, airborne", CHASER_RIG, { airborne: 0.6, vy: 300 }],
    ["ghost, flailing", RUNNER_RIG, { flail: { angle: 2.4, amount: 1 } }],
  ] as const)("never stretches a bone past its length: %s", (_label, rig, opts) => {
    const k = rig.size;
    const legLen = (THIGH + SHIN) * k;
    for (let i = 0; i <= 20; i++) {
      const pose = posture(i / 20, rig, opts);
      for (const leg of pose.legs) {
        const thigh = Math.hypot(leg.joint.x - leg.root.x, leg.joint.y - leg.root.y);
        const shin = Math.hypot(leg.end.x - leg.joint.x, leg.end.y - leg.joint.y);
        expect(thigh).toBeLessThanOrEqual(THIGH * k + 0.05);
        expect(shin).toBeLessThanOrEqual(SHIN * k + 0.05);
        // reachClamp guarantees the whole leg never exceeds its total length.
        const total = Math.hypot(leg.end.x - leg.root.x, leg.end.y - leg.root.y);
        expect(total).toBeLessThanOrEqual(legLen + 0.05);
      }
      for (const arm of pose.arms) {
        const upperLen = Math.hypot(arm.joint.x - arm.root.x, arm.joint.y - arm.root.y);
        const foreLen = Math.hypot(arm.end.x - arm.joint.x, arm.end.y - arm.joint.y);
        expect(upperLen).toBeCloseTo(UPPER_ARM * rig.armLen * k, 3);
        expect(foreLen).toBeCloseTo(FOREARM * rig.armLen * k, 3);
      }
    }
  });

  it("gives the chaser a visibly different silhouette from the runner", () => {
    const r = posture(0.1, RUNNER_RIG);
    const c = posture(0.1, CHASER_RIG);
    // Every one of these is a deliberate silhouette difference (see the Rig
    // comments): a glance at a shrunk figure has to separate them on shape
    // alone, not on a size reading nobody can make at 50px.
    expect(c.headR).toBeGreaterThan(r.headR);
    expect(Math.hypot(c.shoulder.x - c.hip.x, c.shoulder.y - c.hip.y)).toBeGreaterThan(
      Math.hypot(r.shoulder.x - r.hip.x, r.shoulder.y - r.hip.y),
    );
  });

  it("blends smoothly from grounded to airborne rather than snapping", () => {
    const near0 = posture(0.3, RUNNER_RIG, { airborne: 0.02, vy: 400 });
    const grounded = posture(0.3, RUNNER_RIG, { airborne: 0, vy: 400 });
    const dx = near0.legs[1].end.x - grounded.legs[1].end.x;
    const dy = near0.legs[1].end.y - grounded.legs[1].end.y;
    // A 2% blend should move the foot only a small fraction of its full
    // airborne excursion, not jump straight to the airborne pose.
    expect(Math.hypot(dx, dy)).toBeLessThan(HIP_HEIGHT * 0.3);
  });
});

describe("ghostFallDepth", () => {
  it("is zero at the moment of death", () => {
    expect(ghostFallDepth(0)).toBe(0);
  });

  it("clamps negative time to zero rather than rising back out of the fall", () => {
    expect(ghostFallDepth(-1)).toBe(0);
  });

  it("increases monotonically and accelerates", () => {
    const a = ghostFallDepth(0.5);
    const b = ghostFallDepth(1);
    const c = ghostFallDepth(1.5);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // Acceleration: the second half-second interval covers more depth than
    // the first, because this is a fall (gravity), not a constant drift.
    expect(c - b).toBeGreaterThan(b - a);
  });

  it("matches the documented ballistic formula", () => {
    expect(ghostFallDepth(1)).toBeCloseTo(55 * 1 + 0.5 * 620 * 1 * 1, 6);
  });
});

describe("drawing", () => {
  const phases = [0, 0.17, 0.5, 0.83, 0.999];
  const palette = paletteFor(0);

  it("draws a grounded runner at every phase", () => {
    for (const p of phases) {
      expect(() => drawRunner(mockCtx(), runner(), p, palette)).not.toThrow();
    }
  });

  it("draws rising, falling and steeply-sloped runners", () => {
    const cases: Partial<Runner>[] = [
      { grounded: false, vel: { x: 185, y: -420 } },
      { grounded: false, vel: { x: 185, y: 900 } },
      { grounded: true, vel: { x: 140, y: 120 } },
      { grounded: true, vel: { x: -185, y: 0 } }, // facing flipped
      { vel: { x: 0, y: 0 } },
    ];
    for (const c of cases) {
      expect(() => drawRunner(mockCtx(), runner(c), 0.3, palette)).not.toThrow();
    }
  });

  it("draws the chaser", () => {
    const chaser: Chaser = {
      pos: { x: 40, y: 400 }, vel: { x: 172, y: 0 }, radius: 16, grounded: true,
    };
    for (const p of phases) {
      expect(() => drawChaser(mockCtx(), chaser, p, palette)).not.toThrow();
    }
  });

  it("draws the ghost alive and through its whole fade", () => {
    const base: Ghost = {
      pos: { x: 70, y: 400 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true, goneFor: 0,
    };
    expect(() => drawGhost(mockCtx(), base, 0.4, palette)).not.toThrow();
    for (const g of [0.01, 0.5, 1.4, 2.5, 4]) {
      expect(() => drawGhost(mockCtx(), { ...base, goneFor: g }, 0.4, palette)).not.toThrow();
    }
  });

  it("draws the ghost's pre-death panic without throwing", () => {
    const falling: Ghost = {
      pos: { x: 70, y: 400 }, vel: { x: 185, y: 600 }, radius: 12, grounded: false, goneFor: 0,
    };
    expect(() => drawGhost(mockCtx(), falling, 0.4, palette)).not.toThrow();
  });

  it("draws every figure under every level palette, including the inverted night one", () => {
    for (let level = 0; level < 4; level++) {
      const p = paletteFor(level);
      expect(() => drawRunner(mockCtx(), runner(), 0.3, p)).not.toThrow();
      expect(() =>
        drawChaser(
          mockCtx(),
          { pos: { x: 40, y: 400 }, vel: { x: 172, y: 0 }, radius: 16, grounded: true },
          0.3,
          p,
        ),
      ).not.toThrow();
      expect(() =>
        drawGhost(
          mockCtx(),
          { pos: { x: 70, y: 400 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true, goneFor: 0.6 },
          0.3,
          p,
        ),
      ).not.toThrow();
    }
  });
});
