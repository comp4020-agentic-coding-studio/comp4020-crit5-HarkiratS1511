// Frame composition and the camera. The drawing itself lives in figures.ts
// (bodies), scenery.ts (world) and hud.ts (bar and end screens); this module
// decides only what goes down in what order, and where the camera looks.

import type { GameState, PointerState, Vec2 } from "./types";
import { GROUND_SCREEN_FRACTION, MIN_SIGHTLINE, REFERENCE_HEIGHT } from "./tuning";
import { drawChaser, drawGhost, drawRunner } from "./figures";
import { drawFinish, drawGround, drawPickups, drawSky, drawStrokes } from "./scenery";
import { drawEndScreen, drawInkBar, drawSlowmoWash } from "./hud";

const INK = "#1a1a2e";

/** Scale by height, dropped only as far as the minimum sightline demands.
 *  Exported so the pointer transform consumes the SAME scale the renderer
 *  uses — two copies of this formula drift and land strokes off-cursor. */
export function worldScale(viewport: { width: number; height: number }): number {
  return Math.min(viewport.height / REFERENCE_HEIGHT, viewport.width / MIN_SIGHTLINE);
}

/** World x at the left edge. The runner sits left of centre because nothing
 *  behind can hurt you and every decision is ahead. */
export function cameraFor(
  state: GameState,
  viewport: { width: number; height: number },
): number {
  const viewWidthWorld = viewport.width / worldScale(viewport);
  return state.runner.pos.x - viewWidthWorld * 0.35;
}

/** World y at the top, pinned so the ground sits at a constant fraction of
 *  screen height whatever the viewport. */
export function cameraYFor(
  state: GameState,
  viewport: { width: number; height: number },
): number {
  const viewHeightWorld = viewport.height / worldScale(viewport);
  return state.level.groundY - viewHeightWorld * GROUND_SCREEN_FRACTION;
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: number,
  pointer: PointerState,
  viewport: { width: number; height: number },
): void {
  const scale = worldScale(viewport);
  const cameraY = cameraYFor(state, viewport);
  const slowmo = pointer.down && state.phase === "running";

  ctx.save();
  drawSky(ctx, viewport, camera, scale, state.levelIndex);

  const world = (): void => {
    ctx.save();
    ctx.translate(-camera * scale, -cameraY * scale);
    ctx.scale(scale, scale);
  };

  world();
  drawGround(ctx, state.level, scale);
  drawPickups(ctx, state.level, state.elapsed);
  drawStrokes(ctx, state.strokes, state.level.stub, scale);
  drawFinish(ctx, state.level, state.elapsed);
  if (state.ghost) drawGhost(ctx, state.ghost, state.elapsed);
  drawChaser(ctx, state.chaser, state.elapsed);
  drawRunner(ctx, state.runner, state.elapsed);
  ctx.restore();

  // Slow motion pales the WORLD, and only the world: the wash goes down here,
  // then the live stroke and the nib are drawn over it, so the pen stays at
  // full strength while everything around it settles. Losing is the dark
  // signal; these two may never be mistakable for one another.
  if (slowmo) drawSlowmoWash(ctx, viewport);

  world();
  drawLivePreview(ctx, pointer, scale);
  drawNib(ctx, pointer, scale, slowmo);
  ctx.restore();

  drawInkBar(ctx, state, viewport);
  if (state.phase !== "running") drawEndScreen(ctx, state, viewport);

  ctx.restore();
}

/** The stroke currently under the pointer: wet ink, happening now. */
function drawLivePreview(
  ctx: CanvasRenderingContext2D,
  pointer: PointerState,
  scale: number,
): void {
  const pts = pointer.drawing;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5 / scale + 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.restore();
}

/** The cursor is drawn, not native (CSS sets cursor:none), so it can be an
 *  instrument that visibly makes marks rather than an arrow. */
function drawNib(
  ctx: CanvasRenderingContext2D,
  pointer: PointerState,
  scale: number,
  engaged: boolean,
): void {
  const p: Vec2 = pointer.pos;
  const s = (engaged ? 15 : 12) / scale;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-s * 0.42, -s * 1.5);
  ctx.lineTo(s * 0.42, -s * 1.5);
  ctx.closePath();
  ctx.fill();
  if (engaged) {
    ctx.beginPath();
    ctx.arc(0, s * 0.42, s * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
