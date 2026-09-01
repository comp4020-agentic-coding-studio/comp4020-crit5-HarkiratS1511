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
    hazards: [],
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

/**
 * A recording variant of the mock context: on top of every no-op above, it
 * records every x coordinate passed to moveTo/lineTo and counts fill/stroke/
 * fillRect calls, so a test can make structural assertions (e.g. "the path
 * reached far past the rightmost segment", "only one fill call was made for
 * this connected chain") without needing a real canvas or pixel inspection.
 */
function makeRecordingCtx() {
  const base = makeMockCtx() as unknown as Record<string, unknown>;
  const xs: number[] = [];
  let fillCalls = 0;
  let strokeCalls = 0;
  let fillRectCalls = 0;

  base.moveTo = (x: number) => {
    xs.push(x);
  };
  base.lineTo = (x: number) => {
    xs.push(x);
  };
  base.fill = () => {
    fillCalls++;
  };
  base.stroke = () => {
    strokeCalls++;
  };
  base.fillRect = () => {
    fillRectCalls++;
  };

  return {
    ctx: base as unknown as CanvasRenderingContext2D,
    xs,
    get fillCalls() {
      return fillCalls;
    },
    get strokeCalls() {
      return strokeCalls;
    },
    get fillRectCalls() {
      return fillRectCalls;
    },
  };
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

  it("still draws sky and both parallax layers with the camera far before the level start", () => {
    const level = makeLevel();
    const farBefore = level.startX - 500_000;
    const rec = makeRecordingCtx();
    expect(() => drawSky(rec.ctx, DESKTOP, farBefore, 1.4, 1)).not.toThrow();
    // Paper base always covers the frame, and both parallax layers (far +
    // near) each still produce at least one fill, however far the camera is
    // from the level's own bounds — coverage depends only on camera and
    // viewport, never on level data.
    expect(rec.fillRectCalls).toBeGreaterThan(0);
    expect(rec.fillCalls).toBeGreaterThanOrEqual(2);
  });

  it("still draws sky and both parallax layers with the camera far past the level end", () => {
    const level = makeLevel();
    const farPast = level.finishX + 500_000;
    const rec = makeRecordingCtx();
    expect(() => drawSky(rec.ctx, DESKTOP, farPast, 1.4, 1)).not.toThrow();
    expect(rec.fillRectCalls).toBeGreaterThan(0);
    expect(rec.fillCalls).toBeGreaterThanOrEqual(2);
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

  it("extends the ground mass far past the first and last segment in both directions, so the world never visibly runs out", () => {
    // makeLevel's segments span x in [0, 900] with a gap between 300 and 400.
    const level = makeLevel();
    const rec = makeRecordingCtx();
    drawGround(rec.ctx, level, 1.4);
    const minX = Math.min(...rec.xs);
    const maxX = Math.max(...rec.xs);
    // A large margin (well under the module's own edge-extension constant)
    // proves the fill reaches far beyond the level's own segment data on
    // both sides, for rendering only — the Level's segments themselves are
    // untouched (asserted below).
    expect(minX).toBeLessThan(-1000);
    expect(maxX).toBeGreaterThan(1900);
    expect(level.groundSegments).toEqual([
      { a: { x: 0, y: 500 }, b: { x: 300, y: 500 } },
      { a: { x: 400, y: 500 }, b: { x: 900, y: 500 } },
    ]);
  });

  it("still draws (extends to cover the frame) for a camera positioned far before the level start or far past its end", () => {
    // drawGround has no camera parameter — it always renders in world space
    // — so "still draws under an extreme camera" reduces to: the rendered
    // mass already reaches far beyond both ends regardless of scale, which
    // is exactly what the extension test above establishes. This case just
    // confirms it holds at the extreme scales/viewports too.
    const level = makeLevel();
    for (const scale of [0.557, 2.0]) {
      const rec = makeRecordingCtx();
      expect(() => drawGround(rec.ctx, level, scale)).not.toThrow();
      expect(rec.fillCalls).toBeGreaterThan(0);
    }
  });

  it("renders a long chain of sloped, connected segments as one continuous mass with a smooth top edge", () => {
    // A run of ramps, each one's end exactly matching the next one's start —
    // the shape rolling levels use instead of flat platforms at discrete
    // heights. No gaps anywhere in this chain.
    const points: { x: number; y: number }[] = [];
    let x = 0;
    let y = 500;
    for (let i = 0; i < 40; i++) {
      points.push({ x, y });
      x += 30;
      y += Math.sin(i * 0.7) * 12; // undulating: alternates up- and down-slope
    }
    points.push({ x, y });
    const groundSegments = [];
    for (let i = 0; i < points.length - 1; i++) {
      groundSegments.push({ a: points[i], b: points[i + 1] });
    }
    const level = makeLevel({ groundSegments });

    const rec = makeRecordingCtx();
    expect(() => drawGround(rec.ctx, level, 1.4)).not.toThrow();
    // One connected chain of 40 segments must still produce exactly one fill
    // call for the ground mass — a single continuous shape whose downward
    // fill follows the slope, never one rectangle stamped out per segment.
    expect(rec.fillCalls).toBe(1);
  });

  it("only cuts a gap edge at a genuine break between chains, never at a join inside a connected sloped run", () => {
    // Three segments, each one's end exactly matching the next one's start:
    // one connected chain, no gaps. Top edge (1) + crust (1) = 2 strokes;
    // zero gap-tick strokes, because nothing here is actually exposed.
    const connectedSegments = [
      { a: { x: 0, y: 500 }, b: { x: 100, y: 480 } },
      { a: { x: 100, y: 480 }, b: { x: 220, y: 510 } },
      { a: { x: 220, y: 510 }, b: { x: 340, y: 470 } },
    ];
    const level = makeLevel({ groundSegments: connectedSegments });
    const rec = makeRecordingCtx();
    drawGround(rec.ctx, level, 1.4);
    expect(rec.strokeCalls).toBe(2);

    // Same two outer segments, but with a real gap between them (two chains
    // instead of one): top edge (2, one per chain) + crust (2) + gap ticks
    // (2, one per exposed end of the single real gap) = 6 strokes.
    const gappedSegments = [
      { a: { x: 0, y: 500 }, b: { x: 100, y: 480 } },
      { a: { x: 220, y: 510 }, b: { x: 340, y: 470 } }, // a real gap before this one
    ];
    const gappedLevel = makeLevel({ groundSegments: gappedSegments });
    const rec2 = makeRecordingCtx();
    drawGround(rec2.ctx, gappedLevel, 1.4);
    expect(rec2.strokeCalls).toBe(6);

    // The extra 4 strokes on the gapped level are exactly the second chain's
    // own top-edge + crust strokes, plus the two gap-tick cuts that only a
    // genuine break — never a join inside a connected run — produces.
    expect(rec2.strokeCalls - rec.strokeCalls).toBe(4);
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
