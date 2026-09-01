// Shared contracts for the game modules. Every module in src/game keys off
// these types; they are the integration boundary, so change them deliberately.

export type Vec2 = { x: number; y: number };

/** A directed line segment. Surfaces are built from these. */
export type Segment = { a: Vec2; b: Vec2 };

/** A stroke the player drew. `points` is the raw polyline (already truncated
 *  to whatever ink was available); `segments` is its collidable form. */
export type Stroke = { points: Vec2[]; segments: Segment[] };

/** Result of sweeping a circle along a movement vector against surfaces. */
export type Contact = {
  /** Circle centre position at the moment of impact. */
  point: Vec2;
  /** Unit surface normal, pointing away from the surface toward the circle. */
  normal: Vec2;
  /** Time of impact in [0,1] along the attempted movement. */
  toi: number;
  segment: Segment;
};

export type Pickup = { pos: Vec2; amount: number; taken: boolean };

export type Level = {
  /** Static ground. The chaser walks ONLY these — never player strokes. */
  groundSegments: Segment[];
  pickups: Pickup[];
  startX: number;
  chaserStartX: number;
  finishX: number;
  /** Ground surface y at the start, for spawn placement. */
  groundY: number;
  /** Pre-drawn teaching stub over a small notch near the start. */
  stub: Stroke | null;
};

export type Runner = {
  pos: Vec2;
  vel: Vec2;
  radius: number;
  grounded: boolean;
};

export type Chaser = { pos: Vec2; radius: number };

export type Phase = "running" | "won" | "lost";

export type GameState = {
  runner: Runner;
  chaser: Chaser;
  strokes: Stroke[];
  ink: number;
  maxInk: number;
  phase: Phase;
  level: Level;
  /** Seconds of game time elapsed (already time-dilated). */
  elapsed: number;
};

export type PointerState = {
  pos: Vec2;
  down: boolean;
  /** Points accumulated in the stroke currently being drawn, else null. */
  drawing: Vec2[] | null;
};
