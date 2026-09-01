// Swept-circle-vs-segments collision and movement resolution.
//
// Coordinate convention: +x is right, +y is DOWN (canvas convention).
// Gravity is +y. An upward-facing ground surface has normal (0,-1).
//
// This module is deliberately conservative about numerical edge cases:
// zero-length segments, zero-length movement, and near-zero denominators
// are all guarded so callers never see NaN.

import type { Vec2, Segment, Contact } from "./types";

const EPS = 1e-9;
/** Depenetration skin: how far off a surface we leave the circle. */
const SKIN = 0.01;
/** Max slide iterations per resolveMovement call. */
const MAX_ITER = 4;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function length(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  if (len < EPS) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function closestPointOnSegment(p: Vec2, s: Segment): Vec2 {
  const ab = sub(s.b, s.a);
  const lenSq = dot(ab, ab);
  if (lenSq < EPS) {
    // Zero-length segment: closest point is just the (shared) endpoint.
    return { x: s.a.x, y: s.a.y };
  }
  let t = dot(sub(p, s.a), ab) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return add(s.a, scale(ab, t));
}

export function segmentsFromPolyline(points: Vec2[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segs.push({ a: points[i], b: points[i + 1] });
  }
  return segs;
}

/**
 * Earliest time-of-impact of a point moving from `from` toward `from + d`
 * against a stationary circle of radius `radius` centred at `center`.
 * Returns the smallest t in [0,1] at which distance(point(t), center) == radius,
 * or null if there is no such t (never within radius, or already past it
 * moving away without having been exactly on it within range).
 */
function raySweepVsCircle(
  from: Vec2,
  d: Vec2,
  center: Vec2,
  radius: number
): number | null {
  // |from + t*d - center|^2 = radius^2
  const f = sub(from, center);
  const a = dot(d, d);
  const b = 2 * dot(f, d);
  const c = dot(f, f) - radius * radius;

  if (a < EPS) {
    // No movement: only relevant if already exactly on the boundary,
    // which discrete-overlap handling elsewhere covers. Treat as no hit
    // for the sweep itself.
    return null;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);

  // We want the earliest t in [0,1] where the point is on/inside the circle
  // boundary while approaching (i.e. the entry root). If c <= 0 the point
  // already starts inside/on the circle at t=0 -- treat t=0 as the contact
  // so callers can react immediately rather than tunnelling through.
  if (c <= 0) return 0;

  if (t0 >= -EPS && t0 <= 1 + EPS) return Math.max(0, t0);
  if (t1 >= -EPS && t1 <= 1 + EPS) return Math.max(0, t1);
  return null;
}

/**
 * Time-of-impact of a point sweeping from `from` to `from+d` against an
 * infinite offset line parallel to the segment, offset by `radius` on the
 * side given by `normalSign` (the unit normal used is +/- the segment's
 * perpendicular). Returns t in [0,1] and the contact point, or null.
 */
function raySweepVsOffsetLine(
  from: Vec2,
  d: Vec2,
  s: Segment,
  radius: number,
  normal: Vec2
): { t: number; point: Vec2 } | null {
  // Offset line: points X such that dot(X - a, normal) = radius
  // (the line running parallel to the segment, radius away in `normal`
  // direction from the segment).
  const d0 = dot(sub(from, s.a), normal);

  // Already at/inside this face's offset line at t=0 (perpendicular
  // distance on the correct outward side is within the radius): treat as
  // an immediate contact rather than missing it because the algebraic
  // root would fall outside [0,1] or behind t=0. This guards against
  // tiny floating-point penetration surviving the depenetration skin.
  if (d0 >= -1e-6 && d0 < radius) {
    const point = { x: from.x, y: from.y };
    const ab = sub(s.b, s.a);
    const lenSq = dot(ab, ab);
    if (lenSq < EPS) return null;
    const proj = dot(sub(point, s.a), ab) / lenSq;
    if (proj < -1e-6 || proj > 1 + 1e-6) return null;
    return { t: 0, point };
  }

  const denom = dot(d, normal);
  if (Math.abs(denom) < EPS) return null; // moving parallel to the offset line

  const num = radius - d0;
  const t = num / denom;
  if (t < -EPS || t > 1 + EPS) return null;

  const clampedT = Math.max(0, Math.min(1, t));
  const point = add(from, scale(d, clampedT));

  // The contact point must actually project onto the finite segment
  // (between a and b), not just the infinite line, otherwise this is the
  // endpoint-circle case's job.
  const ab = sub(s.b, s.a);
  const lenSq = dot(ab, ab);
  if (lenSq < EPS) return null;
  const proj = dot(sub(point, s.a), ab) / lenSq;
  if (proj < -1e-6 || proj > 1 + 1e-6) return null;

  return { t: clampedT, point };
}

/**
 * Earliest contact when a circle of `radius` sweeps from `from` to `to`
 * against a single segment. Tests the two offset lines (one per side of
 * the segment) and the two endpoint capsule caps, returns the smallest
 * valid t, or null.
 */
function sweptCircleVsSegment(
  from: Vec2,
  to: Vec2,
  radius: number,
  s: Segment
): Contact | null {
  const ab = sub(s.b, s.a);
  const segLen = length(ab);
  if (segLen < EPS) {
    // Degenerate segment: treat as a single point/circle cap only.
    const d = sub(to, from);
    const t = raySweepVsCircle(from, d, s.a, radius);
    if (t === null) return null;
    const point = add(from, scale(d, t));
    let normal = normalize(sub(point, s.a));
    if (length(normal) < EPS) normal = { x: 0, y: -1 };
    return { point, normal, toi: t, segment: s };
  }

  const d = sub(to, from);
  const moveLen = length(d);
  if (moveLen < EPS) return null; // no movement, nothing to sweep

  // Two possible normals (perpendicular to segment), pointing to either side.
  const perp = normalize({ x: -ab.y, y: ab.x });
  const normalOptions = [perp, scale(perp, -1)];

  let best: Contact | null = null;

  for (const n of normalOptions) {
    const hit = raySweepVsOffsetLine(from, d, s, radius, n);
    if (hit && (best === null || hit.t < best.toi)) {
      best = { point: hit.point, normal: n, toi: hit.t, segment: s };
    }
  }

  // Endpoint caps (capsule rounded ends).
  for (const endpoint of [s.a, s.b]) {
    const t = raySweepVsCircle(from, d, endpoint, radius);
    if (t !== null && (best === null || t < best.toi)) {
      const point = add(from, scale(d, t));
      let normal = normalize(sub(point, endpoint));
      if (length(normal) < EPS) {
        // Circle center coincides with endpoint (started penetrating
        // exactly at the point) -- fall back to a normal derived from the
        // segment perpendicular so we still push away sensibly.
        normal = perp;
      }
      best = { point, normal, toi: t, segment: s };
    }
  }

  return best;
}

/** Earliest contact when a circle of `radius` sweeps from `from` to `to`
 *  against `segments`. Returns null if no contact. */
export function sweptCircleVsSegments(
  from: Vec2,
  to: Vec2,
  radius: number,
  segments: Segment[]
): Contact | null {
  let best: Contact | null = null;
  for (const s of segments) {
    const hit = sweptCircleVsSegment(from, to, radius, s);
    if (hit && (best === null || hit.toi < best.toi)) {
      best = hit;
    }
  }
  return best;
}

/** Advance a circle by `vel * dt` against `segments`, sliding along surfaces.
 *  Returns the resolved position, the post-slide velocity, and whether it
 *  ended resting on an upward-facing surface. */
export function resolveMovement(
  from: Vec2,
  vel: Vec2,
  radius: number,
  segments: Segment[],
  dt: number
): { pos: Vec2; vel: Vec2; grounded: boolean } {
  if (!isFinite(dt) || dt <= 0 || segments.length === 0) {
    // Nothing to collide with, or no time to advance: move freely.
    const pos =
      isFinite(dt) && dt > 0
        ? add(from, scale(vel, dt))
        : { x: from.x, y: from.y };
    return { pos, vel, grounded: false };
  }

  let pos = { x: from.x, y: from.y };
  let curVel = { x: vel.x, y: vel.y };
  let remaining = dt;
  let grounded = false;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const moveLen = length(scale(curVel, remaining));
    if (remaining <= EPS || moveLen < EPS) break;

    const to = add(pos, scale(curVel, remaining));
    const contact = sweptCircleVsSegments(pos, to, radius, segments);

    if (!contact) {
      pos = to;
      remaining = 0;
      break;
    }

    // Move to the point of impact, then pull back along the normal by the
    // depenetration skin so next frame doesn't start overlapping.
    const toi = Math.max(0, Math.min(1, contact.toi));
    let landed = contact.point;
    landed = add(landed, scale(contact.normal, SKIN));
    pos = landed;

    if (contact.normal.y < -0.5) {
      grounded = true;
    }

    // Consume the time spent reaching the contact.
    remaining = remaining * (1 - toi);

    // Slide: remove the velocity component along the normal (into the
    // surface), keep the tangential component. Do not zero velocity.
    const vn = dot(curVel, contact.normal);
    if (vn < 0) {
      curVel = sub(curVel, scale(contact.normal, vn));
    }

    if (remaining <= EPS) break;
  }

  return { pos, vel: curVel, grounded };
}
