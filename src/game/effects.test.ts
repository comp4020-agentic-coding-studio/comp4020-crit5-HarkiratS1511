import { describe, expect, it } from "vitest";
import type { GameState, Phase, Pickup } from "./types";
import { createState } from "./world";
import { cameraFor, cameraYFor, worldScale } from "./render";
import {
  _debugEffectsMemorySize,
  cameraDipOffset,
  dangerIntensity,
  drawScreenEffects,
  drawWorldEffects,
  shakeOffset,
  updateEffects,
} from "./effects";

const PORTRAIT = { width: 390, height: 844 };
const DESKTOP = { width: 1920, height: 1080 };
const VIEWPORTS = [PORTRAIT, DESKTOP];
const PHASES: Phase[] = ["running", "won", "lost"];

/** A plain-object stand-in for CanvasRenderingContext2D: every drawing
 *  method is a no-op. No canvas library involved — matches the mock used by
 *  render.test.ts and figures.test.ts, just enough surface for these draw
 *  functions to run against without throwing. */
function mockCtx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const ctx: Record<string, unknown> = {
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clip: noop,
    setLineDash: noop,
    arcTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
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

/** Builds a state for a given phase, plus the pickup/stroke edge cases the
 *  spec calls out: empty strokes, no pickups, and every pickup already
 *  taken. `variant` picks which of those the caller gets. */
function stateFor(phase: Phase, variant: "default" | "noPickups" | "allTaken" | "noStrokes" = "default"): GameState {
  const state = createState(0);
  state.phase = phase;
  if (phase !== "running") state.phaseFor = 0.9;
  if (variant === "noPickups") state.level.pickups = [];
  if (variant === "allTaken") for (const p of state.level.pickups) p.taken = true;
  if (variant === "noStrokes") state.strokes = [];
  return state;
}

function drawEverything(state: GameState, viewport: { width: number; height: number }): void {
  const scale = worldScale(viewport);
  const camera = cameraFor(state, viewport);
  const cameraY = cameraYFor(state, viewport);
  updateEffects(state, 1 / 60);
  drawWorldEffects(mockCtx(), state, scale);
  drawScreenEffects(mockCtx(), state, viewport, camera, cameraY, scale);
}

describe("effects: runs without throwing", () => {
  for (const phase of PHASES) {
    for (const viewport of VIEWPORTS) {
      const label = `${phase} @ ${viewport.width}x${viewport.height}`;

      it(`composes at ${label} (default state)`, () => {
        expect(() => drawEverything(stateFor(phase), viewport)).not.toThrow();
      });

      it(`composes at ${label} with an empty stroke list`, () => {
        expect(() => drawEverything(stateFor(phase, "noStrokes"), viewport)).not.toThrow();
      });

      it(`composes at ${label} with no pickups`, () => {
        expect(() => drawEverything(stateFor(phase, "noPickups"), viewport)).not.toThrow();
      });

      it(`composes at ${label} with every pickup already taken`, () => {
        expect(() => drawEverything(stateFor(phase, "allTaken"), viewport)).not.toThrow();
      });
    }
  }

  it("draw functions tolerate being called before updateEffects ever ran", () => {
    const state = createState(0);
    const viewport = DESKTOP;
    const scale = worldScale(viewport);
    expect(() => drawWorldEffects(mockCtx(), state, scale)).not.toThrow();
    expect(() =>
      drawScreenEffects(mockCtx(), state, viewport, cameraFor(state, viewport), cameraYFor(state, viewport), scale),
    ).not.toThrow();
  });

  it("survives a landing, a committed stroke and a pickup all in the same tick", () => {
    const state = createState(0);
    // Force a fall-then-land.
    state.runner.grounded = false;
    state.runner.vel.y = -900;
    updateEffects(state, 1 / 60);
    state.elapsed += 1 / 60;
    state.runner.grounded = true;
    // Commit a stroke.
    state.strokes.push({
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 5 },
        { x: 40, y: -3 },
      ],
      segments: [],
    });
    // Take a pickup.
    const pickup: Pickup | undefined = state.level.pickups[0];
    if (pickup) pickup.taken = true;

    expect(() => drawEverything(state, DESKTOP)).not.toThrow();
    expect(() => drawEverything(state, PORTRAIT)).not.toThrow();
  });

  it("survives death (screen shake window) right at the moment of the loss", () => {
    const state = createState(0);
    state.phase = "lost";
    state.phaseFor = 0; // the very instant of the catch
    expect(() => drawEverything(state, DESKTOP)).not.toThrow();
    state.phaseFor = 0.15; // mid-shake
    expect(() => drawEverything(state, DESKTOP)).not.toThrow();
  });
});

describe("effects: determinism", () => {
  it("shakeOffset is a pure function of phase and phaseFor", () => {
    const state = createState(0);
    state.phase = "lost";
    state.phaseFor = 0.1;
    expect(shakeOffset(state)).toEqual(shakeOffset(state));

    const clone: GameState = { ...state, phaseFor: 0.1, phase: "lost" };
    expect(shakeOffset(clone)).toEqual(shakeOffset(state));
  });

  it("shakeOffset is zero outside its brief window, and on any non-death phase", () => {
    const running = createState(0);
    expect(shakeOffset(running)).toEqual({ x: 0, y: 0 });

    const won = createState(0);
    won.phase = "won";
    won.phaseFor = 0.1;
    expect(shakeOffset(won)).toEqual({ x: 0, y: 0 });

    const longAfterDeath = createState(0);
    longAfterDeath.phase = "lost";
    longAfterDeath.phaseFor = 5;
    expect(shakeOffset(longAfterDeath)).toEqual({ x: 0, y: 0 });
  });

  it("dangerIntensity is a pure function of runner/chaser distance", () => {
    const state = createState(0);
    const a = dangerIntensity(state);
    const b = dangerIntensity(state);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
  });

  it("dangerIntensity rises as the chaser closes and is zero once the run has ended", () => {
    const far = createState(0);
    far.chaser.pos.x = far.runner.pos.x - 10000;
    expect(dangerIntensity(far)).toBe(0);

    const close = createState(0);
    close.chaser.pos.x = close.runner.pos.x - 5;
    close.chaser.pos.y = close.runner.pos.y;
    expect(dangerIntensity(close)).toBeGreaterThan(dangerIntensity(far));

    const ended = createState(0);
    ended.chaser.pos.x = ended.runner.pos.x - 5;
    ended.phase = "lost";
    expect(dangerIntensity(ended)).toBe(0);
  });

  it("cameraDipOffset replays identically for the same state and elapsed time", () => {
    const state = createState(0);
    state.runner.grounded = false;
    state.runner.vel.y = -1000;
    updateEffects(state, 1 / 60);
    state.elapsed += 1 / 60;
    state.runner.grounded = true;
    updateEffects(state, 1 / 60);

    const first = cameraDipOffset(state);
    const second = cameraDipOffset(state);
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0); // a real landing just happened
  });

  it("a harder landing dips the camera at least as much as a soft one", () => {
    const soft = createState(0);
    soft.runner.grounded = false;
    soft.runner.vel.y = -80;
    updateEffects(soft, 1 / 60);
    soft.elapsed += 1 / 60;
    soft.runner.grounded = true;
    updateEffects(soft, 1 / 60);

    const hard = createState(0);
    hard.runner.grounded = false;
    hard.runner.vel.y = -1200;
    updateEffects(hard, 1 / 60);
    hard.elapsed += 1 / 60;
    hard.runner.grounded = true;
    updateEffects(hard, 1 / 60);

    expect(cameraDipOffset(hard)).toBeGreaterThanOrEqual(cameraDipOffset(soft));
  });
});

describe("effects: bounded memory", () => {
  it("never fires a landing for ground-hugging jitter (tiny vertical speed)", () => {
    const state = createState(0);
    state.runner.grounded = false;
    state.runner.vel.y = -5; // far below the noise threshold
    updateEffects(state, 1 / 60);
    state.elapsed += 1 / 60;
    state.runner.grounded = true;
    updateEffects(state, 1 / 60);
    expect(_debugEffectsMemorySize(state)).toBe(0);
  });

  it("stays bounded under thousands of updateEffects calls with sustained landings, strokes and pickups", () => {
    const state = createState(0);
    // Far more pickups than any real level carries, so the burst buffer's
    // cap gets properly exercised rather than just running out of pickups.
    for (let i = 0; i < 500; i++) {
      state.level.pickups.push({ pos: { x: i * 10, y: 0 }, amount: 10, taken: false });
    }

    for (let i = 0; i < 5000; i++) {
      state.elapsed = i * 0.016;
      // Alternate grounded/airborne so a landing fires roughly every other tick.
      state.runner.grounded = i % 2 === 0;
      state.runner.vel.y = i % 2 === 0 ? 0 : -900;
      // A new stroke every few ticks.
      if (i % 5 === 0) {
        state.strokes.push({
          points: [
            { x: i, y: 0 },
            { x: i + 10, y: 10 },
          ],
          segments: [],
        });
      }
      // Collect a pickup every tick, for as long as any remain unclaimed.
      const pickup = state.level.pickups[i];
      if (pickup) pickup.taken = true;

      updateEffects(state, 0.016);
    }

    // The store must stay small no matter how long play continues — a leak
    // here is a slow frame-rate death, not a crash, so this is checked
    // directly rather than inferred from "it didn't throw".
    expect(_debugEffectsMemorySize(state)).toBeLessThanOrEqual(15);
  });

  it("does not accumulate anything for a state that never changes", () => {
    const state = createState(0);
    for (let i = 0; i < 2000; i++) {
      updateEffects(state, 1 / 60);
    }
    expect(_debugEffectsMemorySize(state)).toBe(0);
  });
});
