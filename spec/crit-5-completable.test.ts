// Answers the crit-5 spec line "a stranger can pick it up and reach an ending
// inside five minutes" from the only angle a test can reach: every level must
// actually be COMPLETABLE by the real physics, not merely affordable on paper.
//
// A scripted player drives the true simulation, drawing one straight line per
// gap — the cheapest correct strategy, and the one a competent first-timer
// converges on. If this cannot finish a level, no human can. It says nothing
// about whether the game teaches itself; the pod settles that, not this file.

import { describe, expect, it } from "vitest";
import { LEVEL_COUNT } from "../src/game/level";
import { createState, groundSurfaceYAt, step, strokeFromPoints } from "../src/game/world";
import { inkCost } from "../src/game/ink";
import { RUNNER_RADIUS, SPIKE_HEIGHT } from "../src/game/tuning";
import type { GameState } from "../src/game/types";

function gapsOf(state: GameState): { from: number; to: number }[] {
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

function play(levelIndex: number): GameState {
  const state = createState(levelIndex);
  const gaps = gapsOf(state);
  const bridged = new Set<number>();
  const STEP = 1 / 120;
  let guard = 0;

  const spiked = new Set<number>();

  while (state.phase === "running" && state.elapsed < 300 && guard++ < 400_000) {
    // Spike fields: the runner cannot jump, so the only answer is a line up,
    // over and down. Committed on approach, exactly as for a gap.
    for (const [i, h] of state.level.hazards.entries()) {
      if (spiked.has(i)) continue;
      if (state.runner.pos.x < h.x - 260) continue;
      spiked.add(i);
      const clear = SPIKE_HEIGHT + 10;
      const pts = [
        { x: h.x - 100, y: h.y - 2 },
        { x: h.x - 6, y: h.y - clear },
        { x: h.x + h.width + 6, y: h.y - clear },
        { x: h.x + h.width + 100, y: h.y - 2 },
      ];
      const cost = inkCost(pts);
      if (cost > state.ink) continue;
      state.ink -= cost;
      state.strokes.push(strokeFromPoints(pts));
    }

    for (const [i, gap] of gaps.entries()) {
      if (bridged.has(i)) continue;
      if (state.runner.pos.x < gap.from - 260) continue;
      bridged.add(i);
      const yFrom = groundSurfaceYAt(gap.from - 4, state.level.groundSegments);
      const yTo = groundSurfaceYAt(gap.to + 4, state.level.groundSegments);
      if (yFrom === null || yTo === null) continue;
      const points = [
        { x: gap.from - 4, y: yFrom - RUNNER_RADIUS * 0.2 },
        { x: gap.to + 4, y: yTo - RUNNER_RADIUS * 0.2 },
      ];
      const cost = inkCost(points);
      if (cost > state.ink) continue; // out of ink: the player is now doomed
      state.ink -= cost;
      state.strokes.push(strokeFromPoints(points));
    }
    step(state, STEP, STEP);
  }
  return state;
}

describe("every level is completable by the real physics", () => {
  for (let i = 0; i < LEVEL_COUNT; i++) {
    describe(`level ${i}`, () => {
      const state = play(i);

      it("a scripted player reaches the finish", () => {
        expect(
          state.phase,
          `ended as "${state.phase}" at x=${Math.round(state.runner.pos.x)} of ${state.level.finishX}`,
        ).toBe("won");
      });

      it("finishes well inside five minutes", () => {
        expect(state.elapsed).toBeLessThan(300);
      });

      it("leaves the cheapest strategy some ink in hand", () => {
        // If the minimum viable line set exhausts the bar exactly, there is no
        // room for a first-timer to be imperfect, and the five-minute promise
        // fails for anyone who is not already optimal.
        expect(state.ink).toBeGreaterThan(0);
      });
    });
  }
});
