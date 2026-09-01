// Entry point: canvas setup, the fixed-timestep loop, and time dilation.

import { attachInput } from "../game/input";
import { LEVEL_COUNT } from "../game/level";
import { cameraFor, cameraYFor, render, worldScale } from "../game/render";
import { CHASE_DRAW_SCALE, SLOWMO_SCALE } from "../game/tuning";
import type { GameState } from "../game/types";
import { createState, step } from "../game/world";

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (canvas) start(canvas);

function start(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let state: GameState = createState(0);
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
    (force: boolean) => {
      // Forced (Escape/R) always retries the level being played. Otherwise a
      // press on the end screen advances after a win and retries after a
      // loss, so the campaign moves without ever needing a menu.
      if (force || state.phase === "lost") {
        state = createState(state.levelIndex);
      } else if (state.phase === "won") {
        state = createState((state.levelIndex + 1) % LEVEL_COUNT);
      }
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
    const drawing = input.isDrawing();
    const slow = drawing ? SLOWMO_SCALE : 1;
    // The chaser runs on its own, shallower dilation, so drawing costs ground
    // without handing it the run.
    const chaserScale = drawing ? CHASE_DRAW_SCALE : 1;

    accumulator += realDt * slow;
    let guard = 0;
    while (accumulator >= STEP && guard++ < 8) {
      step(state, STEP, STEP * (chaserScale / slow));
      accumulator -= STEP;
    }

    render(ctx, state, cameraFor(state, viewport), input.pointer, viewport);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
