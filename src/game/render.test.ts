import { describe, expect, it } from "vitest";
import { buildLevel } from "./level";
import { createState } from "./world";
import { cameraFor, cameraYFor, render, worldScale } from "./render";
import type { PointerState } from "./types";

const PORTRAIT = { width: 390, height: 844 };
const DESKTOP = { width: 1920, height: 1080 };

function mockCtx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const ctx: Record<string, unknown> = {
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, ellipse: noop, rect: noop,
    fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clip: noop,
    setLineDash: noop, drawImage: noop, clearRect: noop, arcTo: noop,
    roundRect: noop, arcTo2: noop, setTransform: noop, transform: noop,
    createPattern: () => null, isPointInPath: () => false,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 0 }), fillText: noop, strokeText: noop,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const pointer: PointerState = { pos: { x: 0, y: 0 }, down: false, drawing: null };

describe("camera", () => {
  for (const viewport of [PORTRAIT, DESKTOP]) {
    const label = `${viewport.width}x${viewport.height}`;

    it(`keeps the runner on screen at ${label}`, () => {
      const state = createState(0);
      const camera = cameraFor(state, viewport);
      const viewWidthWorld = viewport.width / worldScale(viewport);
      expect(state.runner.pos.x).toBeGreaterThanOrEqual(camera);
      expect(state.runner.pos.x).toBeLessThanOrEqual(camera + viewWidthWorld);
    });

    it(`shows more ahead than behind at ${label}`, () => {
      const state = createState(0);
      const camera = cameraFor(state, viewport);
      const viewWidthWorld = viewport.width / worldScale(viewport);
      const rearward = state.runner.pos.x - camera;
      const forward = camera + viewWidthWorld - state.runner.pos.x;
      expect(forward).toBeGreaterThan(rearward);
    });

    it(`puts the ground at a consistent screen fraction at ${label}`, () => {
      // The bug this guards: scale alone decided vertical placement, so the
      // ground sat at 78% of the screen on desktop and 20% on the phone.
      const state = createState(0);
      const scale = worldScale(viewport);
      const screenY = (buildLevel(0).groundY - cameraYFor(state, viewport)) * scale;
      expect(screenY / viewport.height).toBeCloseTo(0.72, 1);
    });
  }

  it("tracks the runner forward", () => {
    const a = createState(0);
    const b = createState(0);
    b.runner.pos.x += 500;
    expect(cameraFor(b, DESKTOP)).toBeGreaterThan(cameraFor(a, DESKTOP));
  });
});

describe("render", () => {
  for (const phase of ["running", "won", "lost"] as const) {
    for (const viewport of [PORTRAIT, DESKTOP]) {
      it(`composes "${phase}" at ${viewport.width}x${viewport.height}`, () => {
        const state = createState(0);
        state.phase = phase;
        expect(() =>
          render(mockCtx(), state, cameraFor(state, viewport), pointer, viewport),
        ).not.toThrow();
      });
    }
  }

  it("composes while drawing, with no ink and no ghost", () => {
    const state = createState(0);
    state.ink = 0;
    state.ghost = null;
    const drawing: PointerState = {
      pos: { x: 40, y: 40 },
      down: true,
      drawing: [{ x: 10, y: 10 }, { x: 30, y: 20 }],
    };
    expect(() =>
      render(mockCtx(), state, cameraFor(state, DESKTOP), drawing, DESKTOP),
    ).not.toThrow();
  });
});
