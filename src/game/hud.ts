// HUD and resolution screens. Screen-space drawing only (no camera/world
// transform), composed the same way as render.ts: no words, no numerals, no
// letters, anywhere. Every piece of state is read through form, colour,
// motion and position.
//
// This module owns three jobs the playtest flagged as missing or weak:
//
//   1. THE RESERVOIR. The ink meter is the resource, the timer and the
//      tension at once, and it used to be a black pill with a bare circle on
//      the end — a debug widget. It is now a pen: a glass tube of ink feeding
//      a nib, with a marked reserve at the dry end. The tube says "finite"
//      before a single stroke is drawn (it has walls, a graduation, a marked
//      last stretch and a nib the ink has to reach), it reacts when ink is
//      spent (a lagging ghost band of what just went, and a meniscus that
//      wobbles as it is drawn down) and when a pickup lands (a surge of
//      accent, rings off the surface, bubbles rising), and it escalates on
//      its own as the well dries (accent alarm halo, drips leaking away
//      underneath, a nib that goes visibly dry, and finally a tremble).
//
//   2. THE SLOW-MOTION WASH. Three dark screen effects now compete on this
//      frame — the loss flood, the danger vignette creeping in from the left
//      (effects.ts), and whatever else lands later. The wash must never be
//      confused with either, so it obeys one absolute rule: it paints ONLY
//      the palette's bright tone, never a dark one, and it paints it EVENLY
//      with a lit rim, which is the geometric opposite of a vignette. Light,
//      flat, and edge-lit: nothing else on this screen is any of those.
//
//   3. THE RESOLUTION SCREENS. A win and a loss must never read as the same
//      event. They share one element on purpose — a full-width line through
//      the frame — and say opposite things with it: the win closes a ring on
//      an INTACT line; the loss SNAPS that same line in half and drops the
//      ends. Light versus dark, closed versus broken, breathing versus dead
//      still. The restart affordance keeps its existing timing (it grows in
//      about a second after the resolution settles) and now says which way it
//      goes without a word: a forward chevron pair on a win (there is more
//      ahead), a return arc on a loss (go again).
//
// Two playtest-driven fixes still live here: an "impact hold" (IMPACT_HOLD,
// tuning.ts) during which drawEndScreen draws nothing at all, so the player
// sees the catch or the fall before the resolution covers it; and a
// full-frame composition (corner brackets, the band, a connector stem) so the
// resolution reads as a deliberate screen anchored to the viewport, not a
// shape floating in whatever the camera happens to be looking at.
//
// COLOUR. Nothing here hardcodes a colour. Every exported function takes the
// level's Palette as its final argument, because level 3 is inverted — cream
// ink on a near-black world — and every dark flood, bloom and gradient that
// assumed "dark mark on light paper" was wrong there. The four roles below
// are the only place that inversion is reasoned about.

import type { GameState } from "./types";
import type { Palette, Tone } from "./palette";
import { at } from "./palette";
import { IMPACT_HOLD } from "./tuning";

// ---------------------------------------------------------------------------
// Derived colour roles. `paper` is not always light and `ink` is not always
// dark (level 3 inverts), so nothing in this file may ask for "the light one"
// by name. It asks by job:
//
//   glow      the tone used to flood the frame BRIGHTER than it was
//   shroud    the tone used to flood the frame DARKER than it was
//   onShroud  a mark that must stay legible on top of a shroud flood
//
// On the daylight palettes those are paper / ink / paper. On the night
// palette they are ink (cream) / skyTop (near black) / ink (cream): the same
// three jobs, opposite pigments.
// ---------------------------------------------------------------------------
function glowTone(p: Palette): Tone {
  return p.dark ? p.ink : p.paper;
}

function shroudTone(p: Palette): Tone {
  return p.dark ? p.skyTop : p.ink;
}

function onShroudTone(p: Palette): Tone {
  return p.dark ? p.ink : p.paper;
}

/** Flooding a night frame with cream at daylight strength blows the world out
 *  and the player loses the thing they are drawing on. Bright floods are
 *  scaled back on an inverted palette; dark floods are not, because dark on
 *  dark needs all the strength it can get to read as an event. */
function glowAlpha(p: Palette, alpha: number): number {
  return p.dark ? alpha * 0.55 : alpha;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
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
// Ink-bar reactions.
//
// GameState carries a level, not a delta: nothing in it says "you just spent
// 40px of line" or "you just picked up 260". Both of those are the moments
// the bar most needs to react to, so this module remembers the last level it
// drew and derives the rest. It is keyed off state.elapsed (game time, already
// time-dilated) and never off the wall clock, so the bar stays deterministic
// and slows down with the world during a draw — a stroke drawn in slow motion
// leaves its ghost band hanging exactly as long as the slow motion lasts.
//
// A restart winds `elapsed` back to zero; that reads as a fresh well rather
// than as a top-up, so time running backwards resets the memory outright.
// ---------------------------------------------------------------------------
type InkFeedback = {
  /** Last ink level observed, in px of line. */
  ink: number;
  /** Last game time observed, in seconds. */
  elapsed: number;
  /** A lagging fill fraction that trails the real one down: the band between
   *  this and the fill is "what you just spent". */
  trail: number;
  /** 0..1, how hard ink is being drawn out right now. */
  spend: number;
  /** 0..1, decaying from a pickup landing. */
  topUp: number;
};

let feedback: InkFeedback | null = null;

/** Forget the remembered ink level. Only needed when a caller wants the bar
 *  to start clean (a fresh run, or a deterministic test/screenshot); normal
 *  play never has to call it, since a backwards clock resets it anyway. */
export function resetInkBar(): void {
  feedback = null;
}

function updateFeedback(ink: number, maxInk: number, elapsed: number): InkFeedback {
  const frac = clamp01(ink / maxInk);
  const now = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const memory = feedback;
  if (!memory || now < memory.elapsed) {
    const fresh: InkFeedback = { ink, elapsed: now, trail: frac, spend: 0, topUp: 0 };
    feedback = fresh;
    return fresh;
  }

  const dt = Math.min(0.25, Math.max(0, now - memory.elapsed));
  const delta = memory.ink - ink; // positive when ink was spent
  memory.ink = ink;
  memory.elapsed = now;

  if (delta > 0) {
    // Normalised against a chunk of the whole well, so one long stroke reads
    // as one big pull rather than as a hundred imperceptible ones.
    memory.spend = clamp01(memory.spend + delta / Math.max(1, maxInk * 0.05));
  } else if (delta < 0) {
    memory.topUp = 1;
    memory.trail = frac; // nothing is "recently spent" any more
  }

  memory.spend = Math.max(0, memory.spend - dt * 2.2);
  memory.topUp = Math.max(0, memory.topUp - dt * 1.5);
  memory.trail = Math.max(frac, memory.trail - dt * Math.max(0.12, (memory.trail - frac) * 2.4));
  return memory;
}

// ---------------------------------------------------------------------------
// The reservoir.
//
// Screen-space, top-left, sized purely as a fraction of the viewport's shorter
// side so it composes the same way on the 390-wide phone and the 1920-wide
// desktop. It is a pen, drawn as one object: a glass tube of ink, a graduated
// wall, a marked reserve at the dry end, and a nib the ink feeds. Ink drains
// away from the nib, so "running dry" is literal — the supply visibly retreats
// from the thing that needs it, and ends up sitting in the marked reserve.
//
// Everything about it is in the same pigment as the strokes the player draws
// and the pools they collect (palette.ink, palette.accent). That family
// resemblance is the ONLY thing that ever explains "this bar, the lines you
// draw and the pools you collect are the same substance", since the game may
// never say so.
// ---------------------------------------------------------------------------

/** Fraction of the well marked out as the reserve — the hatched last stretch
 *  drawn on the tube from the very first frame, before anything has been
 *  spent. It is what makes the meter read as finite with the tube still full:
 *  there is visibly a place this is heading, and it is marked. The alarm
 *  starts exactly when the surface reaches it, so the mark is a promise the
 *  bar keeps. */
const RESERVE_FRAC = 0.2;

export function drawInkBar(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
  palette: Palette
): void {
  ctx.save();
  try {
    const { width: w, height: h } = viewport;
    const unit = Math.min(w, h);
    const ink = palette.ink;
    const paper = palette.paper;
    const accent = palette.accent;

    const maxInk = state.maxInk > 0 ? state.maxInk : 1;
    const frac = clamp01(state.ink / maxInk);
    const t = Number.isFinite(state.elapsed) ? Math.max(0, state.elapsed) : 0;
    const fb = updateFeedback(state.ink, maxInk, t);

    const margin = unit * 0.05;
    const tubeW = unit * 0.36;
    const tubeH = unit * 0.055;
    const nibW = tubeH * 1.05;
    const tx = margin;
    const ty = margin;
    const r = tubeH / 2;
    const cyBar = ty + tubeH / 2;
    const hair = Math.max(1, unit * 0.0022);

    const low = frac <= RESERVE_FRAC;
    const urgency = low ? clamp01(1 - frac / RESERVE_FRAC) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * (5 + urgency * 8));

    // A tremble, only once it is genuinely desperate. Small enough that it is
    // read rather than noticed, which is the difference between urgency and
    // decoration.
    if (urgency > 0.55) {
      const shake = (urgency - 0.55) / 0.45;
      ctx.translate(Math.sin(t * 27) * unit * 0.0022 * shake, Math.sin(t * 19) * unit * 0.0011 * shake);
    }

    const tubePath = (): void => roundedRectPath(ctx, tx, ty, tubeW, tubeH, r);

    // --- Backing plate ------------------------------------------------------
    // The bar sits over sky, hills, figures and the player's own strokes. A
    // soft plate of the page's own colour holds it off whatever is behind
    // without introducing a colour the game does not otherwise use.
    const pad = tubeH * 0.42;
    ctx.save();
    roundedRectPath(
      ctx,
      tx - pad,
      ty - pad,
      tubeW + nibW + pad * 2,
      tubeH + pad * 2,
      (tubeH + pad * 2) / 2
    );
    ctx.fillStyle = at(paper, 0.5);
    ctx.fill();
    ctx.strokeStyle = at(ink, 0.08);
    ctx.lineWidth = hair;
    ctx.stroke();
    ctx.restore();

    // --- The glass ----------------------------------------------------------
    ctx.save();
    tubePath();
    ctx.fillStyle = at(ink, 0.06);
    ctx.fill();
    ctx.restore();

    const reserveW = tubeW * RESERVE_FRAC;

    // --- What was just spent ------------------------------------------------
    // A ghost band between the real surface and where it was a moment ago.
    // Without it a stroke costs nothing visible until it is over; with it, the
    // cost of the line you are drawing is legible while you are drawing it.
    if (fb.trail > frac + 0.001) {
      ctx.save();
      tubePath();
      ctx.clip();
      ctx.fillStyle = at(ink, 0.2);
      ctx.fillRect(tx + tubeW * frac, ty, tubeW * (fb.trail - frac), tubeH);
      ctx.restore();
    }

    // --- The ink itself -----------------------------------------------------
    const fillW = tubeW * frac;
    if (fillW > 0.5) {
      ctx.save();
      tubePath();
      ctx.clip();

      // A meniscus, not a cut edge: liquid bulges at its surface, and the
      // bulge kicks while ink is being pulled out of the tube.
      const wobble = Math.sin(t * 13) * fb.spend;
      const bulge = Math.min(fillW * 0.45, tubeH * (0.16 + 0.18 * fb.spend) * (1 + 0.4 * wobble));
      ctx.beginPath();
      ctx.moveTo(tx - r, ty);
      ctx.lineTo(tx + fillW - bulge, ty);
      ctx.quadraticCurveTo(tx + fillW + bulge, cyBar, tx + fillW - bulge, ty + tubeH);
      ctx.lineTo(tx - r, ty + tubeH);
      ctx.closePath();
      ctx.fillStyle = at(ink, 0.93);
      ctx.fill();

      // One specular streak along the top of the liquid. This single stroke
      // is most of what separates "a body of ink in a tube" from "a filled
      // rectangle".
      ctx.beginPath();
      const glossW = Math.max(0, fillW - tubeH * 0.55);
      if (glossW > 0) {
        roundedRectPath(
          ctx,
          tx + tubeH * 0.28,
          ty + tubeH * 0.17,
          glossW,
          tubeH * 0.16,
          tubeH * 0.08
        );
        ctx.fillStyle = at(paper, 0.24);
        ctx.fill();
      }

      // Ripples running back from the surface while ink is being drawn out.
      if (fb.spend > 0.02) {
        ctx.strokeStyle = at(paper, 0.18 * fb.spend);
        ctx.lineWidth = Math.max(1, unit * 0.0016);
        for (let i = 1; i <= 2; i++) {
          const rx = tx + fillW - tubeH * (0.5 + i * 0.55) - (t * 40) % (tubeH * 0.5);
          if (rx <= tx) continue;
          ctx.beginPath();
          ctx.moveTo(rx, ty + tubeH * 0.2);
          ctx.quadraticCurveTo(rx + tubeH * 0.16, cyBar, rx, ty + tubeH * 0.8);
          ctx.stroke();
        }
      }

      // Bubbles rising just after a pickup lands: the well is visibly being
      // refilled, not just larger than it was.
      if (fb.topUp > 0.02) {
        ctx.fillStyle = at(paper, 0.4 * fb.topUp);
        for (let i = 0; i < 4; i++) {
          const p = (fb.topUp + i * 0.23) % 1;
          const bx = tx + fillW * (0.35 + 0.15 * i);
          const by = ty + tubeH * (0.92 - 0.75 * (1 - p));
          ctx.beginPath();
          ctx.arc(bx, by, tubeH * 0.07 * (0.6 + p * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // --- The marked reserve -------------------------------------------------
    // Hatched, in the same pigment as the pools that refill it: the last
    // stretch of the well and the thing that fills it are deliberately the
    // same colour, so "get one of those" is the reading when the surface
    // arrives here. Drawn OVER the ink, not under it, because the whole job
    // of this mark is to be visible while the tube is still full — that is
    // the only moment the game has to say "this runs out" before it does.
    ctx.save();
    tubePath();
    ctx.clip();
    ctx.fillStyle = at(accent, 0.12 + 0.28 * urgency * pulse);
    ctx.fillRect(tx, ty, reserveW, tubeH);
    ctx.strokeStyle = at(accent, 0.38 + 0.45 * urgency * pulse);
    ctx.lineWidth = Math.max(1, unit * 0.0022);
    const step = tubeH * 0.45;
    for (let hx = tx - tubeH; hx < tx + reserveW; hx += step) {
      ctx.beginPath();
      ctx.moveTo(hx, ty + tubeH);
      ctx.lineTo(hx + tubeH, ty);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(tx + reserveW, ty);
    ctx.lineTo(tx + reserveW, ty + tubeH);
    ctx.strokeStyle = at(accent, 0.7);
    ctx.lineWidth = Math.max(1, unit * 0.003);
    ctx.stroke();
    ctx.restore();

    // --- Graduation and glass wall -----------------------------------------
    // Three notches on the wall. Not numerals and not a scale to be read —
    // just enough regular marking that the tube reads as a measure of
    // something with an end, which is the whole job while it is still full.
    ctx.save();
    ctx.strokeStyle = at(ink, 0.22);
    ctx.lineWidth = Math.max(1, unit * 0.0018);
    for (let i = 1; i <= 3; i++) {
      const gx = tx + tubeW * (i / 4);
      ctx.beginPath();
      ctx.moveTo(gx, ty);
      ctx.lineTo(gx, ty + tubeH * 0.26);
      ctx.moveTo(gx, ty + tubeH);
      ctx.lineTo(gx, ty + tubeH * 0.74);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    tubePath();
    ctx.strokeStyle = low ? at(accent, 0.45 + 0.45 * urgency * pulse) : at(ink, 0.5);
    ctx.lineWidth = Math.max(1, unit * (0.0028 + 0.004 * urgency * pulse));
    ctx.stroke();
    ctx.restore();

    // --- The nib ------------------------------------------------------------
    // Charged and glossy while the ink still reaches it; a bare outline once
    // the supply has retreated. A dry pen is a thing everyone has held.
    const nx = tx + tubeW;
    const wet = clamp01((frac - 0.06) / 0.5);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(nx, ty + tubeH * 0.06);
    ctx.lineTo(nx + nibW, cyBar);
    ctx.lineTo(nx, ty + tubeH * 0.94);
    ctx.closePath();
    ctx.fillStyle = at(ink, 0.12 + 0.8 * wet);
    ctx.fill();
    ctx.strokeStyle = at(ink, 0.55);
    ctx.lineWidth = Math.max(1, unit * 0.0026);
    ctx.lineJoin = "round";
    ctx.stroke();

    // Slit and vent hole, in the page's colour, so the nib reads as a nib
    // rather than as an arrow.
    ctx.strokeStyle = at(paper, 0.25 + 0.6 * wet);
    ctx.lineWidth = Math.max(1, unit * 0.0022);
    ctx.beginPath();
    ctx.moveTo(nx + nibW * 0.18, cyBar);
    ctx.lineTo(nx + nibW * 0.9, cyBar);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(nx + nibW * 0.2, cyBar, tubeH * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = at(paper, 0.2 + 0.6 * wet);
    ctx.fill();

    // A bead of wet ink hanging at the tip while the pen is properly charged.
    if (wet > 0.35) {
      ctx.globalAlpha = (wet - 0.35) / 0.65;
      ctx.fillStyle = at(ink, 0.85);
      ctx.beginPath();
      ctx.arc(nx + nibW * 1.02, cyBar, tubeH * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // --- Running dry --------------------------------------------------------
    if (low) {
      // An alarm in the pickup's own colour, breathing faster as the well
      // empties: a bloom the whole pen sits inside, and two rings hugging it.
      // Colour does the shouting; the pigment says where the answer is. The
      // rings are held inside the HUD's own margin on purpose — an alarm that
      // runs off the edge of the frame reads as a rendering fault, which is
      // the one thing worse than a quiet warning.
      ctx.save();
      const bloomR = (tubeW + nibW) * 0.75;
      const bloom = ctx.createRadialGradient(
        tx + (tubeW + nibW) / 2,
        cyBar,
        tubeH * 0.4,
        tx + (tubeW + nibW) / 2,
        cyBar,
        bloomR
      );
      bloom.addColorStop(0, at(accent, (0.06 + 0.16 * urgency) * (0.35 + 0.65 * pulse)));
      bloom.addColorStop(1, at(accent, 0));
      ctx.fillStyle = bloom;
      ctx.fillRect(tx - bloomR, cyBar - bloomR, bloomR * 2 + tubeW + nibW, bloomR * 2);

      const room = Math.max(0, margin - pad) * (0.35 + 0.65 * urgency);
      for (let i = 0; i < 2; i++) {
        const grow = room * (0.45 + 0.55 * pulse) * (0.45 + 0.55 * i);
        ctx.globalAlpha = (0.4 + 0.45 * urgency) * (1 - i * 0.45) * (0.35 + 0.65 * pulse);
        ctx.strokeStyle = accent.css;
        ctx.lineWidth = Math.max(1, unit * (0.003 + 0.004 * urgency));
        roundedRectPath(
          ctx,
          tx - pad - grow,
          ty - pad - grow,
          tubeW + nibW + (pad + grow) * 2,
          tubeH + (pad + grow) * 2,
          (tubeH + (pad + grow) * 2) / 2
        );
        ctx.stroke();
      }
      ctx.restore();

      // Ink actually leaving: drips falling away underneath, so running dry
      // is an active loss rather than a number going down.
      for (let i = 0; i < 3; i++) {
        const period = 0.9 + i * 0.31;
        const phase = ((t + i * 0.43) % period) / period;
        const dripAlpha = (1 - phase) * (0.35 + 0.6 * urgency);
        if (dripAlpha <= 0.01) continue;
        const dripX = tx + tubeH * (0.5 + i * 0.75) + fillW * 0.35;
        const dripY = ty + tubeH + pad * 0.5 + phase * tubeH * 3;
        const dripR = tubeH * 0.24 * (1 - phase * 0.45);
        ctx.save();
        ctx.globalAlpha = dripAlpha;
        ctx.fillStyle = ink.css;
        ctx.beginPath();
        ctx.moveTo(dripX, dripY - dripR * 1.8);
        ctx.quadraticCurveTo(dripX + dripR, dripY, dripX, dripY + dripR);
        ctx.quadraticCurveTo(dripX - dripR, dripY, dripX, dripY - dripR * 1.8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // --- A pickup landing ---------------------------------------------------
    // Rings off the surface in the pickup's colour, so the pool that vanished
    // in the world and the well that just grew are visibly one event.
    if (fb.topUp > 0.02) {
      ctx.save();
      const ex = tx + tubeW * frac;
      for (let i = 0; i < 3; i++) {
        const p = clamp01(1 - fb.topUp + i * 0.18);
        if (p >= 1) continue;
        ctx.globalAlpha = (1 - p) * 0.75;
        ctx.strokeStyle = accent.css;
        ctx.lineWidth = Math.max(1, unit * 0.0032 * (1 - p));
        ctx.beginPath();
        ctx.arc(ex, cyBar, tubeH * (0.35 + p * 1.9), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = fb.topUp * 0.28;
      ctx.fillStyle = accent.css;
      ctx.beginPath();
      ctx.arc(ex, cyBar, tubeH * 0.22 * fb.topUp, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Slow-motion wash.
//
// The hard constraint, and the reason this function is so plain: there are now
// THREE full-frame effects in this game, and two of them are dark — the loss
// flood (dark, radial, centred, total) and the danger vignette (dark, creeping
// in from the LEFT as the chaser closes, effects.ts). If this one shaded even
// slightly dark it would read as "something bad is happening" at exactly the
// moment the player has done the one thing the game wants.
//
// So it is defined by opposition, on every axis at once:
//   * VALUE — it only ever paints the palette's bright tone. Not one dark
//     pixel is laid down here, at any alpha, ever. That single rule is what
//     keeps it out of the other two effects' territory no matter how they
//     evolve.
//   * GEOMETRY — it is flat and even, and then lit BRIGHTEST AT THE RIM. A
//     vignette darkens the edges and a flood is radial from the middle; an
//     inverse vignette is neither, and the left edge in particular lifts
//     rather than closing in.
//   * TEXTURE — a few wide concentric rings in the bright tone, so pressing
//     down reads as "the whole frame just did something", not as a filter
//     quietly sitting there. The tester could not tell the old wash had
//     happened until they had already drawn.
// ---------------------------------------------------------------------------
export function drawSlowmoWash(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  palette: Palette
): void {
  ctx.save();
  try {
    const { width: w, height: h } = viewport;
    const glow = glowTone(palette);
    const cx = w / 2;
    const cy = h / 2;
    const outer = Math.max(w, h) * 0.78;

    // Even bleach across the whole frame.
    ctx.save();
    ctx.fillStyle = at(glow, glowAlpha(palette, 0.6));
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Inverse vignette: the rim lifts. This is the axis that keeps it clear
    // of a vignette creeping in from the left — where that one darkens, this
    // one is at its brightest.
    ctx.save();
    const rim = ctx.createRadialGradient(cx, cy, outer * 0.25, cx, cy, outer);
    rim.addColorStop(0, at(glow, 0));
    rim.addColorStop(1, at(glow, glowAlpha(palette, 0.55)));
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Wide rings in the same bright tone: the moment has a shape, and the
    // shape is still made of light.
    ctx.save();
    ctx.strokeStyle = at(glow, glowAlpha(palette, 0.3));
    ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.012);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, outer * (i / 4.2), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Restart affordance. A pressable plate, not a word: it is deliberately absent
// until the resolution has settled (roughly a second in) so it never steps on
// the win/lose moment itself, then grows in and keeps breathing. Exported so
// its timing can be verified directly without rendering anything.
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
// Shared geometry for both resolutions, so the two screens are demonstrably
// the same composition saying opposite things: same mark centre, same band,
// same button position, same corner brackets. Everything that differs between
// them differs on purpose.
// ---------------------------------------------------------------------------
function endLayout(viewport: { width: number; height: number }): {
  unit: number;
  cx: number;
  markY: number;
  markR: number;
  buttonY: number;
  buttonW: number;
  buttonH: number;
} {
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  // Capped against BOTH dimensions: keyed to `unit` alone the mark grew to
  // half the height of a desktop frame and swallowed the button that was
  // supposed to sit under it.
  const markR = Math.min(unit * 0.24, h * 0.18);
  return {
    unit,
    cx: w / 2,
    markY: h * 0.38,
    markR,
    buttonY: h * 0.68,
    buttonW: Math.min(unit * 0.3, w * 0.5),
    buttonH: Math.min(unit * 0.115, h * 0.1),
  };
}

// ---------------------------------------------------------------------------
// Frame brackets: four L-shaped marks anchored to the viewport's own corners,
// never to anything in the world. This is the difference between a shape
// floating in whatever the camera happens to be looking at and a SCREEN: the
// brackets exist purely in screen space, at fixed margins from the real edges,
// so they read as a deliberate frame over a busy scene exactly as much as over
// empty sky — they never touch or depend on either.
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
// The band. One element, two meanings — this is the pivot the whole win/lose
// distinction turns on.
//
// A full-width line through the mark's own centre, growing outward from the
// middle. On a win it is INTACT: one unbroken line, the ring closed on top of
// it. On a loss the SAME line is snapped at the middle, its ends dropped and
// tilted away from each other, with flecks thrown off the break. At a glance,
// from across a room, at either viewport: closed ring on a whole line, or a
// broken line with a hole in the middle. They cannot be confused, and they are
// visibly the same screen with one thing changed — which is what makes the
// difference legible rather than just different.
// ---------------------------------------------------------------------------
function drawBand(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  y: number,
  growth: number,
  tone: Tone,
  broken: boolean
): void {
  const g = easeOutCubic(growth);
  if (g <= 0) return;
  const { width: w, height: h } = viewport;
  const unit = Math.min(w, h);
  const cx = w / 2;
  const halfW = (w / 2) * g;

  ctx.save();
  ctx.lineCap = "round";

  if (!broken) {
    // Intact: a single hairline that fades out toward both edges, so it reads
    // as a line the frame is resting on rather than as a border.
    const grad = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
    grad.addColorStop(0, at(tone, 0));
    grad.addColorStop(0.5, at(tone, 0.5));
    grad.addColorStop(1, at(tone, 0));
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1.5, unit * 0.007);
    ctx.beginPath();
    ctx.moveTo(cx - halfW, y);
    ctx.lineTo(cx + halfW, y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Broken: heavy, and it went wrong in the middle. The gap opens fast and
  // then holds — the loss screen does not move once it has landed.
  const gap = unit * 0.09 * g;
  const drop = unit * 0.05 * g;
  ctx.strokeStyle = at(tone, 0.85);
  ctx.lineWidth = Math.max(2, unit * 0.014);

  ctx.beginPath();
  ctx.moveTo(cx - halfW, y - drop * 0.15);
  ctx.lineTo(cx - gap, y + drop);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx + gap, y + drop * 0.8);
  ctx.lineTo(cx + halfW, y - drop * 0.25);
  ctx.stroke();

  // Flecks thrown out of the break, settled where they landed. Kept close to
  // the gap: scattered wide they read as stars, which is the wrong feeling
  // entirely.
  ctx.fillStyle = at(tone, 0.7);
  const flecks: Array<[number, number, number]> = [
    [-0.55, -0.5, 0.16],
    [0.6, -0.62, 0.12],
    [-0.2, 0.6, 0.1],
    [0.3, 0.9, 0.14],
    [-0.85, 0.25, 0.09],
    [0.95, 0.4, 0.11],
  ];
  for (const [fx, fy, fr] of flecks) {
    ctx.beginPath();
    ctx.arc(cx + fx * gap, y + drop + fy * unit * 0.035, unit * 0.055 * fr * g, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Connector stem: a faint dashed thread from the main mark down to the restart
// cue, fading in with it. Without this the restart affordance is a second,
// unrelated shape sitting below the first; with it, the two are visibly one
// composition — a spine running down the frame.
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

/** Which way the run goes from here. A win offers the next level, a loss
 *  offers this one again; the plate is identical and the glyph is not, so the
 *  two are the same invitation pointing different ways — forward, or round
 *  again. No word says which, because no word is allowed to. */
type RestartKind = "advance" | "retry";

function drawRestart(
  ctx: CanvasRenderingContext2D,
  phaseFor: number,
  viewport: { width: number; height: number },
  color: string,
  kind: RestartKind
): void {
  const { opacity, scale } = restartAffordance(phaseFor);
  if (opacity <= 0 || scale <= 0) return;

  const layout = endLayout(viewport);
  const unit = layout.unit;
  const bw = layout.buttonW * scale;
  const bh = layout.buttonH * scale;
  const r = bh / 2;
  // A slow breath so it reads as the live element on a still screen.
  const breathe = 1 + Math.sin(phaseFor * 2.4) * 0.022;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(layout.cx, layout.buttonY);
  ctx.scale(breathe, breathe);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, unit * 0.006);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Plate. Filled, so it reads as a surface to press rather than as an
  // outlined diagram, with a brighter rim to give it an edge.
  ctx.beginPath();
  ctx.moveTo(-bw / 2 + r, -bh / 2);
  ctx.lineTo(bw / 2 - r, -bh / 2);
  ctx.arcTo(bw / 2, -bh / 2, bw / 2, 0, r);
  ctx.arcTo(bw / 2, bh / 2, bw / 2 - r, bh / 2, r);
  ctx.lineTo(-bw / 2 + r, bh / 2);
  ctx.arcTo(-bw / 2, bh / 2, -bw / 2, 0, r);
  ctx.arcTo(-bw / 2, -bh / 2, -bw / 2 + r, -bh / 2, r);
  ctx.closePath();
  ctx.globalAlpha = opacity * 0.26;
  ctx.fill();
  ctx.globalAlpha = opacity;
  ctx.stroke();

  const gr = bh * 0.3;
  if (kind === "advance") {
    // Two chevrons pointing the way the runner runs. Forward is the only
    // direction this game has, so forward is the only thing this has to mean.
    ctx.lineWidth = Math.max(2, unit * 0.008);
    for (let i = 0; i < 2; i++) {
      const ox = (i - 0.5) * gr * 1.25;
      ctx.beginPath();
      ctx.moveTo(ox - gr * 0.4, -gr * 0.72);
      ctx.lineTo(ox + gr * 0.5, 0);
      ctx.lineTo(ox - gr * 0.4, gr * 0.72);
      ctx.stroke();
    }
  } else {
    // A closed loop back to the start: the same run, again.
    ctx.lineWidth = Math.max(2, unit * 0.007);
    ctx.beginPath();
    ctx.arc(0, 0, gr, Math.PI * 0.42, Math.PI * 1.72);
    ctx.stroke();

    const a = Math.PI * 0.42;
    const hx = Math.cos(a) * gr;
    const hy = Math.sin(a) * gr;
    const s2 = gr * 0.6;
    ctx.beginPath();
    ctx.moveTo(hx + s2 * 0.35, hy + s2 * 0.15);
    ctx.lineTo(hx - s2 * 0.55, hy - s2 * 0.25);
    ctx.lineTo(hx + s2 * 0.1, hy - s2 * 0.8);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Won: earned and calm, and made of light. The frame warms, corner brackets
// open out, the band lies across the frame unbroken, and a ring is BRUSHED
// closed on top of it — drawn round as a stroke with a real brush's pressure,
// thin where it starts, heavy through the belly, thin where it closes. Then it
// stops and simply breathes.
//
// It is a ring because a ring is closed. The whole loss screen is the same
// composition with that line snapped, so the two readings are "whole" and
// "broken" rather than "some shape" and "some other shape".
// ---------------------------------------------------------------------------
function drawWon(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
  palette: Palette
): void {
  const { width: w, height: h } = viewport;
  const { unit, cx, markY, markR, buttonY, buttonH } = endLayout(viewport);
  // Animate from the moment the impact hold ends, not from the raw phase
  // clock, so the entrance still starts from zero after the hold.
  const t = Math.max(0, state.phaseFor - IMPACT_HOLD);
  const ink = palette.ink;
  const glow = glowTone(palette);

  // Ambient warmth: ramps in, then holds — the frame is a little brighter for
  // the rest of the resolution, calmly, with no further motion.
  const washP = easeOutCubic(t / 0.4);
  ctx.save();
  ctx.fillStyle = at(glow, glowAlpha(palette, 0.2) * washP);
  ctx.fillRect(0, 0, w, h);
  // Light arriving AT the mark, not just a flat lift. On the night palette
  // this is most of what separates a win from a loss at a glance: both frames
  // are dark, but one of them has light gathering in the middle of it.
  const lift = ctx.createRadialGradient(cx, markY, 0, cx, markY, Math.max(w, h) * 0.55);
  lift.addColorStop(0, at(glow, glowAlpha(palette, 0.34) * washP));
  lift.addColorStop(1, at(glow, 0));
  ctx.fillStyle = lift;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  drawFrameBrackets(ctx, viewport, ink.css, washP, 0.45 * washP);
  drawBand(ctx, viewport, markY, washP, ink, false);

  const settleAt = 0.85;
  const growP = easeOutCubic(t / settleAt);
  const breathe = t > settleAt ? Math.sin(((t - settleAt) * Math.PI * 2) / 3.4) : 0;
  const radius = Math.max(0, markR * (0.35 + 0.65 * growP) * (1 + 0.02 * breathe));

  // A soft bloom behind the ring gives it weight — a mark with presence, not a
  // bare outline sitting in whatever is behind it. In the palette's own ink,
  // so it deepens on paper and lifts on the night level instead of smearing a
  // hardcoded navy over a black sky.
  if (radius > 0) {
    ctx.save();
    const bloomR = radius * 1.6;
    const bloom = ctx.createRadialGradient(cx, markY, 0, cx, markY, bloomR);
    bloom.addColorStop(0, at(ink, 0.12));
    bloom.addColorStop(1, at(ink, 0));
    ctx.globalAlpha = growP;
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(cx, markY, bloomR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The brushed ring, swept round as the stroke is laid down. It is filled as
  // a ribbon between an outer and an inner edge rather than stroked as an
  // arc, because a stroked arc cannot vary its own width: stroking it in
  // segments to fake that left a beaded, scalloped edge that looked like a
  // rendering artefact rather than like a brush. One closed path, two radii,
  // and the pressure curve between them.
  if (radius > 0) {
    const swept = Math.PI * 2 * easeOutCubic(t / 0.7);
    const start = -Math.PI * 0.62;
    const steps = 96;
    const heavy = unit * 0.026;
    // Pressure: touch down light, press through the belly, lift off light.
    const press = (p: number): number => 0.22 + 0.78 * Math.sin(Math.PI * Math.pow(p, 0.8));
    ctx.save();
    ctx.fillStyle = at(ink, 0.88);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      const a = start + swept * p;
      const rr = radius + (heavy * press(p)) / 2;
      const x = cx + Math.cos(a) * rr;
      const y = markY + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i--) {
      const p = i / steps;
      const a = start + swept * p;
      const rr = Math.max(1, radius - (heavy * press(p)) / 2);
      ctx.lineTo(cx + Math.cos(a) * rr, markY + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // The centre holds a single drop from the first instant, so even frame one
  // reads as "something calm is here" rather than as nothing.
  ctx.save();
  ctx.globalAlpha = 0.9 * easeOutCubic(t / 0.25);
  ctx.fillStyle = ink.css;
  ctx.beginPath();
  ctx.arc(cx, markY, unit * 0.013, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const restart = restartAffordance(t);
  drawConnectorStem(
    ctx,
    viewport,
    markY + markR * 1.15,
    buttonY - buttonH * 0.62,
    ink.css,
    restart.opacity * 0.45
  );
  drawRestart(ctx, t, viewport, ink.css, "advance");
}

// ---------------------------------------------------------------------------
// Lost: heavy, dark and final. The flood arrives fast and then holds at full
// strength; the band SNAPS in the middle and the ends drop; and then nothing
// moves again except the button. Motionlessness is deliberate — the win screen
// breathes, the loss screen does not.
//
// The flood is the palette's shroud, not a hardcoded navy: on the night level
// a navy flood over a navy world was very nearly invisible, so there the
// shroud is the sky's own near-black and the marks on top of it are cream. The
// signal — "the frame just went dark and something broke" — survives the
// inversion, which is the entire point of routing it through the palette.
// ---------------------------------------------------------------------------
function drawLost(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
  palette: Palette
): void {
  const { width: w, height: h } = viewport;
  const { cx, markY, markR, buttonY, buttonH } = endLayout(viewport);
  // Animate from the moment the impact hold ends, not from the raw phase
  // clock, so the entrance still starts from zero after the hold.
  const t = Math.max(0, state.phaseFor - IMPACT_HOLD);
  const shroud = shroudTone(palette);
  const mark = onShroudTone(palette);

  const floodP = easeOutCubic(t / 0.28);
  ctx.save();
  const grad = ctx.createRadialGradient(
    cx,
    markY,
    Math.min(w, h) * 0.02,
    cx,
    markY,
    Math.max(w, h) * 0.75
  );
  grad.addColorStop(0, at(shroud, 0.55 * floodP));
  grad.addColorStop(1, at(shroud, 0.97 * floodP));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // Screen ownership, closing rather than opening: brackets clamp down fast,
  // in the tone that survives the flood.
  drawFrameBrackets(ctx, viewport, mark.css, floodP, 0.5 * floodP);

  // The break. Fast in — well inside a third of a second — and then dead
  // still for as long as the screen is up.
  drawBand(ctx, viewport, markY, easeOutCubic(t / 0.22), mark, true);

  const restart = restartAffordance(t);
  drawConnectorStem(
    ctx,
    viewport,
    markY + markR * 0.55,
    buttonY - buttonH * 0.62,
    mark.css,
    restart.opacity * 0.45
  );
  drawRestart(ctx, t, viewport, mark.css, "retry");
}

/**
 * Screen-space resolution for the "won" or "lost" phase. A no-op while
 * `state.phase === "running"` — there is nothing to resolve yet. Entirely
 * driven by `state.phaseFor`, so it is deterministic and safe to call every
 * frame; nothing here reads the clock.
 *
 * While `state.phaseFor < IMPACT_HOLD` this issues NO drawing calls
 * whatsoever — not even a `save`/`restore` — so the frozen world (the
 * chaser's catch, or the drop into the gap) stays visible and unobscured for
 * that whole hold. The resolution itself, once it starts, animates from
 * `state.phaseFor - IMPACT_HOLD`, so its own entrance still begins at zero.
 */
export function drawEndScreen(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
  palette: Palette
): void {
  if (state.phaseFor < IMPACT_HOLD) return;

  ctx.save();
  try {
    if (state.phase === "won") drawWon(ctx, state, viewport, palette);
    else if (state.phase === "lost") drawLost(ctx, state, viewport, palette);
  } finally {
    ctx.restore();
  }
}
