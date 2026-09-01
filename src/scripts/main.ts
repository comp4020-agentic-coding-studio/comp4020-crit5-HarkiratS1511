// Entry point: canvas setup, the fixed-timestep loop, and time dilation.

import { attachInput } from "../game/input";
import { buildLevel } from "../game/level";
import { cameraFor, render, worldScale } from "../game/render";
import { SLOWMO_SCALE } from "../game/tuning";
import type { GameState } from "../game/types";
import { createState, step } from "../game/world";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (canvas) start(canvas);

function start(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let state: GameState = createState(buildLevel());
  let viewport = { width: 0, height: 0 };

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    viewport = { width: w, height: h };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const input = attachInput(
    canvas,
    () => state,
    () => ({ camera: cameraFor(state, viewport), scale: worldScale(viewport) }),
    () => {
      state = createState(buildLevel());
    },
  );

  // Fixed timestep: swept collision is only as trustworthy as the step size
  // handed to it, and a variable rAF delta on a busy machine is how a runner
  // ends up through a drawn line.
  const STEP = 1 / 120;
  let accumulator = 0;
  let last = performance.now();

  const frame = (now: number): void => {
    // Clamp so a backgrounded tab doesn't resume by simulating a lost minute.
    const realDt = Math.min((now - last) / 1000, 0.25);
    last = now;

    // Slow motion while drawing. The world still advances, so holding the
    // pointer to think is never free — the chaser keeps coming.
    const gameDt = realDt * (input.isDrawing() ? SLOWMO_SCALE : 1);

    accumulator += gameDt;
    let guard = 0;
    while (accumulator >= STEP && guard++ < 8) {
      step(state, STEP);
      accumulator -= STEP;
    }

    render(ctx, state, cameraFor(state, viewport), input.pointer, viewport);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
