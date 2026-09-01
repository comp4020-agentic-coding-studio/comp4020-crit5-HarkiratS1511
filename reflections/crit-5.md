# Crit 5 reflection

## The breakthrough

The single change that moved this build forward the most wasn't a new
feature, it was turning one number down. `RUN_SPEED` went from 260px/s to
185 in [`47fb5ea`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/47fb5ea),
and I went in expecting it to fix one thing — the playtester had found gaps
you could walk straight through downhill with no ink spent at all, which they
correctly called a bug rather than a shortcut. A faster runner has a longer
ballistic arc off every ledge, and at 260px/s that arc was long enough to
clear several of my "gaps" for free. Slowing the runner shrank the arc, and
the free crossings stopped being free.

What I hadn't expected was that the same number was also the reason the
chaser felt unbalanceable and the reason slow motion felt pointless. At
260px/s there wasn't enough distance between "safely ahead" and "instant
kill" for a chaser to occupy — I had it either a rumour off-screen or dead
behind the runner within a stroke. And there wasn't enough spare frame budget
for slow motion to feel like a decision; the whole game already read as one
flat sprint. Turning the pace down bought room in all three places at once.
That's the actual lesson: three things I'd been treating as separate bugs —
free gaps, an unbalanceable chaser, slow motion doing nothing — were three
symptoms of one cause sitting in a tuning constant. If I'd chased each one
individually (widen the gaps, retune the chaser speed again, deepen the
slow-motion dilation again) I'd have papered over all three without ever
finding the thing underneath them. The move that actually worked was to stop
patching symptoms and ask what single number, if wrong, could produce all of
them.

## What went wrong, and what I'm keeping

The chaser in particular took three real attempts to get right, not one. It
started as decorative set-dressing that ground timing didn't respect — slow
motion dilated it along with the runner, so drawing cost nothing relative to
it, and [`58e10f2`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-HarkiratS1511/commit/58e10f2)
records it finishing a level 1026px behind, unable to ever threaten anyone. I
put it on real time to fix that, and overshot: at 232px/s the survivable
drawing window was half a second per gap, and players were dying with a
nearly full ink bar because the chaser had become the whole game. The version
that finally works, in `47fb5ea`, gives the chaser its own shallower slow-mo
dilation and a band it's held to, and only that plus the pace drop made it
visible without being a death sentence.

Stuck detection failed twice before it worked, which embarrassed me a bit
because both failures were foreseeable in hindsight. The first version only
watched a grounded runner and missed the actual commonest failure — a
too-steep line that pins the runner airborne, bouncing against the terrain
forever. The second compared frame to frame and the bouncing kept resetting
its own clock, so it never tripped. The version that shipped uses a watermark
of furthest-x-reached, which doesn't care how the runner is failing to
progress, only that it isn't.

The harness lesson from earlier assignments came back exactly as advertised:
the suite stayed green through all three of these because JSDOM cannot see a
canvas, and a green suite proved nothing about whether the game was playable.
`377f7f4` is the fix — an automated playthrough driver that drives Pointer
Events through the real simulation, which is what actually found the
step-up/wobble bug the tests couldn't. I also shipped a level with a
provably-impossible gap — 46px wide, 140px of rise, a 72-degree wall — because
I'd tested that no gap was free but never tested the inverse, that each gap
was actually climbable. The fix in `47fb5ea` measures the real climb limit
against the physics (about 60 degrees) at test time instead of hardcoding it,
so it can't go stale if the pace ever changes again.

Working with parallel subagents this week only paid off once I fixed the
module interfaces first. `47fb5ea` lands four largely independent modules —
figures, hud, scenery, and a reworked level — and they composed with no
signature drift because the contracts between them were settled before
anyone fanned out. Two agents stalled and wrote nothing when I asked them to
rewrite whole files; re-scoping the same work as targeted edits unstuck both.

What this changes about me as a developer is mostly a bias: when two or three
bugs look unrelated but showed up around the same time, I now go looking for
one shared cause before I fix any of them separately, and I don't trust a
green test suite to mean the thing is fun, or even working, until I've
watched it run.
