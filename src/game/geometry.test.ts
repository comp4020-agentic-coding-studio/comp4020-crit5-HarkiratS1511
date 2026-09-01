import { describe, it, expect } from "vitest";
import type { Segment } from "./types";
import {
  vec,
  add,
  sub,
  scale,
  dot,
  length,
  normalize,
  closestPointOnSegment,
  segmentsFromPolyline,
  sweptCircleVsSegments,
  resolveMovement,
} from "./geometry";

describe("vector primitives", () => {
  it("basic arithmetic", () => {
    expect(add(vec(1, 2), vec(3, 4))).toEqual({ x: 4, y: 6 });
    expect(sub(vec(5, 5), vec(2, 1))).toEqual({ x: 3, y: 4 });
    expect(scale(vec(2, 3), 2)).toEqual({ x: 4, y: 6 });
    expect(dot(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
    expect(length(vec(3, 4))).toBeCloseTo(5);
  });

  it("normalize handles zero-length vectors without NaN", () => {
    const n = normalize(vec(0, 0));
    expect(n.x).not.toBeNaN();
    expect(n.y).not.toBeNaN();
    const n2 = normalize(vec(3, 4));
    expect(length(n2)).toBeCloseTo(1);
  });

  it("closestPointOnSegment projects and clamps", () => {
    const s: Segment = { a: vec(0, 0), b: vec(10, 0) };
    expect(closestPointOnSegment(vec(5, 5), s)).toEqual({ x: 5, y: 0 });
    expect(closestPointOnSegment(vec(-5, 5), s)).toEqual({ x: 0, y: 0 });
    expect(closestPointOnSegment(vec(15, 5), s)).toEqual({ x: 10, y: 0 });
  });

  it("closestPointOnSegment on a zero-length segment doesn't throw or NaN", () => {
    const s: Segment = { a: vec(5, 5), b: vec(5, 5) };
    const p = closestPointOnSegment(vec(10, 10), s);
    expect(p.x).not.toBeNaN();
    expect(p.y).not.toBeNaN();
    expect(p).toEqual({ x: 5, y: 5 });
  });

  it("segmentsFromPolyline builds consecutive segments", () => {
    const pts = [vec(0, 0), vec(10, 0), vec(10, 10)];
    const segs = segmentsFromPolyline(pts);
    expect(segs.length).toBe(2);
    expect(segs[0]).toEqual({ a: vec(0, 0), b: vec(10, 0) });
    expect(segs[1]).toEqual({ a: vec(10, 0), b: vec(10, 10) });
  });

  it("segmentsFromPolyline handles < 2 points without throwing", () => {
    expect(segmentsFromPolyline([])).toEqual([]);
    expect(segmentsFromPolyline([vec(1, 1)])).toEqual([]);
  });
});

describe("sweptCircleVsSegments", () => {
  it("does not tunnel through a thin vertical segment on a fast horizontal sweep", () => {
    // A thin vertical wall at x=100, spanning y in [-50, 50].
    const wall: Segment = { a: vec(100, -50), b: vec(100, 50) };
    const radius = 8;
    // Fast sweep: 1000px in one step (well beyond RUN_SPEED*dt in practice,
    // representative of what a naive discrete check would miss).
    const contact = sweptCircleVsSegments(
      vec(0, 0),
      vec(1000, 0),
      radius,
      [wall]
    );
    expect(contact).not.toBeNull();
    // Contact should occur at approx x = 100 - radius (circle touches wall
    // from the left), well before reaching x=1000.
    expect(contact!.point.x).toBeCloseTo(100 - radius, 1);
    expect(contact!.toi).toBeGreaterThan(0);
    expect(contact!.toi).toBeLessThan(1);
    // Normal should point back toward the incoming side (negative x).
    expect(contact!.normal.x).toBeLessThan(0);
  });

  it("returns null when the sweep passes nowhere near any segment", () => {
    const seg: Segment = { a: vec(0, 1000), b: vec(100, 1000) };
    const contact = sweptCircleVsSegments(vec(0, 0), vec(100, 0), 5, [seg]);
    expect(contact).toBeNull();
  });

  it("handles zero-length segments and zero-length movement without throwing or NaN", () => {
    const degenerate: Segment = { a: vec(50, 0), b: vec(50, 0) };
    const c1 = sweptCircleVsSegments(vec(0, 0), vec(100, 0), 5, [degenerate]);
    if (c1) {
      expect(c1.toi).not.toBeNaN();
      expect(c1.point.x).not.toBeNaN();
      expect(c1.point.y).not.toBeNaN();
    }

    const seg: Segment = { a: vec(0, 10), b: vec(100, 10) };
    // Zero-length movement (from === to).
    const c2 = sweptCircleVsSegments(vec(50, 0), vec(50, 0), 5, [seg]);
    expect(c2).toBeNull();
  });
});

describe("resolveMovement", () => {
  const GRAVITY = 1500;

  it("a falling circle rests on a flat surface and reports grounded", () => {
    const ground: Segment = { a: vec(-500, 100), b: vec(500, 100) };
    let pos = vec(0, 0);
    let vel = vec(0, 0);
    const radius = 12;
    let grounded = false;

    // Simulate falling under gravity for a bunch of steps.
    const dt = 1 / 60;
    for (let i = 0; i < 200; i++) {
      vel = add(vel, vec(0, GRAVITY * dt));
      const res = resolveMovement(pos, vel, radius, [ground], dt);
      pos = res.pos;
      vel = res.vel;
      grounded = res.grounded;
      if (grounded) break;
    }

    expect(grounded).toBe(true);
    // Resting position should be just above the ground surface (y=100)
    // by approximately the radius (plus a small skin).
    expect(pos.y).toBeLessThan(100);
    expect(pos.y).toBeGreaterThan(100 - radius - 1);
    expect(pos.y).toBeCloseTo(100 - radius, 0);
    // Downward velocity should have been removed by the slide/contact.
    expect(vel.y).toBeLessThanOrEqual(0.01);
  });

  it("crossing the join between two collinear segments does not snag or lose speed", () => {
    // Two collinear ground segments joined at x=100.
    const seg1: Segment = { a: vec(0, 100), b: vec(100, 100) };
    const seg2: Segment = { a: vec(100, 100), b: vec(300, 100) };
    const radius = 12;
    // Start resting just above the join, moving horizontally with a slight
    // downward drift each frame (as a real runner would, under gravity,
    // after having its vertical velocity zeroed by the previous frame's
    // contact).
    let pos = vec(70, 100 - radius - 0.005);
    let vel = vec(260, 5);
    const dt = 1 / 60;

    let minSpeed = Infinity;
    for (let i = 0; i < 30; i++) {
      const stepVel = add(vel, vec(0, GRAVITY * dt));
      const res = resolveMovement(pos, stepVel, radius, [seg1, seg2], dt);
      pos = res.pos;
      vel = res.vel;
      const speed = length(vel);
      if (speed < minSpeed) minSpeed = speed;
    }

    // Should have crossed the x=100 join.
    expect(pos.x).toBeGreaterThan(100);
    // Horizontal speed should not have collapsed while crossing the join.
    expect(vel.x).toBeGreaterThan(250);
    expect(vel.y).toBeCloseTo(0, 1);
  });

  it("sliding down a 45-degree slope preserves speed along the tangent", () => {
    // A 45-degree downward-right slope (upward-facing normal).
    const slope: Segment = { a: vec(0, 0), b: vec(1000, 1000) };
    const radius = 10;
    let pos = vec(50, 50 - radius + 1); // just above the slope near its start
    let vel = vec(0, 0);
    const dt = 1 / 60;

    let speedBefore = 0;
    let speedAfter = 0;
    for (let i = 0; i < 120; i++) {
      vel = add(vel, vec(0, GRAVITY * dt));
      const before = length(vel);
      const res = resolveMovement(pos, vel, radius, [slope], dt);
      pos = res.pos;
      vel = res.vel;
      if (i === 60) speedBefore = before;
      if (i === 60) speedAfter = length(vel);
    }

    // On a 45-degree slope, sliding should preserve most of the speed
    // magnitude (only the into-surface component is removed), so speed
    // after resolving should be a substantial fraction of speed before
    // the gravity increment was applied, not collapsed to ~0.
    expect(speedAfter).toBeGreaterThan(speedBefore * 0.5);

    // The runner should have picked up net rightward and downward motion
    // from sliding down the slope (tangent direction is (1,1)/sqrt(2)).
    expect(vel.x).toBeGreaterThan(0);
    expect(vel.y).toBeGreaterThan(0);
  });

  it("a circle leaving a ramp end keeps its velocity (does not zero out)", () => {
    // A short upward-sloping ramp from (0,100) to (100,0), then nothing.
    const ramp: Segment = { a: vec(0, 100), b: vec(100, 0) };
    const radius = 10;
    // Position right at the end of the ramp, moving up and to the right
    // along the ramp's direction, about to leave it.
    const tangent = normalize(vec(100, -100));
    let pos = add(vec(95, 5), scale(normalize(vec(1, 1)), radius)); // just off-surface near the ramp end
    let vel = scale(tangent, 300);
    const dt = 1 / 60;

    const incomingSpeed = length(vel);
    const res = resolveMovement(pos, vel, radius, [ramp], dt);

    // Having left the ramp (moved past its end with no other segment to
    // collide with), velocity should be preserved in full, not zeroed.
    expect(length(res.vel)).toBeGreaterThan(incomingSpeed * 0.9);
    expect(res.vel.x).toBeGreaterThan(0);
  });

  it("global earliest-TOI resolution: two segments forming a shallow corner don't cause sequential snagging", () => {
    // A shallow V made of two segments meeting at (100,100); simulate a
    // fast rightward+downward sweep that should be caught by whichever
    // segment it hits first, not distorted by iterating segment order.
    const segA: Segment = { a: vec(0, 100), b: vec(100, 100) };
    const segB: Segment = { a: vec(100, 100), b: vec(200, 80) };
    const radius = 10;
    const res = resolveMovement(
      vec(50, 50),
      vec(200, 800),
      radius,
      [segA, segB],
      1 / 20
    );
    expect(res.pos.x).not.toBeNaN();
    expect(res.pos.y).not.toBeNaN();
    expect(res.vel.x).not.toBeNaN();
    expect(res.vel.y).not.toBeNaN();
  });

  it("zero-length segments and zero-length movement in resolveMovement don't throw or produce NaN", () => {
    const degenerate: Segment = { a: vec(50, 50), b: vec(50, 50) };
    const res1 = resolveMovement(
      vec(0, 0),
      vec(10, 10),
      5,
      [degenerate],
      1 / 60
    );
    expect(res1.pos.x).not.toBeNaN();
    expect(res1.pos.y).not.toBeNaN();
    expect(res1.vel.x).not.toBeNaN();
    expect(res1.vel.y).not.toBeNaN();

    // Zero velocity / zero dt.
    const res2 = resolveMovement(vec(0, 0), vec(0, 0), 5, [degenerate], 1 / 60);
    expect(res2.pos).toEqual({ x: 0, y: 0 });
    expect(res2.vel.x).not.toBeNaN();

    const res3 = resolveMovement(vec(0, 0), vec(10, 10), 5, [degenerate], 0);
    expect(res3.pos.x).not.toBeNaN();
    expect(res3.pos.y).not.toBeNaN();

    // No segments at all.
    const res4 = resolveMovement(vec(0, 0), vec(10, 10), 5, [], 1 / 60);
    expect(res4.pos.x).toBeCloseTo(10 / 60, 6);
    expect(res4.pos.y).toBeCloseTo(10 / 60, 6);
    expect(res4.grounded).toBe(false);
  });
});
