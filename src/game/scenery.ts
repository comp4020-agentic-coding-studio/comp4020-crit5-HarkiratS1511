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

import type { Level, Segment, Stroke, Vec2 } from "./types";
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
// The selector is total — any integer, including negatives — maps onto one
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
//
// Both layers are built and filled as ONE continuous opaque path per layer —
// never a series of individually-alpha'd shapes — so overlapping silhouette
// features never double up into darker lens-shaped intersections. Each layer
// carries exactly one flat value against the sky; depth comes from that value
// differing layer to layer (distant pale and low-contrast, near darker and
// more defined), never from alpha stacking within a layer.
//
// Both layers are generated purely from camera + viewport (never from the
// level's ground data), so they always cover the full frame at any camera
// position, including long before the level start or long past its end.
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
 *  as "far away" precisely because it has no crisp detail. One path, one
 *  fill, spanning the full viewport width regardless of camera. */
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

/** Shared tile-index range for the tiled near-silhouette families (skyline,
 *  peaks, spires): the smallest run of tiles that fully covers the visible
 *  viewport at this camera + scale, capped so a huge camera excursion can
 *  never blow up path complexity. Because this is derived purely from
 *  camera/viewport/tileWorld (never from level bounds), the tiled layer
 *  always spans the full frame, at any camera position. */
function computeTileRange(worldCamera: number, viewWorldWidth: number, tileWorld: number): { startI: number; endI: number } | null {
  let startI = Math.floor((worldCamera - tileWorld) / tileWorld);
  let endI = Math.ceil((worldCamera + viewWorldWidth + tileWorld) / tileWorld);
  const MAX_TILES = 240;
  if (endI - startI > MAX_TILES) endI = startI + MAX_TILES;
  if (!Number.isFinite(startI) || !Number.isFinite(endI)) return null;
  return { startI, endI };
}

/** Continuous stepped-rooftop skyline: one walked polygon (up at a tile
 *  boundary, across at the new height, up/down at the next boundary — never
 *  a separate rect per building) plus the rare antenna as its own small
 *  closed loop within the SAME path. The caller fills this once. */
function buildSkylinePath(
  ctx: CanvasRenderingContext2D,
  startI: number,
  endI: number,
  tileWorld: number,
  worldCamera: number,
  scale: number,
  baseY: number,
  levelIndex: number
): void {
  const screenXAt = (i: number) => (i * tileWorld - worldCamera) * scale;
  const antennas: { x: number; topY: number; h: number; w: number }[] = [];

  ctx.moveTo(screenXAt(startI), baseY + 6);
  for (let i = startI; i <= endI; i++) {
    const seed = i * 7.13 + levelIndex * 31.7;
    const r1 = hash(seed);
    const r2 = hash(seed + 0.37);
    const bh = baseY * (0.12 + r1 * 0.34);
    const topY = baseY - bh;
    const x0 = screenXAt(i);
    const x1 = screenXAt(i + 1);
    ctx.lineTo(x0, topY);
    ctx.lineTo(x1, topY);
    if (r2 > 0.75) {
      antennas.push({ x: (x0 + x1) * 0.5, topY, h: baseY * 0.08, w: Math.max(1, (x1 - x0) * 0.02) });
    }
  }
  ctx.lineTo(screenXAt(endI + 1), baseY + 6);
  ctx.closePath();

  for (const a of antennas) {
    ctx.moveTo(a.x - a.w * 0.5, a.topY);
    ctx.lineTo(a.x - a.w * 0.5, a.topY - a.h);
    ctx.lineTo(a.x + a.w * 0.5, a.topY - a.h);
    ctx.lineTo(a.x + a.w * 0.5, a.topY);
    ctx.closePath();
  }
}

/** Continuous mountain ridge: alternating peak/saddle, walked as a single
 *  zigzag polyline rather than one triangle per tile, so neighbouring peaks
 *  share an edge instead of overlapping. */
function buildPeaksPath(
  ctx: CanvasRenderingContext2D,
  startI: number,
  endI: number,
  tileWorld: number,
  worldCamera: number,
  scale: number,
  baseY: number,
  levelIndex: number
): void {
  const screenXAt = (i: number) => (i * tileWorld - worldCamera) * scale;
  ctx.moveTo(screenXAt(startI), baseY + 6);
  for (let i = startI; i <= endI; i++) {
    const seed = i * 7.13 + levelIndex * 31.7;
    const r1 = hash(seed);
    const ph = baseY * (0.18 + r1 * 0.42);
    const x0 = screenXAt(i);
    const x1 = screenXAt(i + 1);
    ctx.lineTo((x0 + x1) * 0.5, baseY - ph);
    ctx.lineTo(x1, baseY - ph * 0.15);
  }
  ctx.lineTo(screenXAt(endI + 1), baseY + 6);
  ctx.closePath();
}

/** Continuous low band with sparse spike excursions poking up through it —
 *  one walked silhouette, not one thin rect per spire, so spires never sit
 *  as separate alpha'd shapes stacked on the band. */
function buildSpiresPath(
  ctx: CanvasRenderingContext2D,
  startI: number,
  endI: number,
  tileWorld: number,
  worldCamera: number,
  scale: number,
  baseY: number,
  levelIndex: number
): void {
  const screenXAt = (i: number) => (i * tileWorld - worldCamera) * scale;
  const bandY = baseY - baseY * 0.05;
  ctx.moveTo(screenXAt(startI), baseY + 6);
  ctx.lineTo(screenXAt(startI), bandY);
  for (let i = startI; i <= endI; i++) {
    const seed = i * 7.13 + levelIndex * 31.7;
    const r1 = hash(seed);
    const r2 = hash(seed + 0.37);
    const x0 = screenXAt(i);
    const x1 = screenXAt(i + 1);
    const tileW = x1 - x0;
    if (r2 > 0.5 && tileW > 0) {
      const spikeX = x0 + tileW * (0.3 + r2 * 0.4);
      const spikeH = baseY * (0.25 + r1 * 0.5);
      const half = Math.max(1, tileW * 0.03);
      ctx.lineTo(spikeX - half, bandY);
      ctx.lineTo(spikeX, bandY - spikeH);
      ctx.lineTo(spikeX + half, bandY);
    }
    ctx.lineTo(x1, bandY);
  }
  ctx.lineTo(screenXAt(endI + 1), baseY + 6);
  ctx.closePath();
}

/** Continuous rolling hill silhouette: the same sum-of-sines family as the
 *  far layer, but a different seed, higher frequency and amplitude, so it
 *  reads as nearer and denser while remaining one smooth path — never the
 *  separate overlapping ellipses this replaces. */
function drawHillsSilhouette(
  ctx: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  worldCamera: number,
  scale: number,
  levelIndex: number
): void {
  const amp = Math.max(6, baseY * 0.17);
  const seedA = hash(levelIndex * 4.3 + 11) * Math.PI * 2;
  const seedB = hash(levelIndex * 6.1 + 12) * Math.PI * 2;
  const seedC = hash(levelIndex * 10.7 + 13) * Math.PI * 2;
  const f1 = 0.006, f2 = 0.015, f3 = 0.032;
  const steps = 64;

  ctx.beginPath();
  ctx.moveTo(0, baseY + 6);
  for (let s = 0; s <= steps; s++) {
    const sx = (s / steps) * w;
    const wx = sx / scale + worldCamera;
    const combined =
      0.5 * Math.sin(wx * f1 + seedA) +
      0.32 * Math.sin(wx * f2 + seedB) +
      0.18 * Math.sin(wx * f3 + seedC);
    const y = baseY - amp * ((combined + 1) * 0.5);
    ctx.lineTo(sx, y);
  }
  ctx.lineTo(w, baseY + 6);
  ctx.closePath();
  ctx.fill();
}

/** Nearer, faster-scrolling silhouette. Built as ONE continuous path per
 *  call — a single filled skyline spanning the viewport, with the layer's
 *  near edge (its top boundary) as the skyline itself — then filled exactly
 *  once at the variant's flat alpha. That single fill is what prevents any
 *  intra-layer overlap from ever double-darkening: even where the walked
 *  outline dips and rises against itself, the whole area is painted with one
 *  paint operation, not a pile of separately-composited shapes. The shape
 *  family (hills/skyline/peaks/spires) is what gives each level its distinct
 *  character; tiled families are generated purely from camera + viewport, so
 *  they always cover the full frame at any camera position. */
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
  const worldCamera = camera * parallax;
  const viewWorldWidth = w / scale;

  ctx.fillStyle = inkAlpha(alpha);

  if (shape === "hills") {
    drawHillsSilhouette(ctx, w, baseY, worldCamera, scale, levelIndex);
    return;
  }

  const tileWorld = shape === "spires" ? 130 : shape === "skyline" ? 150 : 175; // peaks
  const range = computeTileRange(worldCamera, viewWorldWidth, tileWorld);
  if (!range) return;
  const { startI, endI } = range;

  ctx.beginPath();
  if (shape === "skyline") {
    buildSkylinePath(ctx, startI, endI, tileWorld, worldCamera, scale, baseY, levelIndex);
  } else if (shape === "peaks") {
    buildPeaksPath(ctx, startI, endI, tileWorld, worldCamera, scale, baseY, levelIndex);
  } else {
    buildSpiresPath(ctx, startI, endI, tileWorld, worldCamera, scale, baseY, levelIndex);
  }
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Ground: a filled ink mass, not a hairline. Segments that connect end to end
// (the new rolling-slope levels: a run of ramps sharing endpoints) are walked
// as ONE continuous top-edge polyline and filled/stroked as a single mass —
// no seam, no gap, no doubled stroke at a join, and the downward fill follows
// the slope itself rather than one rectangle per segment. Only a genuine
// horizontal break between two chains — an actual gap in the ground data —
// gets the emphasised vertical cut; a join between connected slopes never
// does, however sharp the angle.
//
// The outermost ends of the whole ground mass (the very first point of the
// first chain, the very last point of the last chain) are extended flat, for
// rendering only, far past where the level's own segment data ends. That is
// what stops the world visibly running out past the finish (or before the
// start): the ink mass always reaches the edge of the frame, at any camera
// position, without inventing any collidable geometry or touching the Level.
// ---------------------------------------------------------------------------
const GROUND_FILL_DEPTH = 1200;

/** World-px, comfortably beyond any camera's visible sightline (a few
 *  hundred to ~1000 world px at the marked viewports — see tuning.ts's
 *  MIN_SIGHTLINE). Extending the outer ends of the ground mass by this much
 *  guarantees the fill still reaches both frame edges regardless of how far
 *  before the start or past the finish the camera sits. */
const GROUND_EDGE_EXTENSION = 6000;

/** Slack, in world px, for treating one segment's end as "the same point" as
 *  the next segment's start — i.e. connected, not a gap. */
const CHAIN_JOIN_EPSILON = 0.5;

/** Groups ground segments into chains of connected top-edge points. Segments
 *  are sorted by their start x first so chain-building is order-independent;
 *  within a chain, consecutive points share an endpoint (a slope run), so the
 *  chain's own point list IS its continuous top edge. A gap between one
 *  chain's last point and the next chain's first point is a real, visible
 *  hole in the ground — never rendered as if it were connected. */
function buildGroundChains(segments: Segment[]): Vec2[][] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.a.x - b.a.x);
  const chains: Vec2[][] = [];
  let current: Vec2[] = [sorted[0].a, sorted[0].b];
  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    const prevEnd = current[current.length - 1];
    const connected =
      Math.abs(seg.a.x - prevEnd.x) < CHAIN_JOIN_EPSILON && Math.abs(seg.a.y - prevEnd.y) < CHAIN_JOIN_EPSILON;
    if (connected) {
      current.push(seg.b);
    } else {
      chains.push(current);
      current = [seg.a, seg.b];
    }
  }
  chains.push(current);
  return chains;
}

/** The chain's top-edge points, with the outer ends of the WHOLE ground mass
 *  (first point of the first chain, last point of the last chain) extended
 *  flat by GROUND_EDGE_EXTENSION. Internal chain boundaries — real gaps — are
 *  left exactly as they are. */
function extendedChainPoints(chain: Vec2[], isFirstChain: boolean, isLastChain: boolean): Vec2[] {
  const points = [...chain];
  if (isFirstChain) {
    const first = points[0];
    points.unshift({ x: first.x - GROUND_EDGE_EXTENSION, y: first.y });
  }
  if (isLastChain) {
    const last = points[points.length - 1];
    points.push({ x: last.x + GROUND_EDGE_EXTENSION, y: last.y });
  }
  return points;
}

export function drawGround(ctx: CanvasRenderingContext2D, level: Level, scale: number): void {
  const safeScale = scale > 1e-6 ? scale : 1e-6;
  const chains = buildGroundChains(level.groundSegments);
  if (chains.length === 0) return;

  ctx.save();

  // Fill: one continuous path per chain (world-edge extension included), the
  // downward fill following the slope of the chain's own top edge rather
  // than a rectangle per segment.
  ctx.fillStyle = INK;
  for (let c = 0; c < chains.length; c++) {
    const points = extendedChainPoints(chains[c], c === 0, c === chains.length - 1);
    const first = points[0];
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(last.x, last.y + GROUND_FILL_DEPTH);
    ctx.lineTo(first.x, first.y + GROUND_FILL_DEPTH);
    ctx.closePath();
    ctx.fill();
  }

  // Defined top edge: one confident continuous stroke per chain (extension
  // included), so a run of connected slopes reads as a single smooth surface
  // with no seam and no doubled stroke at a join.
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4 / safeScale;
  for (let c = 0; c < chains.length; c++) {
    const points = extendedChainPoints(chains[c], c === 0, c === chains.length - 1);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // A faint paper-toned crust line just under the surface gives the mass a
  // sense of thickness rather than a single flat tone — one continuous
  // offset polyline per chain, following the slope the same way.
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 1.5 / safeScale;
  const dy = 7 / safeScale;
  for (let c = 0; c < chains.length; c++) {
    const points = extendedChainPoints(chains[c], c === 0, c === chains.length - 1);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y + dy);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y + dy);
    ctx.stroke();
  }
  ctx.restore();

  // Gap-edge emphasis: only a genuine break between two chains — an actual
  // hole in the ground data — gets the bold vertical cut. The two extended
  // outer ends of the whole mass are not exposed (the fill keeps going past
  // the frame edge), so they never get a cut; a join between connected
  // slopes inside one chain was never a gap and never gets one either.
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineWidth = 6 / safeScale;
  const tickLen = 22 / safeScale;
  for (let c = 0; c < chains.length - 1; c++) {
    const rightEnd = chains[c][chains[c].length - 1];
    const leftEnd = chains[c + 1][0];
    for (const p of [rightEnd, leftEnd]) {
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
