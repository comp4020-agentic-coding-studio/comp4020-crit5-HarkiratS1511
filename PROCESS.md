# Process overview

This is a reading guide to how the week went, not an essay about it. Each
moment below cites the commit that carries the evidence.

## What I built

**Ink** is a side-on auto-runner: the runner sprints on its own, and the only
thing the player controls is a finite ink bar they spend drawing lines —
bridges over gaps, ramps over spike fields — while a chaser closes in behind
them if they draw badly or too slowly. The brief forbids any instructions
anywhere on screen, so every rule the player needs has to be taught by what
they see happen, never by a word.

## The moments that mattered

### The breakthrough was pace

Three things looked like three unrelated defects: gaps you could cross
downhill with no ink spent at all, a chaser that was either a rumour or an
instant kill with nothing in between, and a slow-motion mechanic that did
nothing you could feel. All three turned out to be downstream of one tuning
constant. `RUN_SPEED` dropping from 260px/s to 185px/s in
[`47fb5ea`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/47fb5ea)
shortened the runner's ballistic arc off every ledge (closing the free
downhill crossings), opened enough distance between "safely ahead" and
"caught" for a chaser to actually occupy a band in the middle, and finally
left spare frame budget for slow motion to register as a decision rather than
noise. Chasing each symptom individually — widen the gaps, retune the chaser
again, deepen the dilation again — would have papered over all three without
ever finding the shared cause.

### A green suite proved nothing

JSDOM cannot see a canvas, so the test suite stayed fully green through three
separate bugs that made the built game unplayable: a portrait-scaled sightline
that showed two thirds of empty sky on the phone viewport and a chaser that
could never catch anyone
([`58e10f2`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/58e10f2)),
a camera with no y-anchor that floated the ground at a different height on
each screen size
([`735768b`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/735768b)),
and a hand-drawn stroke whose upward wobble presented a near-vertical face
that froze the runner in place for three real seconds while the chaser closed
in
([`377f7f4`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/377f7f4)).
None of these were found by a test; all three were found by driving the built
game in a real browser and watching it. That produced two lasting sensors
rather than one-off fixes: an automated playthrough driver
(`scripts/playthrough.mjs`, added in `377f7f4`) that drives real Pointer
Events through the simulation, and a headless-Chromium viewport check
(`spec/viewport.sensor.test.ts`, added in `58e10f2`) that serves the build
under the real GitHub Pages base path and asserts no overflow, no console
errors, and no failed requests. Per `spec/README.md` these are harness, not
contract tests answering this week's brief — they carry into next week's repo
the same way a `CLAUDE.md` rule does.

### Bugs that took several attempts, each one measured

- **Chaser balance** took three attempts, not one. It started inert —
  [`58e10f2`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/58e10f2)
  records it finishing a level 1026px behind because slow motion dilated it
  along with the runner, so drawing cost nothing relative to it. Putting it on
  real time overshot the other way: at 232px/s the survivable drawing window
  measured half a second per gap, and playtesters died with a nearly full ink
  bar because the chaser had become the only mechanic. The version that
  shipped, in
  [`47fb5ea`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/47fb5ea),
  gives the chaser its own shallower slow-motion dilation and holds it to a
  band behind the runner, so it is visible without being a death sentence —
  each version was retuned off a measured playthrough number, not a guess.
- **Stuck detection** failed twice before the third version worked, for the
  same underlying reason both times: a runner pinned against too-steep a line
  bounces rather than sitting still. The first version only watched a
  grounded runner and missed the commonest failure, a line too steep to climb
  that pins the runner airborne. The second compared frame to frame, and the
  bouncing kept resetting its own clock so it never tripped. The version that
  shipped in `47fb5ea` measures a watermark of furthest-x-reached instead,
  which doesn't care how the runner is failing to progress, only that it
  isn't.
- **The walling exploit** — a vertical stroke drawn behind the player
  permanently penned the chaser, leaving the rest of the course free to walk —
  took two attempts to close. The first fix,
  [`8db108e`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/8db108e),
  gave the chaser patience: blocked long enough, it ignores ink and walks
  through. That only delayed the pen, since a still-patient chaser could be
  penned again for the timer's full duration. The real fix,
  [`d08babf`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/d08babf),
  changes what counts as an obstacle at all: the chaser now treats a drawn
  segment as solid only when it's shallow enough to walk on, so a vertical
  stroke simply isn't a wall to it, verified against vertical, near-vertical,
  70-degree and 40-degree strokes.

### A level shipped provably impossible gaps

Every gap test up to that point proved a gap couldn't be crossed for free —
never that it could be crossed at all. Level 3 had shipped a 46px-wide gap
rising 140px, a 72-degree wall no runner could mount, and nothing in the
suite caught it because the suite only ever checked one direction of the
claim. The fix in
[`47fb5ea`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/47fb5ea)
measures the runner's actual climbable limit against the physics — about 60
degrees — and re-measures it at test time rather than hardcoding the number,
so every gap in every level is now proven both ways: not free without ink,
and actually climbable with it. That measurement can't go stale if the pace
constant above ever moves again.

### Directing agents — the lesson worth keeping

`47fb5ea` lands four largely independent modules in one pass — figures, hud,
scenery, and a reworked level — and they composed with zero signature drift
because the contracts between them were settled and fixed before any agent
was set loose on the implementation. That ordering mattered more than any
individual prompt: three separate agents this week stalled out or timed out,
having written nothing, when asked to rewrite a large file wholesale, and
every one of them succeeded once the same piece of work was re-scoped as
targeted edits to specific functions inside a file whose interface didn't
move. That's not an anecdote about one stuck agent — it's a reusable rule for
how to hand this kind of work off at all: fix the seams first, then never ask
an agent to hold a whole file's shape in its head when it only needs to
change a function's insides.
