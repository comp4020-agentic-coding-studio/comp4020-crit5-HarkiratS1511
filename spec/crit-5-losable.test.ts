// Answers the crit-5 spec line "it can be lost: a wrong move is possible, and
// play ends somewhere".
//
// Its sibling `crit-5-completable.test.ts` proves the run can be WON. That is
// only half the contract, and on its own it is satisfied by a toy that cannot
// be failed — which is exactly what last week's instrument was, and exactly
// what this week's brief says a game is not. This file proves the other half
// against the real simulation: that there are wrong moves, that each one ends
// the run, and that a run always terminates rather than going on forever.
//
// Deliberately written to be GEOMETRY-INDEPENDENT. Not one assertion here
// names a coordinate, a gap, a level length or a hazard position, so the
// levels can be re-authored — as they were, when the terrain gained real
// verticality — without this file needing a line changed. What it pins is the
// rule, not the map.

import { describe, expect, it } from "vitest";
import { LEVEL_COUNT } from "../src/game/level";
import { createState, step } from "../src/game/world";
import { CHASE_DRAW_SCALE, CHASER_RADIUS, RUNNER_RADIUS, SLOWMO_SCALE } from "../src/game/tuning";
import type { GameState } from "../src/game/types";

const STEP = 1 / 120;

/** Run the real loop until the phase settles or the budget runs out. `hold`
 *  models the player keeping the brush pressed: the world dilates but the
 *  chaser keeps most of its real seconds, which is the price of thinking. */
function runUntilSettled(
  state: GameState,
  opts: { seconds: number; hold?: boolean } = { seconds: 300 },
): GameState {
  const hold = opts.hold ?? false;
  const worldStep = hold ? STEP * SLOWMO_SCALE : STEP;
  const chaserStep = hold ? STEP * CHASE_DRAW_SCALE : STEP;
  let ticks = 0;
  const maxTicks = Math.ceil(opts.seconds / STEP);
  while (state.phase === "running" && ticks++ < maxTicks) {
    step(state, worldStep, chaserStep);
  }
  return state;
}

describe("a wrong move is possible: drawing nothing loses the run", () => {
  it.each(Array.from({ length: LEVEL_COUNT }, (_, i) => i))(
    "level %i cannot be walked through without drawing",
    (levelIndex) => {
      const state = runUntilSettled(createState(levelIndex), { seconds: 300 });
      // The single most important property in the game. If a level could be
      // completed by holding still and doing nothing, the only verb the game
      // has would be optional, and there would be no game.
      expect(state.phase).toBe("lost");
    },
  );

  it("the loss is legible: a player who draws nothing dies on screen, not off it", () => {
    const state = runUntilSettled(createState(0), { seconds: 300 });
    expect(state.phase).toBe("lost");
    // Whatever ended it, the body is close enough to the ground the player was
    // last looking at to be visible in frame. FALL_KILL_DEPTH is kept small for
    // exactly this reason (see tuning.ts) — a game that may not explain itself
    // in words has to let the player SEE the cause of death.
    const lowest = Math.max(
      ...state.level.groundSegments.flatMap((s) => [s.a.y, s.b.y]),
    );
    expect(state.runner.pos.y).toBeLessThan(lowest + 400);
  });
});

describe("the chaser is a real loss condition, not set dressing", () => {
  it("catching the runner ends the run", () => {
    const state = createState(0);
    // Put it right on top of the runner. Contact is judged on the summed radii
    // (tightened by CONTACT_TIGHTEN), so this is inside the catch envelope by
    // construction, whatever the level looks like.
    state.chaser.pos = { x: state.runner.pos.x, y: state.runner.pos.y };
    state.chaser.grounded = true;
    step(state, STEP, STEP);
    expect(state.phase).toBe("lost");
  });

  it("a body's length of daylight is NOT a catch", () => {
    const state = createState(0);
    // Just outside the envelope: the catch must not fire while the player can
    // still see clear space between the two figures. An earlier build ended
    // the run at the full summed radii and it read as firing early.
    state.chaser.pos = {
      x: state.runner.pos.x - (RUNNER_RADIUS + CHASER_RADIUS) * 1.5,
      y: state.runner.pos.y,
    };
    state.chaser.grounded = true;
    step(state, STEP, STEP);
    expect(state.phase).toBe("running");
  });

  it("dithering is punished: holding the brush down forever loses", () => {
    // Slow motion is the game's one mercy, and it has to have a price, or the
    // correct strategy is to hold the button and think for as long as you like.
    // Held indefinitely, the run must still end — in a loss.
    const state = runUntilSettled(createState(0), { seconds: 300, hold: true });
    expect(state.phase).toBe("lost");
  });
});

describe("play ends somewhere", () => {
  it.each(Array.from({ length: LEVEL_COUNT }, (_, i) => i))(
    "level %i always terminates rather than running forever",
    (levelIndex) => {
      // Five minutes is the spec's ceiling for a stranger reaching an ending.
      // A passive player must hit one well inside that; this is the backstop
      // against a level that can be entered and then neither won nor lost —
      // a runner wedged against its own line, standing still, is the failure
      // this catches, and it is why world.ts carries a stall watchdog at all.
      const state = runUntilSettled(createState(levelIndex), { seconds: 300 });
      expect(state.phase).not.toBe("running");
      expect(state.elapsed).toBeLessThan(300);
    },
  );

  it("an ended run stays ended", () => {
    const state = runUntilSettled(createState(0), { seconds: 300 });
    const settled = state.phase;
    const x = state.runner.pos.x;
    for (let i = 0; i < 600; i++) step(state, STEP, STEP);
    // The end screen animates off `phaseFor`, which must keep advancing, while
    // the simulation underneath it stays frozen — otherwise the world carries
    // on moving behind the resolution.
    expect(state.phase).toBe(settled);
    expect(state.runner.pos.x).toBe(x);
    expect(state.phaseFor).toBeGreaterThan(0);
  });
});
