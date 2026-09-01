import { describe, it, expect } from "vitest";
import type { Level, Stroke } from "./types";
import { PALETTE_COUNT, paletteFor, type Palette } from "./palette";
import {
  drawSky,
  drawGround,
  drawStrokes,
  drawPickups,
  drawFinish,
  drawHazards,
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
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
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
 * records every coordinate passed to moveTo/lineTo/arc and every colour
 * string assigned to fillStyle/strokeStyle, and counts fill/stroke/fillRect
 * calls. That lets a test make structural assertions ("the path reached far
 * past the rightmost segment", "only one fill call for this connected
 * chain") and colour assertions ("nothing was painted in a colour this
 * palette does not contain") without a real canvas or pixel inspection.
 */
function makeRecordingCtx() {
  const base = makeMockCtx() as unknown as Record<string, unknown>;
  const xs: number[] = [];
  const ys: number[] = [];
  const styles: string[] = [];
  let fillCalls = 0;
  let strokeCalls = 0;
  let fillRectCalls = 0;

  const recordStyle = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) styles.push(v);
  };
  Object.defineProperty(base, "fillStyle", {
    get: () => "",
    set: recordStyle,
    configurable: true,
  });
  Object.defineProperty(base, "strokeStyle", {
    get: () => "",
    set: recordStyle,
    configurable: true,
  });

  base.moveTo = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  base.lineTo = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  base.arc = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
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
    ys,
    styles,
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
const PALETTES: Palette[] = Array.from({ length: PALETTE_COUNT }, (_, i) => paletteFor(i));
const DAWN = paletteFor(0);
const NIGHT = paletteFor(3);

/** Every "r,g,b" triple this palette is allowed to put on the canvas. Used to
 *  prove no module-local hardcoded colour survived the palette rewrite: if a
 *  literal hex or a stale INK constant were still in scenery.ts, it would
 *  show up here as a style string that matches none of these. */
function allowedTriples(p: Palette): string[] {
  return [p.paper.rgb, p.skyTop.rgb, p.skyHorizon.rgb, p.terrain.rgb, p.ink.rgb, p.accent.rgb];
}

function assertOnlyPaletteColours(styles: string[], p: Palette): void {
  const allowed = allowedTriples(p);
  for (const s of styles) {
    // Gradients arrive as objects, not strings, so anything string-shaped
    // here is a literal colour and must be one of the palette's own. Both
    // rgb() and rgba() appear; only the first three channels identify a tone.
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,[^)]*)?\)$/.exec(s);
    expect(m, `unparseable colour ${s}`).not.toBeNull();
    const g = m as RegExpExecArray;
    expect(allowed, `colour ${s} is not in this palette`).toContain(`${g[1]},${g[2]},${g[3]}`);
  }
}

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

  it("agrees with palette.ts's own selector, so light and silhouette can never drift apart", () => {
    for (let i = -50; i <= 50; i++) {
      expect(paletteFor(i)).toBe(PALETTES[skyVariantIndex(i)]);
    }
  });

  it("survives a non-finite level index rather than blanking the frame", () => {
    expect(skyVariantIndex(Number.NaN)).toBe(0);
    expect(skyVariantIndex(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("drawSky", () => {
  for (const viewport of VIEWPORTS) {
    for (const camera of CAMERAS) {
      for (const levelIndex of LEVEL_INDICES) {
        it(`does not throw at ${viewport.width}x${viewport.height}, camera=${camera}, levelIndex=${levelIndex}`, () => {
          const ctx = makeMockCtx();
          const palette = paletteFor(levelIndex);
          expect(() => drawSky(ctx, viewport, camera, 1.4, levelIndex, palette)).not.toThrow();
        });
      }
    }
  }

  it("does not throw with a degenerate scale", () => {
    const ctx = makeMockCtx();
    expect(() => drawSky(ctx, DESKTOP, 0, 0, 2, paletteFor(2))).not.toThrow();
    expect(() => drawSky(ctx, DESKTOP, 0, -1, 2, paletteFor(2))).not.toThrow();
  });

  it("does not throw with a zero-size viewport", () => {
    const ctx = makeMockCtx();
    expect(() => drawSky(ctx, { width: 0, height: 0 }, 100, 1, 1, paletteFor(1))).not.toThrow();
  });

  it("does not throw with a non-finite camera", () => {
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      expect(() => drawSky(ctx, DESKTOP, Number.NaN, 1.4, 0, p)).not.toThrow();
    }
  });

  it("still draws sky and all three parallax bands with the camera far before the level start", () => {
    const level = makeLevel();
    const farBefore = level.startX - 500_000;
    const rec = makeRecordingCtx();
    expect(() => drawSky(rec.ctx, DESKTOP, farBefore, 1.4, 1, paletteFor(1))).not.toThrow();
    // Paper base always covers the frame, and all THREE parallax bands (far,
    // mid, near) each still produce a fill, however far the camera is from
    // the level's own bounds — coverage depends only on camera and viewport,
    // never on level data.
    expect(rec.fillRectCalls).toBeGreaterThan(0);
    expect(rec.fillCalls).toBeGreaterThanOrEqual(3);
  });

  it("still draws sky and all three parallax bands with the camera far past the level end", () => {
    const level = makeLevel();
    const farPast = level.finishX + 500_000;
    const rec = makeRecordingCtx();
    expect(() => drawSky(rec.ctx, DESKTOP, farPast, 1.4, 1, paletteFor(1))).not.toThrow();
    expect(rec.fillRectCalls).toBeGreaterThan(0);
    expect(rec.fillCalls).toBeGreaterThanOrEqual(3);
  });

  it("draws three parallax bands, not two, for every palette at both viewports", () => {
    // The two-layer version left a visible step between "far pale" and "near
    // dark" that read as cut paper rather than as distance. Three bands is
    // the fix, and the palette carries farAlpha/midAlpha/nearAlpha for
    // exactly this — so the count is a contract, not an implementation
    // detail.
    for (const viewport of VIEWPORTS) {
      for (let i = 0; i < PALETTE_COUNT; i++) {
        const rec = makeRecordingCtx();
        drawSky(rec.ctx, viewport, 900, 1.4, i, paletteFor(i));
        expect(rec.fillCalls, `palette ${i} at ${viewport.width}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("gives the near band real height: the sky reaches well into the upper half of the frame", () => {
    // The complaint this rewrite answers is that two thirds of the frame was
    // empty above the horizon. The near silhouette has to climb out of the
    // ground line and occupy the frame. Sampling a spread of cameras (the
    // band undulates, so a single camera can land in a saddle) the highest
    // point any band reaches must sit above the vertical midpoint.
    for (const viewport of VIEWPORTS) {
      for (let i = 0; i < PALETTE_COUNT; i++) {
        let highest = Infinity;
        for (const camera of [0, 400, 1300, 2600, 5200]) {
          const rec = makeRecordingCtx();
          drawSky(rec.ctx, viewport, camera, 1.4, i, paletteFor(i));
          // Ignore the far-off-screen scaffolding coordinates the tiled
          // families walk past the frame edges.
          for (let k = 0; k < rec.ys.length; k++) {
            if (rec.xs[k] < -viewport.width || rec.xs[k] > viewport.width * 2) continue;
            if (rec.ys[k] < highest) highest = rec.ys[k];
          }
        }
        expect(highest, `palette ${i} at ${viewport.width}`).toBeLessThan(viewport.height * 0.5);
      }
    }
  });

  it("is deterministic: the same camera and palette always produce the same frame", () => {
    // The whole point of hashing world position rather than calling
    // Math.random() or reading a frame counter. If any background shape ever
    // depended on either, two identical calls would diverge and the layers
    // would shimmer as the camera moved.
    for (let i = 0; i < PALETTE_COUNT; i++) {
      for (const camera of [-1200, 0, 733.25, 41000]) {
        const a = makeRecordingCtx();
        const b = makeRecordingCtx();
        drawSky(a.ctx, DESKTOP, camera, 1.4, i, paletteFor(i));
        drawSky(b.ctx, DESKTOP, camera, 1.4, i, paletteFor(i));
        expect(b.xs).toEqual(a.xs);
        expect(b.ys).toEqual(a.ys);
        expect(b.styles).toEqual(a.styles);
      }
    }
  });

  it("moves with the camera: a different camera produces a different frame", () => {
    // The mirror of determinism. A background that is deterministic but
    // camera-invariant is a wallpaper, not parallax.
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const a = makeRecordingCtx();
      const b = makeRecordingCtx();
      drawSky(a.ctx, DESKTOP, 0, 1.4, i, paletteFor(i));
      drawSky(b.ctx, DESKTOP, 640, 1.4, i, paletteFor(i));
      expect(b.xs).not.toEqual(a.xs);
    }
  });

  it("paints only colours from the palette it was handed — no hardcoded ink or paper survives", () => {
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const p = paletteFor(i);
      const rec = makeRecordingCtx();
      drawSky(rec.ctx, DESKTOP, 812, 1.4, i, p);
      assertOnlyPaletteColours(rec.styles, p);
    }
  });

  it("uses each palette's own light, so no two levels are the same place", () => {
    // Colour identity has to come out of the palette, not out of levelIndex.
    // Handing drawSky the SAME level index with four different palettes must
    // still produce four different sets of colours.
    const seen = new Set<string>();
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const rec = makeRecordingCtx();
      drawSky(rec.ctx, DESKTOP, 500, 1.4, 0, paletteFor(i));
      seen.add(rec.styles.join("|"));
    }
    expect(seen.size).toBe(PALETTE_COUNT);
  });
});

describe("drawGround", () => {
  for (let i = 0; i < PALETTE_COUNT; i++) {
    it(`does not throw for a normal level (palette ${i})`, () => {
      const level = makeLevel({ index: i });
      const ctx = makeMockCtx();
      expect(() => drawGround(ctx, level, 1.4, paletteFor(i))).not.toThrow();
    });
  }

  it("does not throw with no ground segments", () => {
    const level = makeLevel({ groundSegments: [] });
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      expect(() => drawGround(ctx, level, 1.4, p)).not.toThrow();
    }
  });

  it("does not throw at both marked viewport scales", () => {
    const level = makeLevel();
    for (const scale of [0.557, 1.5626]) {
      const ctx = makeMockCtx();
      expect(() => drawGround(ctx, level, scale, DAWN)).not.toThrow();
    }
  });

  it("extends the ground mass far past the first and last segment in both directions, so the world never visibly runs out", () => {
    // makeLevel's segments span x in [0, 900] with a gap between 300 and 400.
    const level = makeLevel();
    const rec = makeRecordingCtx();
    drawGround(rec.ctx, level, 1.4, DAWN);
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
      expect(() => drawGround(rec.ctx, level, scale, DAWN)).not.toThrow();
      expect(rec.fillCalls).toBeGreaterThan(0);
    }
  });

  it("renders a long chain of sloped, connected segments as one continuous mass with a smooth top edge", () => {
    const level = makeLevel({ groundSegments: undulatingSegments() });
    const rec = makeRecordingCtx();
    expect(() => drawGround(rec.ctx, level, 1.4, DAWN)).not.toThrow();
    // One connected chain of 40 segments must still produce exactly one fill
    // call for the ground mass — a single continuous shape whose downward
    // fill follows the slope, never one rectangle stamped out per segment.
    // The interior gradient is part of that ONE fill, not a second pass.
    expect(rec.fillCalls).toBe(1);
  });

  it("only cuts a gap edge at a genuine break between chains, never at a join inside a connected sloped run", () => {
    // Three segments, each one's end exactly matching the next one's start:
    // one connected chain, no gaps. Per chain the mass gets a lip stroke and
    // a crust stroke (2); the surface hatch is batched into one further
    // stroke for the whole level (1); zero gap-tick strokes, because nothing
    // here is actually exposed.
    const connectedSegments = [
      { a: { x: 0, y: 500 }, b: { x: 100, y: 480 } },
      { a: { x: 100, y: 480 }, b: { x: 220, y: 510 } },
      { a: { x: 220, y: 510 }, b: { x: 340, y: 470 } },
    ];
    const level = makeLevel({ groundSegments: connectedSegments });
    const rec = makeRecordingCtx();
    drawGround(rec.ctx, level, 1.4, DAWN);
    expect(rec.strokeCalls).toBe(3);

    // Same two outer segments, but with a real gap between them (two chains
    // instead of one): lip + crust per chain (4) + the one batched hatch (1)
    // + gap ticks (2, one per exposed end of the single real gap) = 7.
    const gappedSegments = [
      { a: { x: 0, y: 500 }, b: { x: 100, y: 480 } },
      { a: { x: 220, y: 510 }, b: { x: 340, y: 470 } }, // a real gap before this one
    ];
    const gappedLevel = makeLevel({ groundSegments: gappedSegments });
    const rec2 = makeRecordingCtx();
    drawGround(rec2.ctx, gappedLevel, 1.4, DAWN);
    expect(rec2.strokeCalls).toBe(7);

    // The extra 4 strokes on the gapped level are exactly the second chain's
    // own lip + crust strokes, plus the two gap-tick cuts that only a
    // genuine break — never a join inside a connected run — produces.
    expect(rec2.strokeCalls - rec.strokeCalls).toBe(4);
  });

  it("gives the mass material: the interior is a gradient, not one flat value", () => {
    // A gradient object is not a colour string, so the body fill never shows
    // up in `styles`. What must show up is the lip, the crust and the hatch —
    // three distinct tones over the one mass.
    const rec = makeRecordingCtx();
    drawGround(rec.ctx, makeLevel(), 1.4, DAWN);
    expect(new Set(rec.styles).size).toBeGreaterThanOrEqual(3);
  });

  it("paints only colours from the palette it was handed, on light paper and inverted alike", () => {
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const p = paletteFor(i);
      const rec = makeRecordingCtx();
      drawGround(rec.ctx, makeLevel({ index: i }), 1.4, p);
      assertOnlyPaletteColours(rec.styles, p);
    }
  });

  it("inverts the top lip on the night palette instead of assuming a dark mark on light paper", () => {
    // On light paper the lip is `ink` at full strength — a crust darker than
    // the body it caps. On the inverted palette `ink` is CREAM, so the same
    // stroke has to become a rim light rather than a solid cream slab across
    // the top of the world. Different alpha, same role.
    const light = makeRecordingCtx();
    const night = makeRecordingCtx();
    drawGround(light.ctx, makeLevel(), 1.4, DAWN);
    drawGround(night.ctx, makeLevel({ index: 3 }), 1.4, NIGHT);
    expect(light.styles).toContain(`rgba(${DAWN.ink.rgb},1)`);
    expect(night.styles).not.toContain(`rgba(${NIGHT.ink.rgb},1)`);
    expect(night.styles.some((s) => s.startsWith(`rgba(${NIGHT.ink.rgb},0.`))).toBe(true);
  });

  it("is deterministic: the same level and palette always produce the same mass", () => {
    const level = makeLevel({ groundSegments: undulatingSegments() });
    for (const p of PALETTES) {
      const a = makeRecordingCtx();
      const b = makeRecordingCtx();
      drawGround(a.ctx, level, 1.4, p);
      drawGround(b.ctx, level, 1.4, p);
      expect(b.xs).toEqual(a.xs);
      expect(b.ys).toEqual(a.ys);
      expect(b.styles).toEqual(a.styles);
    }
  });
});

/** A run of ramps, each one's end exactly matching the next one's start — the
 *  shape rolling levels use instead of flat platforms at discrete heights. No
 *  gaps anywhere in this chain. */
function undulatingSegments() {
  const points: { x: number; y: number }[] = [];
  let x = 0;
  let y = 500;
  for (let i = 0; i < 40; i++) {
    points.push({ x, y });
    x += 30;
    y += Math.sin(i * 0.7) * 12; // undulating: alternates up- and down-slope
  }
  points.push({ x, y });
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({ a: points[i], b: points[i + 1] });
  }
  return segments;
}

describe("drawStrokes", () => {
  it("does not throw with an empty stroke list and a null stub", () => {
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, [], null, 1.4, DAWN)).not.toThrow();
  });

  it("does not throw with a populated stroke list and a null stub", () => {
    const strokes: Stroke[] = [
      { points: [{ x: 300, y: 500 }, { x: 340, y: 460 }, { x: 400, y: 500 }], segments: [] },
    ];
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      expect(() => drawStrokes(ctx, strokes, null, 1.4, p)).not.toThrow();
    }
  });

  it("does not throw with a stub present alongside player strokes", () => {
    const stub: Stroke = { points: [{ x: 0, y: 500 }, { x: 60, y: 470 }], segments: [] };
    const strokes: Stroke[] = [
      { points: [{ x: 300, y: 500 }, { x: 400, y: 500 }], segments: [] },
    ];
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, strokes, stub, 1.4, DAWN)).not.toThrow();
  });

  it("does not throw with a single-point stroke", () => {
    const strokes: Stroke[] = [{ points: [{ x: 10, y: 10 }], segments: [] }];
    const ctx = makeMockCtx();
    expect(() => drawStrokes(ctx, strokes, null, 1.4, DAWN)).not.toThrow();
  });

  it("draws the player's line in the palette's ink at full strength, including on the inverted night palette", () => {
    // The line the player made is the one thing that is never washed back.
    // On palette 3 that makes it the brightest mark on screen, which is the
    // whole statement of the level.
    const strokes: Stroke[] = [
      { points: [{ x: 0, y: 0 }, { x: 40, y: 20 }], segments: [] },
    ];
    for (const p of PALETTES) {
      const rec = makeRecordingCtx();
      drawStrokes(rec.ctx, strokes, null, 1.4, p);
      expect(rec.styles).toContain(`rgba(${p.ink.rgb},1)`);
      assertOnlyPaletteColours(rec.styles, p);
    }
  });
});

describe("drawPickups", () => {
  it("does not throw with a level with no pickups", () => {
    const level = makeLevel({ pickups: [] });
    const ctx = makeMockCtx();
    for (const t of TIMES) {
      expect(() => drawPickups(ctx, level, t, DAWN)).not.toThrow();
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
      expect(() => drawPickups(ctx, level, t, DAWN)).not.toThrow();
    }
  });

  it("does not throw with a mix of taken and untaken pickups across time, on every palette", () => {
    const level = makeLevel();
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      for (const t of TIMES) {
        expect(() => drawPickups(ctx, level, t, p)).not.toThrow();
      }
    }
  });

  it("marks a pickup in accent, so 'this refills my bar' reads without a word", () => {
    for (const p of PALETTES) {
      const rec = makeRecordingCtx();
      drawPickups(rec.ctx, makeLevel(), 2, p);
      expect(rec.styles.some((s) => s.startsWith(`rgba(${p.accent.rgb},`))).toBe(true);
      assertOnlyPaletteColours(rec.styles, p);
    }
  });

  it("carries its inner mark in paper, which contrasts with accent on the inverted palette too", () => {
    for (const p of PALETTES) {
      const rec = makeRecordingCtx();
      drawPickups(rec.ctx, makeLevel(), 2, p);
      expect(rec.styles.some((s) => s.startsWith(`rgba(${p.paper.rgb},`))).toBe(true);
    }
  });

  it("draws nothing at all for a taken pickup", () => {
    const rec = makeRecordingCtx();
    drawPickups(rec.ctx, makeLevel({ pickups: [{ pos: { x: 5, y: 5 }, amount: 1, taken: true }] }), 3, DAWN);
    expect(rec.fillCalls).toBe(0);
    expect(rec.strokeCalls).toBe(0);
  });
});

describe("drawFinish", () => {
  it("does not throw across a range of times, on every palette", () => {
    const level = makeLevel();
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      for (const t of TIMES) {
        expect(() => drawFinish(ctx, level, t, p)).not.toThrow();
      }
    }
  });

  it("says 'end' in accent and in ink, redundantly, on every palette", () => {
    for (const p of PALETTES) {
      const rec = makeRecordingCtx();
      drawFinish(rec.ctx, makeLevel(), 1.2, p);
      expect(rec.styles.some((s) => s.startsWith(`rgba(${p.accent.rgb},`))).toBe(true);
      expect(rec.styles.some((s) => s.startsWith(`rgba(${p.ink.rgb},`))).toBe(true);
      assertOnlyPaletteColours(rec.styles, p);
      // A beacon, a bar across the ground, a post and two pennants: no single
      // one of these carries the whole signal.
      expect(rec.fillRectCalls).toBeGreaterThanOrEqual(2);
      expect(rec.fillCalls).toBeGreaterThanOrEqual(3);
    }
  });

  it("stands above the ground line, so it breaks the horizon rather than lying on it", () => {
    const level = makeLevel();
    const rec = makeRecordingCtx();
    drawFinish(rec.ctx, level, 0, DAWN);
    expect(Math.min(...rec.ys)).toBeLessThan(level.groundY - 100);
  });
});

describe("drawHazards", () => {
  it("does not throw with no hazards", () => {
    const level = makeLevel({ hazards: [] });
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      expect(() => drawHazards(ctx, level, 1, p)).not.toThrow();
    }
  });

  it("does not throw across a range of times and palettes", () => {
    const level = makeLevel({ hazards: [{ x: 120, width: 90, y: 500 }] });
    const ctx = makeMockCtx();
    for (const p of PALETTES) {
      for (const t of TIMES) {
        expect(() => drawHazards(ctx, level, t, p)).not.toThrow();
      }
    }
  });

  it("silhouettes the teeth in terrain and tips them in accent, so 'those kill me' reads without a word", () => {
    for (const p of PALETTES) {
      const rec = makeRecordingCtx();
      drawHazards(rec.ctx, makeLevel({ hazards: [{ x: 120, width: 90, y: 500 }] }), 1, p);
      expect(rec.styles.some((s) => s.startsWith(`rgba(${p.terrain.rgb},`))).toBe(true);
      expect(rec.styles.some((s) => s.startsWith(`rgba(${p.accent.rgb},`))).toBe(true);
      assertOnlyPaletteColours(rec.styles, p);
    }
  });

  it("rises above the ground it stands on", () => {
    const rec = makeRecordingCtx();
    drawHazards(rec.ctx, makeLevel({ hazards: [{ x: 120, width: 90, y: 500 }] }), 0, DAWN);
    expect(Math.min(...rec.ys)).toBeLessThan(500);
  });
});

describe("cross-viewport smoke test", () => {
  it("runs the full scenery pipeline without throwing at both marked viewports, on every palette", () => {
    for (const viewport of VIEWPORTS) {
      for (const levelIndex of LEVEL_INDICES) {
        const palette = paletteFor(levelIndex);
        const level = makeLevel({ index: levelIndex, hazards: [{ x: 500, width: 80, y: 500 }] });
        const ctx = makeMockCtx();
        const camera = 123.4;
        const scale = 1.1;
        const t = 5.5;
        expect(() => {
          drawSky(ctx, viewport, camera, scale, levelIndex, palette);
          drawGround(ctx, level, scale, palette);
          drawHazards(ctx, level, t, palette);
          drawPickups(ctx, level, t, palette);
          drawStrokes(ctx, [{ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], segments: [] }], level.stub, scale, palette);
          drawFinish(ctx, level, t, palette);
        }).not.toThrow();
      }
    }
  });

  it("puts nothing on the canvas that is not in the level's own palette", () => {
    // The single assertion that catches a colour smuggled in from anywhere
    // other than palette.ts, across the whole module at once.
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const p = paletteFor(i);
      const level = makeLevel({ index: i, hazards: [{ x: 500, width: 80, y: 500 }] });
      const rec = makeRecordingCtx();
      drawSky(rec.ctx, DESKTOP, 640, 1.2, i, p);
      drawGround(rec.ctx, level, 1.2, p);
      drawHazards(rec.ctx, level, 2, p);
      drawPickups(rec.ctx, level, 2, p);
      drawStrokes(rec.ctx, [{ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], segments: [] }], level.stub, 1.2, p);
      drawFinish(rec.ctx, level, 2, p);
      assertOnlyPaletteColours(rec.styles, p);
    }
  });
});
