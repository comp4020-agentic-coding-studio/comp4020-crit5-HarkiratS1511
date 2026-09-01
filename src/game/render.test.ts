import { describe, it, expect } from "vitest";
import type { GameState, Level, PointerState } from "./types";
import { RUNNER_RADIUS, CHASER_RADIUS, MAX_INK, REFERENCE_HEIGHT } from "./tuning";
import { render, cameraFor } from "./render";

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
    groundY: 500,
    stub: { points: [{ x: 300, y: 500 }, { x: 400, y: 500 }], segments: [] },
    ...overrides,
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const level = overrides.level ?? makeLevel();
  return {
    runner: {
      pos: { x: 150, y: level.groundY - RUNNER_RADIUS },
      vel: { x: 260, y: 0 },
      radius: RUNNER_RADIUS,
      grounded: true,
    },
    chaser: {
      pos: { x: level.chaserStartX, y: level.groundY - CHASER_RADIUS },
      radius: CHASER_RADIUS,
    },
    strokes: [],
    ink: MAX_INK,
    maxInk: MAX_INK,
    phase: "running",
    level,
    elapsed: 0,
    ...overrides,
  };
}

function makePointer(overrides: Partial<PointerState> = {}): PointerState {
  return { pos: { x: 150, y: 480 }, down: false, drawing: null, ...overrides };
}

/**
 * A plain-object stand-in for CanvasRenderingContext2D: every drawing method
 * is a no-op, every style property is a plain settable field, and
 * createRadialGradient/createLinearGradient return an object whose
 * addColorStop is also a no-op. No canvas library involved — this is enough
 * surface for render() to run against without throwing.
 */
function makeMockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const ctx = {
    // settable style properties
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",

    // no-op drawing methods
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

    // no canvas backing element: render() must guard this being absent
    canvas: undefined,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

describe("cameraFor", () => {
  for (const viewport of [PORTRAIT, DESKTOP]) {
    it(`keeps the runner on screen at ${viewport.width}x${viewport.height}`, () => {
      const state = makeState();
      const camera = cameraFor(state, viewport);
      const scale = viewport.height / REFERENCE_HEIGHT;
      const viewWidthWorld = viewport.width / scale;

      expect(state.runner.pos.x).toBeGreaterThanOrEqual(camera);
      expect(state.runner.pos.x).toBeLessThanOrEqual(camera + viewWidthWorld);
    });
  }

  for (const viewport of [PORTRAIT, DESKTOP]) {
    it(`gives more forward than rearward visibility at ${viewport.width}x${viewport.height}`, () => {
      const state = makeState();
      const camera = cameraFor(state, viewport);
      const scale = viewport.height / REFERENCE_HEIGHT;
      const viewWidthWorld = viewport.width / scale;

      const rearward = state.runner.pos.x - camera;
      const forward = camera + viewWidthWorld - state.runner.pos.x;

      expect(forward).toBeGreaterThan(rearward);
    });
  }

  it("moves forward with the runner (camera tracks position)", () => {
    const state1 = makeState();
    const state2 = makeState({
      runner: { ...makeState().runner, pos: { x: 500, y: 480 } },
    });
    const camera1 = cameraFor(state1, DESKTOP);
    const camera2 = cameraFor(state2, DESKTOP);
    expect(camera2).toBeGreaterThan(camera1);
  });
});

describe("render", () => {
  const phases: GameState["phase"][] = ["running", "won", "lost"];

  for (const phase of phases) {
    for (const viewport of [PORTRAIT, DESKTOP]) {
      it(`does not throw for phase "${phase}" at ${viewport.width}x${viewport.height}`, () => {
        const state = makeState({ phase });
        const ctx = makeMockCtx();
        const camera = cameraFor(state, viewport);
        const pointer = makePointer();
        expect(() => render(ctx, state, camera, pointer, viewport)).not.toThrow();
      });
    }
  }

  it("does not throw with an empty stroke list", () => {
    const state = makeState({ strokes: [] });
    const ctx = makeMockCtx();
    expect(() =>
      render(ctx, state, cameraFor(state, DESKTOP), makePointer(), DESKTOP)
    ).not.toThrow();
  });

  it("does not throw with a null stub", () => {
    const level = makeLevel({ stub: null });
    const state = makeState({ level });
    const ctx = makeMockCtx();
    expect(() =>
      render(ctx, state, cameraFor(state, DESKTOP), makePointer(), DESKTOP)
    ).not.toThrow();
  });

  it("does not throw with zero ink", () => {
    const state = makeState({ ink: 0 });
    const ctx = makeMockCtx();
    expect(() =>
      render(ctx, state, cameraFor(state, DESKTOP), makePointer(), DESKTOP)
    ).not.toThrow();
  });

  it("does not throw while the pointer is down and drawing a live stroke", () => {
    const state = makeState();
    const ctx = makeMockCtx();
    const pointer = makePointer({
      down: true,
      drawing: [{ x: 140, y: 480 }, { x: 160, y: 470 }, { x: 180, y: 460 }],
    });
    expect(() =>
      render(ctx, state, cameraFor(state, PORTRAIT), pointer, PORTRAIT)
    ).not.toThrow();
  });

  it("does not throw with a populated stroke list and a taken/untaken pickup mix", () => {
    const state = makeState({
      strokes: [
        { points: [{ x: 300, y: 500 }, { x: 400, y: 460 }], segments: [] },
      ],
    });
    const ctx = makeMockCtx();
    expect(() =>
      render(ctx, state, cameraFor(state, DESKTOP), makePointer(), DESKTOP)
    ).not.toThrow();
  });
});
