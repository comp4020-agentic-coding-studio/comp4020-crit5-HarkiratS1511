// Scenery: everything that dresses the world without being gameplay.
//
// Vector-inspired brief: silhouette foreground against a deep, layered,
// atmospheric background. Kept strictly monochrome-ish (paper/ink only) per
// the ink-on-paper premise — depth and level identity come from VALUE
// (alpha over the ink colour) and SHAPE, never hue.
//
// No text, no numerals, anywhere in this module.
//
// Determinism note: every background shape is a pure function of world
// position (and levelIndex), never of frame count or Math.random(). That is
// what stops the parallax layers shimmering as the camera moves — the same
// world x always produces the same silhouette.

import type { Level, Stroke, Vec2 } from "./types";
import { GROUND_SCREEN_FRACTION, PICKUP_RADIUS } from "./tuning";

const PAPER = "#f4f1e8";
const INK = "#1a1a2e";
const INK_RGB = "26,26,46";

function inkAlpha(a: number): string {
  const clamped = Math.max(0, Math.min(1, a));
  return `rgba(${INK_RGB},${clamped})`;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random in [0,1), seeded from a plain number. Used
// everywhere shapes need to look organically varied without ever re-rolling
// per frame — same seed always gives the same value.
// ---------------------------------------------------------------------------
function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Level identity: a small fixed set of background "moods". Each varies the
// sky gradient's depth (value, not hue) and the silhouette family of the
// nearer parallax layer, so arriving at a new level is visible at a glance.
// The selector is total — any integer, including negatives, maps onto one
// of these — and wraps once the campaign runs past the defined set.
// ---------------------------------------------------------------------------
type SkylineShape = "hills" | "skyline" | "peaks" | "spires";

type Palette = {
  topAlpha: number;
  horizonAlpha: number;
  farAlpha: number;
  nearAlpha: number;
  shape: SkylineShape;
};

const PALETTES: Palette[] = [
  // 0: pale open countryside — soft, low-contrast, rolling.
  { topAlpha: 0.04, horizonAlpha: 0.16, farAlpha: 0.22, nearAlpha: 0.5, shape: "hills" },
  // 1: a city's rooftops against a heavier sky.
  { topAlpha: 0.09, horizonAlpha: 0.26, farAlpha: 0.3, nearAlpha: 0.68, shape: "skyline" },
  // 2: jagged high country, sharper contrast.
  { topAlpha: 0.16, horizonAlpha: 0.36, farAlpha: 0.4, nearAlpha: 0.8, shape: "peaks" },
  // 3: sparse industrial spires under a near-dusk wash — the deepest value.
  { topAlpha: 0.07, horizonAlpha: 0.48, farAlpha: 0.48, nearAlpha: 0.92, shape: "spires" },
];

/** Total: every integer, including negatives and anything past the defined
 *  set, maps onto a valid palette index by wrapping. Exported so the level
 *  identity guarantee ("support at least 4 variants and wrap beyond that")
 *  is independently testable. */
export function skyVariantIndex(levelIndex: number): number {
  const n = PALETTES.length;
  const i = Number.isFinite(levelIndex) ? Math.trunc(levelIndex) : 0;
  return ((i % n) + n) % n;
}

function paletteFor(levelIndex: number): Palette {
  return PALETTES[skyVariantIndex(levelIndex)];
}

// ---------------------------------------------------------------------------
// Sky: screen-space vertical gradient (the wash) plus two parallax layers.
// Far layer is a single smooth, continuous rolling silhouette shared by every
// variant (distance flattens detail); the near layer carries the variant's
// distinct character (rooftops, peaks, spires, dense hills) and scrolls
// faster, which is what actually reads as depth.
// ---------------------------------------------------------------------------
export function drawSky(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  camera: number,
  scale: number,
  levelIndex: number
): void {
  const w = Math.max(0, viewport.width);
  const h = Math.max(0, viewport.height);
  const safeCamera = Number.isFinite(camera) ? camera : 0;
  const safeScale = scale > 1e-6 ? scale : 1e-6;
  const palette = paletteFor(levelIndex);
  const horizonY = h * GROUND_SCREEN_FRACTION;

  ctx.save();

  // Paper base — drawSky owns the full background, top to bottom.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);

  if (w > 0 && h > 0) {
    // Vertical wash: pale near the top, deepening toward the horizon band.
    const washBottom = Math.min(h, horizonY + h * 0.12);
    const grad = ctx.createLinearGradient(0, 0, 0, Math.max(1, washBottom));
    grad.addColorStop(0, inkAlpha(palette.topAlpha * 0.4));
    grad.addColorStop(0.6, inkAlpha(palette.topAlpha));
    grad.addColorStop(1, inkAlpha(palette.horizonAlpha));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, washBottom);

    drawFarHills(ctx, w, horizonY, safeCamera, safeScale, levelIndex, palette.farAlpha);
    drawNearSilhouette(ctx, w, horizonY, safeCamera, safeScale, levelIndex, palette.nearAlpha, palette.shape);
  }

  ctx.restore();
}

/** Distant, low-parallax rolling silhouette. A continuous sum-of-sines curve
 *  rather than tiles, so it stays smooth at any scale with no seams — reads
 *  as "far away" precisely because it has no crisp detail. */
function drawFarHills(
  ctx: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  camera: number,
  scale: number,
  levelIndex: number,
  alpha: number
): void {
  const parallax = 0.12;
  const worldCamera = camera * parallax;
  const amp = Math.max(4, baseY * 0.22);

  const seedA = hash(levelIndex * 3.1 + 1) * Math.PI * 2;
  const seedB = hash(levelIndex * 5.7 + 2) * Math.PI * 2;
  const seedC = hash(levelIndex * 9.3 + 3) * Math.PI * 2;
  const f1 = 0.0021, f2 = 0.0053, f3 = 0.011;

  ctx.beginPath();
  ctx.moveTo(0, baseY + 6);
  const steps = 40;
  for (let s = 0; s <= steps; s++) {
    const sx = (s / steps) * w;
    const wx = sx / scale + worldCamera;
    const combined =
      0.55 * Math.sin(wx * f1 + seedA) +
      0.3 * Math.sin(wx * f2 + seedB) +
      0.15 * Math.sin(wx * f3 + seedC);
    const y = baseY - amp * ((combined + 1) * 0.5);
    ctx.lineTo(sx, y);
  }
  ctx.lineTo(w, baseY + 6);
  ctx.closePath();
  ctx.fillStyle = inkAlpha(alpha);
  ctx.fill();
}

/** Nearer, faster-scrolling silhouette. Tiled deterministically from world
 *  x so the shapes are stable frame to frame; the shape family is what
 *  gives each level its distinct character. */
function drawNearSilhouette(
  ctx: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  camera: number,
  scale: number,
  levelIndex: number,
  alpha: number,
  shape: SkylineShape
): void {
  const parallax = 0.32;
  const tileWorld = shape === "spires" ? 130 : shape === "skyline" ? 150 : shape === "peaks" ? 175 : 210;
  const worldCamera = camera * parallax;
  const viewWorldWidth = w / scale;

  let startI = Math.floor((worldCamera - tileWorld) / tileWorld);
  let endI = Math.ceil((worldCamera + viewWorldWidth + tileWorld) / tileWorld);
  const MAX_TILES = 240;
  if (endI - startI > MAX_TILES) endI = startI + MAX_TILES;
  if (!Number.isFinite(startI) || !Number.isFinite(endI)) return;

  ctx.fillStyle = inkAlpha(alpha);

  for (let i = startI; i <= endI; i++) {
    const screenX = (i * tileWorld - worldCamera) * scale;
    const tileW = tileWorld * scale;
    if (tileW <= 0) continue;
    const seed = i * 7.13 + levelIndex * 31.7;
    const r1 = hash(seed);
    const r2 = hash(seed + 0.37);

    switch (shape) {
      case "skyline": {
        const bh = baseY * (0.12 + r1 * 0.34);
        const bw = tileW * (0.55 + r2 * 0.35);
        const bx = screenX + (tileW - bw) * 0.5;
        ctx.fillRect(bx, baseY - bh, bw, bh + 8);
        if (r2 > 0.7) {
          ctx.fillRect(bx + bw * 0.4, baseY - bh - baseY * 0.08, Math.max(1, tileW * 0.03), baseY * 0.08);
        }
        break;
      }
      case "peaks": {
        const ph = baseY * (0.18 + r1 * 0.42);
        ctx.beginPath();
        ctx.moveTo(screenX, baseY + 6);
        ctx.lineTo(screenX + tileW * 0.5, baseY - ph);
        ctx.lineTo(screenX + tileW, baseY + 6);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "spires": {
        const bh = baseY * (0.25 + r1 * 0.5);
        const bw = Math.max(2, tileW * 0.12);
        const bx = screenX + tileW * (0.3 + r2 * 0.4);
        ctx.fillRect(bx, baseY - bh, bw, bh + 8);
        if (r2 > 0.5) {
          ctx.fillRect(bx + bw * 0.5 - 0.5, baseY - bh - baseY * 0.15, 1, baseY * 0.15);
        }
        break;
      }
      case "hills":
      default: {
        const bh = baseY * (0.1 + r1 * 0.22);
        const bw = tileW * 1.15;
        const cx = screenX + tileW * 0.5;
        ctx.beginPath();
        ctx.ellipse(cx, baseY, bw * 0.5, bh, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Ground: a filled ink mass, not a hairline. Every segment is filled from its
// top edge down through a generous depth so it reads as substance underfoot;
// a gap between segments is therefore an unmistakable hole in that mass, not
// just a missing line. Exposed ends (every gap lip) get an emphasised
// vertical cut, visible well before the runner reaches it.
// ---------------------------------------------------------------------------
const GROUND_FILL_DEPTH = 1200;

export function drawGround(ctx: CanvasRenderingContext2D, level: Level, scale: number): void {
  const safeScale = scale > 1e-6 ? scale : 1e-6;

  ctx.save();
  ctx.fillStyle = INK;

  for (const seg of level.groundSegments) {
    ctx.beginPath();
    ctx.moveTo(seg.a.x, seg.a.y);
    ctx.lineTo(seg.b.x, seg.b.y);
    ctx.lineTo(seg.b.x, seg.b.y + GROUND_FILL_DEPTH);
    ctx.lineTo(seg.a.x, seg.a.y + GROUND_FILL_DEPTH);
    ctx.closePath();
    ctx.fill();
  }

  // Defined top edge: a confident stroke along the surface itself.
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4 / safeScale;
  for (const seg of level.groundSegments) {
    ctx.beginPath();
    ctx.moveTo(seg.a.x, seg.a.y);
    ctx.lineTo(seg.b.x, seg.b.y);
    ctx.stroke();
  }

  // A faint paper-toned crust line just under the surface gives the mass a
  // sense of thickness rather than a single flat tone.
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 1.5 / safeScale;
  for (const seg of level.groundSegments) {
    const dy = 7 / safeScale;
    ctx.beginPath();
    ctx.moveTo(seg.a.x, seg.a.y + dy);
    ctx.lineTo(seg.b.x, seg.b.y + dy);
    ctx.stroke();
  }
  ctx.restore();

  // Gap-edge emphasis: every exposed end of the ink mass gets a bold vertical
  // cut, so a hole reads as a deliberate break, not a rendering glitch.
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineWidth = 6 / safeScale;
  const tickLen = 22 / safeScale;
  for (const seg of level.groundSegments) {
    for (const p of [seg.a, seg.b]) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y + tickLen);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Strokes: the pre-drawn teaching stub and the player's own strokes are
// rendered by this ONE function, at the same weight, so the stub is
// indistinguishable from ink the player laid down themselves. Weight varies
// slightly per segment (a deterministic function of the segment's own index
// and position, never of time) for a hand-drawn feel, with rounded caps and
// joins throughout.
// ---------------------------------------------------------------------------
function drawInkPolyline(ctx: CanvasRenderingContext2D, points: Vec2[], scale: number): void {
  if (points.length < 2) return;
  const safeScale = scale > 1e-6 ? scale : 1e-6;
  const baseWidth = 5 / safeScale;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const wobble = 0.82 + 0.36 * hash(i * 0.913 + a.x * 0.013 + a.y * 0.017);
    ctx.lineWidth = baseWidth * wobble;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], stub: Stroke | null, scale: number): void {
  ctx.save();
  if (stub) drawInkPolyline(ctx, stub.points, scale);
  for (const s of strokes) drawInkPolyline(ctx, s.points, scale);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Pickups: a soft ink blot (same fill as the ink bar and every drawn line)
// carrying a small nib-stroke mark, so the resemblance to "this is ink" is
// unmistakable. A gentle bob + pulse driven by `t` — never a per-frame
// re-roll — makes them impossible to miss without ever using a word.
// Per-pickup phase offset comes from its own position, so a field of pickups
// doesn't pulse in lockstep like a HUD, but stays perfectly deterministic.
// ---------------------------------------------------------------------------
export function drawPickups(ctx: CanvasRenderingContext2D, level: Level, t: number): void {
  ctx.save();

  for (const pickup of level.pickups) {
    if (pickup.taken) continue;

    const phase = pickup.pos.x * 0.017 + pickup.pos.y * 0.011;
    const bob = Math.sin(t * 2.2 + phase) * 4;
    const pulse = 0.85 + 0.15 * Math.sin(t * 3.1 + phase * 1.3);
    const cx = pickup.pos.x;
    const cy = pickup.pos.y + bob;
    const r = Math.max(1, PICKUP_RADIUS * 0.5 * pulse);

    // Halo ring — same visual family as the ink bar's outline.
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.3 + 0.15 * Math.sin(t * 3.1 + phase);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, PICKUP_RADIUS * (0.9 + 0.1 * pulse), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Core ink blot.
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // A small nib-stroke mark across the blot: the same rounded-cap ink line
    // family as drawn strokes, so the eye connects "this glyph" to "ink".
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, r * 0.35);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy + r * 0.32);
    ctx.lineTo(cx, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.32);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Finish: a post with a pennant, plus a soft ambient halo that pulses gently
// off `t` so the destination reads from a distance, not just up close. The
// pennant flutters subtly on the same clock, never a per-frame re-roll.
// ---------------------------------------------------------------------------
export function drawFinish(ctx: CanvasRenderingContext2D, level: Level, t: number): void {
  const x = level.finishX;
  const groundY = level.groundY;
  const postH = 110;

  ctx.save();

  const pulse = 0.5 + 0.5 * Math.sin(t * 1.4);
  const haloR = 34 + pulse * 10;
  ctx.save();
  ctx.globalAlpha = 0.12 + pulse * 0.08;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(x, groundY - postH * 0.55, haloR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, groundY);
  ctx.lineTo(x, groundY - postH);
  ctx.stroke();

  const flutter = Math.sin(t * 4.0) * 0.15;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(x, groundY - postH);
  ctx.lineTo(x + 30 + flutter * 10, groundY - postH + 12 + flutter * 6);
  ctx.lineTo(x, groundY - postH + 26);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
