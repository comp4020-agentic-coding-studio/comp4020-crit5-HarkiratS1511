// The simulation. Composes geometry (collision), ink (economy) and level
// (layout) into one stepped world. Never touches the DOM.

import type { Chaser, GameState, Ghost, Level, Runner, Segment, Stroke, Vec2 } from "./types";
import { resolveMovement, segmentsFromPolyline } from "./geometry";
import { inkCost } from "./ink";
import { buildLevel } from "./level";
import {
  SPIKE_HEIGHT,
  STALL_PROGRESS_EPS,
  CHASER_BREAK_SECONDS,
  CHASE_BAND_FAR,
  CONTACT_TIGHTEN,
  CHASE_CRUISE,
  CHASE_SPRINT,
  CHASER_RADIUS,
  CHASER_SPEED,
  FALL_KILL_DEPTH,
  GHOST_LEAD,
  GRAVITY,
  MAX_FALL_SPEED,
  MAX_INK,
  PICKUP_RADIUS,
  RUNNER_RADIUS,
  RUN_SPEED,
  STEP_UP_MAX,
  STUCK_SECONDS,
} from "./tuning";

/** Ground surface height at a world x, or null over a gap. */
export function groundSurfaceYAt(x: number, ground: Segment[]): number | null {
  let best: number | null = null;
  for (const s of ground) {
    const lo = Math.min(s.a.x, s.b.x);
    const hi = Math.max(s.a.x, s.b.x);
    if (x < lo || x > hi) continue;
    const span = s.b.x - s.a.x;
    const t = Math.abs(span) < 1e-6 ? 0 : (x - s.a.x) / span;
    const y = s.a.y + (s.b.y - s.a.y) * t;
    if (best === null || y < best) best = y;
  }
  return best;
}

/** Terrain plus everything drawn. The runner AND the chaser both use this —
 *  the chaser follows the player's own path, so a bridge you build is a
 *  bridge it crosses. */
export function runnerSurfaces(state: GameState): Segment[] {
  const out: Segment[] = [...state.level.groundSegments];
  if (state.level.stub) out.push(...state.level.stub.segments);
  for (const stroke of state.strokes) out.push(...stroke.segments);
  return out;
}

/** Terrain only. The ghost never gets a bridge, which is why it always falls. */
function terrainOnly(level: Level): Segment[] {
  const out = [...level.groundSegments];
  if (level.stub) out.push(...level.stub.segments);
  return out;
}

export function strokeFromPoints(points: Vec2[]): Stroke {
  return { points: [...points], segments: segmentsFromPolyline(points) };
}

function lowestGround(level: Level): number {
  let lowest = level.groundY;
  for (const s of level.groundSegments) lowest = Math.max(lowest, s.a.y, s.b.y);
  return lowest;
}

export function createState(levelIndex: number): GameState {
  const level = buildLevel(levelIndex);
  const runner: Runner = {
    pos: { x: level.startX, y: level.groundY - RUNNER_RADIUS },
    vel: { x: RUN_SPEED, y: 0 },
    radius: RUNNER_RADIUS,
    grounded: true,
  };
  const chaser: Chaser = {
    // Placed by the band, not by the level: a level-authored head start that
    // is smaller than the cost of one stroke makes the opening unsurvivable.
    pos: {
      x: Math.min(level.chaserStartX, level.startX - CHASE_BAND_FAR),
      y: level.groundY - CHASER_RADIUS,
    },
    vel: { x: CHASER_SPEED, y: 0 },
    radius: CHASER_RADIUS,
    grounded: true,
  };
  // Only the first level demonstrates. After that the player knows.
  const ghost: Ghost | null =
    levelIndex === 0
      ? {
          pos: { x: level.startX + GHOST_LEAD, y: level.groundY - RUNNER_RADIUS },
          vel: { x: RUN_SPEED, y: 0 },
          radius: RUNNER_RADIUS,
          grounded: true,
          goneFor: 0,
        }
      : null;

  return {
    runner,
    chaser,
    ghost,
    levelIndex,
    strokes: [],
    ink: level.stub ? Math.max(0, MAX_INK - inkCost(level.stub.points)) : MAX_INK,
    maxInk: MAX_INK,
    phase: "running",
    phaseFor: 0,
    stuckFor: 0,
    progressX: level.startX,
    chaserProgressX: chaser.pos.x,
    chaserStuckFor: 0,
    level,
    elapsed: 0,
  };
}

/** Drive a body forward one step under gravity, with the auto-run rule and
 *  the step-up assist. Shared by the runner and the chaser so the chaser
 *  moves exactly as the player does — the chase is honest. */
function advance(
  body: { pos: Vec2; vel: Vec2; radius: number; grounded: boolean },
  speed: number,
  surfaces: Segment[],
  dt: number,
): void {
  body.vel.y = Math.min(body.vel.y + GRAVITY * dt, MAX_FALL_SPEED);
  // Grounded: drive horizontal speed back up, and let the slide projection
  // carry it along a slope. Airborne: hands off, so a launch keeps the arc
  // it earned.
  if (body.grounded) body.vel.x = speed;

  let moved = resolveMovement(body.pos, body.vel, body.radius, surfaces, dt);

  const wanted = body.vel.x * dt;
  const progressed = moved.pos.x - body.pos.x;
  if (body.grounded && wanted > 0 && progressed < wanted * 0.25) {
    for (const lift of [STEP_UP_MAX * 0.5, STEP_UP_MAX]) {
      const probe = resolveMovement(
        { x: body.pos.x, y: body.pos.y - lift },
        body.vel,
        body.radius,
        surfaces,
        dt,
      );
      if (probe.pos.x - body.pos.x > wanted * 0.5) {
        moved = probe;
        break;
      }
    }
  }

  body.pos = moved.pos;
  body.vel = moved.vel;
  body.grounded = moved.grounded;
}

/** Advance by `dt` seconds of GAME time. `chaserDt` is REAL seconds: dilating
 *  the chaser along with everything else would make thinking free. */
export function step(state: GameState, dt: number, chaserDt: number = dt): void {
  state.phaseFor += dt;
  if (state.phase !== "running") return;
  state.elapsed += dt;

  const surfaces = runnerSurfaces(state);
  const floor = lowestGround(state.level);

  advance(state.runner, RUN_SPEED, surfaces, dt);

  // Wedged and never getting out. Kill it rather than let the player watch a
  // motionless figure wait to be caught.
  //
  // Measured against a WATERMARK of the furthest x ever reached, not against
  // per-frame movement. Two earlier versions of this check failed: the first
  // required `grounded`, and missed the commonest wedge of all — a line too
  // steep to climb pins the runner AIRBORNE, bouncing with grounded flickering
  // false. The second compared frame to frame, and the same bouncing nudged x
  // enough to keep resetting the timer, so it never fired either. Only real
  // forward progress clears it; a legitimate arc advances the watermark
  // throughout, so nothing in flight is ever killed by mistake.
  if (state.runner.pos.x > state.progressX + STALL_PROGRESS_EPS) {
    state.progressX = state.runner.pos.x;
    state.stuckFor = 0;
  } else {
    state.stuckFor += dt;
    if (state.stuckFor > STUCK_SECONDS) return end(state, "lost");
  }

  // The chaser runs the player's path, on real time, in three modes:
  //   drawing  -> full speed, no reprieve. Slow motion is real time to it, so
  //               thinking is always paid for in ground.
  //   far      -> sprints back into the band, so it never becomes the distant
  //               rumour the playtester never once saw.
  //   cruising -> meaningfully slower than the runner, so clean running buys
  //               back what a draw costs. Without this the arithmetic only
  //               ran one way and the second stroke of the game was fatal.
  const drawing = chaserDt > dt * 1.5;
  const trail = state.runner.pos.x - state.chaser.pos.x;
  const chaseSpeed = drawing
    ? CHASER_SPEED
    : trail > CHASE_BAND_FAR
      ? RUN_SPEED * CHASE_SPRINT
      : RUN_SPEED * CHASE_CRUISE;
  // A wall of ink behind you used to pen the chaser in for good, leaving the
  // rest of the course a stroll. It cannot be solved by geometry — the chaser
  // collides with strokes exactly as the runner does, so anything that stops
  // the runner stops it. Instead it loses patience: once blocked for
  // CHASER_BREAK_SECONDS it ignores drawn ink entirely and walks through the
  // wall, colliding with terrain alone until it is moving again. Your ink
  // buys time, never safety.
  const penned = state.chaserStuckFor > CHASER_BREAK_SECONDS;
  advance(
    state.chaser,
    chaseSpeed,
    penned ? terrainOnly(state.level) : surfaces,
    chaserDt,
  );
  if (state.chaser.pos.x > state.chaserProgressX + STALL_PROGRESS_EPS) {
    state.chaserProgressX = state.chaser.pos.x;
    state.chaserStuckFor = 0;
  } else {
    state.chaserStuckFor += chaserDt;
  }
  // It cannot be escaped by breaking the bridge behind you: if it falls out
  // of the world it re-emerges on solid ground and keeps coming.
  if (state.chaser.pos.y - floor > FALL_KILL_DEPTH) {
    const y = groundSurfaceYAt(state.chaser.pos.x, state.level.groundSegments);
    state.chaser.pos.y = (y ?? state.level.groundY) - state.chaser.radius;
    state.chaser.vel = { x: CHASER_SPEED, y: 0 };
    state.chaser.grounded = true;
  }

  stepGhost(state, dt, floor);
  collectPickups(state);

  const dx = state.runner.pos.x - state.chaser.pos.x;
  const dy = state.runner.pos.y - state.chaser.pos.y;
  // Tightened: the silhouettes are narrower than their collision circles, so
  // at the full summed radii the run ended with daylight still visible
  // between them and the catch looked like it fired early.
  const reach = (state.runner.radius + state.chaser.radius) * CONTACT_TIGHTEN;
  if (dx * dx + dy * dy <= reach * reach) return end(state, "lost");

  if (hitsHazard(state)) return end(state, "lost");
  if (state.runner.pos.y - floor > FALL_KILL_DEPTH) return end(state, "lost");
  if (state.runner.pos.x >= state.level.finishX) return end(state, "won");
}

function end(state: GameState, phase: "won" | "lost"): void {
  state.phase = phase;
  state.phaseFor = 0;
}

function stepGhost(state: GameState, dt: number, floor: number): void {
  const ghost = state.ghost;
  if (!ghost) return;
  if (ghost.goneFor > 0) {
    ghost.goneFor += dt;
    if (ghost.goneFor > 2.5) state.ghost = null;
    return;
  }
  advance(ghost, RUN_SPEED, terrainOnly(state.level), dt);
  if (ghost.pos.y - floor > FALL_KILL_DEPTH * 0.6) ghost.goneFor = 0.0001;
}

/** A spike field is cleared only by passing above it. The runner's lowest
 *  point is its centre plus its radius, so riding a drawn line at least
 *  SPIKE_HEIGHT above the ground carries it over. */
function hitsHazard(state: GameState): boolean {
  const r = state.runner;
  const bottom = r.pos.y + r.radius;
  for (const h of state.level.hazards) {
    if (r.pos.x + r.radius < h.x || r.pos.x - r.radius > h.x + h.width) continue;
    if (bottom > h.y - SPIKE_HEIGHT) return true;
  }
  return false;
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
      state.ink = Math.min(state.maxInk, state.ink + pickup.amount);
    }
  }
}
