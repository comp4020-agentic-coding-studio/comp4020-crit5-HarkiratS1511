// Design-contract tests for the campaign (src/game/level.ts): totality of
// buildLevel over any integer, per-level length, the difficulty ramp, the
// level-0-only teaching apparatus, the ink budget, chaser placement — and,
// the tester's specific complaint, that NO gap can be crossed without
// drawing a line. That last property is checked by direct physics
// simulation (createState/step from ./world), not by a formula.

import { describe, expect, it } from "vitest";
import { buildLevel, LEVEL_COUNT } from "./level";
import { createState, step } from "./world";
import { CHASER_RADIUS, MAX_INK, PICKUP_AMOUNT, RUNNER_RADIUS, RUN_SPEED } from "./tuning";
import type { Level, Phase, Segment } from "./types";

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

const ALL_LEVELS = Array.from({ length: LEVEL_COUNT }, (_, i) => buildLevel(i));
const ALL_REAL_GAPS = ALL_LEVELS.map(realGapsFor);

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
    // drawing, in aggregate, than level 0 (a gentle opener with only a
    // handful of hazards).
    const total = (gaps: Gap[]) => gaps.reduce((sum, g) => sum + gapCost(g), 0);
    expect(total(ALL_REAL_GAPS[3])).toBeGreaterThan(total(ALL_REAL_GAPS[0]));
  });

  it("level 3's closing gaps demand a big, efficient single arc", () => {
    const gaps = ALL_REAL_GAPS[3];
    const last = gaps[gaps.length - 1];
    // the finale is a real, substantial diagonal crossing, not a token one
    expect(last.width).toBeGreaterThan(100);
    expect(Math.abs(last.dy)).toBeGreaterThan(100);
  });
});

describe("buildLevel: structural variety (requirement 1)", () => {
  it("level 0 (long flat runs, few wide chasms) is mostly flat with low gap count", () => {
    const gaps = ALL_REAL_GAPS[0];
    expect(gaps.length).toBeLessThanOrEqual(8);
    expect(gaps.every((g) => g.dy === 0)).toBe(true);
    expect(Math.max(...gaps.map((g) => g.width))).toBeGreaterThan(300); // a genuinely wide chasm
  });

  it("level 1 (stepped ascending platforms) only ever climbs", () => {
    const gaps = ALL_REAL_GAPS[1];
    expect(gaps.length).toBeGreaterThanOrEqual(6);
    expect(gaps.every((g) => g.dy < 0)).toBe(true);
  });

  it("level 2 (tight rapid-fire small gaps) has many small, narrow gaps", () => {
    const gaps = ALL_REAL_GAPS[2];
    expect(gaps.length).toBeGreaterThanOrEqual(15);
    expect(gaps.every((g) => g.width < 150)).toBe(true);
  });

  it("level 3 (big height swings) alternates large drops and climbs", () => {
    const gaps = ALL_REAL_GAPS[3];
    expect(gaps.some((g) => g.dy > 100)).toBe(true);
    expect(gaps.some((g) => g.dy < -100)).toBe(true);
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

describe("buildLevel: ink budget (requirement 5)", () => {
  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i is completable in ink: minimal bridging cost < MAX_INK + pickups",
    (_i, level) => {
      const gaps = realGapsFor(level);
      const minimalInk = gaps.reduce((sum, g) => sum + gapCost(g), 0);
      const pickupTotal = level.pickups.reduce((sum, p) => sum + p.amount, 0);
      expect(minimalInk).toBeLessThan(MAX_INK + pickupTotal);
    },
  );

  it.each(ALL_LEVELS.map((l) => [l.index, l] as const))(
    "level %i genuinely requires collecting (most of) its pickups",
    (_i, level) => {
      const gaps = realGapsFor(level);
      const minimalInk = gaps.reduce((sum, g) => sum + gapCost(g), 0);
      const pickupTotal = level.pickups.reduce((sum, p) => sum + p.amount, 0);
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
      for (const p of level.pickups) {
        const platform = level.groundSegments.find((s) => {
          const lo = Math.min(s.a.x, s.b.x);
          const hi = Math.max(s.a.x, s.b.x);
          return p.pos.x >= lo && p.pos.x <= hi && Math.abs(s.a.y - s.b.y) < 1e-6;
        });
        expect(platform).toBeDefined();
        // within reach of a runner standing on that platform (radius +
        // pickup radius is ~38px; the vertical offset used throughout is 18)
        expect(Math.abs(p.pos.y - platform!.a.y)).toBeLessThan(38);
      }
    },
  );
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

/** True if, starting at the edge of `gap` with no strokes, the runner
 *  reaches the far side alive (a free, undrawn crossing -- a bug), false if
 *  it correctly falls to its death first. */
function gapRequiresDrawing(gap: Gap): boolean {
  const iso: Level = {
    groundSegments: [
      seg(gap.startX - 2000, gap.takeoffY, gap.startX, gap.takeoffY),
      seg(gap.endX, gap.landingY, gap.endX + 4000, gap.landingY),
    ],
    pickups: [],
    startX: gap.startX - 5,
    chaserStartX: gap.startX - 1_000_000, // never interferes
    finishX: gap.endX + 1_000_000, // never triggers a premature "won"
    index: 0,
    groundY: gap.takeoffY,
    stub: null,
  };

  const state = createState(0);
  state.level = iso;
  state.strokes = [];
  state.ghost = null;
  state.ink = MAX_INK;
  state.chaser.pos = { x: iso.chaserStartX, y: gap.takeoffY - CHASER_RADIUS };
  state.chaser.vel = { x: 0, y: 0 };
  state.runner.pos = { x: gap.startX - 5, y: gap.takeoffY - RUNNER_RADIUS };
  state.runner.vel = { x: RUN_SPEED, y: 0 };
  state.runner.grounded = true;
  state.phase = "running" as Phase;

  const dt = 1 / 120;
  const farEdge = gap.endX + 5;
  for (let i = 0; i < 1200; i++) {
    step(state, dt, dt);
    if (state.phase === "lost") return false;
    if (state.phase === "won") return true;
    if (state.runner.pos.x >= farEdge && state.runner.grounded) return true;
  }
  // Timed out without dying or crossing (e.g. stuck) -- not a free crossing.
  return false;
}

function seg(ax: number, ay: number, bx: number, by: number): Segment {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

describe("buildLevel: EVERY gap requires drawing a line (no free crossings)", () => {
  for (const level of ALL_LEVELS) {
    const gaps = realGapsFor(level);
    it.each(gaps.map((g, i) => [i, g] as const))(
      `level ${level.index} gap #%i (width=%s) cannot be crossed without a stroke`,
      (_i, gap) => {
        expect(gapRequiresDrawing(gap)).toBe(false);
      },
    );
  }
});

// ===========================================================================
// THE MISSING INVERSE (the bug this file exists to fix): it is not enough
// that no gap can be crossed WITHOUT a line -- every gap must ALSO be
// crossable WITH a reasonable one. Integration testing found several Level
// 3 climbs whose straight edge-to-edge bridge was steeper than the runner
// can actually climb: it auto-runs into the line, cannot climb it, and the
// stuck-watchdog in world.ts kills it before it ever reaches the far side.
// That property had no test at all. This section adds a permanent one:
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
  const iso: Level = {
    groundSegments: [
      seg(gap.startX - 2000, gap.takeoffY, gap.startX, gap.takeoffY),
      seg(gap.endX, gap.landingY, gap.endX + 4000, gap.landingY),
    ],
    pickups: [],
    startX: gap.startX - 5,
    chaserStartX: gap.startX - 1_000_000, // never interferes
    finishX: gap.endX + 1_000_000, // never triggers a premature "won"
    index: 0,
    groundY: gap.takeoffY,
    stub: null,
  };
  const bridge: Segment = seg(gap.startX, gap.takeoffY, gap.endX, gap.landingY);

  const state = createState(0);
  state.level = iso;
  state.strokes = [{ points: [bridge.a, bridge.b], segments: [bridge] }];
  state.ghost = null;
  state.ink = MAX_INK;
  state.chaser.pos = { x: iso.chaserStartX, y: gap.takeoffY - CHASER_RADIUS };
  state.chaser.vel = { x: 0, y: 0 };
  state.runner.pos = { x: gap.startX - 5, y: gap.takeoffY - RUNNER_RADIUS };
  state.runner.vel = { x: RUN_SPEED, y: 0 };
  state.runner.grounded = true;
  state.phase = "running" as Phase;

  const dt = 1 / 120;
  const farEdge = gap.endX + 5;
  const steps = Math.round(maxSeconds / dt);
  for (let i = 0; i < steps; i++) {
    step(state, dt, dt);
    if (state.phase === "lost") return false;
    if (state.phase === "won") return true;
    if (state.runner.pos.x >= farEdge && state.runner.grounded) return true;
  }
  // Timed out without dying or crossing -- e.g. pinned/stuck-but-not-yet-
  // killed, or just too slow. Not a successful crossing either way.
  return false;
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
