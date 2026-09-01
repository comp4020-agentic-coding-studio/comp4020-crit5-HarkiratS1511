// Scenery: everything that dresses the world without being gameplay.
//
// Vector-inspired brief: silhouette foreground against a deep, layered,
// atmospheric background — now TINTED ink-on-paper. The premise is unchanged
// (your line is ink, the world is drawn on paper) but every colour comes from
// palette.ts, so each level gets its own paper and its own light and arriving
// somewhere new is visible in the first frame, before a single piece of
// terrain has been read. Nothing on screen is allowed to say "level 2", so
// the light has to.
//
// No text, no numerals, anywhere in this module.
//
// COLOUR RULE. This module never names a colour. It reads roles off the
// Palette it is handed — paper / terrain / ink / accent — and it never infers
// colour from levelIndex. `levelIndex` survives as a parameter only where it
// seeds SHAPE (which ridgeline, where the sun sits), never value. Palette 3 is
// inverted: cream ink on a near-black world. Every path below that lifts
// something off the background branches on `palette.dark`, because "dark mark
// on light background" is false there.
//
// RESTRAINT RULE. The player has to read three things to play at all: the
// runner, the gaps, and their own drawn line. Everything in this file exists
// to make those three legible against a composed frame, and nothing in it may
// compete with them. That is why the near parallax band gets a ground-level
// haze wash laid back over it (`drawGroundHaze`) — the band is tall and dark
// on purpose, and the haze is what keeps the strip the runner actually
// occupies from swallowing it.
//
// Determinism note: every background shape is a pure function of world
// position, levelIndex and palette — never of frame count and never of
// Math.random(). That is what stops the parallax layers shimmering as the
// camera moves: the same world x always produces the same silhouette. The
// motes and birds "drift" off the CAMERA, not off a clock, for exactly this
// reason. Only the gameplay marks (pickups, hazard shimmer, finish pulse)
// take a time argument, and they are foreground, few, and meant to move.

import type { Level, Segment, Stroke, Vec2 } from "./types";
import { SPIKE_HEIGHT, GROUND_SCREEN_FRACTION, PICKUP_RADIUS } from "./tuning";
import { at, paletteIndex, type Palette, type SkylineShape, type Tone } from "./palette";

// ---------------------------------------------------------------------------
// Deterministic pseudo-random in [0,1), seeded from a plain number. Used
// everywhere shapes need to look organically varied without ever re-rolling
// per frame — same seed always gives the same value.
// ---------------------------------------------------------------------------
function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

/** Kept exported and total because the level-identity guarantee ("at least 4
 *  variants, wrapping beyond that") is asserted against it. It is now just
 *  palette.ts's own index function under its old name — one selector, so the
 *  sky variant and the palette can never drift apart. */
export function skyVariantIndex(levelIndex: number): number {
  return paletteIndex(levelIndex);
}

/** A soft radial falloff, squashed to an ellipse. The only "blur" available
 *  without ctx.filter (which no headless/JSDOM context implements), and the
 *  workhorse behind the sun disc's glow, the hanging haze banks and the
 *  finish beacon. Painted as ONE gradient fill, never a stack of rings, so
 *  it cannot band. */
function softDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tone: Tone,
  alpha: number,
): void {
  if (!(rx > 0) || !(ry > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, at(tone, alpha));
  g.addColorStop(0.5, at(tone, alpha * 0.52));
  g.addColorStop(1, at(tone, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Sky. A real gradient from `skyTop` overhead to `skyHorizon` at the ground
// line — this is what fills the two-thirds of the frame the monochrome build
// left as dead cream — then quiet atmosphere, then THREE parallax bands.
//
// Three, not two. The old two-layer version left a visible step between "far
// pale" and "near dark" which read as cut paper rather than as distance; the
// palette carries farAlpha / midAlpha / nearAlpha for precisely this, and the
// mid band is what turns the step into a ramp.
//
// Every band is built and filled as ONE continuous opaque path — never a
// series of individually-alpha'd shapes — so overlapping features within a
// band never double up into darker lens-shaped intersections. Depth comes
// from the value differing BETWEEN bands, never from alpha stacking within
// one. And every band is generated purely from camera + viewport (never from
// the level's ground data), so they cover the full frame at any camera
// position, long before the level start and long past its end.
// ---------------------------------------------------------------------------

type BandSpec = {
  /** Fraction of camera movement this band tracks. Smaller = further away. */
  parallax: number;
  /** Silhouette height above the ground line, in px, at its lowest and
   *  highest. The low figure is deliberately small so the band has real
   *  saddles: stretches where the sky comes right down to the ground line and
   *  the runner has clean paper behind it. */
  minRise: number;
  maxRise: number;
  alpha: number;
  /** "smooth" is the far band's featureless distance-flattened ridge; every
   *  other value is the palette's own silhouette family. */
  shape: SkylineShape | "smooth";
  /** Base frequency for the wave families (smooth / hills). */
  freq: number;
  /** Tile width in world px for the tiled families. */
  tileWorld: number;
  seed: number;
};

/** Tile width per silhouette family, in world px. Tuned so a desktop frame
 *  shows roughly a dozen features rather than four enormous ones. */
function tileWorldFor(shape: SkylineShape): number {
  if (shape === "spires") return 95;
  if (shape === "skyline") return 105;
  return 150; // peaks
}

export function drawSky(
  ctx: CanvasRenderingContext2D,
  viewport: { width: number; height: number },
  camera: number,
  scale: number,
  levelIndex: number,
  palette: Palette,
): void {
  const w = Math.max(0, viewport.width);
  const h = Math.max(0, viewport.height);
  const safeCamera = Number.isFinite(camera) ? camera : 0;
  const safeScale = scale > 1e-6 ? scale : 1e-6;
  const horizonY = h * GROUND_SCREEN_FRACTION;
  const seed = Number.isFinite(levelIndex) ? Math.trunc(levelIndex) : 0;

  ctx.save();

  // Paper base — drawSky owns the full background, top to bottom. Painted
  // first and opaque, so nothing beneath ever shows through a gradient stop
  // that happens to be transparent.
  ctx.fillStyle = palette.paper.css;
  ctx.fillRect(0, 0, w, h);

  if (w > 0 && h > 0) {
    drawSkyWash(ctx, w, h, horizonY, palette);
    if (palette.dark) drawStars(ctx, w, h, horizonY, safeCamera, safeScale, seed, palette);
    drawSunDisc(ctx, w, h, horizonY, safeCamera, seed, palette);
    drawHazeBanks(ctx, w, h, horizonY, safeCamera, safeScale, seed, palette);

    const footY = horizonY + Math.max(6, h * 0.012);
    const shape = palette.shape;
    const tile = tileWorldFor(shape);

    drawBand(ctx, w, horizonY, footY, safeCamera, safeScale, palette.terrain, {
      parallax: 0.07,
      minRise: h * 0.06,
      maxRise: h * 0.19,
      alpha: palette.farAlpha,
      shape: "smooth",
      freq: 0.0019,
      tileWorld: tile,
      seed: seed * 3.7 + 1.3,
    });

    // Birds ride between the far and mid bands: far enough to be atmosphere,
    // near enough to read as alive. Daylight only — a flock at night reads as
    // a smudge, and the night sky already has its own inhabitants.
    if (!palette.dark) drawBirds(ctx, w, h, safeCamera, safeScale, seed, palette);

    drawBand(ctx, w, horizonY, footY, safeCamera, safeScale, palette.terrain, {
      parallax: 0.17,
      minRise: h * 0.1,
      maxRise: h * 0.3,
      alpha: palette.midAlpha,
      shape,
      freq: 0.0052,
      tileWorld: tile * 0.66,
      seed: seed * 8.1 + 4.7,
    });

    // The near band's height is capped against the frame's WIDTH as well as
    // its height. A silhouette feature is about one tile wide, and a tile is
    // a fixed share of the sightline — so on a tall narrow viewport a rise
    // set purely off `h` turns every mountain into a needle four times taller
    // than it is wide. Blending in a width term keeps the same feature
    // proportions at 390x844 that it has at 1920x1080; on desktop the cap
    // never binds and the value is exactly h * 0.48.
    const nearRise = Math.min(h * 0.48, h * 0.28 + w * 0.28);

    drawBand(ctx, w, horizonY, footY, safeCamera, safeScale, palette.terrain, {
      parallax: 0.34,
      minRise: h * 0.09,
      maxRise: nearRise,
      alpha: palette.nearAlpha,
      shape,
      freq: 0.0098,
      tileWorld: tile,
      seed: seed * 12.9 + 9.1,
    });

    drawGroundHaze(ctx, w, h, horizonY, palette);
    if (!palette.dark) drawMotes(ctx, w, h, horizonY, safeCamera, safeScale, seed, palette);
  }

  ctx.restore();
}

/** The wash. Two tones, not one alpha ramp over a single ink: `skyTop`
 *  overhead falling to `skyHorizon` at the ground line, at the opacities the
 *  palette specifies. The gradient runs slightly past the horizon so its
 *  hottest stop is not clipped by the ground mass sitting on top of it. */
function drawSkyWash(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizonY: number,
  palette: Palette,
): void {
  const bottom = Math.min(h, horizonY + h * 0.06);
  const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, bottom));
  g.addColorStop(0, at(palette.skyTop, palette.topAlpha));
  g.addColorStop(0.38, at(palette.skyTop, palette.topAlpha * 0.72));
  g.addColorStop(0.7, at(palette.skyHorizon, palette.horizonAlpha * 0.42));
  g.addColorStop(0.92, at(palette.skyHorizon, palette.horizonAlpha));
  g.addColorStop(1, at(palette.skyHorizon, palette.horizonAlpha * 0.9));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, bottom);
}

/** A sun or a moon, low on the horizon. It drifts on a slow sine of the
 *  camera rather than wrapping modulo anything, so it never pops as it
 *  crosses a seam, and it is drawn BEFORE the parallax bands so the land
 *  occludes it — which is most of what sells it as distant.
 *
 *  The disc takes `ink`'s tone on dark paper and `paper`'s on light: on both,
 *  that is the tone furthest from the sky it sits in, which is the only
 *  definition of "bright" that survives the night inversion. */
function drawSunDisc(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizonY: number,
  camera: number,
  seed: number,
  palette: Palette,
): void {
  const s = hash(seed * 17.3 + 5.1);
  const cx = w * (0.5 + 0.36 * Math.sin(camera * 0.00009 + s * Math.PI * 2));
  const cy = horizonY - h * (0.15 + 0.06 * Math.cos(camera * 0.00007 + s * 3.1));
  const r = Math.max(9, h * 0.042);
  const tone = palette.dark ? palette.ink : palette.paper;
  const discAlpha = palette.dark ? 0.9 : 0.42 + palette.horizonAlpha * 0.34;

  softDisc(ctx, cx, cy, r * 5.2, r * 5.2, tone, palette.dark ? 0.17 : 0.3);
  ctx.fillStyle = at(tone, discAlpha);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Hanging haze banks: five soft flattened ellipses, each drifting at its own
 *  near-zero parallax. They wrap over a period wider than the viewport plus
 *  their own width, so the jump happens entirely off-screen and is never
 *  seen. Pale on light paper (mist catching the light), cold and faint on
 *  dark (skyglow).
 *
 *  Deliberately spread across the WHOLE height of the sky rather than banked
 *  up near the horizon: the complaint that started this rewrite was two
 *  thirds of the frame reading as empty, and the parallax bands can only
 *  reach so far up before they stop looking like distance. Above that line
 *  it is the haze doing the work. Higher banks are wider and flatter, the
 *  way high cloud actually is, so they never read as a second horizon. */
function drawHazeBanks(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizonY: number,
  camera: number,
  scale: number,
  seed: number,
  palette: Palette,
): void {
  const BANKS = 5;
  for (let k = 0; k < BANKS; k++) {
    const s = hash(seed * 13.7 + k * 5.31 + 0.7);
    const s2 = hash(seed * 13.7 + k * 5.31 + 2.9);
    const up = k / (BANKS - 1); // 0 at the horizon, 1 at the top of the frame
    const high = up > 0.4;
    // Low banks are mist lying on the land, and lift toward the paper. High
    // banks are cloud seen from underneath, and go the other way — a paper
    // bank up there is invisible, because the top of the sky wash is already
    // within a few values of the paper it is painted over. Tried it the
    // uniform way first and the whole upper half stayed empty.
    const tone = palette.dark ? palette.skyHorizon : high ? palette.terrain : palette.paper;
    const alpha = palette.dark ? 0.1 + up * 0.07 : high ? 0.048 + (1 - up) * 0.045 : 0.26;
    const rx = w * (0.17 + s * 0.12 + up * 0.16);
    const period = w + rx * 2 + 40;
    const drift = camera * (0.035 + k * 0.02) * scale;
    const raw = (-drift + s2 * period) % period;
    const cx = ((raw + period) % period) - rx - 20;
    const cy = horizonY - horizonY * (0.07 + up * 0.86 + (s - 0.5) * 0.07);
    const ry = h * (0.015 + s2 * 0.018) * (1 - up * 0.35);
    softDisc(ctx, cx, cy, rx, ry, tone, alpha);
  }
}

/** Stars, night only. A sparse lattice in world space at a near-zero
 *  parallax, so they hold still relative to the land in a way that reads as
 *  "very far" rather than as a fixed overlay. Deterministic per lattice cell:
 *  the same world x always produces the same star at the same brightness. */
function drawStars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizonY: number,
  camera: number,
  scale: number,
  seed: number,
  palette: Palette,
): void {
  const parallax = 0.05;
  const spacingWorld = 130;
  const worldCamera = camera * parallax;
  const range = computeTileRange(worldCamera, w / scale, spacingWorld);
  if (!range) return;
  const top = h * 0.02;
  const bottom = horizonY - h * 0.1;
  if (bottom <= top) return;

  ctx.fillStyle = at(palette.ink, 1);
  for (let i = range.startI; i <= range.endI; i++) {
    const r1 = hash(i * 4.17 + seed * 21.3);
    if (r1 < 0.42) continue;
    const r2 = hash(i * 4.17 + seed * 21.3 + 1.7);
    const r3 = hash(i * 4.17 + seed * 21.3 + 3.3);
    const sx = (i * spacingWorld + r2 * spacingWorld - worldCamera) * scale;
    if (sx < -4 || sx > w + 4) continue;
    const sy = top + (bottom - top) * (r3 * r3); // biased upward, thinning out toward the horizon haze
    const rad = 0.7 + r1 * 1.5;
    ctx.globalAlpha = 0.22 + r2 * 0.55;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Daylight dust: a handful of near-foreground motes, so the air between the
 *  camera and the land is not vacuum. Drawn last, at a parallax faster than
 *  any band, and kept at an alpha low enough that they never read as
 *  something you could land on. */
function drawMotes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizonY: number,
  camera: number,
  scale: number,
  seed: number,
  palette: Palette,
): void {
  const parallax = 0.52;
  const spacingWorld = 230;
  const worldCamera = camera * parallax;
  const range = computeTileRange(worldCamera, w / scale, spacingWorld);
  if (!range) return;
  const top = horizonY - h * 0.36;
  const bottom = horizonY - h * 0.02;
  if (bottom <= top) return;

  ctx.fillStyle = at(palette.terrain, 1);
  for (let i = range.startI; i <= range.endI; i++) {
    const r1 = hash(i * 6.71 + seed * 9.13);
    if (r1 < 0.5) continue;
    const r2 = hash(i * 6.71 + seed * 9.13 + 1.31);
    const r3 = hash(i * 6.71 + seed * 9.13 + 2.77);
    const sx = (i * spacingWorld + r2 * spacingWorld - worldCamera) * scale;
    if (sx < -4 || sx > w + 4) continue;
    ctx.globalAlpha = 0.05 + r3 * 0.07;
    ctx.beginPath();
    ctx.arc(sx, top + (bottom - top) * r3, 1 + r1 * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** One or two distant birds, on a very coarse lattice so most of the time
 *  there are none at all. Two shallow chevrons apiece — enough to read as a
 *  bird at 8px, quiet enough that the eye never stops on them. */
function drawBirds(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  camera: number,
  scale: number,
  seed: number,
  palette: Palette,
): void {
  const parallax = 0.11;
  const spacingWorld = 1500;
  const worldCamera = camera * parallax;
  const range = computeTileRange(worldCamera, w / scale, spacingWorld);
  if (!range) return;

  ctx.save();
  ctx.strokeStyle = at(palette.terrain, Math.min(0.62, palette.farAlpha + 0.24));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.1, h * 0.0018);

  for (let i = range.startI; i <= range.endI; i++) {
    const r1 = hash(i * 11.9 + seed * 5.77);
    if (r1 < 0.55) continue;
    const r2 = hash(i * 11.9 + seed * 5.77 + 1.9);
    const r3 = hash(i * 11.9 + seed * 5.77 + 4.1);
    const baseX = (i * spacingWorld + r2 * spacingWorld - worldCamera) * scale;
    const baseY = h * (0.1 + r3 * 0.28);
    const count = r1 > 0.82 ? 3 : 2;
    for (let b = 0; b < count; b++) {
      const o = hash(i * 11.9 + b * 2.3 + 0.5);
      const bx = baseX + (b - 1) * h * 0.035 + o * h * 0.02;
      const by = baseY + (o - 0.5) * h * 0.03;
      const s = h * (0.006 + o * 0.005);
      if (bx < -20 || bx > w + 20) continue;
      ctx.beginPath();
      ctx.moveTo(bx - s * 2, by);
      ctx.quadraticCurveTo(bx - s, by - s * 1.1, bx, by);
      ctx.quadraticCurveTo(bx + s, by - s * 1.1, bx + s * 2, by);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Ground haze: the atmosphere the near band is standing in, laid back OVER
 *  the bands as a gradient rising off the ground line.
 *
 *  This is not decoration. The near band is tall and nearly solid by design,
 *  and the strip it occupies is exactly the strip the runner, the gaps and
 *  the drawn line occupy too — on the dusk palette an ink runner in front of
 *  an 85%-terrain hillside is very nearly invisible. Washing the bottom of
 *  the bands back toward the paper restores that contrast where it is needed
 *  and nowhere else, and it happens to be what distance actually looks like.
 *  On dark paper it lifts toward `skyHorizon` instead, because washing toward
 *  a near-black paper would do nothing at all. */
function drawGroundHaze(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizonY: number,
  palette: Palette,
): void {
  const tone = palette.dark ? palette.skyHorizon : palette.paper;
  const alpha = palette.dark ? 0.34 : 0.52;
  const top = horizonY - h * 0.19;
  const bottom = Math.min(h, horizonY + h * 0.03);
  if (bottom <= top) return;
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, at(tone, 0));
  g.addColorStop(0.45, at(tone, alpha * 0.3));
  g.addColorStop(0.85, at(tone, alpha));
  g.addColorStop(1, at(tone, alpha));
  ctx.fillStyle = g;
  ctx.fillRect(0, top, w, bottom - top);
}

/** Shared tile-index range for anything laid out on a world-space lattice
 *  (the tiled silhouette families, stars, motes, birds): the smallest run of
 *  cells that fully covers the visible viewport at this camera + scale,
 *  capped so a huge camera excursion can never blow up path complexity.
 *  Because this is derived purely from camera/viewport/cell width (never from
 *  level bounds), everything built on it spans the full frame at any camera
 *  position. */
function computeTileRange(
  worldCamera: number,
  viewWorldWidth: number,
  tileWorld: number,
): { startI: number; endI: number } | null {
  if (!(tileWorld > 0) || !Number.isFinite(worldCamera) || !Number.isFinite(viewWorldWidth)) return null;
  let startI = Math.floor((worldCamera - tileWorld) / tileWorld);
  let endI = Math.ceil((worldCamera + viewWorldWidth + tileWorld) / tileWorld);
  const MAX_TILES = 400;
  if (endI - startI > MAX_TILES) endI = startI + MAX_TILES;
  if (!Number.isFinite(startI) || !Number.isFinite(endI)) return null;
  return { startI, endI };
}

/** One parallax band: exactly one path, exactly one fill, at the band's flat
 *  alpha over `tone`. */
function drawBand(
  ctx: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  footY: number,
  camera: number,
  scale: number,
  tone: Tone,
  spec: BandSpec,
): void {
  const worldCamera = camera * spec.parallax;
  ctx.fillStyle = at(tone, spec.alpha);

  if (spec.shape === "smooth" || spec.shape === "hills") {
    buildWaveBand(ctx, w, baseY, footY, worldCamera, scale, spec);
    ctx.fill();
    return;
  }

  const range = computeTileRange(worldCamera, w / scale, spec.tileWorld);
  if (!range) return;
  const { startI, endI } = range;
  const screenXAt = (i: number): number => (i * spec.tileWorld - worldCamera) * scale;

  ctx.beginPath();
  if (spec.shape === "skyline") {
    buildSkylinePath(ctx, startI, endI, screenXAt, baseY, footY, spec);
  } else if (spec.shape === "peaks") {
    buildPeaksPath(ctx, startI, endI, screenXAt, baseY, footY, spec);
  } else {
    buildSpiresPath(ctx, startI, endI, screenXAt, baseY, footY, spec);
  }
  ctx.fill();
}

/** Continuous rolling silhouette: a sum of three sines rather than tiles, so
 *  it stays smooth at any scale with no seams. The far band uses it at a low
 *  frequency (distance flattens detail into a single soft ridge); the "hills"
 *  family uses the same generator faster and taller for its mid and near
 *  bands. */
function buildWaveBand(
  ctx: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  footY: number,
  worldCamera: number,
  scale: number,
  spec: BandSpec,
): void {
  const seedA = hash(spec.seed * 3.1 + 1) * Math.PI * 2;
  const seedB = hash(spec.seed * 5.7 + 2) * Math.PI * 2;
  const seedC = hash(spec.seed * 9.3 + 3) * Math.PI * 2;
  const f1 = spec.freq;
  const f2 = spec.freq * 2.6;
  const f3 = spec.freq * 5.3;
  const steps = 88;

  ctx.beginPath();
  ctx.moveTo(0, footY);
  for (let s = 0; s <= steps; s++) {
    const sx = (s / steps) * w;
    const wx = sx / scale + worldCamera;
    const combined =
      0.54 * Math.sin(wx * f1 + seedA) +
      0.3 * Math.sin(wx * f2 + seedB) +
      0.16 * Math.sin(wx * f3 + seedC);
    const rise = spec.minRise + (spec.maxRise - spec.minRise) * ((combined + 1) * 0.5);
    ctx.lineTo(sx, baseY - rise);
  }
  ctx.lineTo(w, footY);
  ctx.closePath();
}

/** Continuous stepped-rooftop skyline: one walked polygon (up at a tile
 *  boundary, across at the new height, up/down at the next — never a separate
 *  rect per building) plus the rare antenna as its own small closed loop
 *  within the SAME path, so the caller's single fill covers both. */
function buildSkylinePath(
  ctx: CanvasRenderingContext2D,
  startI: number,
  endI: number,
  screenXAt: (i: number) => number,
  baseY: number,
  footY: number,
  spec: BandSpec,
): void {
  const antennas: { x: number; topY: number; h: number; w: number }[] = [];
  const span = spec.maxRise - spec.minRise;

  ctx.moveTo(screenXAt(startI), footY);
  for (let i = startI; i <= endI; i++) {
    const s = i * 7.13 + spec.seed * 31.7;
    const r1 = hash(s);
    const r2 = hash(s + 0.37);
    const topY = baseY - (spec.minRise + r1 * r1 * span);
    const x0 = screenXAt(i);
    const x1 = screenXAt(i + 1);
    ctx.lineTo(x0, topY);
    ctx.lineTo(x1, topY);
    if (r2 > 0.78) {
      antennas.push({ x: (x0 + x1) * 0.5, topY, h: span * 0.22, w: Math.max(1, (x1 - x0) * 0.05) });
    }
  }
  ctx.lineTo(screenXAt(endI + 1), footY);
  ctx.closePath();

  for (const a of antennas) {
    ctx.moveTo(a.x - a.w * 0.5, a.topY);
    ctx.lineTo(a.x - a.w * 0.5, a.topY - a.h);
    ctx.lineTo(a.x + a.w * 0.5, a.topY - a.h);
    ctx.lineTo(a.x + a.w * 0.5, a.topY);
    ctx.closePath();
  }
}

/** Continuous mountain ridge: alternating peak and saddle, walked as a single
 *  zigzag polyline rather than one triangle per tile, so neighbouring peaks
 *  share an edge instead of overlapping. */
function buildPeaksPath(
  ctx: CanvasRenderingContext2D,
  startI: number,
  endI: number,
  screenXAt: (i: number) => number,
  baseY: number,
  footY: number,
  spec: BandSpec,
): void {
  const span = spec.maxRise - spec.minRise;
  ctx.moveTo(screenXAt(startI), footY);
  for (let i = startI; i <= endI; i++) {
    const s = i * 7.13 + spec.seed * 31.7;
    const r1 = hash(s);
    const r2 = hash(s + 0.61);
    const peak = spec.minRise + r1 * span;
    const saddle = spec.minRise * (0.35 + r2 * 0.4);
    const x0 = screenXAt(i);
    const x1 = screenXAt(i + 1);
    // A shoulder short of the summit gives the ridge a face rather than a
    // pure isosceles tooth — the difference between a mountain and a spike.
    ctx.lineTo(x0 + (x1 - x0) * 0.34, baseY - peak * 0.72);
    ctx.lineTo(x0 + (x1 - x0) * 0.5, baseY - peak);
    ctx.lineTo(x1, baseY - saddle);
  }
  ctx.lineTo(screenXAt(endI + 1), footY);
  ctx.closePath();
}

/** Continuous low band with sparse tapered towers rising out of it — one
 *  walked silhouette, not one thin rect per spire, so spires never sit as
 *  separate alpha'd shapes stacked on the band. */
function buildSpiresPath(
  ctx: CanvasRenderingContext2D,
  startI: number,
  endI: number,
  screenXAt: (i: number) => number,
  baseY: number,
  footY: number,
  spec: BandSpec,
): void {
  const span = spec.maxRise - spec.minRise;
  const bandY = baseY - spec.minRise * 0.55;
  ctx.moveTo(screenXAt(startI), footY);
  ctx.lineTo(screenXAt(startI), bandY);
  for (let i = startI; i <= endI; i++) {
    const s = i * 7.13 + spec.seed * 31.7;
    const r1 = hash(s);
    const r2 = hash(s + 0.37);
    const x0 = screenXAt(i);
    const x1 = screenXAt(i + 1);
    const tileW = x1 - x0;
    if (r2 > 0.52 && tileW > 0) {
      const cx = x0 + tileW * (0.24 + r2 * 0.42);
      const top = baseY - (spec.minRise * 0.55 + r1 * span);
      const half = Math.max(1.2, tileW * (0.1 + r1 * 0.14));
      ctx.lineTo(cx - half, bandY);
      ctx.lineTo(cx - half * 0.4, top);
      ctx.lineTo(cx + half * 0.4, top);
      ctx.lineTo(cx + half, bandY);
    }
    ctx.lineTo(x1, bandY);
  }
  ctx.lineTo(screenXAt(endI + 1), footY);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Ground: a filled mass of ink, not a hairline, and now with material to it —
// a hard top lip, an interior that fades with depth rather than sitting at one
// flat value, and a sparse hatch just under the surface. The mass has to read
// as something laid ON the paper, because the whole premise is that the world
// is drawn.
//
// Segments that connect end to end (the rolling-slope levels: a run of ramps
// sharing endpoints) are walked as ONE continuous top-edge polyline and
// filled/stroked as a single mass — no seam, no gap, no doubled stroke at a
// join, and the downward fill follows the slope itself rather than one
// rectangle per segment. Only a genuine horizontal break between two chains —
// an actual gap in the ground data — gets the emphasised vertical cut; a join
// between connected slopes never does, however sharp the angle.
//
// The outermost ends of the whole ground mass (the very first point of the
// first chain, the very last point of the last chain) are extended flat, for
// rendering only, far past where the level's own segment data ends. That is
// what stops the world visibly running out past the finish (or before the
// start): the ink mass always reaches the edge of the frame, at any camera
// position, without inventing any collidable geometry or touching the Level.
// ---------------------------------------------------------------------------
const GROUND_FILL_DEPTH = 1200;

/** How deep the interior gradient takes to reach its lightest value, in world
 *  px. Beyond this the gradient clamps, so the mass never fades out entirely
 *  however tall the viewport is. */
const GROUND_BODY_DEPTH = 520;

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

export function drawGround(
  ctx: CanvasRenderingContext2D,
  level: Level,
  scale: number,
  palette: Palette,
): void {
  const safeScale = scale > 1e-6 ? scale : 1e-6;
  const chains = buildGroundChains(level.groundSegments);
  if (chains.length === 0) return;

  // Extended once, reused by every pass, so the fill, the lip, the crust and
  // the hatch can never disagree about where the surface is.
  const extended = chains.map((chain, c) => extendedChainPoints(chain, c === 0, c === chains.length - 1));

  ctx.save();

  // Body: one continuous path per chain, the downward fill following the
  // slope of the chain's own top edge rather than a rectangle per segment,
  // and filled with a vertical gradient rather than one flat value — solid at
  // the surface, easing back toward the paper with depth. That is what ink
  // laid thick and then dragged actually does, and it is the difference
  // between a mass and a silhouette-shaped hole in the frame.
  for (const points of extended) {
    const first = points[0];
    const last = points[points.length - 1];
    let topY = Infinity;
    for (const p of points) if (p.y < topY) topY = p.y;
    const g = ctx.createLinearGradient(0, topY, 0, topY + GROUND_BODY_DEPTH);
    g.addColorStop(0, at(palette.terrain, 1));
    g.addColorStop(0.28, at(palette.terrain, 0.95));
    g.addColorStop(1, at(palette.terrain, 0.83));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(last.x, last.y + GROUND_FILL_DEPTH);
    ctx.lineTo(first.x, first.y + GROUND_FILL_DEPTH);
    ctx.closePath();
    ctx.fill();
  }

  // Hatch: a sparse run of short dashes just under the surface, following the
  // slope, batched into ONE path and stroked once. Deterministic in world x,
  // so it never crawls as the camera moves. Restricted to the level's real
  // span — the flat outer extensions are off-screen scaffolding and want no
  // texture drawing attention to them.
  const hatchTone = palette.dark ? palette.ink : palette.paper;
  ctx.strokeStyle = at(hatchTone, palette.dark ? 0.07 : 0.1);
  ctx.lineCap = "round";
  ctx.lineWidth = 1.6 / safeScale;
  let hatched = false;
  ctx.beginPath();
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 0)) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const step = 26;
      for (let d = step * 0.5; d < len; d += step) {
        const px = a.x + ux * d;
        const py = a.y + uy * d;
        const r1 = hash(Math.floor(px / step) * 3.7 + 0.9);
        if (r1 < 0.45) continue;
        const r2 = hash(Math.floor(px / step) * 3.7 + 2.3);
        const depth = 13 + r2 * 40;
        const dashLen = 9 + r1 * 20;
        ctx.moveTo(px, py + depth);
        ctx.lineTo(px + ux * dashLen, py + uy * dashLen + depth);
        hatched = true;
      }
    }
  }
  if (hatched) ctx.stroke();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const points of extended) {
    // The lip: one confident continuous stroke per chain, so a run of
    // connected slopes reads as a single smooth surface with no seam and no
    // doubled stroke at a join. On light paper it is `ink` at full strength —
    // a darker crust than the body it caps. On dark paper `ink` is CREAM, so
    // the same stroke becomes a rim light along the top of a near-black
    // silhouette, which is the inverted world's version of the same job:
    // separate the ground from the sky with a hard, unmistakable edge.
    ctx.strokeStyle = at(palette.ink, palette.dark ? 0.55 : 1);
    ctx.lineWidth = (palette.dark ? 3 : 5) / safeScale;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();

    // A faint counter-toned line a little under the lip: the mass reads as
    // having a thickness, a crust over a body, rather than as one flat tone.
    ctx.strokeStyle = at(hatchTone, palette.dark ? 0.14 : 0.26);
    ctx.lineWidth = 1.5 / safeScale;
    const dy = 9 / safeScale;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y + dy);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y + dy);
    ctx.stroke();
  }

  // Gap-edge emphasis: only a genuine break between two chains — an actual
  // hole in the ground data — gets the bold vertical cut. The two extended
  // outer ends of the whole mass are not exposed (the fill keeps going past
  // the frame edge), so they never get a cut; a join between connected
  // slopes inside one chain was never a gap and never gets one either. Drawn
  // in `ink`, which means it is the darkest thing in the frame on light paper
  // and the brightest on dark — either way, the one mark that says "the
  // ground stops here", which is the single most important thing to read.
  ctx.strokeStyle = at(palette.ink, palette.dark ? 0.85 : 1);
  ctx.lineCap = "round";
  ctx.lineWidth = 7 / safeScale;
  const tickLen = 26 / safeScale;
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
//
// This is the only thing on screen the player made. It is drawn in `ink` at
// full strength on every palette — on the night level that makes the line the
// brightest thing in the frame, which is the right final statement for a game
// whose whole verb is drawing.
// ---------------------------------------------------------------------------
function drawInkPolyline(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  scale: number,
  palette: Palette,
): void {
  if (points.length < 2) return;
  const safeScale = scale > 1e-6 ? scale : 1e-6;
  const baseWidth = 5 / safeScale;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = at(palette.ink, 1);

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

export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  stub: Stroke | null,
  scale: number,
  palette: Palette,
): void {
  ctx.save();
  if (stub) drawInkPolyline(ctx, stub.points, scale, palette);
  for (const s of strokes) drawInkPolyline(ctx, s.points, scale, palette);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Pickups. One of only two things in the frame drawn in `accent`, and the
// player has no words to be told what it does — so the shape has to say
// "desirable" on its own: it floats clear of the ground, it glows, it breathes,
// and it wears the same rising nib mark as the ink bar it refills. Round,
// warm, haloed. The hazards below are the exact opposite in every one of those
// respects, deliberately.
//
// The bob and pulse are driven by `t`, never a per-frame re-roll, and each
// pickup's phase comes from its own position so a field of them doesn't pulse
// in lockstep like a HUD.
// ---------------------------------------------------------------------------
export function drawPickups(
  ctx: CanvasRenderingContext2D,
  level: Level,
  t: number,
  palette: Palette,
): void {
  ctx.save();

  for (const pickup of level.pickups) {
    if (pickup.taken) continue;

    const phase = pickup.pos.x * 0.017 + pickup.pos.y * 0.011;
    const bob = Math.sin(t * 2.2 + phase) * 4;
    const pulse = 0.85 + 0.15 * Math.sin(t * 3.1 + phase * 1.3);
    const cx = pickup.pos.x;
    const cy = pickup.pos.y + bob;
    const r = Math.max(1, PICKUP_RADIUS * 0.52 * pulse);

    // Glow: the "come and get this" signal, and the part that reads from far
    // enough away to be worth changing your line for.
    softDisc(ctx, cx, cy, PICKUP_RADIUS * 2.4, PICKUP_RADIUS * 2.4, palette.accent, 0.3 + 0.1 * pulse);

    // Halo ring — the same visual family as the ink bar's outline.
    ctx.save();
    ctx.strokeStyle = at(palette.accent, 0.45 + 0.25 * Math.sin(t * 3.1 + phase));
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, PICKUP_RADIUS * (0.92 + 0.1 * pulse), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Four short shine ticks. Nothing says "valuable" as cheaply as a
    // sparkle, and they cost four line segments.
    ctx.save();
    ctx.strokeStyle = at(palette.accent, 0.6);
    ctx.lineCap = "round";
    ctx.lineWidth = 2;
    const tick = PICKUP_RADIUS * (0.28 + 0.12 * pulse);
    const ringR = PICKUP_RADIUS * 1.18;
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI * 0.25 + (k * Math.PI) / 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(cx + dx * ringR, cy + dy * ringR);
      ctx.lineTo(cx + dx * (ringR + tick), cy + dy * (ringR + tick));
      ctx.stroke();
    }
    ctx.restore();

    // Core blot, in accent so it never reads as a piece of terrain.
    ctx.fillStyle = at(palette.accent, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // The nib mark across the blot, in `paper` — the tone guaranteed to
    // contrast with `accent` on every palette, including the inverted one,
    // because accent is chosen against the paper it sits on.
    ctx.strokeStyle = at(palette.paper, 0.92);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, r * 0.32);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy + r * 0.34);
    ctx.lineTo(cx, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.34);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Finish. It has to look like an END from further away than anything else in
// the frame, because it is the only thing the player is aiming at and nothing
// is allowed to tell them so. Four signals, all redundant on purpose: a
// standing beacon of accent light, a bar of accent painted across the ground
// at the line itself, a post that breaks the horizon, and a double pennant.
// Any one of them read alone still says "this is where you are going".
// ---------------------------------------------------------------------------
export function drawFinish(
  ctx: CanvasRenderingContext2D,
  level: Level,
  t: number,
  palette: Palette,
): void {
  const x = level.finishX;
  const groundY = level.groundY;
  const postH = 130;

  ctx.save();

  const pulse = 0.5 + 0.5 * Math.sin(t * 1.4);

  // The beacon: a tall soft column of accent standing on the line. This is
  // the part that carries across a whole screen of terrain.
  softDisc(ctx, x, groundY - postH * 0.62, 42 + pulse * 6, postH * 0.95, palette.accent, 0.2 + pulse * 0.08);

  // The line on the ground, painted across it: one crisp bar for the line
  // itself, sitting in a soft pool of the same colour so it does not read as
  // a rectangle someone dropped on the terrain.
  softDisc(ctx, x, groundY, 78, 15, palette.accent, 0.34);
  ctx.fillStyle = at(palette.accent, 0.92);
  ctx.fillRect(x - 34, groundY - 4, 68, 8);

  // The post. Ink, so it belongs to the same family as everything drawn.
  ctx.strokeStyle = at(palette.ink, 1);
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, groundY);
  ctx.lineTo(x, groundY - postH);
  ctx.stroke();

  // Two pennants rather than one: a pair reads as a marker, a single triangle
  // reads as a random shape on a stick.
  const flutter = Math.sin(t * 4.0) * 0.15;
  ctx.fillStyle = at(palette.accent, 1);
  for (let k = 0; k < 2; k++) {
    const top = groundY - postH + k * 34;
    const reach = 34 - k * 8;
    const f = flutter * (1 - k * 0.35);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + reach + f * 12, top + 13 + f * 7);
    ctx.lineTo(x, top + 27);
    ctx.closePath();
    ctx.fill();
  }

  // A bead of accent capping the post, so the top of it is a point and not a
  // cut-off line.
  ctx.beginPath();
  ctx.arc(x, groundY - postH, 5.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Spike fields. A run of sharp teeth standing on the ground. The player has no
// words to be warned with, so the shape has to say "do not touch this" on its
// own: hard points, no curves anywhere, mounted on a plinth, and lit from
// below by a band of accent that reads as a hot zone rather than as scenery.
//
// The body is `terrain` — the same tone as the land, so the teeth silhouette
// hard against the SKY, which is what makes them legible at the phone
// viewport. Only the tips and the rim carry `accent`. A gap says "you drew too
// little"; these say "you drew too low".
// ---------------------------------------------------------------------------
export function drawHazards(
  ctx: CanvasRenderingContext2D,
  level: Level,
  t: number,
  palette: Palette,
): void {
  if (level.hazards.length === 0) return;
  ctx.save();
  ctx.lineJoin = "miter";

  for (const h of level.hazards) {
    const toothW = 17;
    const count = Math.max(3, Math.round(h.width / toothW));
    const w = h.width / count;
    // A slow shimmer so they read as live and dangerous rather than as
    // scenery. Deterministic in `t` and the hazard's own x, never re-rolled.
    const pulse = 1 + Math.sin(t * 2.2 + h.x * 0.01) * 0.045;
    const tipY = h.y - SPIKE_HEIGHT * pulse;

    // Warning wash: a pool of danger colour around the field. A gradient
    // RECT was the obvious way to do this and it was wrong — the wash showed
    // its own hard vertical edges in the sky above the teeth, a translucent
    // box floating in the frame. A soft ellipse has no edges to show.
    softDisc(
      ctx,
      h.x + h.width * 0.5,
      h.y - SPIKE_HEIGHT * 0.35,
      h.width * 0.62 + SPIKE_HEIGHT,
      SPIKE_HEIGHT * 2.1,
      palette.accent,
      0.22,
    );

    // The teeth: one walked path, one fill, so neighbouring teeth share
    // edges instead of stacking.
    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    for (let i = 0; i < count; i++) {
      const x0 = h.x + i * w;
      ctx.lineTo(x0 + w / 2, tipY);
      ctx.lineTo(x0 + w, h.y);
    }
    ctx.closePath();
    ctx.fillStyle = at(palette.terrain, 1);
    ctx.fill();
    // A hot rim on the same path — the danger colour tracing every point.
    ctx.strokeStyle = at(palette.accent, 0.95);
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Accent tips: the top third of each tooth, filled. Points that look
    // sharpened.
    ctx.fillStyle = at(palette.accent, 1);
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x0 = h.x + i * w;
      const cut = 0.55; // fraction of the way up where the tip starts
      const lx = x0 + (w / 2) * (1 - cut);
      const rx = x0 + w - (w / 2) * (1 - cut);
      const ly = h.y + (tipY - h.y) * cut;
      ctx.moveTo(lx, ly);
      ctx.lineTo(x0 + w / 2, tipY);
      ctx.lineTo(rx, ly);
      ctx.closePath();
    }
    ctx.fill();

    // A base plinth, so the teeth read as mounted rather than floating, with
    // an accent underline across it.
    ctx.fillStyle = at(palette.terrain, 1);
    ctx.fillRect(h.x - 4, h.y - 3, h.width + 8, 8);
    ctx.fillStyle = at(palette.accent, 0.85);
    ctx.fillRect(h.x - 4, h.y + 3, h.width + 8, 2.5);
  }
  ctx.restore();
}
