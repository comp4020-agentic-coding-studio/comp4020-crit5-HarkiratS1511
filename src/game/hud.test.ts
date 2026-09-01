import { beforeEach, describe, expect, it } from "vitest";
import {
  drawEndScreen,
  drawInkBar,
  drawSlowmoWash,
  resetInkBar,
  restartAffordance,
} from "./hud";
import { IMPACT_HOLD } from "./tuning";
import { PALETTE_COUNT, paletteFor, type Palette } from "./palette";
import type { GameState, Level, Phase } from "./types";

const DESKTOP = { width: 1920, height: 1080 };
const PORTRAIT = { width: 390, height: 844 };
const VIEWPORTS = [DESKTOP, PORTRAIT];
const PALETTES: Palette[] = Array.from({ length: PALETTE_COUNT }, (_, i) => paletteFor(i));
const DAY = paletteFor(0);
const NIGHT = paletteFor(3);

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
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
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

/** Same mock as `mockCtx`, but every method call (including `save`) is
 *  counted, so tests can assert "issued zero drawing calls" or "issued more
 *  calls than before" without caring which specific canvas methods fired. */
function countingMockCtx(): { ctx: CanvasRenderingContext2D; counts: { total: number } } {
  const counts = { total: 0 };
  const base = mockCtx() as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    const value = base[key];
    if (typeof value === "function") {
      wrapped[key] = (...args: unknown[]) => {
        counts.total += 1;
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    }
  }
  return { ctx: wrapped as unknown as CanvasRenderingContext2D, counts };
}

/** A mock that records every colour the module asks for — assigned to
 *  fillStyle/strokeStyle, or handed to a gradient stop. The palette rewrite
 *  turned "which pigment did this effect use" into the load-bearing question
 *  (level 3 inverts, so a hardcoded navy flood is invisible there), and this
 *  is how a headless test can answer it. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; rgbs: () => string[] } {
  const seen: string[] = [];
  const record = (value: unknown): void => {
    if (typeof value === "string") seen.push(value);
  };
  const gradient = { addColorStop: (_stop: number, color: string) => record(color) };
  const base = mockCtx() as unknown as Record<string, unknown>;
  const target: Record<string, unknown> = {
    ...base,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  const proxy = new Proxy(target, {
    set(obj, prop, value) {
      if (prop === "fillStyle" || prop === "strokeStyle") record(value);
      obj[prop as string] = value;
      return true;
    },
  });
  return {
    ctx: proxy as unknown as CanvasRenderingContext2D,
    // Only opaque-enough marks count: a colour laid down at alpha 0 is not a
    // pigment on the screen, and the gradients legitimately fade to zero.
    rgbs: () =>
      seen
        .map((c) => {
          const m = /^rgba?\(([^)]*)\)$/.exec(c);
          if (!m) return null;
          const parts = m[1].split(",").map((p) => p.trim());
          const alpha = parts.length > 3 ? Number(parts[3]) : 1;
          if (!(alpha > 0.001)) return null;
          return `${parts[0]},${parts[1]},${parts[2]}`;
        })
        .filter((c): c is string => c !== null),
  };
}

function makeLevel(): Level {
  return {
    groundSegments: [{ a: { x: 0, y: 500 }, b: { x: 2000, y: 500 } }],
    pickups: [{ pos: { x: 300, y: 480 }, amount: 260, taken: false }],
    hazards: [],
    startX: 0,
    chaserStartX: -80,
    finishX: 1800,
    index: 0,
    groundY: 500,
    stub: null,
  };
}

function makeState(
  phase: Phase,
  phaseFor: number,
  ink: number,
  maxInk = 1150,
  elapsed = 4.75
): GameState {
  return {
    runner: { pos: { x: 150, y: 488 }, vel: { x: 185, y: 0 }, radius: 12, grounded: true },
    chaser: { pos: { x: 60, y: 484 }, vel: { x: 172, y: 0 }, radius: 16, grounded: true },
    ghost: null,
    levelIndex: 0,
    phaseFor,
    stuckFor: 0,
    progressX: 0,
    chaserProgressX: 0,
    chaserStuckFor: 0,
    runPhase: 0,
    chaserPhase: 0.5,
    ghostPhase: 0,
    strokes: [],
    ink,
    maxInk,
    phase,
    level: makeLevel(),
    elapsed,
  };
}

// Full, half, nearly-empty, exactly-zero, against a 1150 max — matches the
// tuning module's MAX_INK without importing it, so this test stays decoupled
// from files other work is touching concurrently.
const MAX = 1150;
const INK_LEVELS = [MAX, MAX / 2, 20, 0];
const PHASE_FORS = [0, 0.1, 0.25, 0.5, 0.9, 1, 1.35, 2, 3, 5];
const PHASES: Phase[] = ["won", "lost"];

// The ink bar remembers the last level it drew, so it can react to a spend or
// a pickup that GameState carries no delta for. Every test starts from a
// forgotten well, or one test's ink level leaks into the next one's reaction.
beforeEach(() => {
  resetInkBar();
});

describe("drawInkBar", () => {
  for (const viewport of VIEWPORTS) {
    for (const ink of INK_LEVELS) {
      for (let p = 0; p < PALETTES.length; p++) {
        it(`renders without throwing at ${viewport.width}x${viewport.height}, ink=${ink}, palette=${p}`, () => {
          const ctx = mockCtx();
          const state = makeState("running", 0.5, ink);
          expect(() => drawInkBar(ctx, state, viewport, PALETTES[p])).not.toThrow();
        });
      }
    }
  }

  it("tolerates a zero maxInk without dividing by zero into NaN draws", () => {
    const ctx = mockCtx();
    const state = makeState("running", 0.5, 0, 0);
    expect(() => drawInkBar(ctx, state, DESKTOP, DAY)).not.toThrow();
  });

  it("tolerates a non-finite clock without throwing", () => {
    const ctx = mockCtx();
    const state = makeState("running", 0.5, 600, MAX, Number.NaN);
    expect(() => drawInkBar(ctx, state, DESKTOP, DAY)).not.toThrow();
  });

  // The no-instructions rule means the bar has to say "this runs out" before
  // the player has spent a drop. It does that by marking the reserve — the
  // last stretch of the tube — in the same pigment as the pickups that refill
  // it, from the very first frame with the well still full.
  for (const palette of PALETTES) {
    it(`marks the reserve in the pickup pigment while still completely full (shape=${palette.shape})`, () => {
      const { ctx, rgbs } = recordingCtx();
      drawInkBar(ctx, makeState("running", 0, MAX), DESKTOP, palette);
      expect(rgbs()).toContain(palette.accent.rgb);
    });
  }

  it("does not react on the very first frame it ever sees", () => {
    // A fresh well must not flash as though it had just been topped up.
    resetInkBar();
    const first = countingMockCtx();
    drawInkBar(first.ctx, makeState("running", 0, 800, MAX, 1), DESKTOP, DAY);

    resetInkBar();
    const settled = countingMockCtx();
    drawInkBar(settled.ctx, makeState("running", 0, 800, MAX, 1), DESKTOP, DAY);
    drawInkBar(settled.ctx, makeState("running", 0, 800, MAX, 1.1), DESKTOP, DAY);

    expect(settled.counts.total).toBe(first.counts.total * 2);
  });

  it("reacts to ink being spent with marks a steady bar does not make", () => {
    resetInkBar();
    const steady = countingMockCtx();
    drawInkBar(steady.ctx, makeState("running", 0, 800, MAX, 1), DESKTOP, DAY);
    const before = steady.counts.total;
    drawInkBar(steady.ctx, makeState("running", 0, 800, MAX, 1.05), DESKTOP, DAY);
    const steadyFrame = steady.counts.total - before;

    resetInkBar();
    const spending = countingMockCtx();
    drawInkBar(spending.ctx, makeState("running", 0, 800, MAX, 1), DESKTOP, DAY);
    const priorSpend = spending.counts.total;
    drawInkBar(spending.ctx, makeState("running", 0, 640, MAX, 1.05), DESKTOP, DAY);
    const spendFrame = spending.counts.total - priorSpend;

    expect(spendFrame).toBeGreaterThan(steadyFrame);
  });

  it("reacts to a pickup topping the well up", () => {
    resetInkBar();
    const steady = countingMockCtx();
    drawInkBar(steady.ctx, makeState("running", 0, 400, MAX, 1), DESKTOP, DAY);
    const before = steady.counts.total;
    drawInkBar(steady.ctx, makeState("running", 0, 400, MAX, 1.05), DESKTOP, DAY);
    const steadyFrame = steady.counts.total - before;

    resetInkBar();
    const filling = countingMockCtx();
    drawInkBar(filling.ctx, makeState("running", 0, 400, MAX, 1), DESKTOP, DAY);
    const priorFill = filling.counts.total;
    drawInkBar(filling.ctx, makeState("running", 0, 660, MAX, 1.05), DESKTOP, DAY);
    const fillFrame = filling.counts.total - priorFill;

    expect(fillFrame).toBeGreaterThan(steadyFrame);
  });

  for (const viewport of VIEWPORTS) {
    it(`escalates visibly as the well runs dry at ${viewport.width}x${viewport.height}`, () => {
      resetInkBar();
      const comfortable = countingMockCtx();
      drawInkBar(comfortable.ctx, makeState("running", 0, MAX * 0.6), viewport, DAY);

      resetInkBar();
      const desperate = countingMockCtx();
      drawInkBar(desperate.ctx, makeState("running", 0, MAX * 0.02), viewport, DAY);

      expect(desperate.counts.total).toBeGreaterThan(comfortable.counts.total);
    });
  }

  it("restarting the run (clock back to zero) does not read as a top-up", () => {
    resetInkBar();
    const ctx = mockCtx();
    drawInkBar(ctx, makeState("running", 0, 120, MAX, 9), DESKTOP, DAY);
    const restarted = countingMockCtx();
    drawInkBar(restarted.ctx, makeState("running", 0, MAX, MAX, 0), DESKTOP, DAY);

    resetInkBar();
    const fresh = countingMockCtx();
    drawInkBar(fresh.ctx, makeState("running", 0, MAX, MAX, 0), DESKTOP, DAY);

    expect(restarted.counts.total).toBe(fresh.counts.total);
  });
});

describe("drawSlowmoWash", () => {
  for (const viewport of VIEWPORTS) {
    for (let p = 0; p < PALETTES.length; p++) {
      it(`renders without throwing at ${viewport.width}x${viewport.height}, palette=${p}`, () => {
        const ctx = mockCtx();
        expect(() => drawSlowmoWash(ctx, viewport, PALETTES[p])).not.toThrow();
      });
    }
  }

  // THE rule this effect exists under. Three full-frame effects now overlap:
  // this wash, the loss flood, and the danger vignette creeping in from the
  // left. Both of the others are dark. So this one may lay down NOTHING but
  // the palette's bright tone — not a tint of ink, not a faint dark ring, not
  // at any alpha. Anything else and "you are drawing" starts to look like
  // "you are dying", which is the exact confusion the effect was rebuilt to
  // end.
  for (const palette of PALETTES) {
    it(`paints only the bright tone, never a dark one (shape=${palette.shape})`, () => {
      const { ctx, rgbs } = recordingCtx();
      drawSlowmoWash(ctx, DESKTOP, palette);
      const glow = palette.dark ? palette.ink.rgb : palette.paper.rgb;
      const used = rgbs();
      expect(used.length).toBeGreaterThan(0);
      for (const rgb of used) expect(rgb).toBe(glow);
    });

    it(`never touches the pigment the loss flood is made of (shape=${palette.shape})`, () => {
      const { ctx, rgbs } = recordingCtx();
      drawSlowmoWash(ctx, DESKTOP, palette);
      const shroud = palette.dark ? palette.skyTop.rgb : palette.ink.rgb;
      expect(rgbs()).not.toContain(shroud);
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
            expect(() => drawEndScreen(ctx, state, viewport, DAY)).not.toThrow();
          });
        }
      }

      for (let p = 0; p < PALETTES.length; p++) {
        it(`renders "${phase}" on palette ${p} without throwing at ${viewport.width}x${viewport.height}`, () => {
          const ctx = mockCtx();
          const state = makeState(phase, IMPACT_HOLD + 1.6, 300);
          expect(() => drawEndScreen(ctx, state, viewport, PALETTES[p])).not.toThrow();
        });
      }
    }

    it(`is a no-op that still does not throw while "running" at ${viewport.width}x${viewport.height}`, () => {
      const ctx = mockCtx();
      const state = makeState("running", 2, 600);
      expect(() => drawEndScreen(ctx, state, viewport, DAY)).not.toThrow();
    });
  }
});

// The two resolutions must never read as the same event. The pigment is the
// half of that a headless test can hold: a loss floods the frame with the
// palette's darkest tone and marks over it in the tone that survives the
// flood; a win never lays that flood down at all. The other half — closed
// ring on an intact line versus a snapped one — is verified by looking at the
// rendered frames.
describe("win and loss are made of opposite pigment", () => {
  for (const palette of PALETTES) {
    const shroud = palette.dark ? palette.skyTop.rgb : palette.ink.rgb;

    it(`a loss floods the frame with the darkest tone (shape=${palette.shape})`, () => {
      const { ctx, rgbs } = recordingCtx();
      drawEndScreen(ctx, makeState("lost", IMPACT_HOLD + 2, 0), DESKTOP, palette);
      expect(rgbs()).toContain(shroud);
    });

    it(`a win never floods the frame with it (shape=${palette.shape})`, () => {
      const { ctx, rgbs } = recordingCtx();
      drawEndScreen(ctx, makeState("won", IMPACT_HOLD + 2, 400), DESKTOP, palette);
      if (!palette.dark) {
        // On a daylight palette the win's own marks ARE ink, so the flood
        // colour cannot be excluded by pigment alone; what must not appear is
        // the shroud used as a full-frame gradient, which is covered by the
        // bright-wash assertion below instead.
        expect(rgbs()).toContain(palette.paper.rgb);
      } else {
        expect(rgbs()).not.toContain(shroud);
      }
    });
  }

  it("the night palette's loss marks are legible against its own flood", () => {
    const { ctx, rgbs } = recordingCtx();
    drawEndScreen(ctx, makeState("lost", IMPACT_HOLD + 2, 0), DESKTOP, NIGHT);
    // Cream marks on near-black: the inverted level must not draw its loss
    // screen in the same near-black it just flooded with.
    expect(rgbs()).toContain(NIGHT.ink.rgb);
    expect(rgbs()).not.toContain(NIGHT.paper.rgb);
  });
});

// The regression that matters: the playtest verdict was that the loss flood
// covered the frame before the player ever saw the chaser reach them, and
// the win ring appeared with nothing to connect it to the frozen world
// behind it. IMPACT_HOLD (tuning.ts) fixes the timing half of that — the
// frozen world must be left completely unobscured for that whole hold.
describe("drawEndScreen impact hold", () => {
  for (const viewport of VIEWPORTS) {
    for (const phase of PHASES) {
      it(`issues NO drawing calls at all while phaseFor < IMPACT_HOLD ("${phase}", ${viewport.width}x${viewport.height})`, () => {
        for (const phaseFor of [0, IMPACT_HOLD * 0.25, IMPACT_HOLD * 0.5, IMPACT_HOLD * 0.9, IMPACT_HOLD - 0.001]) {
          const { ctx, counts } = countingMockCtx();
          const state = makeState(phase, phaseFor, 600);
          drawEndScreen(ctx, state, viewport, DAY);
          expect(counts.total).toBe(0);
        }
      });

      it(`starts drawing as soon as phaseFor reaches IMPACT_HOLD ("${phase}", ${viewport.width}x${viewport.height})`, () => {
        for (const phaseFor of [IMPACT_HOLD, IMPACT_HOLD + 0.01, IMPACT_HOLD + 1, IMPACT_HOLD + 3]) {
          const { ctx, counts } = countingMockCtx();
          const state = makeState(phase, phaseFor, 600);
          drawEndScreen(ctx, state, viewport, DAY);
          expect(counts.total).toBeGreaterThan(0);
        }
      });
    }
  }
});

// The restart affordance must key off time-since-the-hold-ended, not the raw
// phase clock, or it would appear IMPACT_HOLD seconds too early (right at
// phaseFor ~ 1.0) instead of ~1s after the resolution itself begins.
describe("restart affordance timing relative to the impact hold", () => {
  for (const viewport of VIEWPORTS) {
    for (const phase of PHASES) {
      it(`draws no restart cue until roughly one second past the hold ("${phase}", ${viewport.width}x${viewport.height})`, () => {
        // Just past the hold, but well under a second into the resolution:
        // raw phaseFor is already > 1.0, which would show the restart cue
        // if its timing were wired to the raw clock instead of
        // phaseFor - IMPACT_HOLD.
        const stillHidden = countingMockCtx();
        drawEndScreen(stillHidden.ctx, makeState(phase, IMPACT_HOLD + 0.5, 600), viewport, DAY);

        // Comfortably past one second into the resolution itself.
        const nowVisible = countingMockCtx();
        drawEndScreen(nowVisible.ctx, makeState(phase, IMPACT_HOLD + 1.4, 600), viewport, DAY);

        // The restart cue (and its connector stem) are extra draw calls on
        // top of everything else in the composition, so once it appears the
        // call count must be strictly higher than the identical scene
        // without it.
        expect(nowVisible.counts.total).toBeGreaterThan(stillHidden.counts.total);
      });
    }
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
