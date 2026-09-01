import { describe, it, expect } from "vitest";
import type { Runner, Chaser, Ghost } from "./types";
import { RUNNER_RADIUS, CHASER_RADIUS } from "./tuning";
import {
  drawRunner,
  drawChaser,
  drawGhost,
  gaitFrequency,
  gaitPhase,
  legFootOffset,
  twoBoneIK,
  armSwingAngle,
  elbowBendAngle,
  bodyBobOffset,
  torsoCounterRotation,
} from "./figures";

/**
 * A plain-object stand-in for CanvasRenderingContext2D: every drawing method
 * is a no-op, every style property is a plain settable field. No canvas
 * library involved — this is enough surface for the draw functions to run
 * against without throwing.
 */
function makeMockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,

    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    resetTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,

    canvas: undefined,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function makeRunner(overrides: Partial<Runner> = {}): Runner {
  return {
    pos: { x: 150, y: 488 },
    vel: { x: 185, y: 0 },
    radius: RUNNER_RADIUS,
    grounded: true,
    ...overrides,
  };
}

function makeChaser(overrides: Partial<Chaser> = {}): Chaser {
  return {
    pos: { x: -60, y: 484 },
    vel: { x: 172, y: 0 },
    radius: CHASER_RADIUS,
    grounded: true,
    ...overrides,
  };
}

function makeGhost(overrides: Partial<Ghost> = {}): Ghost {
  return {
    pos: { x: 300, y: 488 },
    vel: { x: 185, y: 0 },
    radius: RUNNER_RADIUS,
    grounded: true,
    goneFor: 0,
    ...overrides,
  };
}

const SAMPLE_TIMES = [0, 0.05, 0.13, 0.37, 0.5, 0.999, 1.3, 2.71, 5.5, 12.0];

// ---------------------------------------------------------------------------
// drawRunner
// ---------------------------------------------------------------------------

describe("drawRunner", () => {
  it("does not throw while grounded, across several t values", () => {
    const ctx = makeMockCtx();
    for (const t of SAMPLE_TIMES) {
      expect(() => drawRunner(ctx, makeRunner({ grounded: true }), t)).not.toThrow();
    }
  });

  it("does not throw while airborne and rising (vel.y < 0)", () => {
    const ctx = makeMockCtx();
    for (const t of SAMPLE_TIMES) {
      expect(() =>
        drawRunner(ctx, makeRunner({ grounded: false, vel: { x: 185, y: -400 } }), t)
      ).not.toThrow();
    }
  });

  it("does not throw while airborne and falling (vel.y > 0)", () => {
    const ctx = makeMockCtx();
    for (const t of SAMPLE_TIMES) {
      expect(() =>
        drawRunner(ctx, makeRunner({ grounded: false, vel: { x: 185, y: 600 } }), t)
      ).not.toThrow();
    }
  });

  it("does not throw at the apex, where vel.y is ~0", () => {
    const ctx = makeMockCtx();
    expect(() =>
      drawRunner(ctx, makeRunner({ grounded: false, vel: { x: 185, y: 0 } }), 0.42)
    ).not.toThrow();
  });

  it("does not throw when facing backward (negative vel.x)", () => {
    const ctx = makeMockCtx();
    expect(() =>
      drawRunner(ctx, makeRunner({ vel: { x: -185, y: 0 } }), 0.42)
    ).not.toThrow();
  });

  it("does not throw with a zero radius (defensive edge case)", () => {
    const ctx = makeMockCtx();
    expect(() => drawRunner(ctx, makeRunner({ radius: 0 }), 0.1)).not.toThrow();
  });

  it("always balances save/restore exactly once", () => {
    let saves = 0;
    let restores = 0;
    const ctx = makeMockCtx();
    ctx.save = () => {
      saves++;
    };
    ctx.restore = () => {
      restores++;
    };
    drawRunner(ctx, makeRunner(), 0.3);
    expect(saves).toBeGreaterThan(0);
    expect(saves).toBe(restores);
  });

  it("does not mutate the runner it draws", () => {
    const ctx = makeMockCtx();
    const runner = makeRunner();
    const before = JSON.parse(JSON.stringify(runner));
    drawRunner(ctx, runner, 0.7);
    expect(runner).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// drawChaser
// ---------------------------------------------------------------------------

describe("drawChaser", () => {
  it("does not throw while grounded, across several t values", () => {
    const ctx = makeMockCtx();
    for (const t of SAMPLE_TIMES) {
      expect(() => drawChaser(ctx, makeChaser({ grounded: true }), t)).not.toThrow();
    }
  });

  it("does not throw while airborne and rising", () => {
    const ctx = makeMockCtx();
    expect(() =>
      drawChaser(ctx, makeChaser({ grounded: false, vel: { x: 172, y: -350 } }), 1.1)
    ).not.toThrow();
  });

  it("does not throw while airborne and falling", () => {
    const ctx = makeMockCtx();
    expect(() =>
      drawChaser(ctx, makeChaser({ grounded: false, vel: { x: 172, y: 500 } }), 1.1)
    ).not.toThrow();
  });

  it("does not throw when facing backward", () => {
    const ctx = makeMockCtx();
    expect(() =>
      drawChaser(ctx, makeChaser({ vel: { x: -172, y: 0 } }), 0.6)
    ).not.toThrow();
  });

  it("does not mutate the chaser it draws", () => {
    const ctx = makeMockCtx();
    const chaser = makeChaser();
    const before = JSON.parse(JSON.stringify(chaser));
    drawChaser(ctx, chaser, 0.9);
    expect(chaser).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// drawGhost
// ---------------------------------------------------------------------------

describe("drawGhost", () => {
  it("does not throw while alive and grounded", () => {
    const ctx = makeMockCtx();
    for (const t of SAMPLE_TIMES) {
      expect(() => drawGhost(ctx, makeGhost({ goneFor: 0, grounded: true }), t)).not.toThrow();
    }
  });

  it("does not throw while alive and airborne", () => {
    const ctx = makeMockCtx();
    expect(() =>
      drawGhost(ctx, makeGhost({ goneFor: 0, grounded: false, vel: { x: 185, y: -300 } }), 0.4)
    ).not.toThrow();
  });

  it("does not throw mid-fade, at several points across the ~2.5s fade", () => {
    const ctx = makeMockCtx();
    for (const goneFor of [0.001, 0.5, 1.25, 2.0, 2.49]) {
      expect(() => drawGhost(ctx, makeGhost({ goneFor }), 3.0)).not.toThrow();
    }
  });

  it("does not throw once fully faded (goneFor beyond the fade window)", () => {
    const ctx = makeMockCtx();
    expect(() => drawGhost(ctx, makeGhost({ goneFor: 10 }), 5.0)).not.toThrow();
  });

  it("always balances save/restore exactly once, alive or faded", () => {
    for (const goneFor of [0, 1.0, 10]) {
      let saves = 0;
      let restores = 0;
      const ctx = makeMockCtx();
      ctx.save = () => {
        saves++;
      };
      ctx.restore = () => {
        restores++;
      };
      drawGhost(ctx, makeGhost({ goneFor }), 1.0);
      expect(saves).toBeGreaterThan(0);
      expect(saves).toBe(restores);
    }
  });

  it("does not mutate the ghost it draws", () => {
    const ctx = makeMockCtx();
    const ghost = makeGhost({ goneFor: 0.8 });
    const before = JSON.parse(JSON.stringify(ghost));
    drawGhost(ctx, ghost, 1.2);
    expect(ghost).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Pose helpers: periodic and finite across a full cycle.
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;
const PHASE_SAMPLES = Array.from({ length: 24 }, (_, i) => (i / 24) * TWO_PI);

function expectFinite(v: number) {
  expect(Number.isFinite(v)).toBe(true);
  expect(Number.isNaN(v)).toBe(false);
}

describe("gaitFrequency", () => {
  it("is finite and positive for typical speeds/strides", () => {
    for (const speed of [0, 1, 172, 185, 900]) {
      for (const stride of [1, 62, 90, 500]) {
        const f = gaitFrequency(speed, stride);
        expectFinite(f);
        expect(f).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("never divides by zero for a zero or negative stride length", () => {
    expectFinite(gaitFrequency(185, 0));
    expectFinite(gaitFrequency(185, -10));
  });
});

describe("gaitPhase", () => {
  it("stays within [0, 2*PI) and is finite for a range of t and frequency", () => {
    for (const t of [...SAMPLE_TIMES, -3, -0.5]) {
      for (const freq of [0, 1, 2.06, 2.77, 10]) {
        const p = gaitPhase(t, freq);
        expectFinite(p);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(TWO_PI);
      }
    }
  });

  it("is periodic in t with period 1/frequency", () => {
    const freq = 2.2;
    const period = 1 / freq;
    for (const t of [0, 0.05, 0.3, 1.1]) {
      const a = gaitPhase(t, freq);
      const b = gaitPhase(t + period, freq);
      expect(b).toBeCloseTo(a, 6);
    }
  });
});

describe("legFootOffset", () => {
  it("is finite for every phase across a full cycle", () => {
    for (const phase of PHASE_SAMPLES) {
      const { x, y } = legFootOffset(phase, 22.5, 8);
      expectFinite(x);
      expectFinite(y);
    }
  });

  it("is periodic with period 2*PI", () => {
    for (const phase of PHASE_SAMPLES) {
      const a = legFootOffset(phase, 22.5, 8);
      const b = legFootOffset(phase + TWO_PI, 22.5, 8);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
    }
  });

  it("holds a constant x during stance except for the sweep it defines (no jump discontinuity at the stance/swing boundary)", () => {
    const justBeforeSwing = legFootOffset(Math.PI - 1e-6, 22.5, 8);
    const justAfterSwing = legFootOffset(Math.PI + 1e-6, 22.5, 8);
    expect(justAfterSwing.x).toBeCloseTo(justBeforeSwing.x, 2);
  });

  it("is continuous across the wrap from 2*PI back to 0", () => {
    const justBeforeWrap = legFootOffset(TWO_PI - 1e-6, 22.5, 8);
    const justAfterWrap = legFootOffset(0, 22.5, 8);
    expect(justAfterWrap.x).toBeCloseTo(justBeforeWrap.x, 2);
    expect(justAfterWrap.y).toBeCloseTo(justBeforeWrap.y, 2);
  });
});

describe("twoBoneIK", () => {
  it("is finite for reachable targets across a full swing", () => {
    const l1 = 15;
    const l2 = 14;
    for (const phase of PHASE_SAMPLES) {
      const target = { x: Math.sin(phase) * 10, y: 20 + Math.cos(phase) * 5 };
      const { knee, thighAngle } = twoBoneIK(target, l1, l2);
      expectFinite(knee.x);
      expectFinite(knee.y);
      expectFinite(thighAngle);
    }
  });

  it("is finite even for a target beyond reach", () => {
    const { knee, thighAngle } = twoBoneIK({ x: 0, y: 10000 }, 15, 14);
    expectFinite(knee.x);
    expectFinite(knee.y);
    expectFinite(thighAngle);
  });

  it("is finite even for a target on top of the hip (degenerate distance)", () => {
    const { knee, thighAngle } = twoBoneIK({ x: 0, y: 0 }, 15, 14);
    expectFinite(knee.x);
    expectFinite(knee.y);
    expectFinite(thighAngle);
  });

  it("is finite for degenerate (near-zero) link lengths", () => {
    const { knee, thighAngle } = twoBoneIK({ x: 5, y: 5 }, 0, 0);
    expectFinite(knee.x);
    expectFinite(knee.y);
    expectFinite(thighAngle);
  });
});

describe("armSwingAngle / elbowBendAngle / bodyBobOffset / torsoCounterRotation", () => {
  it("are all finite across a full phase cycle", () => {
    for (const phase of PHASE_SAMPLES) {
      expectFinite(armSwingAngle(phase, 0.9));
      expectFinite(elbowBendAngle(phase, 0.35, 0.55));
      expectFinite(bodyBobOffset(phase, 0.05));
      expectFinite(torsoCounterRotation(phase, 0.08));
    }
  });

  it("are all periodic with period 2*PI", () => {
    for (const phase of PHASE_SAMPLES) {
      expect(armSwingAngle(phase + TWO_PI, 0.9)).toBeCloseTo(armSwingAngle(phase, 0.9), 6);
      expect(elbowBendAngle(phase + TWO_PI, 0.35, 0.55)).toBeCloseTo(
        elbowBendAngle(phase, 0.35, 0.55),
        6
      );
      expect(bodyBobOffset(phase + TWO_PI, 0.05)).toBeCloseTo(bodyBobOffset(phase, 0.05), 6);
      expect(torsoCounterRotation(phase + TWO_PI, 0.08)).toBeCloseTo(
        torsoCounterRotation(phase, 0.08),
        6
      );
    }
  });

  it("bodyBobOffset completes two full bob cycles per gait cycle (never negative)", () => {
    for (const phase of PHASE_SAMPLES) {
      expect(bodyBobOffset(phase, 0.05)).toBeGreaterThanOrEqual(-1e-9);
    }
    // Two peaks across [0, 2*PI): near phase = PI/2 and phase = 3*PI/2.
    expect(bodyBobOffset(Math.PI / 2, 0.05)).toBeCloseTo(0.05, 6);
    expect(bodyBobOffset((3 * Math.PI) / 2, 0.05)).toBeCloseTo(0.05, 6);
    expect(bodyBobOffset(0, 0.05)).toBeCloseTo(0, 6);
  });
});
