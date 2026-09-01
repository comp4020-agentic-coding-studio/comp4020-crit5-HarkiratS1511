import { describe, expect, it } from "vitest";
import {
  HIP_HEIGHT,
  SHIN,
  STEP_H,
  STEP_W,
  THIGH,
  drawChaser,
  drawGhost,
  drawRunner,
  footOffset,
  solveJoint,
} from "./figures";
import type { Chaser, Ghost, Runner } from "./types";

function mockCtx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  return {
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    quadraticCurveTo: noop, ellipse: noop, fill: noop, stroke: noop,
    fillRect: noop, arcTo: noop, setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
}

const runner = (over: Partial<Runner> = {}): Runner => ({
  pos: { x: 100, y: 400 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true, ...over,
});

describe("footOffset", () => {
  it("is finite everywhere and never breaks the cycle", () => {
    for (let i = 0; i <= 400; i++) {
      const f = footOffset(i / 400);
      expect(Number.isFinite(f.x)).toBe(true);
      expect(Number.isFinite(f.y)).toBe(true);
    }
  });

  it("keeps a planted foot level through the whole stance half", () => {
    // The flattened bottom of the ellipse is what makes a foot look planted
    // rather than curving through the floor — the difference between a run
    // and a pair of scissoring sticks.
    const ground = HIP_HEIGHT + STEP_H / 2;
    for (let i = 0; i <= 60; i++) {
      const p = (i / 60) * 0.5; // sin >= 0: stance
      expect(footOffset(p).y).toBeCloseTo(ground, 6);
    }
  });

  it("lifts the foot during the swing half", () => {
    const ground = HIP_HEIGHT + STEP_H / 2;
    expect(footOffset(0.75).y).toBeLessThan(ground - 1);
    // and never lifts further than the ellipse allows
    expect(footOffset(0.75).y).toBeGreaterThanOrEqual(ground - STEP_H - 1e-6);
  });

  it("sweeps the foot backward through stance and forward through swing", () => {
    expect(footOffset(0.25).x).toBeLessThan(footOffset(0).x);
    expect(footOffset(0.5).x).toBeLessThan(footOffset(0.25).x);
    expect(footOffset(0.9).x).toBeGreaterThan(footOffset(0.6).x);
  });

  it("travels a stride no wider than the ellipse", () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const x = footOffset(i / 200).x;
      lo = Math.min(lo, x); hi = Math.max(hi, x);
    }
    expect(hi - lo).toBeCloseTo(STEP_W, 4);
  });

  it("wraps continuously across the cycle boundary", () => {
    const a = footOffset(0.999);
    const b = footOffset(0);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
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
    // A limb that snaps inside-out is the classic IK failure; clamping keeps
    // it straight and pointed at an unreachable target instead.
    const target = { x: 500, y: 0 };
    const j = solveJoint(from, target, THIGH, SHIN, 1);
    expect(Number.isFinite(j.x)).toBe(true);
    expect(Number.isFinite(j.y)).toBe(true);
    // Effectively straight: the joint sits a bone's length along the line to
    // the target, with only the clamp epsilon's worth of bend left in it.
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

describe("drawing", () => {
  const phases = [0, 0.17, 0.5, 0.83, 0.999];

  it("draws a grounded runner at every phase", () => {
    for (const p of phases) {
      expect(() => drawRunner(mockCtx(), runner(), p)).not.toThrow();
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
      expect(() => drawRunner(mockCtx(), runner(c), 0.3)).not.toThrow();
    }
  });

  it("draws the chaser", () => {
    const chaser: Chaser = {
      pos: { x: 40, y: 400 }, vel: { x: 172, y: 0 }, radius: 16, grounded: true,
    };
    for (const p of phases) expect(() => drawChaser(mockCtx(), chaser, p)).not.toThrow();
  });

  it("draws the ghost alive and through its whole fade", () => {
    const base: Ghost = {
      pos: { x: 70, y: 400 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true, goneFor: 0,
    };
    expect(() => drawGhost(mockCtx(), base, 0.4)).not.toThrow();
    for (const g of [0.01, 0.5, 1.4, 2.5, 4]) {
      expect(() => drawGhost(mockCtx(), { ...base, goneFor: g }, 0.4)).not.toThrow();
    }
  });
});
