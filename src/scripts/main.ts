// Entry point: canvas setup, the fixed-timestep loop, and time dilation.

import { attachInput } from "../game/input";
import { buildLevel } from "../game/level";
import { cameraFor, cameraYFor, render, worldScale } from "../game/render";
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
    () => ({
      camera: cameraFor(state, viewport),
      cameraY: cameraYFor(state, viewport),
      scale: worldScale(viewport),
    }),
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

  // A read-only seam for automated playthroughs. It exposes the live state and
  // the SAME camera/scale the renderer and pointer use, so a driving script
  // never has to reimplement the transform — reimplementing it is exactly how
  // the earlier scale drift went unnoticed. Nothing here is reachable by, or
  // visible to, a player.
  (window as unknown as Record<string, unknown>).__inkDebug = {
    get state(): GameState {
      return state;
    },
    get transform(): { camera: number; cameraY: number; scale: number } {
      return {
        camera: cameraFor(state, viewport),
        cameraY: cameraYFor(state, viewport),
        scale: worldScale(viewport),
      };
    },
  };

  const frame = (now: number): void => {
    // Clamp so a backgrounded tab doesn't resume by simulating a lost minute.
    const realDt = Math.min((now - last) / 1000, 0.25);
    last = now;

    // Slow motion while drawing. The runner's world crawls; the chaser does
    // not. Dividing the step back out by `slow` gives the chaser the real
    // seconds that elapsed, so thinking time is paid for in ground.
    const slow = input.isDrawing() ? SLOWMO_SCALE : 1;

    accumulator += realDt * slow;
    let guard = 0;
    while (accumulator >= STEP && guard++ < 8) {
      step(state, STEP, STEP / slow);
      accumulator -= STEP;
    }

    render(ctx, state, cameraFor(state, viewport), input.pointer, viewport);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
