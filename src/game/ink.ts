// Ink budget mechanics: a stroke costs ink proportional to its drawn length,
// ink is never reclaimed, and a stroke that outruns the remaining ink is
// truncated exactly where the ink ran out (not rejected outright). This file
// is pure geometry/arithmetic — no DOM, no game-loop state.

import type { Vec2 } from "./types";
import { INK_PER_PIXEL, STROKE_POINT_SPACING } from "./tuning";

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Total length of a polyline in world units. Does not mutate `points`. */
export function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

/** Ink a polyline would cost: length * INK_PER_PIXEL from tuning.ts.
 *  Does not mutate `points`. */
export function inkCost(points: Vec2[]): number {
  return polylineLength(points) * INK_PER_PIXEL;
}

/** Truncate a polyline so its cost does not exceed `remaining` ink.
 *  If the budget runs out mid-segment, the final point is interpolated to sit
 *  exactly at the affordable distance along that segment. Does not mutate
 *  `points`; always returns a new array. */
export function truncateToInk(points: Vec2[], remaining: number): Vec2[] {
  if (points.length === 0) return [];
  if (remaining <= 0) return [points[0]];

  // Budget is expressed in ink; convert to a drawable distance up front so
  // the walk below compares like with like.
  let budget = remaining / INK_PER_PIXEL;

  const result: Vec2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const segLen = distance(prev, curr);

    if (segLen <= budget) {
      result.push(curr);
      budget -= segLen;
      continue;
    }

    // The affordable distance falls inside this segment: interpolate the
    // exact point where the ink runs out and stop there.
    if (segLen > 0) {
      const t = budget / segLen;
      result.push({
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t,
      });
    }
    return result;
  }

  return result;
}

/** Append `p` to `points` only if it is at least STROKE_POINT_SPACING from
 *  the last point. Returns whether it was appended. Keeps polylines cheap and
 *  stops pointer jitter inflating ink cost.
 *
 *  NOTE — asymmetric mutation: unlike the read-only functions above, this
 *  function DOES mutate `points` in place (push). It's the hot path called on
 *  every pointer-move while drawing a stroke, so it avoids reallocating the
 *  array on each call. */
export function appendStrokePoint(points: Vec2[], p: Vec2): boolean {
  const last = points[points.length - 1];
  if (last !== undefined && distance(last, p) < STROKE_POINT_SPACING) {
    return false;
  }
  points.push(p);
  return true;
}
