import { describe, expect, it } from "vitest";
import { drawEndScreen, drawInkBar, drawSlowmoWash, restartAffordance } from "./hud";
import type { GameState, Level, Phase } from "./types";

const DESKTOP = { width: 1920, height: 1080 };
const PORTRAIT = { width: 390, height: 844 };
const VIEWPORTS = [DESKTOP, PORTRAIT];

/** Plain object of no-op methods plus settable style properties — no canvas
 *  library, matching the mock convention already used by render.test.ts. */
function mockCtx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const ctx: Record<string, unknown> = {
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clip: noop,
    setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function makeLevel(): Level {
  return {
    groundSegments: [{ a: { x: 0, y: 500 }, b: { x: 2000, y: 500 } }],
    pickups: [{ pos: { x: 300, y: 480 }, amount: 260, taken: false }],
    startX: 0,
    chaserStartX: -80,
    finishX: 1800,
    index: 0,
    groundY: 500,
    stub: null,
  };
}

function makeState(phase: Phase, phaseFor: number, ink: number, maxInk = 1150): GameState {
  return {
    runner: { pos: { x: 150, y: 488 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true },
    chaser: { pos: { x: 60, y: 484 }, vel: { x: 172, y: 0 }, radius: 16, grounded: true },
    ghost: null,
    levelIndex: 0,
    phaseFor,
    stuckFor: 0,
    progressX: 0,
    strokes: [],
    ink,
    maxInk,
    phase,
    level: makeLevel(),
    elapsed: 4.75,
  };
}

// Full, half, nearly-empty, exactly-zero, against a 1150 max — matches the
// tuning module's MAX_INK without importing it, so this test stays decoupled
// from files other work is touching concurrently.
const INK_LEVELS = [1150, 575, 20, 0];
const PHASE_FORS = [0, 0.1, 0.25, 0.5, 0.9, 1, 1.35, 2, 3, 5];
const PHASES: Phase[] = ["won", "lost"];

describe("drawInkBar", () => {
  for (const viewport of VIEWPORTS) {
    for (const ink of INK_LEVELS) {
      it(`renders without throwing at ${viewport.width}x${viewport.height}, ink=${ink}`, () => {
        const ctx = mockCtx();
        const state = makeState("running", 0.5, ink);
        expect(() => drawInkBar(ctx, state, viewport)).not.toThrow();
      });
    }
  }

  it("tolerates a zero maxInk without dividing by zero into NaN draws", () => {
    const ctx = mockCtx();
    const state = makeState("running", 0.5, 0, 0);
    expect(() => drawInkBar(ctx, state, DESKTOP)).not.toThrow();
  });
});

describe("drawSlowmoWash", () => {
  for (const viewport of VIEWPORTS) {
    it(`renders without throwing at ${viewport.width}x${viewport.height}`, () => {
      const ctx = mockCtx();
      expect(() => drawSlowmoWash(ctx, viewport)).not.toThrow();
    });
  }
});

describe("drawEndScreen", () => {
  for (const viewport of VIEWPORTS) {
    for (const phase of PHASES) {
      for (const phaseFor of PHASE_FORS) {
        for (const ink of INK_LEVELS) {
          it(`renders "${phase}" without throwing at ${viewport.width}x${viewport.height}, phaseFor=${phaseFor}, ink=${ink}`, () => {
            const ctx = mockCtx();
            const state = makeState(phase, phaseFor, ink);
            expect(() => drawEndScreen(ctx, state, viewport)).not.toThrow();
          });
        }
      }
    }

    it(`is a no-op that still does not throw while "running" at ${viewport.width}x${viewport.height}`, () => {
      const ctx = mockCtx();
      const state = makeState("running", 2, 600);
      expect(() => drawEndScreen(ctx, state, viewport)).not.toThrow();
    });
  }
});

describe("restartAffordance", () => {
  it("is fully hidden before it should appear", () => {
    for (const phaseFor of [0, 0.25, 0.5, 0.75, 0.99]) {
      const { opacity, scale } = restartAffordance(phaseFor);
      expect(opacity).toBe(0);
      expect(scale).toBe(0);
    }
  });

  it("becomes visible once the resolution has settled (~1s in)", () => {
    for (const phaseFor of [1.4, 2, 3, 5]) {
      const { opacity, scale } = restartAffordance(phaseFor);
      expect(opacity).toBeGreaterThan(0);
      expect(scale).toBeGreaterThan(0);
    }
  });

  it("opacity stays within a sane [0,1] range across a wide time span", () => {
    for (let phaseFor = 0; phaseFor <= 5; phaseFor += 0.1) {
      const { opacity } = restartAffordance(phaseFor);
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });
});
