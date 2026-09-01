// The simulation. Composes geometry (collision), ink (economy) and level
// (layout) into one stepped world. Pure with respect to rendering: this
// module never touches the DOM.

import type { GameState, Level, Segment, Stroke, Vec2 } from "./types";
import { resolveMovement, segmentsFromPolyline } from "./geometry";
import {
  CHASER_RADIUS,
  CHASER_SPEED,
  FALL_KILL_DEPTH,
  GRAVITY,
  MAX_FALL_SPEED,
  MAX_INK,
  PICKUP_RADIUS,
  RUNNER_RADIUS,
  RUN_SPEED,
} from "./tuning";

/** Ground surface height at a world x, or null over a gap. Only static
 *  ground counts — the chaser is bound to this and never to player strokes,
 *  which is what keeps "draw high to escape it" a real option. */
export function groundSurfaceYAt(x: number, ground: Segment[]): number | null {
  let best: number | null = null;
  for (const s of ground) {
    const lo = Math.min(s.a.x, s.b.x);
    const hi = Math.max(s.a.x, s.b.x);
    if (x < lo || x > hi) continue;
    const span = s.b.x - s.a.x;
    const t = Math.abs(span) < 1e-6 ? 0 : (x - s.a.x) / span;
    const y = s.a.y + (s.b.y - s.a.y) * t;
    // Smaller y is higher on screen; the topmost surface is the one you walk.
    if (best === null || y < best) best = y;
  }
  return best;
}

/** Every surface the RUNNER may stand on: terrain, the teaching stub, and
 *  everything the player has drawn. */
export function runnerSurfaces(state: GameState): Segment[] {
  const out: Segment[] = [...state.level.groundSegments];
  if (state.level.stub) out.push(...state.level.stub.segments);
  for (const stroke of state.strokes) out.push(...stroke.segments);
  return out;
}

export function strokeFromPoints(points: Vec2[]): Stroke {
  return { points: [...points], segments: segmentsFromPolyline(points) };
}

export function createState(level: Level): GameState {
  return {
    runner: {
      pos: { x: level.startX, y: level.groundY - RUNNER_RADIUS },
      vel: { x: RUN_SPEED, y: 0 },
      radius: RUNNER_RADIUS,
      grounded: true,
    },
    chaser: {
      pos: { x: level.chaserStartX, y: level.groundY - CHASER_RADIUS },
      radius: CHASER_RADIUS,
    },
    strokes: [],
    ink: MAX_INK,
    maxInk: MAX_INK,
    phase: "running",
    level,
    elapsed: 0,
  };
}

/** Advance the world by `dt` seconds of GAME time (already time-dilated by
 *  the caller — slow motion is applied before this, not inside it). */
export function step(state: GameState, dt: number): void {
  if (state.phase !== "running") return;
  state.elapsed += dt;

  const runner = state.runner;

  // Gravity always. Terminal velocity is a tunneling guard as much as a feel
  // choice: an uncapped fall outruns even swept collision at low frame rates.
  runner.vel.y = Math.min(runner.vel.y + GRAVITY * dt, MAX_FALL_SPEED);

  // The auto-run rule, and the momentum rule, in one place:
  // grounded -> drive horizontal speed back to RUN_SPEED, and let the slide
  // projection in resolveMovement convert it along a slope;
  // airborne  -> leave velocity untouched, so a well-angled line launches you
  // and the arc you earned is the arc you keep.
  if (runner.grounded) runner.vel.x = RUN_SPEED;

  const surfaces = runnerSurfaces(state);
  const moved = resolveMovement(runner.pos, runner.vel, runner.radius, surfaces, dt);
  runner.pos = moved.pos;
  runner.vel = moved.vel;
  runner.grounded = moved.grounded;

  // The chaser is ground-bound by construction: it advances at a constant
  // rate and rides the static terrain height, holding its last height across
  // a gap. It cannot mount a drawn line, so elevation is genuine safety.
  state.chaser.pos.x += CHASER_SPEED * dt;
  const groundHere = groundSurfaceYAt(state.chaser.pos.x, state.level.groundSegments);
  if (groundHere !== null) state.chaser.pos.y = groundHere - state.chaser.radius;

  collectPickups(state);

  // Loss by contact.
  const dx = runner.pos.x - state.chaser.pos.x;
  const dy = runner.pos.y - state.chaser.pos.y;
  const reach = runner.radius + state.chaser.radius;
  if (dx * dx + dy * dy <= reach * reach) {
    state.phase = "lost";
    return;
  }

  // Loss by falling. Measured against the lowest terrain so a level with
  // varied heights doesn't kill early on a legitimate low platform.
  let lowest = state.level.groundY;
  for (const s of state.level.groundSegments) lowest = Math.max(lowest, s.a.y, s.b.y);
  if (runner.pos.y - lowest > FALL_KILL_DEPTH) {
    state.phase = "lost";
    return;
  }

  if (runner.pos.x >= state.level.finishX) state.phase = "won";
}

function collectPickups(state: GameState): void {
  const r = state.runner;
  for (const pickup of state.level.pickups) {
    if (pickup.taken) continue;
    const dx = r.pos.x - pickup.pos.x;
    const dy = r.pos.y - pickup.pos.y;
    const reach = r.radius + PICKUP_RADIUS;
    if (dx * dx + dy * dy <= reach * reach) {
      pickup.taken = true;
      // Ink is capped, never banked beyond the bar: overfilling would make
      // early pickups a reason to hoard rather than to spend.
      state.ink = Math.min(state.maxInk, state.ink + pickup.amount);
    }
  }
}
