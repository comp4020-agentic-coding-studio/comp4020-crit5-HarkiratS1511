import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Crit 5 ("A game") spec: https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/05-game/
// Two of the seven spec lines are mechanically checkable ahead of a real
// build; the rest need a human (a stranger playing cold) or your own
// process record (PROCESS.md, reflections/crit-5.md — see check:evidence).
// These start red: there's no game here yet.
const home = new JSDOM(readFileSync(resolve("dist/index.html"), "utf8")).window.document;

describe("no instructions anywhere, on screen or off", () => {
  it("has no how-to-play / tutorial / instructions text on the page", () => {
    const text = home.body.textContent ?? "";
    expect(text).not.toMatch(/how to play|instructions|tutorial/i);
  });

  it("links to no separate instructions or help page", () => {
    for (const a of home.querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toMatch(/how-?to-?play|instructions|help|tutorial/i);
    }
  });
});

describe("the opening screen invites the first move", () => {
  it("offers an interactive entry point, not just prose", () => {
    // Whatever form the game takes (canvas, DOM, Twine-style links), the
    // opening screen needs something to act on beyond reading text.
    const hasCanvas = home.querySelector("canvas");
    const hasApplicationRole = home.querySelector('[role="application"]');
    const hasGameButton = home.querySelector("main button, main [tabindex]");
    expect(
      hasCanvas ?? hasApplicationRole ?? hasGameButton,
      "no canvas, role=application element, or focusable/button control found in <main>",
    ).toBeTruthy();
  });
});

// Judged at the crit, not here:
// - "a stranger can pick it up and reach an ending inside five minutes"
//   (your pod plays it cold — see spec)
// - "it can be lost: a wrong move is possible, and play ends somewhere"
//   (write a focused test for this once your rule is chosen — that test IS
//   the spec's "one rule has a focused automated test" line)
// - "one change you made came from playing the finished game" (PROCESS.md)
// - "you can account for how you directed, grounded and corrected the work"
//   (crit conversation)
