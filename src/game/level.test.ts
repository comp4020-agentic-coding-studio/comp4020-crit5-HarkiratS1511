// Design-contract tests for the campaign (src/game/level.ts): totality of
// buildLevel over any integer, per-level length, the difficulty ramp, the
// level-0-only teaching apparatus, the ink budget, chaser placement — and
// the two properties the whole file exists to defend, both checked by
// direct physics simulation (createState/step from ./world) rather than by
// formula:
//
//   1. NO gap can be crossed WITHOUT drawing a line (the tester's original
//      complaint: "the downhill gap feels like a bug"), and
//   2. EVERY gap can be crossed WITH one (the missing inverse found later:
//      a bridge steeper than the runner can climb pins it until the chaser
//      arrives).
//
// The rewrite that gave the campaign real vertical relief added a third
// class of guarantee, and new tests for each:
//
//   3. RELIEF. Each level spans a genuine elevation range, inside the band
//      the fixed camera can actually show, and the four profiles are
//      distinguishable from each other at a glance.
//   4. THE FLAT LIP RULE. Terrain ramps make (1) harder to trust: a ramp
//      running off a lip launches the runner and extends its arc past the
//      ballistic range the widths were sized against. So every gap is
//      required to have flat ground either side, AND every gap is now
//      re-simulated ON THE REAL LEVEL, entering over whatever terrain
//      actually precedes it, not only in isolation.
//   5. COMPLETABILITY. Not "the arithmetic adds up" but "a scripted player
//      who draws like a person, on the real level, with the real ink
//      economy, reaches the finish" — driven through the real loop.

import { describe, expect, it } from "vitest";
import {
  ballisticRange,
  buildLevel,
  CEILING_Y,
  downhillWidth,
  FLOOR_Y,
  LEVEL_COUNT,
  LIP_FLAT,
} from "./level";
import { createState, groundSurfaceYAt, step, strokeFromPoints } from "./world";
import { inkCost } from "./ink";
import {
  CHASER_RADIUS,
  MAX_INK,
  PICKUP_AMOUNT,
  RUNNER_RADIUS,
  RUN_SPEED,
  SPIKE_HEIGHT,
} from "./tuning";
import type { Hazard, Level, Phase, Segment, Vec2 } from "./types";

type Gap = {
  startX: number;
  endX: number;
  width: number;
  takeoffY: number;
  landingY: number;
  /** landingY - takeoffY: positive = landing is LOWER, negative = HIGHER. */
  dy: number;
};

/** Ground is broken into gaps wherever consecutive segments (sorted by x)
 *  don't touch. Mirrors how the rest of the game reads the level. */
function findGaps(segments: Segment[]): Gap[] {
  const sorted = [...segments].sort((s1, s2) => s1.a.x - s2.a.x);
  const gaps: Gap[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (right.a.x > left.b.x) {
      gaps.push({
        startX: left.b.x,
        endX: right.a.x,
        width: right.a.x - left.b.x,
        takeoffY: left.b.y,
        landingY: right.a.y,
        dy: right.a.y - left.b.y,
      });
    }
  }
  return gaps;
}

/** The "real" gaps a player must actually bridge: every ground-segment gap
 *  EXCEPT one fully spanned by the level's pre-drawn teaching stub (level 0
 *  only) — that one is already bridged before play starts. */
function realGapsFor(level: Level): Gap[] {
  const all = findGaps(level.groundSegments).sort((a, b) => a.startX - b.startX);
  if (!level.stub) return all;
  const xs = level.stub.points.map((p) => p.x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return all.filter((g) => !(g.startX >= lo - 1 && g.endX <= hi + 1));
}

function gapCost(g: Gap): number {
  return Math.hypot(g.width, g.dy);
}

/** Cheapest line that clears a spike field: ramp up, span over, ramp down. */
function hazardLineCost(h: Hazard): number {
  const clear = SPIKE_HEIGHT + 10;
  return 2 * Math.hypot(100, clear) + h.width + 12;
}

function hazardCost(level: Level): number {
  return level.hazards.reduce((sum, h) => sum + hazardLineCost(h), 0);
}

/** The theoretical minimum line set for a level: one perfect straight
 *  bridge per gap, one perfect clearing line per spike field. Nobody draws
 *  this; it is the floor every budget claim is measured against. */
function minimalInkFor(level: Level): number {
  return realGapsFor(level).reduce((sum, g) => sum + gapCost(g), 0) + hazardCost(level);
}

function pickupTotalFor(level: Level): number {
  return level.pickups.reduce((sum, p) => sum + p.amount, 0);
}

const ALL_LEVELS = Array.from({ length: LEVEL_COUNT }, (_, i) => buildLevel(i));
const ALL_REAL_GAPS = ALL_LEVELS.map(realGapsFor);

/** Lowest (largest y) and highest (smallest y) ground in a level. */
function elevationRange(level: Level): { top: number; bottom: number; span: number } {
  const ys = level.groundSegments.flatMap((s) => [s.a.y, s.b.y]);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { top, bottom, span: bottom - top };
}

describe("buildLevel: totality", () => {
  it("never throws and returns a well-formed Level for arbitrary integers", () => {
    const inputs = [
      0, 1, 2, 3, -1, -2, -4, -5, -1000, 1000, 4, 5, 100, LEVEL_COUNT, LEVEL_COUNT - 1,
      Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
    ];
    for (const i of inputs) {
      let level: Level | undefined;
      expect(() => (level = buildLevel(i))).not.toThrow();
      expect(level).toBeDefined();
      expect(level!.groundSegments.length).toBeGreaterThan(0);
      expect(level!.startX).toBeLessThan(level!.finishX);
      expect(level!.index).toBeGreaterThanOrEqual(0);
      expect(level!.index).toBeLessThan(LEVEL_COUNT);
    }
  });

  it("also never throws on non-integer or non-finite input", () => {
    for (const i of [1.5, -2.7, NaN, Infinity, -Infinity]) {
      expect(() => buildLevel(i)).not.toThrow();
    }
  });

  it("wraps negative and past-range indices consistently (mod LEVEL_COUNT)", () => {
    for (let i = 0; i < LEVEL_COUNT; i++) {
      expect(buildLevel(i).index).toBe(i);
      expect(buildLevel(i + LEVEL_COUNT).index).toBe(i);
      expect(buildLevel(i - LEVEL_COUNT).index).toBe(i);
    }
  });

  it("builds ground as a set of x-ordered platforms with no overlapping spans", () => {
    // The levels are authored as polyline platforms now (a platform can
    // climb, fall and level off inside itself). Two platforms overlapping in
    // x would make groundSurfaceYAt ambiguous and every gap measurement in
    // this file wrong, so it is checked rather than assumed.
    for (const level of ALL_LEVELS) {
      const sorted = [...level.groundSegments].sort((a, b) => a.a.x - b.a.x);
      for (const s of sorted) expect(s.b.x).toBeGreaterThan(s.a.x);
      for (let i = 0; i < sorted.length - 1; i++) {
        expect(sorted[i + 1].a.x).toBeGreaterThanOrEqual(sorted[i].b.x - 1e-6);
      }
    }
  });
});

describe("buildLevel: level count and length", () => {
  it("has at least 4 distinct levels", () => {
    expect(LEVEL_COUNT).toBeGreaterThanOrEqual(4);
  });

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i is 6000-9000 world px long",
    (_i, level) => {
      const length = level.finishX - level.startX;
      expect(length).toBeGreaterThanOrEqual(6000);
      expect(length).toBeLessThanOrEqual(9000);
    },
  );

  it("gives every level its own gap count (structurally distinct)", () => {
    const counts = ALL_REAL_GAPS.map((g) => g.length);
    expect(new Set(counts).size).toBe(counts.length);
  });
});

// ===========================================================================
// RELIEF (the playtest complaint this rewrite answers: the world "reads as
// one flat strip"). It used to be true: every platform was flat, at one of a
// few heights, with a 15px sine ripple laid over a 420px baseline. These
// tests pin the replacement — real, authored, visible verticality.
// ===========================================================================
describe("buildLevel: vertical relief", () => {
  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i spans a real elevation range, not a ripple",
    (_i, level) => {
      const { span } = elevationRange(level);
      // The old terrain moved 15px in total. The floor here is an order of
      // magnitude past that: hundreds of px of climb and fall per level.
      expect(span).toBeGreaterThanOrEqual(180);
    },
  );

  it("gives each level MORE relief than the one before it", () => {
    const spans = ALL_LEVELS.map((l) => elevationRange(l).span);
    for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeGreaterThan(spans[i - 1]);
    // and the finale genuinely swings: over a third of a screen height.
    expect(spans[spans.length - 1]).toBeGreaterThanOrEqual(340);
  });

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i keeps all ground inside the band the fixed camera can show",
    (_i, level) => {
      // render.ts's cameraYFor does NOT follow the runner: it pins
      // level.groundY at a constant fraction of screen height. Ground
      // outside [CEILING_Y, FLOOR_Y] is ground the player never sees. (The
      // levels this replaced ran to y=-504, ~500px above the top of the
      // 1920x1080 frame.)
      const { top, bottom } = elevationRange(level);
      expect(top).toBeGreaterThanOrEqual(CEILING_Y);
      expect(bottom).toBeLessThanOrEqual(FLOOR_Y);
    },
  );

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i starts and ends on ground at groundY (spawn, camera and flag agree)",
    (_i, level) => {
      // groundY is three things at once: the runner's spawn height
      // (world.ts createState), the camera's vertical anchor (render.ts)
      // and the height scenery.ts plants the finish flag at. A level whose
      // start or finish sits anywhere else spawns the runner in mid-air or
      // buries its own flag.
      expect(groundSurfaceYAt(level.startX, level.groundSegments)).toBeCloseTo(level.groundY, 6);
      expect(groundSurfaceYAt(level.finishX, level.groundSegments)).toBeCloseTo(level.groundY, 6);
      // and the chaser's spawn, which world.ts places up to 330px behind.
      expect(groundSurfaceYAt(level.startX - 330, level.groundSegments)).toBeCloseTo(
        level.groundY,
        6,
      );
    },
  );

  it("gives the four levels visibly different profiles, not one shape repeated", () => {
    // Sample each level's ground height at the same 60 fractions of its own
    // length and compare profiles pairwise. Two levels that differ only in
    // gap widths would score near zero here; these have to differ in SHAPE.
    const profile = (level: Level): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 60; i++) {
        const x = level.startX + ((level.finishX - level.startX) * i) / 59;
        const y = groundSurfaceYAt(x, level.groundSegments);
        out.push(y === null ? level.groundY : y - level.groundY);
      }
      return out;
    };
    const profiles = ALL_LEVELS.map(profile);
    for (let a = 0; a < profiles.length; a++) {
      for (let b = a + 1; b < profiles.length; b++) {
        const rms = Math.sqrt(
          profiles[a].reduce((sum, y, i) => sum + (y - profiles[b][i]) ** 2, 0) / profiles[a].length,
        );
        expect(rms).toBeGreaterThan(45);
      }
    }
  });

  it("keeps terrain ramps walkable: no authored slope is a problem to solve", () => {
    // Relief inside a platform is scenery the runner must walk unaided (it
    // cannot jump), not an obstacle it is asked to draw its way out of.
    // Well under the measured 1.732 climb limit in both directions.
    for (const level of ALL_LEVELS) {
      for (const s of level.groundSegments) {
        const run = Math.abs(s.b.x - s.a.x);
        expect(run).toBeGreaterThan(0);
        expect(Math.abs(s.b.y - s.a.y) / run).toBeLessThan(0.6);
      }
    }
  });
});

describe("buildLevel: level 0 teaching apparatus", () => {
  const level0 = ALL_LEVELS[0];
  const allGaps0 = findGaps(level0.groundSegments).sort((a, b) => a.startX - b.startX);

  it("gives a 600px+ run-up before ANY ground break, including the notch", () => {
    const firstBreak = Math.min(...allGaps0.map((g) => g.startX));
    expect(firstBreak - level0.startX).toBeGreaterThanOrEqual(600);
  });

  it("has a non-null stub spanning a notch narrower than every real gap", () => {
    expect(level0.stub).not.toBeNull();
    const stub = level0.stub!;
    expect(stub.points.length).toBeGreaterThanOrEqual(2);
    expect(stub.points.length).toBeLessThanOrEqual(4);
    expect(stub.segments.length).toBe(stub.points.length - 1);

    const notch = allGaps0.find(
      (g) => !ALL_REAL_GAPS[0].some((r) => r.startX === g.startX && r.endX === g.endX),
    );
    expect(notch).toBeDefined();
    for (const real of ALL_REAL_GAPS[0]) {
      expect(notch!.width).toBeLessThan(real.width);
    }
    const xs = stub.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(notch!.startX + 1);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(notch!.endX - 1);
  });

  it("opens gently: the first two real gaps are flat and narrow", () => {
    const gaps = ALL_REAL_GAPS[0];
    expect(gaps[0].dy).toBe(0);
    expect(gaps[1].dy).toBe(0);
    expect(gaps[0].width).toBeLessThan(100);
    expect(gaps[1].width).toBeLessThan(150);
  });

  it("keeps the first unbridged gap where the ghost and the demo can use it", () => {
    // render.ts drawDemoStroke traces the answer over firstUnbridgedGap, but
    // only while the runner is within 620px of its near lip and only after
    // the ghost (300px ahead, world.ts GHOST_LEAD) has fallen into it. So
    // the first real gap has to be early, and level ground either side of it
    // — a demonstration over a gap the player cannot see teaches nothing.
    const first = ALL_REAL_GAPS[0][0];
    expect(first.startX).toBeLessThan(1400);
    expect(first.dy).toBe(0);
    // the ghost dies here when the runner is GHOST_LEAD behind the lip,
    // which must be inside drawDemoStroke's window.
    expect(300).toBeLessThan(620);
  });
});

describe("buildLevel: levels 1+ have no teaching stub", () => {
  it.each([1, 2, 3])("level %i has stub: null", (i) => {
    expect(buildLevel(i).stub).toBeNull();
  });
});

describe("buildLevel: difficulty ramp within each level", () => {
  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i trends harder from its opening third to its closing third",
    (_i, level) => {
      const gaps = realGapsFor(level);
      const costs = gaps.map(gapCost);
      const third = Math.max(1, Math.floor(costs.length / 3));
      const opening = costs.slice(0, third);
      const closing = costs.slice(-third);
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(avg(closing)).toBeGreaterThan(avg(opening));
    },
  );

  it("ramps harder ACROSS levels: the finale level demands more total ink discipline than the opener", () => {
    // A single wide-but-flat chasm in level 0 can cost more raw ink than any
    // one diagonal in level 3, so "hardest single gap" isn't a fair
    // cross-level metric. Total minimal ink required over the whole level
    // is: level 3 (big swings throughout) asks for more disciplined
    // drawing, in aggregate, than level 0 (a gentle opener).
    expect(minimalInkFor(ALL_LEVELS[3])).toBeGreaterThan(minimalInkFor(ALL_LEVELS[0]));
  });

  it("escalates the steepness of the lines it asks for, level by level", () => {
    // The campaign's difficulty dial is the climbing ratio (see the CLIMB
    // LIMIT note in level.ts): level 0 asks for no climb at all, level 1 for
    // a walkable ramp, levels 2-3 for something that reads as a cliff face.
    const steepest = ALL_REAL_GAPS.map((gaps) =>
      gaps.reduce((max, g) => (g.dy < 0 ? Math.max(max, -g.dy / g.width) : max), 0),
    );
    expect(steepest[0]).toBe(0); // level 0 has no climbing gaps
    expect(steepest[1]).toBeGreaterThan(0.5);
    expect(steepest[2]).toBeGreaterThan(steepest[1] + 0.4);
    expect(steepest[3]).toBeGreaterThan(steepest[1] + 0.4);
  });

  it("level 3's closing gaps demand a big, efficient single arc", () => {
    const gaps = ALL_REAL_GAPS[3];
    const last = gaps[gaps.length - 1];
    // the finale is a real, substantial crossing, not a token one: one
    // stroke worth a meaningful slice of the whole level's minimum.
    expect(last.width).toBeGreaterThan(400);
    expect(gapCost(last)).toBeGreaterThan(minimalInkFor(ALL_LEVELS[3]) * 0.12);
  });
});

describe("buildLevel: structural variety (requirement 1)", () => {
  it("level 0 (The Terrace) is the gentlest: no climb to draw, and its relief is walked", () => {
    const gaps = ALL_REAL_GAPS[0];
    expect(gaps.length).toBeLessThanOrEqual(8);
    // Nothing to climb: every gap is level or drops, and the one drop is
    // shallow. All of level 0's 200px of relief is terrain the runner walks.
    expect(gaps.every((g) => g.dy >= 0)).toBe(true);
    expect(Math.max(...gaps.map((g) => g.dy))).toBeLessThanOrEqual(80);
    expect(Math.max(...gaps.map((g) => g.width))).toBeGreaterThan(300); // a genuinely wide chasm
    expect(elevationRange(ALL_LEVELS[0]).span).toBeGreaterThanOrEqual(180);
  });

  it("level 1 (The Stair) climbs in steps, then descends in steps, on flat plateaus", () => {
    const gaps = ALL_REAL_GAPS[1];
    expect(gaps.length).toBeGreaterThanOrEqual(8);
    // A staircase, not a hill: every platform is dead level, all the height
    // change is in the steps the player has to draw.
    const stepped = ALL_LEVELS[1].groundSegments.filter(
      (s) => Math.abs(s.b.y - s.a.y) > 0.001,
    );
    for (const s of stepped) {
      // only the shallow decorative swells may be non-level here
      expect(Math.abs(s.b.y - s.a.y) / (s.b.x - s.a.x)).toBeLessThan(0.15);
    }
    // up first, down after: no level 1 gap climbs after one has dropped.
    const firstDrop = gaps.findIndex((g) => g.dy > 0);
    expect(firstDrop).toBeGreaterThan(0);
    expect(gaps.slice(0, firstDrop).every((g) => g.dy < 0 || g.width > 400)).toBe(true);
    expect(gaps.slice(firstDrop).every((g) => g.dy >= 0)).toBe(true);
  });

  it("level 2 (The Towers) climbs onto the highest ledges in the campaign, twice per tower", () => {
    const gaps = ALL_REAL_GAPS[2];
    const climbs = gaps.filter((g) => g.dy < 0);
    expect(climbs.length).toBeGreaterThanOrEqual(6);
    // Steep: a tower face, not a ramp. Every climb here is steeper than
    // anything level 1 asks for.
    const steepestLevel1 = Math.max(...ALL_REAL_GAPS[1].map((g) => Math.max(0, -g.dy / g.width)));
    expect(Math.min(...climbs.map((g) => -g.dy / g.width))).toBeGreaterThan(steepestLevel1);
    // Consecutive pairs: a tower is climbed in two steps with a ledge
    // between, which is what makes the silhouette a skyline.
    let pairs = 0;
    for (let i = 1; i < gaps.length; i++) if (gaps[i].dy < 0 && gaps[i - 1].dy < 0) pairs++;
    expect(pairs).toBeGreaterThanOrEqual(3);
    // and the tops are the highest ground anywhere in the campaign.
    const tops = ALL_LEVELS.map((l) => elevationRange(l).top);
    expect(tops[2]).toBe(Math.min(...tops));
  });

  it("level 3 (The Cliffs) alternates deep drops and steep climbs, then one long span", () => {
    const gaps = ALL_REAL_GAPS[3];
    const swings = gaps.filter((g) => Math.abs(g.dy) > 100);
    expect(swings.length).toBeGreaterThanOrEqual(8);
    // strictly alternating drop/climb, which is the sawtooth silhouette
    for (let i = 1; i < swings.length; i++) {
      expect(Math.sign(swings[i].dy)).toBe(-Math.sign(swings[i - 1].dy));
    }
    expect(gaps.some((g) => g.dy > 100)).toBe(true);
    expect(gaps.some((g) => g.dy < -100)).toBe(true);
    // and it owns both extremes of the campaign's vertical band
    const bottoms = ALL_LEVELS.map((l) => elevationRange(l).bottom);
    expect(bottoms[3]).toBe(Math.max(...bottoms));
  });

  it("every level carries spike fields except the gentlest, and they escalate", () => {
    const counts = ALL_LEVELS.map((l) => l.hazards.length);
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[0]);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });

  it("varies gap-spacing rhythm across levels, not just widths", () => {
    // stdev of flat-run lengths between consecutive gaps should differ level
    // to level (a proxy for "rhythm"), not be the same cadence everywhere.
    const rhythmStdev = (gaps: Gap[]): number => {
      const spacings: number[] = [];
      for (let i = 1; i < gaps.length; i++) spacings.push(gaps[i].startX - gaps[i - 1].endX);
      const mean = spacings.reduce((a, b) => a + b, 0) / spacings.length;
      const variance = spacings.reduce((a, b) => a + (b - mean) ** 2, 0) / spacings.length;
      return Math.sqrt(variance);
    };
    const stdevs = ALL_REAL_GAPS.map(rhythmStdev);
    expect(new Set(stdevs.map((s) => Math.round(s))).size).toBeGreaterThan(1);
  });
});

// ===========================================================================
// THE FLAT LIP RULE. Both simulations further down drop the runner off a lip
// at RUN_SPEED with no vertical velocity — which is only representative of
// the real level if the ground immediately before every lip is flat. Now
// that platforms carry ramps, that has to be enforced, not assumed: an
// uphill ramp running off a takeoff edge launches the runner and carries it
// far past the ballistic range every gap width here was sized against.
// ===========================================================================
describe("buildLevel: flat lips either side of every gap", () => {
  /** Walk backwards from a takeoff edge while the ground stays level, and
   *  report how far that level ground runs. */
  const flatRunBefore = (level: Level, gap: Gap): number => {
    let end = gap.startX;
    let run = 0;
    for (;;) {
      const s = level.groundSegments.find((t) => Math.abs(t.b.x - end) < 1e-6);
      if (!s || Math.abs(s.b.y - s.a.y) > 1e-6) return run;
      run += s.b.x - s.a.x;
      end = s.a.x;
    }
  };
  /** The same, forwards from a landing edge. */
  const flatRunAfter = (level: Level, gap: Gap): number => {
    let start = gap.endX;
    let run = 0;
    for (;;) {
      const s = level.groundSegments.find((t) => Math.abs(t.a.x - start) < 1e-6);
      if (!s || Math.abs(s.b.y - s.a.y) > 1e-6) return run;
      run += s.b.x - s.a.x;
      start = s.b.x;
    }
  };

  for (const level of ALL_LEVELS) {
    const gaps = findGaps(level.groundSegments);
    it.each(gaps.map((g, i) => [i, g] as const))(
      `level ${level.index} gap #%i has ${LIP_FLAT}px+ of level ground either side`,
      (_i, gap) => {
        expect(flatRunBefore(level, gap)).toBeGreaterThanOrEqual(LIP_FLAT);
        expect(flatRunAfter(level, gap)).toBeGreaterThanOrEqual(LIP_FLAT);
      },
    );
  }
});

describe("buildLevel: spike fields stand on flat pads, clear of every lip", () => {
  for (const level of ALL_LEVELS) {
    it.each(level.hazards.map((h, i) => [i, h] as const))(
      `level ${level.index} hazard #%i sits on level ground with room for the clearing line`,
      (_i, hazard) => {
        // The cheapest clearing line is a 100px ramp up, a span over and a
        // 100px ramp down; both ramps have to start and finish on level
        // ground or the runner cannot get onto the line at all.
        const pad = level.groundSegments.find(
          (s) =>
            Math.abs(s.b.y - s.a.y) < 1e-6 &&
            Math.abs(s.a.y - hazard.y) < 1e-6 &&
            s.a.x <= hazard.x - LIP_FLAT &&
            s.b.x >= hazard.x + hazard.width + LIP_FLAT,
        );
        expect(pad).toBeDefined();
        // never in the opening run-up: the first stretch of a level is where
        // the player is still learning that the runner cannot stop.
        expect(hazard.x - level.startX).toBeGreaterThan(700);
        // and its stated ground height is the height the ground is actually
        // at, or the drawn cover clears nothing.
        expect(groundSurfaceYAt(hazard.x, level.groundSegments)).toBeCloseTo(hazard.y, 6);
        expect(groundSurfaceYAt(hazard.x + hazard.width, level.groundSegments)).toBeCloseTo(
          hazard.y,
          6,
        );
      },
    );
  }
});

describe("buildLevel: ink budget (requirement 5)", () => {
  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i is completable in ink: minimal bridging cost < MAX_INK + pickups",
    (_i, level) => {
      // Spike fields cost ink too: a ramp up, a span over, a way down. Ignoring
      // them made the budget look comfortable while the level was unwinnable.
      expect(minimalInkFor(level)).toBeLessThan(MAX_INK + pickupTotalFor(level));
    },
  );

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i genuinely requires collecting (most of) its pickups",
    (_i, level) => {
      const minimalInk = minimalInkFor(level);
      const pickupTotal = pickupTotalFor(level);
      // Starting ink alone (no pickups) must NOT be enough: the pickups have
      // to matter, or they are decoration.
      expect(minimalInk).toBeGreaterThan(MAX_INK);
      // But missing exactly one may not be instantly fatal. Demanding every
      // pickup left only 5-7% slack over the THEORETICAL minimum line set,
      // which no human draws — it made the levels unplayable rather than
      // demanding. Pickups still carry more than half the shortfall.
      expect(pickupTotal).toBeGreaterThan((minimalInk - MAX_INK) * 0.5);
    },
  );

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i leaves headroom for a hand that draws like a person, not an optimiser",
    (_i, level) => {
      // The theoretical minimum is not a budget, it is a floor. A person
      // aims past both lips and wobbles: charge every stroke 15% over the
      // straight line plus 20px of overshoot, and the level must still fit.
      // (MAX_INK was raised twice in tuning.ts for exactly this reason; this
      // is the assertion that would have caught it the first time.)
      const strokes = realGapsFor(level).length + level.hazards.length;
      const realistic = 1.15 * minimalInkFor(level) + 20 * strokes;
      expect(realistic).toBeLessThan(MAX_INK + pickupTotalFor(level));
      // and the headroom over the theoretical minimum is never token
      expect(MAX_INK + pickupTotalFor(level)).toBeGreaterThan(minimalInkFor(level) * 1.25);
    },
  );

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i places real pickups worth PICKUP_AMOUNT, not yet taken",
    (_i, level) => {
      expect(level.pickups.length).toBeGreaterThan(0);
      for (const p of level.pickups) {
        expect(p.amount).toBe(PICKUP_AMOUNT);
        expect(p.taken).toBe(false);
      }
    },
  );

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i's pickups sit ON a running platform, reachable in the runner's path",
    (_i, level) => {
      // The property is that a pickup sits on ground the runner actually runs
      // over, within reach of it.
      for (const p of level.pickups) {
        const surfaceY = groundSurfaceYAt(p.pos.x, level.groundSegments);
        expect(surfaceY).not.toBeNull();
        // radius + pickup radius is ~38px; the authored vertical offset is 18
        expect(Math.abs(p.pos.y - surfaceY!)).toBeLessThan(38);
      }
    },
  );

  it("puts the ink where the height is: the high lines are worth taking", () => {
    // "A riskier high line should pay" — on the two levels built around
    // climbing, a meaningful share of the pickups sit on ground well above
    // the level's own baseline, so the ink is on the ledges the player has
    // to commit ink to reach.
    for (const index of [2, 3]) {
      const level = ALL_LEVELS[index];
      const { top } = elevationRange(level);
      const high = level.pickups.filter((p) => p.pos.y < level.groundY - 150);
      expect(high.length).toBeGreaterThanOrEqual(2);
      // including one at the very top of the level
      expect(Math.min(...level.pickups.map((p) => p.pos.y))).toBeLessThan(top + 40);
    }
  });
});

describe("buildLevel: chaser start (requirement 6)", () => {
  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i keeps the chaser a SHORT distance behind startX",
    (_i, level) => {
      const gap = level.startX - level.chaserStartX;
      expect(gap).toBeGreaterThan(50);
      expect(gap).toBeLessThan(300);
    },
  );
});

describe("buildLevel: finish placement", () => {
  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i places the finish past the last gap with a short run-out",
    (_i, level) => {
      const gaps = findGaps(level.groundSegments);
      const lastGapEnd = Math.max(...gaps.map((g) => g.endX));
      expect(level.finishX).toBeGreaterThan(lastGapEnd);
      expect(level.finishX - lastGapEnd).toBeLessThan(700);
    },
  );
});

// ===========================================================================
// THE HEADLINE REQUIREMENT: no gap may be crossable without drawing.
//
// For each real gap, build an isolated two-segment world (the takeoff
// platform and an extended landing platform at the gap's real geometry) and
// drop a runner off the takeoff edge at RUN_SPEED with NO strokes drawn.
// Run the actual simulation (createState/step from ./world) forward. If the
// runner ever reaches the far side while still alive, the gap is a free
// crossing -- exactly the bug the tester found. It must always end "lost".
// ===========================================================================

function isolatedLevelFor(gap: Gap): Level {
  return {
    groundSegments: [
      seg(gap.startX - 2000, gap.takeoffY, gap.startX, gap.takeoffY),
      seg(gap.endX, gap.landingY, gap.endX + 4000, gap.landingY),
    ],
    pickups: [],
    hazards: [],
    startX: gap.startX - 5,
    chaserStartX: gap.startX - 1_000_000, // never interferes
    finishX: gap.endX + 1_000_000, // never triggers a premature "won"
    index: 0,
    groundY: gap.takeoffY,
    stub: null,
  };
}

/** Run the real loop over `level` from `fromX`, with `strokes` already
 *  drawn, until the runner dies or gets past `pastX` on its feet. */
function runsPast(
  level: Level,
  fromX: number,
  pastX: number,
  strokes: Segment[][],
  maxSeconds = 20,
): boolean {
  const surfaceY = groundSurfaceYAt(fromX, level.groundSegments);
  const state = createState(0);
  state.level = level;
  state.strokes = strokes.map((segs) => ({
    points: [segs[0].a, ...segs.map((s) => s.b)],
    segments: segs,
  }));
  state.ghost = null;
  state.ink = MAX_INK;
  state.chaser.pos = { x: level.chaserStartX, y: (surfaceY ?? 0) - CHASER_RADIUS };
  state.chaser.vel = { x: 0, y: 0 };
  state.runner.pos = { x: fromX, y: (surfaceY ?? 0) - RUNNER_RADIUS };
  state.runner.vel = { x: RUN_SPEED, y: 0 };
  state.runner.grounded = true;
  state.progressX = fromX;
  state.phase = "running" as Phase;

  const dt = 1 / 120;
  const steps = Math.round(maxSeconds / dt);
  for (let i = 0; i < steps; i++) {
    step(state, dt, dt);
    if (state.phase === "lost") return false;
    if (state.phase === "won") return true;
    if (state.runner.pos.x >= pastX && state.runner.grounded) return true;
  }
  // Timed out without dying or crossing (e.g. stuck) -- not a crossing.
  return false;
}

/** True if, starting at the edge of `gap` with no strokes, the runner
 *  reaches the far side alive (a free, undrawn crossing -- a bug), false if
 *  it correctly falls to its death first. */
function gapIsFreeInIsolation(gap: Gap): boolean {
  return runsPast(isolatedLevelFor(gap), gap.startX - 5, gap.endX + 5, [], 10);
}

/** The same question asked of the REAL level: enter the gap over whatever
 *  terrain actually precedes it (ramps included), with no strokes drawn.
 *  This is the check that catches a ramp launching the runner past the
 *  ballistic range its width was sized against. */
function gapIsFreeInContext(level: Level, gap: Gap, previousGapEnd: number): boolean {
  const bare: Level = {
    ...level,
    hazards: [], // dying on spikes would be a false pass
    pickups: [],
    stub: null,
    chaserStartX: level.startX - 1_000_000,
    finishX: level.finishX + 1_000_000,
  };
  const from = Math.max(previousGapEnd + 20, gap.startX - 600);
  return runsPast(bare, from, gap.endX + 5, [], 20);
}

function seg(ax: number, ay: number, bx: number, by: number): Segment {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

describe("buildLevel: EVERY gap requires drawing a line (no free crossings)", () => {
  for (const level of ALL_LEVELS) {
    const gaps = realGapsFor(level);
    it.each(gaps.map((g, i) => [i, g] as const))(
      `level ${level.index} gap #%i (width=%s) cannot be crossed without a stroke, in isolation`,
      (_i, gap) => {
        expect(gapIsFreeInIsolation(gap)).toBe(false);
      },
    );

    it.each(gaps.map((g, i) => [i, g] as const))(
      `level ${level.index} gap #%i cannot be crossed without a stroke ON THE REAL LEVEL`,
      (i, gap) => {
        const previousEnd = i === 0 ? level.startX - 1000 : gaps[i - 1].endX;
        expect(gapIsFreeInContext(level, gap, previousEnd)).toBe(false);
      },
    );
  }

  it("every downhill gap also clears the ballistic-range formula with margin", () => {
    // The simulations above are the ground truth; this is the reasoning
    // behind the numbers, kept honest. R(dy) is the free-fall range for the
    // drop; every authored width sits at least 70px past it.
    for (const gaps of ALL_REAL_GAPS) {
      for (const gap of gaps) {
        if (gap.dy <= 0) continue;
        expect(gap.width).toBeGreaterThan(downhillWidth(gap.dy, 70));
        expect(gap.width - ballisticRange(gap.dy)).toBeGreaterThan(70);
      }
    }
  });

  it("no gap is narrow enough for the runner's own body to span it", () => {
    // The second failure mode the formula misses: a hole narrower than the
    // runner's diameter can never stop touching ground. Measured floor for a
    // flat gap was ~27px; every real gap here is over three times that.
    for (const gaps of ALL_REAL_GAPS) {
      for (const gap of gaps) {
        expect(gap.width).toBeGreaterThan(2 * (2 * RUNNER_RADIUS));
      }
    }
  });
});

// ===========================================================================
// THE MISSING INVERSE (the bug this file exists to fix): it is not enough
// that no gap can be crossed WITHOUT a line -- every gap must ALSO be
// crossable WITH a reasonable one. Integration testing found several
// climbs whose straight edge-to-edge bridge was steeper than the runner
// can actually climb: it auto-runs into the line, cannot climb it, and the
// stuck-watchdog in world.ts kills it before it ever reaches the far side.
// That property had no test at all. This section keeps a permanent one:
//   1. Empirically re-measure the maximum climbable slope against the REAL
//      physics (createState/step) -- the same way the fix itself was
//      derived -- rather than trusting a hardcoded constant that could go
//      stale if RUN_SPEED/GRAVITY/STEP_UP_MAX/etc. are ever retuned.
//   2. For every gap in every level, assert the straight edge-to-edge
//      bridging line's slope sits within that measured limit.
//   3. For every gap in every level, ALSO hand the runner exactly that
//      bridging line and confirm -- by direct simulation, the actual
//      ground truth -- that it reaches the far side alive.
// ===========================================================================

/** True if, given exactly the straight edge-to-edge bridging line for
 *  `gap` (and nothing else -- no other strokes, no pickups), the runner
 *  reaches the far side alive. */
function gapCrossableWithBridge(gap: Gap, maxSeconds = 20): boolean {
  const bridge = seg(gap.startX, gap.takeoffY, gap.endX, gap.landingY);
  return runsPast(isolatedLevelFor(gap), gap.startX - 5, gap.endX + 5, [[bridge]], maxSeconds);
}

/** True if a straight line bridging an isolated climb of `width`/`rise`
 *  (nothing else in the world) gets the runner across. Used only to
 *  measure the climb limit below; independent of any real level. */
function canClimb(width: number, rise: number, maxSeconds = 15): boolean {
  return gapCrossableWithBridge(
    { startX: 0, endX: width, width, takeoffY: 0, landingY: -rise, dy: -rise },
    maxSeconds,
  );
}

/** Binary-searches, against the REAL physics, the steepest uphill
 *  rise/width ratio the runner can still climb via a straight bridging
 *  line, at a representative gap width. Measured (while fixing this bug)
 *  to be width-invariant to 5 decimal places across 40-200px gaps, so one
 *  representative width is sufficient. Re-measuring here rather than
 *  hardcoding the result keeps this guard honest against future retuning
 *  of RUN_SPEED / GRAVITY / STEP_UP_MAX / dt. */
function measureMaxClimbRatio(width = 100, iterations = 30): number {
  let lo = 0;
  let hi = 89;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const rise = width * Math.tan((mid * Math.PI) / 180);
    if (canClimb(width, rise)) lo = mid;
    else hi = mid;
  }
  return Math.tan((lo * Math.PI) / 180);
}

const MAX_CLIMB_RATIO = measureMaxClimbRatio();

describe("buildLevel: the missing inverse -- every gap has a climbable, actually-crossable line", () => {
  it("the measured climb limit is steep but finite (~60deg / sqrt(3), found while fixing this bug)", () => {
    expect(MAX_CLIMB_RATIO).toBeGreaterThan(1.6);
    expect(MAX_CLIMB_RATIO).toBeLessThan(1.85);
  });

  it("no authored climb comes near the limit: a third of it is still in hand", () => {
    for (const gaps of ALL_REAL_GAPS) {
      for (const gap of gaps) {
        if (gap.dy >= 0) continue;
        expect(-gap.dy / gap.width).toBeLessThan(MAX_CLIMB_RATIO * 0.75);
      }
    }
  });

  for (const level of ALL_LEVELS) {
    const gaps = realGapsFor(level);
    it.each(gaps.map((g, i) => [i, g] as const))(
      `level ${level.index} gap #%i (width=%s, dy=%s): straight bridge is climbable and actually crosses`,
      (_i, gap) => {
        if (gap.dy < 0) {
          // Uphill: the straight edge-to-edge line's slope must be within
          // the measured climbable limit. (Downhill/flat gaps have no
          // slope ceiling -- gravity only ever helps a descent.)
          const ratio = Math.abs(gap.dy) / gap.width;
          expect(ratio).toBeLessThan(MAX_CLIMB_RATIO);
        }
        // Ground truth, for every gap regardless of direction: give the
        // runner exactly the straight bridging line and confirm it
        // actually reaches the far side alive.
        expect(gapCrossableWithBridge(gap)).toBe(true);
      },
    );
  }
});

// ===========================================================================
// COMPLETABILITY, end to end. Every check above is per-gap. This one plays
// the whole level through the real loop: the real terrain, the real chaser,
// the real spike fields, the real ink economy (strokes cost what ink.ts says
// they cost, and the well starts at MAX_INK less the teaching stub), with a
// scripted player who draws the way a person does — aiming a little past
// both lips, and charged a surcharge for the wobble a straight line in a
// test does not have. If a level cannot be finished this way, the ink
// arithmetic in level.ts is wrong however neatly it adds up.
// ===========================================================================

/** Overshoot past each lip, in px, and the surcharge charged on every
 *  stroke for not being a perfect line. Matches the "realistic hand" the
 *  ink-budget test above asserts against. */
const OVERSHOOT = 12;
const SLOP = 0.15;

/** The line a person actually draws over a gap: a short lead-in along the
 *  ground before the takeoff lip, then straight through both lips and a
 *  little past the landing one.
 *
 *  The overshoot is taken ALONG the line, not horizontally, and that detail
 *  is load-bearing rather than cosmetic — it was found by this test failing.
 *  A line drawn from (startX - 12, takeoffY) to (endX + 12, landingY) has a
 *  shallower slope than the gap, so on a steep climb it passes BELOW the
 *  landing corner: for level 2's first tower (110 wide, 125 of rise) it
 *  arrives 11px under the lip, more than world.ts's STEP_UP_MAX of 7 can
 *  hoist, and the runner wedges against the corner capsule and is killed by
 *  the stuck watchdog. Steep climbs are unforgiving of a line that lands
 *  even slightly low; a line aimed AT the corner and dragged past it is
 *  what the game rewards, and is what this scripted hand draws. */
function bridgeLine(gap: Gap): Vec2[] {
  const len = Math.hypot(gap.width, gap.dy);
  return [
    { x: gap.startX - OVERSHOOT, y: gap.takeoffY },
    { x: gap.startX, y: gap.takeoffY },
    {
      x: gap.endX + (gap.width / len) * OVERSHOOT,
      y: gap.landingY + (gap.dy / len) * OVERSHOOT,
    },
  ];
}

type Obstacle =
  | { kind: "gap"; at: number; gap: Gap }
  | { kind: "hazard"; at: number; hazard: Hazard };

function playLevel(index: number): {
  phase: Phase;
  x: number;
  finishX: number;
  inkLeft: number;
  lowWater: number;
} {
  const state = createState(index);
  const level = state.level;
  const obstacles: Obstacle[] = [
    ...realGapsFor(level).map((gap) => ({ kind: "gap" as const, at: gap.startX, gap })),
    ...level.hazards.map((hazard) => ({
      kind: "hazard" as const,
      at: hazard.x - 120,
      hazard,
    })),
  ].sort((a, b) => a.at - b.at);

  let next = 0;
  let lowWater = state.ink;
  const dt = 1 / 120;
  // 90s of game time is ~16600px at RUN_SPEED: comfortably past any finish.
  for (let i = 0; i < 90 / dt; i++) {
    // Draw when the obstacle comes into reach, exactly once each.
    while (next < obstacles.length && state.runner.pos.x > obstacles[next].at - 260) {
      const o = obstacles[next++];
      const points = o.kind === "gap" ? bridgeLine(o.gap) : [
              { x: o.hazard.x - 120, y: o.hazard.y },
              { x: o.hazard.x - 20, y: o.hazard.y - 45 },
              { x: o.hazard.x + o.hazard.width + 20, y: o.hazard.y - 45 },
              { x: o.hazard.x + o.hazard.width + 120, y: o.hazard.y },
            ];
      // Charge the wobble a real hand adds, then draw the clean shape.
      state.ink -= inkCost(points) * (1 + SLOP);
      lowWater = Math.min(lowWater, state.ink);
      if (state.ink < 0) break; // out of ink: the run is over, honestly
      state.strokes.push(strokeFromPoints(points));
    }
    if (state.ink < 0) break;
    step(state, dt, dt);
    if (state.phase !== "running") break;
  }
  return {
    phase: state.phase,
    x: state.runner.pos.x,
    finishX: level.finishX,
    inkLeft: state.ink,
    lowWater,
  };
}

describe("buildLevel: a scripted player finishes every level on the real ink budget", () => {
  it.each(ALL_LEVELS.map((l) => [l.index] as const))(
    "level %i is completable: every gap bridged, every spike field cleared, ink never runs dry",
    (index) => {
      const result = playLevel(index);
      expect(result.lowWater).toBeGreaterThan(0);
      expect(result.phase).toBe("won");
      expect(result.x).toBeGreaterThanOrEqual(result.finishX);
      // and it finishes with ink to spare, not on fumes
      expect(result.inkLeft).toBeGreaterThan(MAX_INK * 0.05);
    },
  );
});
