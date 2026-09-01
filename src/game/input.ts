// Pointer input: builds strokes, spends ink, and drives slow motion.
// Pointer Events (not mouse events) because this is marked at both a desktop
// and a portrait phone viewport — one API covers mouse, pen and touch.

import type { GameState, PointerState, Vec2 } from "./types";
import { appendStrokePoint, inkCost, truncateToInk } from "./ink";
import { strokeFromPoints } from "./world";

/** Maps a client-space point to world space. Supplied by the caller so the
 *  renderer stays the single source of truth for camera and scale. */
export type Transform = { camera: number; cameraY: number; scale: number };

export type Input = {
  pointer: PointerState;
  /** True while the pointer is held: the caller dilates time on this. */
  isDrawing(): boolean;
  detach(): void;
};

export function attachInput(
  canvas: HTMLCanvasElement,
  getState: () => GameState,
  getTransform: () => Transform,
  onRestart: (force: boolean) => void,
): Input {
  const pointer: PointerState = { pos: { x: 0, y: 0 }, down: false, drawing: null };

  const toWorld = (clientX: number, clientY: number): Vec2 => {
    const rect = canvas.getBoundingClientRect();
    const { camera, cameraY, scale } = getTransform();
    return {
      x: camera + (clientX - rect.left) / scale,
      y: cameraY + (clientY - rect.top) / scale,
    };
  };

  const onPointerDown = (e: PointerEvent): void => {
    const state = getState();
    // A press during an ended run restarts, so the loop never needs a menu.
    if (state.phase !== "running") {
      onRestart(false);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    pointer.pos = toWorld(e.clientX, e.clientY);
    pointer.down = true;
    pointer.drawing = state.ink > 0 ? [{ ...pointer.pos }] : null;
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    pointer.pos = toWorld(e.clientX, e.clientY);
    if (!pointer.down || !pointer.drawing) return;
    const state = getState();
    // Provisionally append, then hold the preview to what the player can
    // actually afford, so the live line stops where the ink stops.
    appendStrokePoint(pointer.drawing, pointer.pos);
    pointer.drawing = truncateToInk(pointer.drawing, state.ink);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!pointer.down) return;
    pointer.down = false;
    const state = getState();
    const points = pointer.drawing;
    pointer.drawing = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!points || points.length < 2) return;

    const affordable = truncateToInk(points, state.ink);
    if (affordable.length < 2) return;
    // Ink is spent, never reclaimed: committing is the irreversible act the
    // whole economy rests on.
    state.ink = Math.max(0, state.ink - inkCost(affordable));
    state.strokes.push(strokeFromPoints(affordable));
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Escape and R bail out at ANY time, including mid-run. Without this a
    // player who has wedged themselves, or simply wants another go, has no
    // way out but to wait to be caught.
    if (e.key === "Escape" || e.key.toLowerCase() === "r") {
      onRestart(true);
      return;
    }
    if (getState().phase !== "running") onRestart(false);
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);

  return {
    pointer,
    isDrawing: () => pointer.down,
    detach() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
    },
  };
}
