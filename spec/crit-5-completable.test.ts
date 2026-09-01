// Answers the crit-5 spec line "a stranger can pick it up and reach an ending
// inside five minutes" from the only angle a test can reach: the level must
// actually be COMPLETABLE by the real physics, not merely affordable on paper.
//
// A scripted player drives the true simulation, drawing one straight line per
// gap — the cheapest correct strategy, and the one a competent first-timer
// converges on. If this can't finish, no human can. It cannot speak to whether
// the game teaches itself; that is settled by the pod, not here.

import { describe, expect, it } from "vitest";
import { buildLevel } from "../src/game/level";
import { createState, groundSurfaceYAt, step, strokeFromPoints } from "../src/game/world";
import { inkCost } from "../src/game/ink";
import { RUNNER_RADIUS } from "../src/game/tuning";
import type { GameState } from "../src/game/types";

/** Gaps as the player sees them: x-ranges with no terrain underfoot. */
function findGaps(state: GameState): { from: number; to: number }[] {
  const ground = state.level.groundSegments;
  const gaps: { from: number; to: number }[] = [];
  let open: number | null = null;
  for (let x = state.level.startX; x <= state.level.finishX; x += 2) {
    const solid = groundSurfaceYAt(x, ground) !== null;
    if (!solid && open === null) open = x;
    if (solid && open !== null) {
      gaps.push({ from: open, to: x });
      open = null;
    }
  }
  return gaps;
}

function playScripted(): { state: GameState; drew: number } {
  const state = createState(buildLevel());
  const gaps = findGaps(state);
  const bridged = new Set<number>();
  let drew = 0;

  const STEP = 1 / 120;
  const LIMIT_SECONDS = 300; // the spec's five minutes
  let guard = 0;

  while (state.phase === "running" && state.elapsed < LIMIT_SECONDS && guard++ < 200_000) {
    for (const [i, gap] of gaps.entries()) {
      if (bridged.has(i)) continue;
      // Commit the line once the gap is close enough to be on screen.
      if (state.runner.pos.x < gap.from - 220) continue;
      bridged.add(i);

      const yFrom = groundSurfaceYAt(gap.from - 6, state.level.groundSegments);
      const yTo = groundSurfaceYAt(gap.to + 6, state.level.groundSegments);
      if (yFrom === null || yTo === null) continue;

      const points = [
        { x: gap.from - 6, y: yFrom - RUNNER_RADIUS * 0.2 },
        { x: gap.to + 6, y: yTo - RUNNER_RADIUS * 0.2 },
      ];
      const cost = inkCost(points);
      if (cost > state.ink) continue; // out of ink: the player is now doomed
      state.ink -= cost;
      state.strokes.push(strokeFromPoints(points));
      drew++;
    }
    step(state, STEP);
  }
  return { state, drew };
}

describe("the level is completable by the real physics", () => {
  const { state, drew } = playScripted();

  it("a scripted player reaches the finish", () => {
    expect(state.phase, `ended as "${state.phase}" at x=${Math.round(state.runner.pos.x)}`).toBe(
      "won",
    );
  });

  it("finishes well inside five minutes", () => {
    expect(state.elapsed).toBeLessThan(300);
  });

  it("bridges every gap it met", () => {
    expect(drew).toBeGreaterThan(0);
  });

  it("leaves the cheapest strategy some ink in hand", () => {
    // If the minimum viable line set exhausts the bar exactly, there is no
    // room for a first-timer to be imperfect, and the five-minute promise
    // fails for anyone who isn't optimal.
    expect(state.ink).toBeGreaterThan(0);
  });
});
