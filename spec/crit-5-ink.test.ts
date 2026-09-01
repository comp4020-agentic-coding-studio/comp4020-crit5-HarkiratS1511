// Crit 5 ("A game") spec: https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/05-game/
//
// This file answers the spec line "one rule of the game has a focused
// automated test". The chosen rule: drawing costs ink proportional to the
// length of the stroke, ink is never given back, and a stroke that runs out
// of ink mid-draw is truncated exactly where the ink ran out rather than
// rejected outright. It is pure logic (no DOM, no dist/) so it stays fast
// and stack-independent.

import { describe, expect, it } from "vitest";
import { inkCost, truncateToInk } from "../src/game/ink";
import { INK_PER_PIXEL } from "../src/game/tuning";

describe("ink cost is proportional to the length of the line drawn", () => {
  it("doubling the drawn length doubles the ink it costs", () => {
    const short = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const long = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
    expect(inkCost(long)).toBeCloseTo(inkCost(short) * 2);
  });

  it("costs exactly length times INK_PER_PIXEL, not a flat per-stroke fee", () => {
    const points = [{ x: 0, y: 0 }, { x: 3, y: 4 }]; // length 5 (3-4-5 triangle)
    expect(inkCost(points)).toBeCloseTo(5 * INK_PER_PIXEL);
  });
});

describe("a stroke that runs out of ink stops where the ink ran out", () => {
  it("truncates the line, it does not reject the whole stroke", () => {
    const attempted = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const onlyEnoughForHalf = 50 * INK_PER_PIXEL;

    const drawn = truncateToInk(attempted, onlyEnoughForHalf);

    expect(drawn.length).toBeGreaterThan(0); // a partial line is still drawn
    expect(inkCost(drawn)).toBeLessThanOrEqual(onlyEnoughForHalf);
  });

  it("stops at the exact affordable point, interpolated mid-segment", () => {
    const attempted = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const remaining = 37 * INK_PER_PIXEL;

    const drawn = truncateToInk(attempted, remaining);

    expect(drawn[drawn.length - 1]).toEqual({ x: 37, y: 0 });
  });

  it("spends every last unit of ink offered, never leaving it unused", () => {
    const attempted = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
    const remaining = 123.5 * INK_PER_PIXEL;

    const drawn = truncateToInk(attempted, remaining);

    expect(inkCost(drawn)).toBeCloseTo(remaining, 6);
  });

  it("draws nothing beyond a single point when there is no ink left", () => {
    const attempted = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];

    const drawn = truncateToInk(attempted, 0);

    expect(drawn).toEqual([{ x: 0, y: 0 }]);
  });
});
