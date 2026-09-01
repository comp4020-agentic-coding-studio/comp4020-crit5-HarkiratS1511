// Effects: the physical feedback layer. Nothing here changes the simulation —
// every function is a read-only observer of GameState that turns three events
// (a landing, a stroke committed, a pickup taken) and two continuous signals
// (how close the chaser is, how long ago the run ended) into marks on paper.
//
// No text, no numerals, anywhere in this module.
//
// Determinism note, same discipline as scenery.ts: every fleck, droplet and
// shake sample is a pure function of world position, of `phaseFor`, or of a
// hash seeded from those — never Math.random() and never a frame counter. Two
// runs that land in the same place throw the same ink, and a paused frame
// redrawn twice is identical. The only clock is `store.now`, advanced by the
// dt the caller already uses to step the world, so slow motion slows the juice
// for free (the same trick STRIDE_PX plays on the gait).
//
// Memory note: this module may not add fields to GameState — that type is the
// integration contract every other module keys off. So the per-state memory
// lives in a module-level WeakMap, keyed by the state object, and dies with
// it. The burst pool is hard-capped (MAX_BURSTS) and evicts oldest-first: a
// leak here would not crash, it would quietly cost frame rate over a long
// run, which is the worst kind of bug to find late.

import type { GameState, Pickup, Vec2 } from "./types";
import { PICKUP_RADIUS, RUNNER_RADIUS } from "./tuning";

const INK_RGB = "26,26,46";

function inkAlpha(a: number): string {
  return `rgba(${INK_RGB},${Math.max(0, Math.min(1, a))})`;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Deterministic pseudo-random in [0,1) from a plain number — the same
 *  function scenery.ts uses, deliberately duplicated rather than exported
 *  across modules so the two layers can never be coupled by a shared seed. */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453123;
  return s - Math.floor(s);
}

/** 1 at or inside `near`, 0 at or outside `far`, smooth between. Both ends are
 *  returned exactly, so "far away" really is zero rather than a rounding
 *  fraction that keeps a vignette faintly lit forever. */
function ramp(near: number, far: number, d: number): number {
  if (!(d < far)) return 0;
  if (d <= near) return 1;
  const t = (far - d) / (far - near);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Tuning. Every number here was set against the built game at both marked
// viewports; the comments record what it was measured against.
// ---------------------------------------------------------------------------

/** Impact speed, px/s, below which a "landing" is just contact noise. The
 *  runner re-seats itself constantly: rolling terrain drops it a pixel at a
 *  time, and the STEP_UP_MAX (7px) assist re-lands it from a lift, which is
 *  worth sqrt(2 * GRAVITY * 7) ~ 145px/s. Anything under this threshold is
 *  that chatter, and puffing ink for it turns the whole run into fog. This
 *  costs ~11px of fall (sqrt(2 * 1500 * 11) ~ 180) before a landing registers,
 *  which no real jump arc is anywhere near. */
const LANDING_MIN_SPEED = 180;

/** Impact speed treated as a full-strength landing. sqrt(2 * GRAVITY * 270),
 *  i.e. a 270px drop — about the tallest fall the levels can set up before
 *  FALL_KILL_DEPTH ends the run instead. */
const LANDING_HARD_SPEED = 900;

/** World px the camera drops on a full-strength landing, and how long it takes
 *  to come back. Deliberately small: the camera is pinned to the ground line
 *  (GROUND_SCREEN_FRACTION) and a dip large enough to *notice* as motion is
 *  large enough to unpin that line and make the ground look springy. */
const DIP_MAX = 7;
const DIP_TIME = 0.26;

/** Screen px of shake at the instant of the catch, and the window it decays
 *  over. Short and sharp on purpose: the loss already has a held frame
 *  (IMPACT_HOLD, 0.55s) before the end screen, so the shake has to be over
 *  well inside that hold or it fights the resolution animation. */
const SHAKE_MAX = 13;
const SHAKE_TIME = 0.34;

/** How many discrete shake samples per second. A continuous sine reads as a
 *  wobble, not an impact; stepping the hash gives the jagged, mechanical
 *  displacement an impact actually has, and stays frame-rate independent
 *  because the step comes from phaseFor, not from how often we were called. */
const SHAKE_STEPS_PER_SECOND = 70;

/** Distance from chaser to runner, in world px, at which dread is total and
 *  at which it is nothing. CHASE_BAND_FAR is 330, so the band's far edge sits
 *  just outside DANGER_FAR: cruising at the back of the band shows nothing,
 *  and the vignette only starts once the chaser is genuinely gaining. */
const DANGER_NEAR = 44;
const DANGER_FAR = 260;

/** How long the death splat blooms for. Inside IMPACT_HOLD, so it plays over
 *  the frozen world and is gone before the end screen arrives. */
const SPLAT_TIME = 0.5;

/** Gravity on thrown ink, world px/s^2. Well under the world's GRAVITY (1500):
 *  flecks are small and light, and at full weight they dropped so fast the
 *  puff was over before the eye caught it. */
const FLECK_GRAVITY = 900;

/** Gravity on a droplet running off wet ink — heavier than a thrown fleck,
 *  because a bead of ink is heavy and falls straight rather than drifting. */
const DRIP_GRAVITY = 1200;

// ---------------------------------------------------------------------------
// The burst pool.
//
// A "burst" is one event, not one particle: its individual flecks are derived
// from its seed at draw time rather than stored. That is what lets the whole
// juice layer live inside a dozen records — the alternative, a particle list,
// is the thing that grows without bound over a long run.
// ---------------------------------------------------------------------------

type BurstKind = "land" | "stroke" | "pickup";

type Burst = {
  kind: BurstKind;
  /** Where it happened, in world units. */
  x: number;
  y: number;
  /** store.now when it was spawned. */
  t0: number;
  /** 0..1 — how hard. Drives count, spread and weight. */
  power: number;
  /** Seed for every derived fleck. Taken from world position, so the same
   *  place always throws the same pattern. */
  seed: number;
  /** For a committed stroke: a few samples along it, so the droplets fall
   *  from the line the player actually drew. Capped, never a live reference
   *  into the stroke itself. */
  path: Vec2[] | null;
};

const LIFE: Record<BurstKind, number> = {
  // Short: a puff of ink off the feet is over almost as soon as it starts.
  land: 0.45,
  // Longest: wet ink takes a moment to stop running.
  stroke: 0.8,
  pickup: 0.6,
};

/** Hard cap on live bursts. Three events can fire in one tick and the eye
 *  cannot follow more than a handful at once, so anything older than the last
 *  dozen is invisible anyway — evicting it costs nothing and bounds the pool. */
const MAX_BURSTS = 12;

/** Path samples kept per committed stroke. Enough to follow a curve, few
 *  enough that a 400-point polyline costs the same as a 3-point one. */
const PATH_SAMPLES = 5;

type Store = {
  bursts: Burst[];
  /** Effect clock, seconds. Advanced by the caller's dt, so it is the world's
   *  own (already dilated) time and keeps running after the run has ended —
   *  unlike state.elapsed, which freezes on the last frame and would leave
   *  every burst hanging in the air over the end screen. */
  now: number;
  /** Baseline captured on the first observation, so a state handed to us
   *  mid-run (or with pickups already taken) does not fire a burst for
   *  history it did not witness. */
  started: boolean;
  wasGrounded: boolean;
  /** |vel.y| on the last tick the runner was airborne. Read on the frame it
   *  touches down, because the collision solver has already zeroed vel.y by
   *  then — the speed that mattered is the one from the frame before. */
  airborneSpeed: number;
  strokeCount: number;
  /** store.now of the last landing worth dipping the camera for, and how hard
   *  it was. -1 means none yet. */
  landAt: number;
  landPower: number;
  /** Pickups already burst for. Weak, so it dies with the level rather than
   *  holding every pickup object alive for the session. */
  seenTaken: WeakSet<Pickup>;
};

const STORES = new WeakMap<GameState, Store>();

function storeFor(state: GameState): Store {
  let store = STORES.get(state);
  if (!store) {
    store = {
      bursts: [],
      now: 0,
      started: false,
      wasGrounded: true,
      airborneSpeed: 0,
      strokeCount: 0,
      landAt: -1,
      landPower: 0,
      seenTaken: new WeakSet<Pickup>(),
    };
    STORES.set(state, store);
  }
  return store;
}

function spawn(store: Store, burst: Burst): void {
  store.bursts.push(burst);
  // Oldest-first eviction: the newest event is always the one the player is
  // looking at.
  while (store.bursts.length > MAX_BURSTS) store.bursts.shift();
}

/** Up to PATH_SAMPLES evenly spaced points, copied out of the stroke so the
 *  burst never aliases live level data. */
function samplePath(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  if (points.length === 0) return out;
  const n = Math.min(PATH_SAMPLES, points.length);
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round((i / (n - 1)) * (points.length - 1));
    const p = points[idx];
    if (p) out.push({ x: p.x, y: p.y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/** Watch the state for one tick: age the pool, and spawn a burst for anything
 *  that just happened. `dt` is the same step the world was advanced by.
 *
 *  Safe to call every tick forever: the pool is capped, expired bursts are
 *  dropped, and a state where nothing happens accumulates nothing at all. */
export function updateEffects(state: GameState, dt: number): void {
  const store = storeFor(state);
  store.now += Math.max(0, dt);

  // Drop expired bursts in place, preserving order (they are already sorted by
  // spawn time, but lifetimes differ by kind so a straight shift is wrong).
  let kept = 0;
  for (const b of store.bursts) {
    if (store.now - b.t0 < LIFE[b.kind]) store.bursts[kept++] = b;
  }
  store.bursts.length = kept;

  const runner = state.runner;
  const grounded = runner.grounded;

  if (!store.started) {
    // First sight of this state: record what is already true, fire nothing.
    store.started = true;
    store.wasGrounded = grounded;
    store.strokeCount = state.strokes.length;
    for (const p of state.level.pickups) if (p.taken) store.seenTaken.add(p);
  } else {
    if (!store.wasGrounded && grounded) landed(store, state, store.airborneSpeed);
    committedStroke(store, state);
    collected(store, state);
  }

  store.airborneSpeed = grounded ? 0 : Math.abs(runner.vel.y);
  store.wasGrounded = grounded;
}

function landed(store: Store, state: GameState, impact: number): void {
  if (impact < LANDING_MIN_SPEED) return;
  const power = clamp01(
    (impact - LANDING_MIN_SPEED) / (LANDING_HARD_SPEED - LANDING_MIN_SPEED),
  );
  const r = state.runner;
  // At the feet, not at the centre: the ink is kicked up off the ground.
  const y = r.pos.y + r.radius;
  store.landAt = store.now;
  store.landPower = power;
  spawn(store, {
    kind: "land",
    x: r.pos.x,
    y,
    t0: store.now,
    power,
    seed: r.pos.x * 0.37 + y * 0.71,
    path: null,
  });
}

function committedStroke(store: Store, state: GameState): void {
  const count = state.strokes.length;
  if (count === store.strokeCount) return;
  if (count < store.strokeCount) {
    // The level was rebuilt under us (a retry reuses the state object in some
    // call sites); resync rather than firing for a stroke that vanished.
    store.strokeCount = count;
    return;
  }
  const stroke = state.strokes[count - 1];
  store.strokeCount = count;
  if (!stroke || stroke.points.length === 0) return;
  const path = samplePath(stroke.points);
  const head = path[0];
  if (!head) return;
  // Longer lines are wetter: more ink was just laid down, so more of it runs.
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  spawn(store, {
    kind: "stroke",
    x: head.x,
    y: head.y,
    t0: store.now,
    power: clamp01(length / 320),
    seed: head.x * 0.53 + head.y * 0.29 + length * 0.017,
    path,
  });
}

function collected(store: Store, state: GameState): void {
  for (const pickup of state.level.pickups) {
    if (!pickup.taken || store.seenTaken.has(pickup)) continue;
    store.seenTaken.add(pickup);
    spawn(store, {
      kind: "pickup",
      x: pickup.pos.x,
      y: pickup.pos.y,
      t0: store.now,
      power: 1,
      seed: pickup.pos.x * 0.61 + pickup.pos.y * 0.43,
      path: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Continuous signals. All three are read by the renderer every frame and must
// be cheap and side-effect free.
// ---------------------------------------------------------------------------

/** Screen-space displacement for the death shake, in CSS px.
 *
 *  A pure function of phase and phaseFor and nothing else — the caller may
 *  apply it around the entire frame, and two frames drawn at the same
 *  phaseFor are identical. Zero everywhere except the brief window after a
 *  loss, so it can be applied unconditionally. */
export function shakeOffset(state: GameState): { x: number; y: number } {
  if (state.phase !== "lost") return { x: 0, y: 0 };
  const t = state.phaseFor;
  if (!(t >= 0) || t >= SHAKE_TIME) return { x: 0, y: 0 };
  // Quadratic decay: violent at contact, essentially gone by half the window.
  const decay = (1 - t / SHAKE_TIME) ** 2;
  const step = Math.floor(t * SHAKE_STEPS_PER_SECOND);
  const amp = SHAKE_MAX * decay;
  return {
    x: (hash(step * 1.7) - 0.5) * 2 * amp,
    // Slightly flatter vertically: a horizontal jolt reads as impact, a
    // vertical one reads as the camera falling.
    y: (hash(step * 3.1 + 17) - 0.5) * 1.5 * amp,
  };
}

/** World px to add to the camera's y after a landing: the ground punches the
 *  view down, then it eases back. Zero unless a real landing just happened. */
export function cameraDipOffset(state: GameState): number {
  const store = STORES.get(state);
  if (!store || store.landAt < 0) return 0;
  const u = (store.now - store.landAt) / DIP_TIME;
  if (!(u >= 0) || u >= 1) return 0;
  // Strictly non-negative: an overshoot back above neutral reads as a hop
  // rather than an impact, and fights the pinned ground line.
  return DIP_MAX * store.landPower * (1 - u) ** 1.5;
}

/** 0..1 dread, rising as the chaser closes. Exactly 0 once the run has ended —
 *  the end screen owns the frame at that point — and exactly 0 while the
 *  chaser is at or beyond DANGER_FAR. */
export function dangerIntensity(state: GameState): number {
  if (state.phase !== "running") return 0;
  const dx = state.runner.pos.x - state.chaser.pos.x;
  const dy = state.runner.pos.y - state.chaser.pos.y;
  return ramp(DANGER_NEAR, DANGER_FAR, Math.hypot(dx, dy));
}

// ---------------------------------------------------------------------------
// World-space drawing. Called with the camera transform already applied, so
// every coordinate below is world units. `scale` is only used to keep hairline
// marks from disappearing on the phone viewport.
// ---------------------------------------------------------------------------

export function drawWorldEffects(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  scale: number,
): void {
  const store = STORES.get(state);
  if (!store || store.bursts.length === 0) return;
  // One device pixel, in world units.
  const px = 1 / Math.max(scale, 1e-6);

  ctx.save();
  ctx.fillStyle = inkAlpha(1);
  ctx.strokeStyle = inkAlpha(1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const b of store.bursts) {
    const u = clamp01((store.now - b.t0) / LIFE[b.kind]);
    if (b.kind === "land") drawLandPuff(ctx, b, u, px);
    else if (b.kind === "stroke") drawWetInk(ctx, b, u, px);
    else drawPickupBurst(ctx, b, u, px);
  }
  ctx.restore();
}

/** Ink kicked off the ground by the feet: back the way the runner came, and
 *  up. The runner only ever moves forward (+x), so the whole spray is biased
 *  to -x — a symmetric puff reads as an explosion under the feet rather than
 *  as ground being scuffed backwards. */
function drawLandPuff(
  ctx: CanvasRenderingContext2D,
  b: Burst,
  u: number,
  px: number,
): void {
  const t = u * LIFE.land;
  const count = 5 + Math.round(b.power * 5);
  const fade = (1 - u) ** 1.5;

  ctx.save();
  ctx.fillStyle = inkAlpha(0.55 * fade);
  for (let i = 0; i < count; i++) {
    const h1 = hash(b.seed + i * 1.7);
    const h2 = hash(b.seed + i * 3.3 + 11);
    const h3 = hash(b.seed + i * 5.1 + 29);
    const back = -(0.2 + h1 * 1.0);
    const up = -(0.45 + h2 * 0.95);
    const speed = (50 + h3 * 90) * (0.55 + b.power * 0.9);
    const x = b.x + back * speed * t;
    const y = b.y + up * speed * t + 0.5 * FLECK_GRAVITY * t * t;
    const r = Math.max(0.7 * px, (0.9 + h2 * 1.6) * (1 - u * 0.55));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A low scuff arc spreading along the ground behind the feet: the part of
  // the impact that stays on the paper. Flattened hard, because a circle here
  // reads as a shockwave from a different game.
  const spread = 8 + 46 * u * (0.5 + b.power);
  ctx.strokeStyle = inkAlpha(0.3 * fade * (0.4 + b.power * 0.6));
  ctx.lineWidth = Math.max(px, 1.6 * (1 - u));
  ctx.beginPath();
  ctx.ellipse(b.x - spread * 0.22, b.y, spread, Math.max(px, spread * 0.16), 0, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** A stroke, one instant after it was committed: the line bleeds outward into
 *  the paper and beads of ink run off the underside of it. This is the only
 *  confirmation the player gets that a stroke took — the line itself is drawn
 *  by scenery.ts and simply appears, with no event to it. */
function drawWetInk(
  ctx: CanvasRenderingContext2D,
  b: Burst,
  u: number,
  px: number,
): void {
  const path = b.path;
  if (!path || path.length === 0) return;
  const fade = (1 - u) ** 2;

  ctx.save();
  // The bleed: a wide, faint halo along the line that tightens as the ink
  // soaks in. Under the line's own weight, so it reads as the paper drinking
  // rather than as a second stroke.
  if (path.length >= 2) {
    ctx.strokeStyle = inkAlpha(0.22 * fade);
    ctx.lineWidth = Math.max(px, (10 + 6 * b.power) * (1 - u) + 2 * px);
    ctx.beginPath();
    const first = path[0];
    if (first) {
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        if (p) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  // Droplets. Each one waits its own beat before it lets go, so they do not
  // fall as a rank — ink runs off a line unevenly, which is most of what makes
  // it read as wet.
  const t = u * LIFE.stroke;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (!p) continue;
    const h1 = hash(b.seed + i * 2.3);
    const h2 = hash(b.seed + i * 4.7 + 13);
    if (h1 > 0.55 + 0.3 * (1 - b.power)) continue; // not every sample drips
    const delay = h2 * 0.3;
    const dt = t - delay;
    if (dt <= 0) continue;
    const fall = 0.5 * DRIP_GRAVITY * dt * dt;
    const drop = clamp01(1 - dt / (LIFE.stroke - delay));
    const r = Math.max(0.6 * px, (1.5 + h1 * 2.2) * drop);
    ctx.fillStyle = inkAlpha(0.7 * drop);
    ctx.beginPath();
    // Elongated downward: a falling bead of ink stretches, it does not stay a
    // sphere. +y is down, so the tail trails above it.
    ctx.ellipse(p.x + (h1 - 0.5) * 3, p.y + fall, r, r * (1 + dt * 3.5), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A pickup taken: a ring of ink thrown outward from where it sat, plus a
 *  short spray. Sized off PICKUP_RADIUS so the ring visibly leaves the halo
 *  that scenery.ts was drawing a frame earlier — the same shape, released. */
function drawPickupBurst(
  ctx: CanvasRenderingContext2D,
  b: Burst,
  u: number,
  px: number,
): void {
  const ease = 1 - (1 - u) ** 3; // fast out, settling
  const fade = (1 - u) ** 2;

  ctx.save();
  ctx.strokeStyle = inkAlpha(0.6 * fade);
  ctx.lineWidth = Math.max(px, 3.5 * (1 - u) + px);
  ctx.beginPath();
  ctx.arc(b.x, b.y, PICKUP_RADIUS * (0.55 + 1.9 * ease), 0, Math.PI * 2);
  ctx.stroke();

  // A second, slower ring: one ring alone reads as a bubble, two read as a
  // release with weight behind it.
  ctx.strokeStyle = inkAlpha(0.3 * fade);
  ctx.lineWidth = Math.max(px, 2 * (1 - u));
  ctx.beginPath();
  ctx.arc(b.x, b.y, PICKUP_RADIUS * (0.3 + 1.15 * ease), 0, Math.PI * 2);
  ctx.stroke();

  const t = u * LIFE.pickup;
  ctx.fillStyle = inkAlpha(0.65 * fade);
  for (let i = 0; i < 7; i++) {
    const h1 = hash(b.seed + i * 2.9 + 5);
    const h2 = hash(b.seed + i * 6.1 + 41);
    // Biased upward: ink that has just been picked up goes with the runner,
    // not into the floor.
    const angle = -Math.PI * 0.5 + (h1 - 0.5) * Math.PI * 1.5;
    const speed = 70 + h2 * 110;
    const x = b.x + Math.cos(angle) * speed * t;
    const y = b.y + Math.sin(angle) * speed * t + 0.5 * FLECK_GRAVITY * t * t;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.7 * px, (1.1 + h2 * 1.7) * (1 - u * 0.6)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Screen-space drawing. No camera transform applied; `camera`/`cameraY`/
// `scale` are here so world points can be projected by hand when an effect is
// anchored to a body but sized in screen px.
// ---------------------------------------------------------------------------

export function drawScreenEffects(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
  camera: number,
  cameraY: number,
  scale: number,
): void {
  drawDangerVignette(ctx, state, viewport);
  drawDeathSplat(ctx, state, viewport, camera, cameraY, scale);
}

/** Dread, creeping in from the LEFT — the side the chaser is on. Directional
 *  on purpose: the player is looking right, at the gap they are about to hit,
 *  and this has to be readable in peripheral vision without a glance back.
 *
 *  Deliberately unmistakable for hud.ts's drawSlowmoWash, which is the other
 *  full-frame overlay: that one is PAPER, bright, centred and radial, and it
 *  means "you are safe, think". This one is INK, dark, edge-anchored and
 *  one-sided, and it means the opposite. Light versus dark, centre versus
 *  edge — the two can be on screen together (drawing while being chased is
 *  exactly when both are true) and still read as separate signals. */
function drawDangerVignette(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
): void {
  const d = dangerIntensity(state);
  if (d <= 0.01) return;
  const { width: w, height: h } = viewport;
  // Reaches further as it gets worse, so the edge is visibly advancing rather
  // than just darkening in place.
  const reach = w * (0.16 + 0.3 * d);

  ctx.save();
  const grad = ctx.createLinearGradient(0, 0, reach, 0);
  grad.addColorStop(0, inkAlpha(0.5 * d));
  grad.addColorStop(0.42, inkAlpha(0.16 * d));
  grad.addColorStop(1, inkAlpha(0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, reach, h);

  // Tendrils reaching in past the gradient's edge. Their undulation is driven
  // by the chaser's own world x — a pure function of position, so it crawls
  // forward as the chaser advances and freezes when it does, and never
  // shimmers off a frame counter.
  const cx = state.chaser.pos.x;
  ctx.fillStyle = inkAlpha(0.17 * d);
  for (let i = 0; i < 5; i++) {
    const seed = hash(i * 7.3 + 1);
    const y = h * ((i + 0.5) / 5) + Math.sin(cx * 0.014 + i * 2.1) * h * 0.05;
    const len = reach * (0.55 + 0.5 * seed) * (0.45 + 0.55 * d);
    const half = h * (0.05 + 0.05 * seed);
    ctx.beginPath();
    ctx.moveTo(0, y - half);
    ctx.quadraticCurveTo(len * 0.6, y - half * 0.35, len, y);
    ctx.quadraticCurveTo(len * 0.6, y + half * 0.35, 0, y + half);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** The catch itself: ink thrown out from the point of contact, drawn in screen
 *  space over the frozen world during IMPACT_HOLD. Anchored to the runner's
 *  projected position so it marks where the player died, sized in screen px so
 *  it is the same event at both marked viewports. */
function drawDeathSplat(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewport: { width: number; height: number },
  camera: number,
  cameraY: number,
  scale: number,
): void {
  if (state.phase !== "lost") return;
  const t = state.phaseFor;
  if (!(t >= 0) || t >= SPLAT_TIME) return;
  const u = clamp01(t / SPLAT_TIME);
  const ease = 1 - (1 - u) ** 3;
  const fade = (1 - u) ** 2;

  const sx = (state.runner.pos.x - camera) * scale;
  const sy = (state.runner.pos.y - cameraY) * scale;
  // Off-screen deaths (a fall well below the view) would otherwise splat on
  // the frame edge.
  if (sx < -200 || sx > viewport.width + 200) return;
  const unit = Math.max(6, RUNNER_RADIUS * scale);
  const seed = state.runner.pos.x * 0.31 + state.runner.pos.y * 0.13;

  ctx.save();
  ctx.fillStyle = inkAlpha(0.75 * fade);
  // Spikes rather than dots: a splat is directional, and the irregular lengths
  // are what stop it reading as a clean geometric burst.
  for (let i = 0; i < 11; i++) {
    const h1 = hash(seed + i * 3.7);
    const h2 = hash(seed + i * 8.9 + 23);
    const angle = (i / 11) * Math.PI * 2 + (h1 - 0.5) * 0.5;
    const len = unit * (0.9 + h2 * 3.2) * (0.35 + ease);
    const halfWidth = unit * (0.16 + h1 * 0.2) * (1 - u * 0.5);
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(sx - ny * halfWidth, sy + nx * halfWidth);
    ctx.lineTo(sx + nx * len, sy + ny * len);
    ctx.lineTo(sx + ny * halfWidth, sy - nx * halfWidth);
    ctx.closePath();
    ctx.fill();
  }

  // A shockwave ring, thinning as it goes: the boundary of the moment.
  ctx.strokeStyle = inkAlpha(0.45 * fade);
  ctx.lineWidth = Math.max(1, unit * 0.3 * (1 - u));
  ctx.beginPath();
  ctx.arc(sx, sy, unit * (0.6 + 4.5 * ease), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Live records held for this state: bursts, plus the landing the camera dip
 *  is still riding. Exists so the bound on this module's memory is asserted
 *  directly rather than inferred from "it didn't throw" — a leak here shows up
 *  as a slow frame-rate death an hour into play, which no other check sees. */
export function _debugEffectsMemorySize(state: GameState): number {
  const store = STORES.get(state);
  if (!store) return 0;
  let live = 0;
  for (const b of store.bursts) if (store.now - b.t0 < LIFE[b.kind]) live++;
  const dipping = store.landAt >= 0 && store.now - store.landAt < DIP_TIME ? 1 : 0;
  return live + dipping;
}
