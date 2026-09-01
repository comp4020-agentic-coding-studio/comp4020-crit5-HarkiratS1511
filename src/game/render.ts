// All drawing lives here. No words, no numerals — every piece of state is
// read through form, colour, motion and position instead.
//
// Coordinate convention: +x right, +y DOWN (canvas convention), matching
// geometry.ts and the rest of src/game.

import type { GameState, PointerState, Vec2 } from "./types";
import { GROUND_SCREEN_FRACTION, MIN_SIGHTLINE, REFERENCE_HEIGHT, RUNNER_RADIUS, CHASER_RADIUS, PICKUP_RADIUS } from "./tuning";

const PAPER = "#f4f1e8";
const INK = "#1a1a2e";

/**
 * World x that should sit at the left edge of the view, given the runner's
 * position.
 *
 * The runner is placed noticeably left of centre (roughly a third of the way
 * across) rather than dead-centre. That asymmetry is deliberate: the whole
 * game is about seeing a gap in time to draw across it, and a gap can only
 * appear ahead of the runner, never behind. Biasing the camera trades
 * rearward view (worthless — nothing back there can hurt you) for forward
 * view (where the next decision lives). This matters most on the narrow
 * portrait viewport, where total horizontal visibility is scarce.
 */
export function cameraFor(
  state: GameState,
  viewport: { width: number; height: number }
): number {
  const scale = worldScale(viewport);
  const viewWidthWorld = viewport.width / scale;
  // Runner sits at ~35% across the view, leaving ~65% of the view ahead.
  const leadFraction = 0.35;
  const camera = state.runner.pos.x - viewWidthWorld * leadFraction;
  return camera;
}

/** Uniform scale factor from world units (px at REFERENCE_HEIGHT) to device
 *  CSS pixels for the given viewport, so the world reads at a sensible size
 *  on both a tall/narrow phone and a wide desktop. */
/** Exported so the pointer transform in main.ts consumes the SAME scale the
 *  renderer uses. Two definitions would drift and land strokes off-cursor. */
export function worldScale(viewport: { width: number; height: number }): number {
  return Math.min(
    viewport.height / REFERENCE_HEIGHT,
    viewport.width / MIN_SIGHTLINE,
  );
}

/** World y at the TOP of the view, chosen so the ground lands at a constant
 *  fraction of screen height whatever the viewport or scale. */
export function cameraYFor(
  state: GameState,
  viewport: { width: number; height: number },
): number {
  const viewHeightWorld = viewport.height / worldScale(viewport);
  return state.level.groundY - viewHeightWorld * GROUND_SCREEN_FRACTION;
}

/** Draw one frame. `camera` is the world x at the left edge of the view. */
export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: number,
  pointer: PointerState,
  viewport: { width: number; height: number }
): void {
  const dpr =
    typeof window !== "undefined" && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;

  // Back the canvas buffer with device pixels so lines stay crisp, while all
  // drawing below happens in CSS-pixel / world-scaled space.
  const targetW = Math.round(viewport.width * dpr);
  const targetH = Math.round(viewport.height * dpr);
  const canvas = ctx.canvas as HTMLCanvasElement | undefined;
  if (canvas && (canvas.width !== targetW || canvas.height !== targetH)) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Paper background.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const slowmo = pointer.down && state.phase === "running";
  if (slowmo) {
    // Slow-motion feedback: a soft desaturating wash over the whole frame,
    // teaching "press => time crawls" the moment it first happens. Applied
    // before the world so the ink strokes drawn on top still read at full
    // strength (the thing the player is actively doing stays crisp; the
    // world around it visibly settles).
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "#8a8a98";
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.restore();
  }

  const scale = worldScale(viewport);

  ctx.save();
  ctx.translate(-camera * scale, -cameraYFor(state, viewport) * scale);
  ctx.scale(scale, scale);

  // `pointer.pos` and `pointer.drawing` are already world-space (input.ts
  // converts client coordinates through this same camera/scale before
  // storing them), so the nib and the live preview are drawn here, inside
  // the world transform, alongside everything else that lives in world
  // space — no separate conversion needed.
  drawGround(ctx, state, scale);
  drawPickups(ctx, state);
  drawStub(ctx, state, scale);
  drawStrokes(ctx, state, scale);
  drawLivePreview(ctx, pointer, scale);
  drawFinish(ctx, state);
  drawChaser(ctx, state);
  drawRunner(ctx, state);
  drawNib(ctx, pointer, scale);

  ctx.restore(); // undo world transform

  drawInkBar(ctx, state, viewport);

  if (state.phase === "won") drawWinOverlay(ctx, state, camera, scale, viewport);
  if (state.phase === "lost") drawLossOverlay(ctx, viewport);

  if (slowmo) drawVignette(ctx, viewport);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Ground: a solid, confident line. Gaps are the one thing that MUST be
// legible from far away, so they get extra help: the lip of every segment
// end carries a short downward tick, making a hole read as a deliberate
// break rather than a rendering glitch, visible well before the runner
// reaches it.
// ---------------------------------------------------------------------------
function drawGround(ctx: CanvasRenderingContext2D, state: GameState, scale: number): void {
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4 / scale;

  for (const seg of state.level.groundSegments) {
    ctx.beginPath();
    ctx.moveTo(seg.a.x, seg.a.y);
    ctx.lineTo(seg.b.x, seg.b.y);
    ctx.stroke();

    // Edge ticks at both ends mark where solid ground stops, so a gap reads
    // as an intentional cut rather than something merely offscreen.
    drawEdgeTick(ctx, seg.a, scale);
    drawEdgeTick(ctx, seg.b, scale);
  }
}

function drawEdgeTick(ctx: CanvasRenderingContext2D, p: Vec2, scale: number): void {
  const tickLen = 10 / scale;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x, p.y + tickLen);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Pickups: small pools of the same ink that fills the bar and draws the
// lines. Same colour, same fill, same visual family as a stroke's own ink —
// the resemblance IS the explanation. Rendered as a soft blot (organic, not
// a hard geometric icon) so it reads as "ink sitting on the paper" rather
// than a game-HUD coin. A faint concentric ring gives it presence at a
// glance without needing motion.
// ---------------------------------------------------------------------------
function drawPickups(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const pickup of state.level.pickups) {
    if (pickup.taken) continue;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(pickup.pos.x, pickup.pos.y, PICKUP_RADIUS * 0.55, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pickup.pos.x, pickup.pos.y, PICKUP_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Stub and player strokes: rendered by the exact same function so they are
// visually indistinguishable. The stub's whole job is to teach "this is what
// a drawn line looks like, and you can stand on it" — any visual difference
// from a real player stroke would undermine that lesson.
// ---------------------------------------------------------------------------
function strokeStyle(ctx: CanvasRenderingContext2D, scale: number): void {
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Divide by scale so a drawn line reads as the same weight of ink on
  // screen regardless of viewport (same treatment as the ground line).
  ctx.lineWidth = 5 / scale;
}

function drawPolyline(ctx: CanvasRenderingContext2D, points: Vec2[]): void {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

function drawStub(ctx: CanvasRenderingContext2D, state: GameState, scale: number): void {
  const stub = state.level.stub;
  if (!stub) return;
  strokeStyle(ctx, scale);
  drawPolyline(ctx, stub.points);
}

function drawStrokes(ctx: CanvasRenderingContext2D, state: GameState, scale: number): void {
  strokeStyle(ctx, scale);
  for (const stroke of state.strokes) {
    drawPolyline(ctx, stroke.points);
  }
}

/** The stroke currently being drawn: a live preview following the cursor,
 *  identical ink so it reads as "this is happening now", plus a faint tail
 *  so the line still feels wet as it's laid down. */
function drawLivePreview(
  ctx: CanvasRenderingContext2D,
  pointer: PointerState,
  scale: number
): void {
  if (!pointer.drawing || pointer.drawing.length === 0) return;
  strokeStyle(ctx, scale);
  ctx.globalAlpha = 0.85;
  drawPolyline(ctx, pointer.drawing);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Finish: a destination, not a wall — a simple upright post with a pennant,
// the one vertical mark on an otherwise horizontal world so it's
// unmistakable at a glance from a distance.
// ---------------------------------------------------------------------------
function drawFinish(ctx: CanvasRenderingContext2D, state: GameState): void {
  const x = state.level.finishX;
  const groundY = state.level.groundY;
  const postH = 90;

  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, groundY);
  ctx.lineTo(x, groundY - postH);
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(x, groundY - postH);
  ctx.lineTo(x + 26, groundY - postH + 12);
  ctx.lineTo(x, groundY - postH + 24);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Runner: a light, upright ink figure. Facing is unambiguous — the whole
// silhouette leans and steps toward +x, the direction it always runs.
// Grounded vs airborne changes the pose: legs scissor while grounded (a
// running stride), tuck up beneath the body while airborne (a jump/flight
// silhouette), so the state reads from the body alone.
// ---------------------------------------------------------------------------
function drawRunner(ctx: CanvasRenderingContext2D, state: GameState): void {
  const r = state.runner;
  const radius = r.radius || RUNNER_RADIUS;
  const cx = r.pos.x;
  const cy = r.pos.y;

  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.5;

  // Body: a forward-leaning ink oval, leaning into the direction of travel.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(0.18); // lean toward +x (down-forward lean reads as running right)
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 0.62, radius, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // A small forward "beak" mark at the leading edge gives the silhouette an
  // unambiguous nose, so facing reads even at a glance.
  ctx.beginPath();
  ctx.moveTo(cx + radius * 0.5, cy - radius * 0.35);
  ctx.lineTo(cx + radius * 1.15, cy - radius * 0.15);
  ctx.stroke();

  if (r.grounded) {
    // Grounded: scissoring legs planted on the ground line — a running stride.
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.3, cy + radius * 0.7);
    ctx.lineTo(cx - radius * 0.9, cy + radius * 1.7);
    ctx.moveTo(cx + radius * 0.2, cy + radius * 0.7);
    ctx.lineTo(cx + radius * 0.9, cy + radius * 1.6);
    ctx.stroke();
  } else {
    // Airborne: legs tucked up beneath the body, a flight/jump silhouette.
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.1, cy + radius * 0.6);
    ctx.lineTo(cx - radius * 0.4, cy + radius * 1.0);
    ctx.moveTo(cx + radius * 0.3, cy + radius * 0.6);
    ctx.lineTo(cx + radius * 0.1, cy + radius * 1.0);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Chaser: darker, heavier, hungrier. Rendered as a dense, near-black filled
// mass (heavier ink coverage than the runner's thin-stroked figure), low and
// wide rather than upright (predatory posture vs. the runner's upright
// stride), with a jagged, spiky leading edge that reads as teeth/menace
// without depicting an actual face. No colour cue beyond ink is available in
// a monochrome game, so weight, shape and posture do all the work — the
// player's first sight of it is the entire lesson.
// ---------------------------------------------------------------------------
function drawChaser(ctx: CanvasRenderingContext2D, state: GameState): void {
  const c = state.chaser;
  const radius = c.radius || CHASER_RADIUS;
  const cx = c.pos.x;
  const cy = c.pos.y;

  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;

  // Low, wide, heavy body mass.
  ctx.beginPath();
  ctx.ellipse(cx, cy + radius * 0.15, radius * 1.25, radius * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();

  // Jagged leading edge: a row of small triangular spikes along the top,
  // giving it a hungry, threatening silhouette on sight.
  const spikeCount = 5;
  const spikeSpan = radius * 1.5;
  ctx.beginPath();
  for (let i = 0; i < spikeCount; i++) {
    const t = i / (spikeCount - 1);
    const sx = cx - spikeSpan / 2 + spikeSpan * t;
    const baseY = cy - radius * 0.45;
    ctx.moveTo(sx - spikeSpan / (spikeCount * 2.2), baseY);
    ctx.lineTo(sx, baseY - radius * 0.55);
    ctx.lineTo(sx + spikeSpan / (spikeCount * 2.2), baseY);
  }
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Ink bar: a bar, no numerals. Fixed to the top-left of the viewport (screen
// space, not world space) so it stays glanceable during play. Fill amount is
// the same ink colour as everything drawable, reinforcing the resource
// identity. Near-empty gets escalating visual weight (a pulse-like double
// outline and a warning notch) so running dry reads as danger, not just a
// shrinking rectangle.
// ---------------------------------------------------------------------------
function drawInkBar(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  const margin = 16;
  const barW = Math.min(160, viewport.width * 0.4);
  const barH = 14;
  const x = margin;
  const y = margin;

  const frac = state.maxInk > 0 ? Math.max(0, Math.min(1, state.ink / state.maxInk)) : 0;

  // Outline / frame.
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.strokeRect(x + 0.5, y + 0.5, barW, barH);

  // Fill, same ink as everything else that IS ink.
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, barW * frac, barH);

  const low = frac <= 0.15;
  if (low) {
    // Empty/near-empty gets real visual weight: a heavier double outline
    // that reads as alarm, since this is the reason the player is about to
    // die.
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.strokeRect(x - 3, y - 3, barW + 6, barH + 6);
    ctx.strokeRect(x - 6, y - 6, barW + 12, barH + 12);
  }
}

// ---------------------------------------------------------------------------
// Nib cursor: drawn because the CSS hides the system cursor. A simple pen
// nib shape (a tapered wedge) that visibly engages — swells slightly and
// gains a small ink droplet mark — while pointer.down is true, so it reads
// as "actively making a mark" rather than just "pointing". `pointer.pos` is
// already world-space (input.ts converts through the same camera/scale
// before storing it), so this is drawn inside the world transform; `scale`
// is only used to keep the nib's own footprint a constant screen size
// regardless of viewport, like a real cursor.
// ---------------------------------------------------------------------------
function drawNib(
  ctx: CanvasRenderingContext2D,
  pointer: PointerState,
  scale: number
): void {
  const { x, y } = pointer.pos;
  // Guard against a pointer position that isn't finite yet (still draw
  // something reasonable rather than throwing).
  const px = isFinite(x) ? x : 0;
  const py = isFinite(y) ? y : 0;

  const engaged = pointer.down;
  const size = (engaged ? 12 : 9) / scale;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-0.6); // tilt like a held pen, nib pointing down-forward

  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(0, -size * 1.6);
  ctx.lineTo(size * 0.35, size * 0.4);
  ctx.lineTo(0, size * 0.7);
  ctx.lineTo(-size * 0.35, size * 0.4);
  ctx.closePath();
  ctx.fill();

  if (engaged) {
    // A small filled droplet at the very tip signals the nib is actively
    // laying down ink right now.
    ctx.beginPath();
    ctx.arc(0, size * 0.9, size * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Slow-motion vignette: darkened corners while the pointer is held, layered
// over the whole frame (screen space) as the other half of the slow-motion
// signal alongside the desaturating wash drawn earlier.
// ---------------------------------------------------------------------------
function drawVignette(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number }
): void {
  const { width: w, height: h } = viewport;
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.max(w, h) * 0.75;
  const inner = outer * 0.45;

  const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  grad.addColorStop(0, "rgba(26,26,46,0)");
  grad.addColorStop(1, "rgba(26,26,46,0.28)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Win: the runner's own mark blooms — an expanding ink ring centred on the
// finish, filling the frame with the same ink as everything the player has
// been making. No colour change (still monochrome-ink), just triumphant
// expansion instead of the chaser's encroaching dread.
// ---------------------------------------------------------------------------
function drawWinOverlay(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: number,
  scale: number,
  viewport: { width: number; height: number }
): void {
  const screenX = (state.level.finishX - camera) * scale;
  const screenY = state.level.groundY * scale;

  const t = Math.max(0, state.elapsed % 2);
  const radius = 20 + t * 260;

  ctx.save();
  ctx.globalAlpha = Math.max(0, 0.5 - t * 0.2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(screenX, screenY, Math.max(0, radius), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // A calm, even paper-coloured wash lightens the busy scene behind, letting
  // the ring read clearly as the focal event.
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Loss: the frame itself goes heavy — ink floods in from the edges (the
// chaser's colour, overtaking the paper), the visual opposite of the win's
// clean expanding ring. Sudden, total, unmistakable as bad.
// ---------------------------------------------------------------------------
function drawLossOverlay(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number }
): void {
  const { width: w, height: h } = viewport;
  const grad = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.05,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.75
  );
  grad.addColorStop(0, "rgba(26,26,46,0.15)");
  grad.addColorStop(1, "rgba(26,26,46,0.92)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}
