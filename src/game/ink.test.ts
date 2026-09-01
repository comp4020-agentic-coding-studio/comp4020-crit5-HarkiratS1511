import { describe, expect, it } from "vitest";
import type { Vec2 } from "./types";
import { INK_PER_PIXEL, STROKE_POINT_SPACING } from "./tuning";
import { appendStrokePoint, inkCost, polylineLength, truncateToInk } from "./ink";

const p = (x: number, y: number): Vec2 => ({ x, y });

describe("polylineLength", () => {
  it("is 0 for an empty array", () => {
    expect(polylineLength([])).toBe(0);
  });

  it("is 0 for a single point", () => {
    expect(polylineLength([p(5, 5)])).toBe(0);
  });

  it("sums straight segment lengths", () => {
    // (0,0) -> (3,0) -> (3,4): 3 + 4 = 7
    expect(polylineLength([p(0, 0), p(3, 0), p(3, 4)])).toBeCloseTo(7);
  });

  it("handles a diagonal segment via Pythagoras", () => {
    expect(polylineLength([p(0, 0), p(3, 4)])).toBeCloseTo(5);
  });

  it("does not mutate the input array", () => {
    const points = [p(0, 0), p(1, 0), p(2, 0)];
    const snapshot = JSON.parse(JSON.stringify(points));
    polylineLength(points);
    expect(points).toEqual(snapshot);
  });

  it("accumulates correctly across many short segments (float robustness)", () => {
    const points: Vec2[] = [p(0, 0)];
    const step = 0.1;
    const n = 10_000;
    for (let i = 1; i <= n; i++) points.push(p(i * step, 0));
    expect(polylineLength(points)).toBeCloseTo(n * step, 6);
  });
});

describe("inkCost", () => {
  it("is length * INK_PER_PIXEL", () => {
    const points = [p(0, 0), p(10, 0), p(10, 10)];
    expect(inkCost(points)).toBeCloseTo(polylineLength(points) * INK_PER_PIXEL);
  });

  it("is 0 for an empty array or single point", () => {
    expect(inkCost([])).toBe(0);
    expect(inkCost([p(1, 1)])).toBe(0);
  });

  it("does not mutate the input array", () => {
    const points = [p(0, 0), p(4, 0), p(4, 3)];
    const snapshot = JSON.parse(JSON.stringify(points));
    inkCost(points);
    expect(points).toEqual(snapshot);
  });
});

describe("truncateToInk", () => {
  it("returns an empty array for an empty polyline", () => {
    expect(truncateToInk([], 100)).toEqual([]);
  });

  it("returns the single point unchanged when the polyline has one point", () => {
    expect(truncateToInk([p(3, 4)], 100)).toEqual([p(3, 4)]);
  });

  it("collapses to just the start point when remaining is exactly 0", () => {
    const points = [p(0, 0), p(10, 0), p(20, 0)];
    expect(truncateToInk(points, 0)).toEqual([p(0, 0)]);
  });

  it("collapses to just the start point for negative remaining", () => {
    const points = [p(0, 0), p(10, 0)];
    expect(truncateToInk(points, -5)).toEqual([p(0, 0)]);
  });

  it("returns the whole polyline untouched when remaining exceeds its full cost", () => {
    const points = [p(0, 0), p(10, 0), p(10, 10)];
    const result = truncateToInk(points, 1000);
    expect(result).toEqual(points);
  });

  it("returns the whole polyline when remaining exactly equals its cost", () => {
    const points = [p(0, 0), p(3, 4)]; // length 5
    const result = truncateToInk(points, 5 * INK_PER_PIXEL);
    expect(result).toEqual(points);
    expect(inkCost(result)).toBeCloseTo(5 * INK_PER_PIXEL);
  });

  it("interpolates the exact stopping point mid-segment", () => {
    // Single segment of length 10 along the x-axis; afford exactly 4 px.
    const points = [p(0, 0), p(10, 0)];
    const result = truncateToInk(points, 4 * INK_PER_PIXEL);
    expect(result).toEqual([p(0, 0), p(4, 0)]);
    expect(inkCost(result)).toBeCloseTo(4 * INK_PER_PIXEL);
  });

  it("keeps whole segments already paid for, then interpolates the partial one", () => {
    // Segments of length 5 and 5 (total 10); afford 7 -> keep first vertex,
    // then stop 2 units into the second segment.
    const points = [p(0, 0), p(5, 0), p(10, 0)];
    const result = truncateToInk(points, 7 * INK_PER_PIXEL);
    expect(result).toEqual([p(0, 0), p(5, 0), p(7, 0)]);
  });

  it("never exceeds the ink budget for the truncated result", () => {
    const points = [p(0, 0), p(10, 0), p(10, 10), p(0, 10)];
    for (const remaining of [0, 1, 5, 12.5, 100, 1000]) {
      const result = truncateToInk(points, remaining);
      expect(inkCost(result)).toBeLessThanOrEqual(remaining + 1e-9);
    }
  });

  it("does not mutate the input array", () => {
    const points = [p(0, 0), p(10, 0), p(10, 10)];
    const snapshot = JSON.parse(JSON.stringify(points));
    truncateToInk(points, 5);
    expect(points).toEqual(snapshot);
  });

  it("returns a new array, not the same reference", () => {
    const points = [p(0, 0), p(10, 0)];
    const result = truncateToInk(points, 1000);
    expect(result).not.toBe(points);
  });

  it("handles floating-point accumulation across many short segments", () => {
    const points: Vec2[] = [p(0, 0)];
    const step = 0.1;
    const n = 1000;
    for (let i = 1; i <= n; i++) points.push(p(i * step, 0));
    const budget = 55.35; // affords 553 whole steps + a partial one
    const result = truncateToInk(points, budget * INK_PER_PIXEL);
    expect(inkCost(result)).toBeLessThanOrEqual(budget * INK_PER_PIXEL + 1e-9);
    expect(inkCost(result)).toBeCloseTo(budget, 6);
  });
});

describe("appendStrokePoint", () => {
  it("always appends the first point", () => {
    const points: Vec2[] = [];
    const appended = appendStrokePoint(points, p(0, 0));
    expect(appended).toBe(true);
    expect(points).toEqual([p(0, 0)]);
  });

  it("rejects a point closer than STROKE_POINT_SPACING to the last point", () => {
    const points: Vec2[] = [p(0, 0)];
    const tooClose = p(STROKE_POINT_SPACING - 0.01, 0);
    const appended = appendStrokePoint(points, tooClose);
    expect(appended).toBe(false);
    expect(points).toEqual([p(0, 0)]);
  });

  it("accepts a point at least STROKE_POINT_SPACING away", () => {
    const points: Vec2[] = [p(0, 0)];
    const farEnough = p(STROKE_POINT_SPACING, 0);
    const appended = appendStrokePoint(points, farEnough);
    expect(appended).toBe(true);
    expect(points).toEqual([p(0, 0), farEnough]);
  });

  it("mutates the input array in place (documented asymmetry vs. the read-only functions)", () => {
    const points: Vec2[] = [p(0, 0)];
    const ref = points;
    appendStrokePoint(points, p(STROKE_POINT_SPACING, 0));
    expect(ref).toBe(points);
    expect(ref.length).toBe(2);
  });

  it("ignores repeated jitter near the same spot, keeping ink cost low", () => {
    const points: Vec2[] = [p(0, 0)];
    for (let i = 0; i < 50; i++) {
      appendStrokePoint(points, p(Math.random() * 2, Math.random() * 2));
    }
    expect(points.length).toBe(1);
  });
});
