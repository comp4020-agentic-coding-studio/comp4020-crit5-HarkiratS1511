// Design-contract tests for the hand-authored level (src/game/level.ts).
// These assert the SHAPE of the design decisions called for in the brief —
// run-up length, the teaching notch, the difficulty ramp, the strategic
// fork, and the ink budget — not just that buildLevel() returns something.

import { describe, expect, it } from "vitest";
import { buildLevel } from "./level";
import { MAX_INK, PICKUP_AMOUNT } from "./tuning";
import type { Segment } from "./types";

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
 *  don't touch. This mirrors how the rest of the game reads the level:
 *  gaps are absences of ground segments, nothing more. */
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

const level = buildLevel();
const allGaps = findGaps(level.groundSegments);
const narrowest = allGaps.reduce((a, b) => (a.width < b.width ? a : b));
const realGaps = allGaps
  .filter((g) => g !== narrowest)
  .sort((a, b) => a.startX - b.startX);

describe("buildLevel: ground layout", () => {
  it("breaks the ground into a teaching notch plus exactly 7 real gaps", () => {
    expect(allGaps.length).toBe(8);
    expect(realGaps.length).toBe(7);
  });

  it("gives a long run-up before the very first ground break", () => {
    const firstBreak = Math.min(...allGaps.map((g) => g.startX));
    // several full seconds of pure running at RUN_SPEED before anything
    // (even the teaching notch) is on screen
    expect(firstBreak - level.startX).toBeGreaterThan(500);
  });

  it("does not spawn the player at the edge of a gap", () => {
    const firstBreak = Math.min(...allGaps.map((g) => g.startX));
    expect(level.startX).toBeLessThan(firstBreak - 200);
  });
});

describe("buildLevel: teaching notch + stub", () => {
  it("has a non-null stub with a short 2-4 point polyline", () => {
    expect(level.stub).not.toBeNull();
    const stub = level.stub!;
    expect(stub.points.length).toBeGreaterThanOrEqual(2);
    expect(stub.points.length).toBeLessThanOrEqual(4);
  });

  it("builds stub segments as a/b pairs along the polyline", () => {
    const stub = level.stub!;
    expect(stub.segments.length).toBe(stub.points.length - 1);
    for (let i = 0; i < stub.segments.length; i++) {
      expect(stub.segments[i].a).toEqual(stub.points[i]);
      expect(stub.segments[i].b).toEqual(stub.points[i + 1]);
    }
  });

  it("is narrower than every real gap", () => {
    for (const real of realGaps) {
      expect(narrowest.width).toBeLessThan(real.width);
    }
  });

  it("is actually spanned by the stub's points", () => {
    const stubXs = level.stub!.points.map((p) => p.x);
    expect(Math.min(...stubXs)).toBeLessThanOrEqual(narrowest.startX + 1);
    expect(Math.max(...stubXs)).toBeGreaterThanOrEqual(narrowest.endX - 1);
  });
});

describe("buildLevel: difficulty ramp", () => {
  it("widens the 7 real gaps progressively", () => {
    for (let i = 1; i < realGaps.length; i++) {
      expect(realGaps[i].width).toBeGreaterThan(realGaps[i - 1].width);
    }
  });

  it("makes the closing pair of gaps markedly bigger than the opening pair", () => {
    const opening = (realGaps[0].width + realGaps[1].width) / 2;
    const closing = (realGaps[5].width + realGaps[6].width) / 2;
    expect(closing).toBeGreaterThan(opening * 2);
  });

  it("keeps gaps 1-2 flat and forgiving, with pickups near each", () => {
    expect(realGaps[0].dy).toBe(0);
    expect(realGaps[1].dy).toBe(0);
    expect(level.pickups.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildLevel: the strategic fork (height variation from gap 3 on)", () => {
  it("varies landing height on every gap from gap 3 onward", () => {
    const laterDys = realGaps.slice(2).map((g) => g.dy);
    expect(laterDys.every((dy) => dy !== 0)).toBe(true);
  });

  it("includes both lower and higher landings, not just one direction", () => {
    const laterDys = realGaps.slice(2).map((g) => g.dy);
    expect(laterDys.some((dy) => dy > 0)).toBe(true); // some landings lower
    expect(laterDys.some((dy) => dy < 0)).toBe(true); // some landings higher
  });
});

describe("buildLevel: ink budget", () => {
  it("is beatable with disciplined (near-minimal) drawing", () => {
    const minimalInk = realGaps.reduce(
      (sum, g) => sum + Math.hypot(g.width, g.dy),
      0,
    );
    expect(minimalInk).toBeLessThan(MAX_INK);
  });

  it("is not beatable with wasteful drawing, even collecting every pickup", () => {
    const minimalInk = realGaps.reduce(
      (sum, g) => sum + Math.hypot(g.width, g.dy),
      0,
    );
    const pickupTotal = level.pickups.reduce((sum, p) => sum + p.amount, 0);
    // "wasteful" modelled as habitually spending 2x the minimal cost
    expect(minimalInk * 2).toBeGreaterThan(MAX_INK + pickupTotal);
  });

  it("places pickups worth PICKUP_AMOUNT that offer real but non-trivial recovery", () => {
    expect(level.pickups.length).toBeGreaterThan(0);
    for (const p of level.pickups) {
      expect(p.amount).toBe(PICKUP_AMOUNT);
      expect(p.taken).toBe(false);
    }
    const pickupTotal = level.pickups.reduce((sum, p) => sum + p.amount, 0);
    expect(pickupTotal).toBeGreaterThan(0);
    expect(pickupTotal).toBeLessThan(MAX_INK);
  });
});

describe("buildLevel: chaser, start and finish", () => {
  it("starts the chaser off-screen behind the player", () => {
    expect(level.chaserStartX).toBeLessThan(level.startX);
    expect(level.startX - level.chaserStartX).toBeGreaterThan(300);
  });

  it("places the finish line past the last gap, with a short run-out", () => {
    const lastGapEnd = Math.max(...allGaps.map((g) => g.endX));
    expect(level.finishX).toBeGreaterThan(lastGapEnd);
    expect(level.finishX - lastGapEnd).toBeLessThan(400);
    expect(level.finishX - lastGapEnd).toBeGreaterThan(50);
  });
});
