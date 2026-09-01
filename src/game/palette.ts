// The single source of colour truth. Every module that puts a pixel down
// reads its colours from here and from nowhere else.
//
// WHY THIS FILE EXISTS
//
// The game shipped strictly monochrome: one navy, one cream, and depth done
// purely by stacking alpha. Two things went wrong with that. Distant terrain
// composited to the same flat mid-grey at every level, so four levels with
// four different silhouette families still read as one place; and with no
// horizon colour there was nothing to look at above the ground line, which
// left roughly two thirds of the frame empty at both marked viewports.
//
// The fix keeps the ink-on-paper premise — your line is ink, the world is
// drawn on paper — and gives each level its own paper and its own light.
// Arriving at a new level is then visible in the first frame, before a single
// piece of terrain has been read. That matters under this brief specifically:
// nothing on screen is allowed to say "level 2", so the light has to.
//
// ROLES, NOT LITERAL COLOURS
//
// The obvious shape for this file — an `ink` and a `paper` per level — breaks
// on the night level, where the marks the player makes are LIGHTER than the
// ground they sit on. So colours are named by the job they do:
//
//   paper    the sky and page behind everything
//   terrain  the solid ground mass and the parallax silhouettes cut from it
//   ink      the player's strokes, the figures, the brush, the HUD marks
//   accent   pickups and the finish, the two things the player wants to reach
//
// On the three daylight levels `terrain` and `ink` are near-identical dark
// values and the distinction costs nothing. On the night level they invert
// independently: near-black ground, cream ink. Anything that hardcodes
// "dark mark on light background" will be wrong there, which is exactly the
// bug this shape is here to make impossible.

/** A colour carried as both a CSS string and its "r,g,b" triple, so callers
 *  can composite at any alpha without re-parsing hex at draw time. */
export type Tone = { css: string; rgb: string };

function tone(r: number, g: number, b: number): Tone {
  return {
    css: `rgb(${r},${g},${b})`,
    rgb: `${r},${g},${b}`,
  };
}

/** `tone` at an alpha. Clamped, because a computed alpha that slips outside
 *  [0,1] produces an invalid colour string and canvas silently keeps the
 *  PREVIOUS fillStyle — a failure that shows up as one shape wearing another
 *  shape's colour, with nothing thrown to point at it. */
export function at(t: Tone, alpha: number): string {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${t.rgb},${a})`;
}

/** The silhouette family of the near parallax layer. Each level gets its own,
 *  so the shape of the horizon is a second, redundant signal of which level
 *  this is — redundant on purpose, since colour alone fails anyone who cannot
 *  separate these hues. */
export type SkylineShape = "hills" | "skyline" | "peaks" | "spires";

export type Palette = {
  /** Sky and page base. */
  paper: Tone;
  /** Top of the sky wash — the colour the sky tends toward overhead. */
  skyTop: Tone;
  /** Horizon glow — the colour the sky tends toward at the ground line. This
   *  is what fills the dead space the monochrome build left empty. */
  skyHorizon: Tone;
  /** The ground mass and every silhouette layer cut against the sky. */
  terrain: Tone;
  /** The player's marks: strokes, figures, brush, HUD. */
  ink: Tone;
  /** Pickups and the finish. */
  accent: Tone;

  /** Opacity of the sky wash at the top of the frame. */
  topAlpha: number;
  /** Opacity of the horizon glow where it meets the ground line. */
  horizonAlpha: number;
  /** Terrain opacity in each parallax band. Far is palest (haze eats
   *  contrast with distance); near is nearly solid. The mid band is new —
   *  two layers left a visible step between "far pale" and "near dark", and
   *  the step is what made the background read as cut paper rather than as
   *  distance. */
  farAlpha: number;
  midAlpha: number;
  nearAlpha: number;

  shape: SkylineShape;

  /** True where the paper is darker than the ink. Callers that need to lift
   *  something OFF the background (a glow, a highlight, a rim) must reverse
   *  direction here: on light paper you deepen toward terrain, on dark paper
   *  you lift toward ink. Nothing else in the palette encodes that, because
   *  the right answer differs per effect. */
  dark: boolean;
};

// ---------------------------------------------------------------------------
// The four levels' light. Ordered as a day: first light, flat overcast,
// low sun, then night. Value contrast climbs across the set in step with
// difficulty, so the world gets harder to read exactly as the terrain gets
// harder to cross.
// ---------------------------------------------------------------------------
const PALETTES: readonly Palette[] = [
  // 0 — DAWN. Warm paper under a cool pale sky, low contrast, nothing
  // threatening. This is the level that has to teach the verb, so the
  // background is deliberately the quietest of the four: the eye should go to
  // the runner, the gap and the demonstrating brush, not to the horizon.
  {
    paper: tone(247, 241, 230),
    skyTop: tone(206, 216, 228),
    skyHorizon: tone(246, 219, 184),
    terrain: tone(43, 39, 57),
    ink: tone(34, 32, 46),
    accent: tone(200, 118, 60),
    topAlpha: 0.5,
    horizonAlpha: 0.75,
    farAlpha: 0.14,
    midAlpha: 0.3,
    nearAlpha: 0.62,
    shape: "hills",
    dark: false,
  },
  // 1 — OVERCAST. Cool, flat, the light drained out of it. Rooftops. The
  // narrowest value range of the four on purpose: a grey day flattens depth,
  // and the level's difficulty comes from reading structure in poor light.
  {
    paper: tone(233, 237, 241),
    skyTop: tone(184, 198, 211),
    skyHorizon: tone(223, 230, 235),
    terrain: tone(31, 42, 55),
    ink: tone(22, 32, 43),
    accent: tone(64, 132, 134),
    topAlpha: 0.62,
    horizonAlpha: 0.5,
    farAlpha: 0.17,
    midAlpha: 0.36,
    nearAlpha: 0.72,
    shape: "skyline",
    dark: false,
  },
  // 2 — DUSK. Low sun behind high country: a hot horizon under a mauve sky,
  // the strongest contrast of the three daylight levels. Peaks read almost
  // black against the glow, which is what makes the silhouette legible at the
  // phone viewport where everything is small.
  {
    paper: tone(244, 227, 208),
    skyTop: tone(146, 118, 140),
    skyHorizon: tone(245, 186, 126),
    terrain: tone(48, 32, 42),
    ink: tone(40, 27, 35),
    accent: tone(184, 69, 47),
    topAlpha: 0.72,
    horizonAlpha: 0.86,
    farAlpha: 0.22,
    midAlpha: 0.45,
    nearAlpha: 0.85,
    shape: "peaks",
    dark: false,
  },
  // 3 — NIGHT, and the only inverted palette. Cream ink on a dark world: the
  // line you draw is the brightest thing on screen, which is the right final
  // statement for a game whose whole verb is drawing. Ground is near-black
  // against an indigo sky so the terrain silhouette still reads, and the
  // horizon carries a cold skyglow rather than going flat black — a flat
  // black sky would put the frame right back to the dead space this palette
  // was written to fix.
  {
    paper: tone(23, 27, 43),
    skyTop: tone(11, 14, 25),
    skyHorizon: tone(58, 66, 102),
    terrain: tone(12, 15, 30),
    ink: tone(242, 234, 216),
    accent: tone(127, 214, 196),
    topAlpha: 0.8,
    horizonAlpha: 0.9,
    farAlpha: 0.5,
    midAlpha: 0.72,
    nearAlpha: 0.95,
    shape: "spires",
    dark: true,
  },
];

export const PALETTE_COUNT = PALETTES.length;

/** Total: every integer — negative, fractional, past the end of the set, or
 *  not a number at all — maps onto a valid palette index. The campaign wraps
 *  rather than running out, and a NaN level index (which has happened, from a
 *  restart racing a resize) must not blank the screen. */
export function paletteIndex(levelIndex: number): number {
  const n = PALETTES.length;
  const i = Number.isFinite(levelIndex) ? Math.trunc(levelIndex) : 0;
  return ((i % n) + n) % n;
}

export function paletteFor(levelIndex: number): Palette {
  return PALETTES[paletteIndex(levelIndex)];
}
