// HUD and resolution screens. Screen-space drawing only (no camera/world
// transform), composed the same way as render.ts: no words, no numerals, no
// letters, anywhere. Every piece of state is read through form, colour,
// motion and position.
//
// This module owns three jobs the playtest flagged as missing or weak:
//   1. An ink bar that reads as "the reason you are about to die", not just
//      a shrinking rectangle.
//   2. A slow-motion wash that is unmistakably the OPPOSITE of losing (light
//      vs. dark) and immediate enough to be self-teaching on first touch.
//   3. Composed, animated win/lose screens with a wordless restart cue,
//      because the previous build simply stopped with no resolution and no
//      way back in.

import type { GameState } from "./types";

const PAPER = "#f4f1e8";
const INK = "#1a1a2e";

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

function easeOutCubic(x: number): number {
  const c = clamp01(x);
  return 1 - Math.pow(1 - c, 3);
}

/** Path for a rounded-rect / capsule, left open so the caller fills or
 *  strokes it. Radius is clamped so it never exceeds half the shorter side,
 *  which degenerates gracefully to a stadium/circle as the shape shrinks. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  ctx.beginPath();
  if (w <= 0 || h <= 0) return;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Ink bar. Screen-space, top-left, sized purely as a fraction of the
// viewport's shorter side so it composes the same way on the 390-wide phone
// and the 1920-wide desktop. Drawn as a soft ink capsule rather than a hard
// HUD gauge, and its fill ends in the same "soft blot" bulge used for
// pickups elsewhere in the game — the family resemblance (same colour, same
// silhouette language) is the ONLY thing that ever explains "this bar, the
// lines you draw, and the pools you collect are the same substance", since
// the game may never say so.
//
// Near-empty gets escalating alarm: a pulsing halo around the whole bar and
// small drips falling away from the fill's leading edge, so the player reads
// running dry as an active, worsening danger — the reason they are about to
// die — rather than a passive number ticking down.
// ---------------------------------------------------------------------------
export function drawInkBar(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  ctx.save();
  try {
    const { width: w, height: h } = viewport;
    const unit = Math.min(w, h);

    const margin = unit * 0.045;
    const barW = unit * 0.42;
    const barH = unit * 0.034;
    const x = margin;
    const y = margin;
    const radius = barH / 2;

    const maxInk = state.maxInk > 0 ? state.maxInk : 1;
    const frac = clamp01(state.ink / maxInk);
    const t = Math.max(0, state.elapsed || 0);

    // Frame: the bar's full capacity.
    ctx.save();
    ctx.lineWidth = Math.max(1, unit * 0.0035);
    ctx.strokeStyle = INK;
    roundedRectPath(ctx, x, y, barW, barH, radius);
    ctx.stroke();
    ctx.restore();

    const fillW = barW * frac;
    if (fillW > 0) {
      ctx.save();
      ctx.fillStyle = INK;
      if (fillW >= barH) {
        roundedRectPath(ctx, x, y, fillW, barH, radius);
        ctx.fill();
      } else {
        // Too little left for a full capsule: it reads instead as a
        // shrinking blot, the same family as an uncollected pickup.
        ctx.beginPath();
        ctx.arc(x + fillW / 2, y + barH / 2, fillW / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // The leading-edge blot: a bulge of the same ink, plus the same faint
      // concentric ring the pickups carry. This is the family resemblance.
      const tipX = x + fillW;
      const tipR = barH * 0.62;
      ctx.beginPath();
      ctx.arc(tipX, y + barH / 2, tipR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1, unit * 0.002);
      ctx.beginPath();
      ctx.arc(tipX, y + barH / 2, tipR * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Low ink: real visual weight, not a colour change (there is only one
    // ink colour). A pulsing halo escalates in speed and reach as the well
    // dries, plus drips visibly leaking away from the fill's edge.
    const low = frac <= 0.18;
    if (low) {
      const urgency = 1 - frac / 0.18; // 0 at the threshold, 1 when bone dry
      const pulse = 0.5 + 0.5 * Math.sin(t * (6 + urgency * 6));

      ctx.save();
      ctx.globalAlpha = 0.25 + 0.5 * urgency * pulse;
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1, unit * (0.006 + 0.006 * urgency));
      const grow = unit * (0.01 + 0.02 * urgency) * (0.6 + 0.4 * pulse);
      roundedRectPath(
        ctx,
        x - grow,
        y - grow,
        barW + grow * 2,
        barH + grow * 2,
        radius + grow
      );
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < 2; i++) {
        const period = 1.1 + i * 0.35;
        const phase = ((t + i * 0.5) % period) / period;
        const dripAlpha = (1 - phase) * (0.2 + 0.5 * urgency);
        if (dripAlpha <= 0) continue;
        const dripX = x + fillW * (0.35 + i * 0.4);
        const dripY = y + barH + phase * barH * 2.2;
        ctx.save();
        ctx.globalAlpha = dripAlpha;
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(dripX, dripY, barH * 0.16 * (1 - phase * 0.4), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Slow-motion wash. This is a hard-won constraint: slow motion and losing
// used to be the same dark radial wash at different opacities, which is no
// distinction at a glance. Losing floods the frame dark (see drawEndScreen /
// the loss flood below); slow motion does the opposite — it PALES the world
// with the same paper the strokes are drawn on. That opposition must never
// blur, so this function only ever paints paper, at real strength, never a
// tint of ink.
//
// The tester found the effect "not obvious enough" until they drew, so it is
// deliberately stronger and busier than a flat tint: a solid paper flood
// plus a soft brightening bloom toward the centre, plus a few faint
// concentric rings, so pressing down reads immediately as "something
// happened to the whole frame", not just a slight dimming.
// ---------------------------------------------------------------------------
export function drawSlowmoWash(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number }
): void {
  ctx.save();
  try {
    const { width: w, height: h } = viewport;
    const cx = w / 2;
    const cy = h / 2;
    const outer = Math.max(w, h) * 0.75;

    // Flat, strong paper flood: the whole world pales at once.
    ctx.save();
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // A brightening bloom toward the centre, layered on top — light
    // flooding IN rather than a flat tint sitting there, which is what
    // makes the transition read as an event and not a filter.
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
    grad.addColorStop(0, "rgba(244,241,232,0.55)");
    grad.addColorStop(1, "rgba(244,241,232,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // A few faint concentric rings for texture — reads as "the moment has
    // shape", not just dimmer light. Kept extremely faint (ink at very low
    // alpha) so the overwhelming impression stays light, never dark.
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.06;
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.003);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, outer * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Restart affordance. A pulsing shape, not a word: a filled dot with a
// breathing outer ring, the universal "press here" cue. Deliberately absent
// until the resolution has settled (roughly a second in) so it never steps
// on the win/lose moment itself; exported so its timing can be verified
// directly without rendering anything.
// ---------------------------------------------------------------------------
const RESTART_APPEAR_AT = 1.0; // seconds into the phase before it starts to show
const RESTART_ENTRANCE = 0.35; // seconds to grow in once it starts

export function restartAffordance(phaseFor: number): { opacity: number; scale: number } {
  const since = phaseFor - RESTART_APPEAR_AT;
  if (since <= 0) return { opacity: 0, scale: 0 };

  const grow = easeOutCubic(since / RESTART_ENTRANCE);
  // A slow, steady breathing pulse once visible — the "come here" invitation.
  const breathe = Math.sin((since * Math.PI * 2) / 1.6);
  const scale = grow * (1 + 0.08 * breathe * grow);
  const opacity = clamp01(grow * (0.85 + 0.15 * breathe));
  return { opacity, scale };
}

function drawRestart(
  ctx: CanvasRenderingContext2D,
  phaseFor: number,
  viewport: { width: number; height: number },
  color: string
): void {
  const { opacity, scale } = restartAffordance(phaseFor);
  if (opacity <= 0 || scale <= 0) return;

  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  const cx = w / 2;
  const cy = h * 0.76;
  const r = unit * 0.05 * scale;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, unit * 0.006);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// A heavy, spiky mass — an amplified relative of the chaser's own silhouette
// — that slams down and comes to rest for the loss screen. It is given NO
// motion once it reaches full size: final means final, and stillness is
// what tells "lost" apart from the win screen's gentle, ongoing breathing.
// ---------------------------------------------------------------------------
function drawHeavyMass(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  if (radius <= 0) return;
  ctx.save();
  ctx.fillStyle = INK;

  ctx.beginPath();
  ctx.ellipse(cx, cy + radius * 0.1, radius * 1.15, radius * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();

  const spikeCount = 7;
  const spikeSpan = radius * 1.9;
  ctx.beginPath();
  for (let i = 0; i < spikeCount; i++) {
    const frac = i / (spikeCount - 1);
    const sx = cx - spikeSpan / 2 + spikeSpan * frac;
    const baseY = cy - radius * 0.5;
    const half = spikeSpan / (spikeCount * 2);
    ctx.moveTo(sx - half, baseY);
    ctx.lineTo(sx, baseY - radius * 0.6);
    ctx.lineTo(sx + half, baseY);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Won: earned and calm. A single ring blooms outward from the centre on a
// gentle ease-out, settles by well under a second, and then does nothing but
// breathe (a tiny, slow scale/alpha oscillation) — a held, living moment,
// not a repeating flourish. A small filled core sits at the centre from the
// very start, so even the first instant already reads as "something calm is
// here" rather than nothing.
// ---------------------------------------------------------------------------
function drawWon(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  const t = Math.max(0, state.phaseFor);
  const cx = w / 2;
  const cy = h * 0.42;

  // Ambient warmth: ramps in, then holds — the frame is a little brighter
  // for the rest of the resolution, calmly, with no further motion.
  const washP = easeOutCubic(t / 0.4);
  ctx.save();
  ctx.globalAlpha = 0.16 * washP;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const settleAt = 0.85;
  const growP = easeOutCubic(t / settleAt);
  const breathe = t > settleAt ? Math.sin(((t - settleAt) * Math.PI * 2) / 3.4) : 0;
  const baseRadius = unit * 0.3;
  const radius = Math.max(0, baseRadius * growP * (1 + 0.025 * breathe));
  const ringAlpha = Math.max(0, lerp(0.85, 0.32, growP) + breathe * 0.03);

  ctx.save();
  ctx.globalAlpha = ringAlpha;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, unit * 0.008);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.9 * growP;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(cx, cy, unit * 0.014, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawRestart(ctx, t, viewport, INK);
}

// ---------------------------------------------------------------------------
// Lost: heavy and final. A dark flood arrives fast (well inside half a
// second) and then holds at full strength — no further growth. A dense,
// spiky mass — the thing that caught the runner — slams down at centre a
// beat later and then sits dead still. Motionlessness is deliberate: the win
// screen breathes, the loss screen does not.
// ---------------------------------------------------------------------------
function drawLost(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  const t = Math.max(0, state.phaseFor);
  const cx = w / 2;
  const cy = h * 0.42;

  const floodP = easeOutCubic(t / 0.28);
  ctx.save();
  const grad = ctx.createRadialGradient(cx, cy, unit * 0.02, cx, cy, Math.max(w, h) * 0.75);
  grad.addColorStop(0, `rgba(26,26,46,${(0.22 * floodP).toFixed(3)})`);
  grad.addColorStop(1, `rgba(26,26,46,${(0.95 * floodP).toFixed(3)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const massP = easeOutCubic((t - 0.08) / 0.42);
  drawHeavyMass(ctx, cx, cy, unit * 0.24 * massP);

  drawRestart(ctx, t, viewport, PAPER);
}

/**
 * Screen-space resolution for the "won" or "lost" phase. A no-op while
 * `state.phase === "running"` — there is nothing to resolve yet. Entirely
 * driven by `state.phaseFor`, so it is deterministic and safe to call every
 * frame; nothing here reads the clock.
 */
export function drawEndScreen(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  ctx.save();
  try {
    if (state.phase === "won") drawWon(ctx, state, viewport);
    else if (state.phase === "lost") drawLost(ctx, state, viewport);
  } finally {
    ctx.restore();
  }
}
