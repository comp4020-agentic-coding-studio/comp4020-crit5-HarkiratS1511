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
//      way back in. Two playtest-driven fixes live here too: an "impact
//      hold" (IMPACT_HOLD, tuning.ts) during which drawEndScreen draws
//      nothing at all, so the player actually sees the catch or the fall
//      before the resolution covers it; and a full-frame composition (frame
//      brackets, an anchor band, a connector stem) so the resolution reads
//      as a deliberate screen anchored to the viewport, not a shape
//      floating in whatever the camera happens to be looking at.

import type { GameState } from "./types";
import { IMPACT_HOLD } from "./tuning";

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

// ---------------------------------------------------------------------------
// Frame brackets: four L-shaped marks anchored to the viewport's own
// corners, never to anything in the world. This is the difference between a
// shape floating in whatever the camera happens to be looking at and a
// SCREEN: the brackets exist purely in screen space, at fixed margins from
// the real edges, so they read as a deliberate frame over a busy scene
// exactly as much as over empty sky — they never touch or depend on either.
// ---------------------------------------------------------------------------
function drawFrameBrackets(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  color: string,
  growth: number,
  alpha: number
): void {
  const g = clamp01(growth);
  if (g <= 0 || alpha <= 0) return;
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  const margin = unit * 0.05;
  const arm = unit * 0.13 * easeOutCubic(g);
  if (arm <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, unit * 0.01);

  const corners: Array<[number, number, number, number]> = [
    [margin, margin, 1, 1], // top-left
    [w - margin, margin, -1, 1], // top-right
    [margin, h - margin, 1, -1], // bottom-left
    [w - margin, h - margin, -1, -1], // bottom-right
  ];
  for (const [x, y, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x + dx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * arm);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Anchor band: a full-width line through the resolution's own centre,
// growing outward from the middle to the edges. It gives the ring/mass a
// horizontal structure to sit on — a "third" of the frame claimed on
// purpose — instead of a shape adrift with nothing else in frame to relate
// it to.
// ---------------------------------------------------------------------------
function drawAnchorBand(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  cy: number,
  growth: number,
  color: string,
  alpha: number
): void {
  const g = easeOutCubic(growth);
  if (g <= 0 || alpha <= 0) return;
  const { width: w, height: h } = viewport;
  const halfW = (w / 2) * g;
  ctx.save();
  ctx.globalAlpha = alpha * g;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.0035);
  ctx.beginPath();
  ctx.moveTo(w / 2 - halfW, cy);
  ctx.lineTo(w / 2 + halfW, cy);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Connector stem: a faint dashed thread from the main mark down to the
// restart cue, fading in with it. Without this the restart affordance is a
// second, unrelated circle sitting below the first; with it, the two are
// visibly one composition — a spine running down the frame — rather than a
// spare shape the player has to notice separately.
// ---------------------------------------------------------------------------
function drawConnectorStem(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  fromY: number,
  toY: number,
  color: string,
  alpha: number
): void {
  if (alpha <= 0 || toY <= fromY) return;
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  const cx = w / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, unit * 0.004);
  ctx.setLineDash([unit * 0.012, unit * 0.014]);
  ctx.beginPath();
  ctx.moveTo(cx, fromY);
  ctx.lineTo(cx, toY);
  ctx.stroke();
  ctx.restore();
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
  const cy = h * 0.62;

  // A button, not a dot. The dot read as decoration and the playtester asked
  // for something that looks pressable. A rounded plate with a circular-arrow
  // glyph says "do this again" in a shape everyone already knows, and does it
  // without a word — which the spec requires, since instructions of any kind
  // are forbidden anywhere in this game.
  const bw = unit * 0.30 * scale;
  const bh = unit * 0.115 * scale;
  const r = bh / 2;
  // A slow breath so it reads as the live element on a still screen.
  const breathe = 1 + Math.sin(phaseFor * 2.4) * 0.022;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(cx, cy);
  ctx.scale(breathe, breathe);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, unit * 0.0055);
  ctx.lineCap = "round";

  // Plate.
  ctx.beginPath();
  ctx.moveTo(-bw / 2 + r, -bh / 2);
  ctx.lineTo(bw / 2 - r, -bh / 2);
  ctx.arcTo(bw / 2, -bh / 2, bw / 2, 0, r);
  ctx.arcTo(bw / 2, bh / 2, bw / 2 - r, bh / 2, r);
  ctx.lineTo(-bw / 2 + r, bh / 2);
  ctx.arcTo(-bw / 2, bh / 2, -bw / 2, 0, r);
  ctx.arcTo(-bw / 2, -bh / 2, -bw / 2 + r, -bh / 2, r);
  ctx.closePath();
  ctx.globalAlpha = opacity * 0.14;
  ctx.fill();
  ctx.globalAlpha = opacity;
  ctx.stroke();

  // Circular-arrow glyph, centred on the plate.
  const gr = bh * 0.28;
  ctx.beginPath();
  ctx.arc(0, 0, gr, Math.PI * 0.32, Math.PI * 1.78);
  ctx.stroke();

  // Arrowhead on the open end of the arc.
  const a = Math.PI * 0.32;
  const hx = Math.cos(a) * gr;
  const hy = Math.sin(a) * gr;
  const s2 = gr * 0.62;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - s2 * 0.15, hy - s2);
  ctx.lineTo(hx + s2 * 0.85, hy - s2 * 0.35);
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
//
// The ring alone used to read as a stray shape adrift in whatever the camera
// was looking at. It is now the centrepiece of a full-frame composition:
// corner brackets claim the screen's own edges, a horizontal band gives the
// ring a "third" of the frame to sit on, and a soft bloom gives it weight
// beyond a hairline. All of it is anchored to viewport fractions, never to
// world content, so it composes the same over a busy scene or empty sky.
// ---------------------------------------------------------------------------
function drawWon(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  // Animate from the moment the impact hold ends, not from the raw phase
  // clock, so the entrance still starts from zero after the hold.
  const t = Math.max(0, state.phaseFor - IMPACT_HOLD);
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

  // Screen ownership: brackets at the frame's own corners, and a band the
  // ring sits on — the composition, not just the ring.
  drawFrameBrackets(ctx, viewport, INK, washP, 0.5 * washP);
  drawAnchorBand(ctx, viewport, cy, washP, INK, 0.14);

  const settleAt = 0.85;
  const growP = easeOutCubic(t / settleAt);
  const breathe = t > settleAt ? Math.sin(((t - settleAt) * Math.PI * 2) / 3.4) : 0;
  const baseRadius = unit * 0.3;
  const radius = Math.max(0, baseRadius * growP * (1 + 0.025 * breathe));
  const ringAlpha = Math.max(0, lerp(0.85, 0.32, growP) + breathe * 0.03);

  // A soft bloom behind the ring gives it weight — a mark with presence,
  // not a bare outline sitting in whatever is behind it.
  if (radius > 0) {
    ctx.save();
    const bloomR = radius * 1.5;
    const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloomR);
    bloom.addColorStop(0, "rgba(26,26,46,0.10)");
    bloom.addColorStop(1, "rgba(26,26,46,0)");
    ctx.globalAlpha = growP;
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

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

  // Tie the restart cue into the same composition with a faint spine
  // running down from the ring, rather than leaving it as a second, spare
  // circle with nothing between it and the first.
  const restart = restartAffordance(t);
  drawConnectorStem(
    ctx,
    viewport,
    cy + baseRadius * 1.05,
    h * 0.76 - unit * 0.08,
    INK,
    restart.opacity * 0.5
  );
  drawRestart(ctx, t, viewport, INK);
}

// ---------------------------------------------------------------------------
// Lost: heavy and final. A dark flood arrives fast (well inside half a
// second) and then holds at full strength — no further growth. A dense,
// spiky mass — the thing that caught the runner — slams down at centre a
// beat later and then sits dead still. Motionlessness is deliberate: the win
// screen breathes, the loss screen does not.
//
// The flood already covers the full frame, so unlike the win screen this was
// never literally "adrift" — but it still needs the same screen-owned
// language: brackets clamping down at the frame's own corners (in paper, so
// they read against the dark), and a band the mass rests on, so the
// composition is legible as a deliberate frame and not just a colour flood
// with a blob in it.
// ---------------------------------------------------------------------------
function drawLost(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  // Animate from the moment the impact hold ends, not from the raw phase
  // clock, so the entrance still starts from zero after the hold.
  const t = Math.max(0, state.phaseFor - IMPACT_HOLD);
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

  // Screen ownership, closing rather than opening: brackets clamp down fast
  // in paper against the dark, same language as the win screen's corners.
  drawFrameBrackets(ctx, viewport, PAPER, floodP, 0.55 * floodP);
  drawAnchorBand(ctx, viewport, cy, floodP, PAPER, 0.1);

  // Deliberately modest. The first version drew the chaser at 2.1x this
  // radius, which filled the frame and read as a portrait of the character
  // rather than as an ending — the playtester's words were "why is it just a
  // massive frame of the character". Standing back, with the dark around it
  // doing the work, it reads as the run being over.
  // No figure. It was asked for as a portrait-free ending: the darkness and
  // the button carry it, and a giant character on the screen only competed
  // with the one thing the player is meant to reach for.
  const massRadius = unit * 0.24;

  const restart = restartAffordance(t);
  drawConnectorStem(
    ctx,
    viewport,
    cy + massRadius * 0.7,
    h * 0.76 - unit * 0.08,
    PAPER,
    restart.opacity * 0.5
  );
  drawRestart(ctx, t, viewport, PAPER);
}

/**
 * Screen-space resolution for the "won" or "lost" phase. A no-op while
 * `state.phase === "running"` — there is nothing to resolve yet. Entirely
 * driven by `state.phaseFor`, so it is deterministic and safe to call every
 * frame; nothing here reads the clock.
 *
 * While `state.phaseFor < IMPACT_HOLD` this issues NO drawing calls
 * whatsoever — not even a `save`/`restore` — so the frozen world (the
 * chaser's catch, or the drop into the gap) stays visible and unobscured
 * for that whole hold. The resolution itself, once it starts, animates from
 * `state.phaseFor - IMPACT_HOLD`, so its own entrance still begins at zero.
 */
export function drawEndScreen(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number }
): void {
  if (state.phaseFor < IMPACT_HOLD) return;

  ctx.save();
  try {
    if (state.phase === "won") drawWon(ctx, state, viewport);
    else if (state.phase === "lost") drawLost(ctx, state, viewport);
  } finally {
    ctx.restore();
  }
}
