// Frame composition and the camera. The drawing itself lives in figures.ts
// (bodies), scenery.ts (world) and hud.ts (bar and end screens); this module
// decides only what goes down in what order, and where the camera looks.

import type { GameState, PointerState, Stroke, Vec2 } from "./types";
import { GROUND_SCREEN_FRACTION, MIN_SIGHTLINE, REFERENCE_HEIGHT } from "./tuning";
import { drawChaser, drawGhost, drawRunner } from "./figures";
import { drawFinish, drawGround, drawHazards, drawPickups, drawSky, drawStrokes } from "./scenery";
import { drawEndScreen, drawInkBar, drawSlowmoWash } from "./hud";
import { cameraDipOffset, drawScreenEffects, drawWorldEffects } from "./effects";
import { at as tone, paletteFor, type Palette } from "./palette";

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
  // The landing dip belongs to the WORLD, not the HUD: it must move the sky
  // and the ground together with everything standing on them, so it is
  // folded into cameraY here rather than applied by the caller.
  const cameraY = cameraYFor(state, viewport) + cameraDipOffset(state);
  const slowmo = pointer.down && state.phase === "running";
  const palette = paletteFor(state.levelIndex);

  ctx.save();
  drawSky(ctx, viewport, camera, scale, state.levelIndex, palette);

  const world = (): void => {
    ctx.save();
    ctx.translate(-camera * scale, -cameraY * scale);
    ctx.scale(scale, scale);
  };

  world();
  drawGround(ctx, state.level, scale, palette);
  drawHazards(ctx, state.level, state.elapsed, palette);
  drawPickups(ctx, state.level, state.elapsed, palette);
  drawStrokes(ctx, state.strokes, state.level.stub, scale, palette);
  drawFinish(ctx, state.level, state.elapsed, palette);
  if (state.ghost) drawGhost(ctx, state.ghost, state.ghostPhase, palette);
  drawChaser(ctx, state.chaser, state.chaserPhase, palette);
  drawRunner(ctx, state.runner, state.runPhase, palette);
  drawWorldEffects(ctx, state, scale);
  ctx.restore();

  // Slow motion pales the WORLD, and only the world: the wash goes down here,
  // then the live stroke and the nib are drawn over it, so the pen stays at
  // full strength while everything around it settles. Losing is the dark
  // signal; these two may never be mistakable for one another.
  if (slowmo) drawSlowmoWash(ctx, viewport, palette);
  // The chaser-proximity vignette is the OPPOSITE signal (danger, not
  // thinking-time) and has to stay legible even while slow motion is also on
  // screen, so it is drawn after the wash rather than folded into it.
  drawScreenEffects(ctx, state, viewport, camera, cameraY, scale);

  world();
  drawDemoStroke(ctx, state, scale, palette);
  drawLivePreview(ctx, pointer, scale, palette);
  drawNib(ctx, pointer, scale, slowmo, palette);
  ctx.restore();

  drawInkBar(ctx, state, viewport, palette);
  if (state.phase !== "running") drawEndScreen(ctx, state, viewport, palette);

  ctx.restore();
}

/** The stroke currently under the pointer: wet ink, happening now. */
function drawLivePreview(
  ctx: CanvasRenderingContext2D,
  pointer: PointerState,
  scale: number,
  palette: Palette,
): void {
  const pts = pointer.drawing;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = tone(palette.ink, 1);
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
 *  instrument that visibly makes marks rather than an arrow. A brush rather
 *  than a pen nib: with no words anywhere to name the verb, the tool in your
 *  hand has to look like something you paint with. */
function drawNib(
  ctx: CanvasRenderingContext2D,
  pointer: PointerState,
  scale: number,
  engaged: boolean,
  palette: Palette,
): void {
  const p: Vec2 = pointer.pos;
  const u = (engaged ? 17 : 14) / scale;
  ctx.save();
  ctx.translate(p.x, p.y);
  // Tilted like a held brush, tip at the pointer position.
  ctx.rotate(-0.42);
  ctx.fillStyle = tone(palette.ink, 1);
  ctx.lineJoin = "round";

  // Bristles: a soft wedge narrowing to the tip, splayed a little when in use.
  const splay = engaged ? 1.35 : 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-u * 0.34 * splay, -u * 0.5, -u * 0.26 * splay, -u * 1.05);
  ctx.lineTo(u * 0.26 * splay, -u * 1.05);
  ctx.quadraticCurveTo(u * 0.34 * splay, -u * 0.5, 0, 0);
  ctx.closePath();
  ctx.fill();

  // Ferrule: the metal band, drawn as a lighter notch so the brush reads as
  // two materials rather than one blob.
  ctx.fillStyle = tone(palette.paper, 1);
  ctx.fillRect(-u * 0.28, -u * 1.28, u * 0.56, u * 0.2);
  ctx.fillStyle = tone(palette.ink, 1);
  ctx.fillRect(-u * 0.3, -u * 1.34, u * 0.6, u * 0.1);

  // Handle, tapering away from the hand.
  ctx.beginPath();
  ctx.moveTo(-u * 0.24, -u * 1.34);
  ctx.lineTo(-u * 0.13, -u * 2.5);
  ctx.lineTo(u * 0.13, -u * 2.5);
  ctx.lineTo(u * 0.24, -u * 1.34);
  ctx.closePath();
  ctx.fill();

  if (engaged) {
    // A bead of ink at the tip while it is actually painting.
    ctx.beginPath();
    ctx.arc(0, u * 0.22, u * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}


/** The first gap the player must actually solve: found from segment endpoints
 *  rather than by scanning, and skipping any gap the pre-drawn teaching stub
 *  already spans. Demonstrating the notch would be pointless — it is already
 *  bridged, and the runner is past it before the ghost has finished falling. */
function firstUnbridgedGap(
  segs: { a: Vec2; b: Vec2 }[],
  stub: Stroke | null,
): { from: Vec2; to: Vec2 } | null {
  const sorted = [...segs].sort((p, q) => p.a.x - q.a.x);
  const spans = (from: number, to: number): boolean => {
    if (!stub || stub.points.length < 2) return false;
    const xs = stub.points.map((p) => p.x);
    return Math.min(...xs) <= from + 2 && Math.max(...xs) >= to - 2;
  };
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i].b;
    const to = sorted[i + 1].a;
    if (to.x - from.x > 1 && !spans(from.x, to.x)) return { from, to };
  }
  return null;
}

/** The wordless tutorial, and the only thing that ever names the verb.
 *
 *  The ghost teaches the stakes by falling into the first gap; nothing taught
 *  the player what to DO about it, and the playtester confirmed the opening
 *  gave them no reason to press and drag. So once the ghost is gone, a
 *  ghosted brush traces the answer across that same gap, leaving a line that
 *  fades: the problem, then the solution, shown rather than told. It loops
 *  until the player draws anything at all, and never returns after that.
 *
 *  The spec forbids instructions "anywhere, on screen or off", so this has to
 *  carry the whole lesson without a word — which is exactly why it is a
 *  demonstration and not a caption. */
function drawDemoStroke(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  scale: number,
  palette: Palette,
): void {
  if (state.levelIndex !== 0 || state.strokes.length > 0) return;
  if (state.phase !== "running") return;
  const gap = firstUnbridgedGap(state.level.groundSegments, state.level.stub);
  if (!gap) return;

  // Only once the player can see the gap, and only after the ghost has had
  // its moment — being shown the answer before the problem teaches nothing.
  const reach = gap.from.x - state.runner.pos.x;
  if (reach > 620 || reach < -40) return;
  if (state.ghost && state.ghost.goneFor === 0) return;

  const CYCLE = 2.6;
  const phase = (state.elapsed % CYCLE) / CYCLE;
  const draw = Math.min(1, phase / 0.55); // trace, then hold, then restart
  if (phase > 0.92) return;

  const lift = Math.min(70, (gap.to.x - gap.from.x) * 0.42 + 22);
  const at = (u: number): Vec2 => ({
    x: gap.from.x - 10 + (gap.to.x - gap.from.x + 20) * u,
    y: gap.from.y + (gap.to.y - gap.from.y) * u - Math.sin(u * Math.PI) * lift - 4,
  });

  const fade = phase < 0.55 ? 1 : 1 - (phase - 0.55) / 0.37;
  ctx.save();
  ctx.globalAlpha = 0.44 * fade;
  ctx.strokeStyle = tone(palette.ink, 1);
  ctx.lineWidth = 5 / scale + 2;
  ctx.lineCap = "round";
  ctx.setLineDash([14 / scale, 10 / scale]);
  ctx.beginPath();
  const p0 = at(0);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i <= 24; i++) {
    const u = (i / 24) * draw;
    const p = at(u);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // The brush itself, riding the head of the stroke, so the mark is visibly
  // being MADE by the same tool sitting under the player's own cursor.
  if (draw < 1) {
    const head = at(draw);
    ctx.globalAlpha = 0.66 * fade;
    ctx.translate(head.x, head.y);
    ctx.rotate(-0.42);
    const u = 13 / scale;
    ctx.fillStyle = tone(palette.ink, 1);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-u * 0.34, -u * 0.5, -u * 0.26, -u * 1.05);
    ctx.lineTo(u * 0.26, -u * 1.05);
    ctx.quadraticCurveTo(u * 0.34, -u * 0.5, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-u * 0.26, -u * 1.32, u * 0.52, u * 0.2);
    ctx.beginPath();
    ctx.moveTo(-u * 0.22, -u * 1.32);
    ctx.lineTo(-u * 0.12, -u * 2.4);
    ctx.lineTo(u * 0.12, -u * 2.4);
    ctx.lineTo(u * 0.22, -u * 1.32);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
