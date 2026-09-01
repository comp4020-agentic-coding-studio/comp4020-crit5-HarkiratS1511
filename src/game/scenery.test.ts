import { describe, it, expect } from "vitest";
import type { Level, Stroke } from "./types";
import {
  drawSky,
  drawGround,
  drawStrokes,
  drawPickups,
  drawFinish,
  skyVariantIndex,
} from "./scenery";

const PORTRAIT = { width: 390, height: 844 };
const DESKTOP = { width: 1920, height: 1080 };

function makeLevel(overrides: Partial<Level> = {}): Level {
  return {
    groundSegments: [
      { a: { x: 0, y: 500 }, b: { x: 300, y: 500 } },
      { a: { x: 400, y: 500 }, b: { x: 900, y: 500 } },
    ],
    pickups: [
      { pos: { x: 200, y: 480 }, amount: 220, taken: false },
      { pos: { x: 700, y: 480 }, amount: 220, taken: true },
    ],
    startX: 20,
    chaserStartX: -60,
    finishX: 860,
    index: 0,
    groundY: 500,
    stub: { points: [{ x: 300, y: 500 }, { x: 400, y: 500 }], segments: [] },
    ...overrides,
  };
}

/**
 * A plain-object stand-in for CanvasRenderingContext2D: every drawing method
 * is a no-op, every style property is a plain settable field, and gradient
 * factories return an object whose addColorStop is also a no-op. No canvas
 * library involved.
 */
function makeMockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",

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
    fillText: noop,
    strokeText: noop,
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,

    canvas: undefined,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const CAMERAS = [-5000, -137.5, 0, 250, 5000, 123456.7];
const LEVEL_INDICES = [-100, -5, -1, 0, 1, 2, 3, 4, 5, 7, 100];
const TIMES = [0, 0.5, 1, 3.14159, 100, 9999.25];
const VIEWPORTS = [PORTRAIT, DESKTOP];

describe("skyVariantIndex", () => {
  it("is total: every integer, including negatives, maps to a valid variant", () => {
    for (let i = -1000; i <= 1000; i += 7) {
      const v = skyVariantIndex(i);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4); // at least 4 distinct variants are defined
    }
  });

  it("wraps beyond the defined variant count", () => {
    expect(skyVariantIndex(4)).toBe(skyVariantIndex(0));
    expect(skyVariantIndex(5)).toBe(skyVariantIndex(1));
    expect(skyVariantIndex(-1)).toBe(skyVariantIndex(3));
    expect(skyVariantIndex(-4)).toBe(skyVariantIndex(0));
  });

  it("produces at least 4 distinct variants across a small range", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) seen.add(skyVariantIndex(i));
    expect(seen.size).toBe(4);
  });
});

describe("drawSky", () => {
  for (const viewport of VIEWPORTS) {
    for (const camera of CAMERAS) {
      for (const levelIndex of LEVEL_INDICES) {
        it(`does not throw at ${viewport.width}x${viewport.height}, camera=${camera}, levelIndex=${levelIndex}`, () => {
          const ctx = makeMockCtx();
          expect(() => drawSky(ctx, viewport, camera, 1.4, levelIndex)).not.toThrow();
        });
      }
    }
  }

  it("does not throw with a degenerate scale", () => {
    const ctx = makeMockCtx();
    expect(() => drawSky(ctx, DESKTOP, 0, 0, 2)).not.toThrow();
    expect(() => drawSky(ctx, DESKTOP, 0, -1, 2)).not.toThrow();
  });

  it("does not throw with a zero-size viewport", () => {
    const ctx = makeMockCtx();
    expect(() => drawSky(ctx, { width: 0, height: 0 }, 100, 1, 1)).not.toThrow();
  });
});

describe("drawGround", () => {
  for (const levelIndex of [0, 1]) {
    it(`does not throw for a normal level (variant ${levelIndex})`, () => {
      const level = makeLevel({ index: levelIndex });
      const ctx = makeMockCtx();
      expect(() => drawGround(ctx, level, 1.4)).not.toThrow();
    });
  }

  it("does not throw with no ground segments", () => {
    const level = makeLevel({ groundSegments: [] });
    const ctx = makeMockCtx();
    expect(() => drawGround(ctx, level, 1.4)).not.toThrow();
  });

  it("does not throw at both marked viewport scales", () => {
    const level = makeLevel();
    for (const scale of [0.557, 1.5626]) {
      const ctx = makeMockCtx();
      expect(() => drawGround(ctx, level, scale)).not.toThrow();
    }
  });
});

describe("drawStrokes", () => {
  it("does not throw with an empty stroke list and a null stub", () => {
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, [], null, 1.4)).not.toThrow();
  });

  it("does not throw with a populated stroke list and a null stub", () => {
    const strokes: Stroke[] = [
      { points: [{ x: 300, y: 500 }, { x: 340, y: 460 }, { x: 400, y: 500 }], segments: [] },
    ];
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, strokes, null, 1.4)).not.toThrow();
  });

  it("does not throw with a stub present alongside player strokes", () => {
    const stub: Stroke = { points: [{ x: 0, y: 500 }, { x: 60, y: 470 }], segments: [] };
    const strokes: Stroke[] = [
      { points: [{ x: 300, y: 500 }, { x: 400, y: 500 }], segments: [] },
    ];
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, strokes, stub, 1.4)).not.toThrow();
  });

  it("does not throw with a single-point stroke", () => {
    const strokes: Stroke[] = [{ points: [{ x: 10, y: 10 }], segments: [] }];
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, strokes, null, 1.4)).not.toThrow();
  });
});

describe("drawPickups", () => {
  it("does not throw with a level with no pickups", () => {
    const level = makeLevel({ pickups: [] });
    const ctx = makeMockCtx();
    for (const t of TIMES) {
      expect(() => drawPickups(ctx, level, t)).not.toThrow();
    }
  });

  it("does not throw with a level with all pickups taken", () => {
    const level = makeLevel({
      pickups: [
        { pos: { x: 100, y: 480 }, amount: 100, taken: true },
        { pos: { x: 200, y: 480 }, amount: 100, taken: true },
      ],
    });
    const ctx = makeMockCtx();
    for (const t of TIMES) {
      expect(() => drawPickups(ctx, level, t)).not.toThrow();
    }
  });

  it("does not throw with a mix of taken and untaken pickups across time", () => {
    const level = makeLevel();
    const ctx = makeMockCtx();
    for (const t of TIMES) {
      expect(() => drawPickups(ctx, level, t)).not.toThrow();
    }
  });
});

describe("drawFinish", () => {
  it("does not throw across a range of times", () => {
    const level = makeLevel();
    const ctx = makeMockCtx();
    for (const t of TIMES) {
      expect(() => drawFinish(ctx, level, t)).not.toThrow();
    }
  });
});

describe("cross-viewport smoke test", () => {
  it("runs the full scenery pipeline without throwing at both marked viewports", () => {
    for (const viewport of VIEWPORTS) {
      for (const levelIndex of LEVEL_INDICES) {
        const level = makeLevel({ index: levelIndex });
        const ctx = makeMockCtx();
        const camera = 123.4;
        const scale = 1.1;
        const t = 5.5;
        expect(() => {
          drawSky(ctx, viewport, camera, scale, levelIndex);
          drawGround(ctx, level, scale);
          drawPickups(ctx, level, t);
          drawStrokes(ctx, [{ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], segments: [] }], level.stub, scale);
          drawFinish(ctx, level, t);
        }).not.toThrow();
      }
    }
  });
});
