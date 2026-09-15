/** Pure gesture -> CSS-transform maths for a pinch-zoom / drag-pan / double-tap-to-reset image
 *  view (used by `TimelapseViewer` to zoom its plain `<canvas>`, which — unlike the OpenSeadragon
 *  viewer in `Viewer.svelte` — has no built-in gesture handling of its own).
 *
 *  The state is a CSS `translate(tx, ty) scale(scale)` applied with `transform-origin: 0 0`, so
 *  `tx`/`ty` and any pointer position passed in must both be in the *container's* untransformed
 *  coordinate frame (e.g. `container.getBoundingClientRect()`, not the transformed element's). */

export interface ZoomPanState { scale: number; tx: number; ty: number }

export const IDENTITY: ZoomPanState = { scale: 1, tx: 0, ty: 0 }
export const MIN_SCALE = 1
export const MAX_SCALE = 8

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

/** Snap back to the identity transform once zoomed out to (or past) 1x, so a pinch that ends
 *  slightly below MIN_SCALE doesn't leave the image stranded off-centre. */
export function normalize(state: ZoomPanState): ZoomPanState {
  return state.scale <= MIN_SCALE ? IDENTITY : state
}

/** Scale `state` by `factor`, keeping the point (px, py) stationary on screen. */
export function zoomAt(state: ZoomPanState, factor: number, px: number, py: number): ZoomPanState {
  const scale = clampScale(state.scale * factor)
  const applied = scale / state.scale
  return { scale, tx: px - applied * (px - state.tx), ty: py - applied * (py - state.ty) }
}

export function panBy(state: ZoomPanState, dx: number, dy: number): ZoomPanState {
  return { ...state, tx: state.tx + dx, ty: state.ty + dy }
}

export function pinchDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function pinchMidpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** CSS `transform` string for a `ZoomPanState` (transform-origin must be set to `0 0`). */
export function cssTransform(state: ZoomPanState): string {
  return `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`
}
