/** Pure maths for the scale bar and on-image measurement tool: no DOM, no device access.
 *
 *  Scale (µm/px) can come from two places (see `lib/store/scaleCal.svelte.ts`):
 *   - the CSM calibration (`lib/algo/csm.ts`) plus the stage's documented step size, or
 *   - a length the user measured directly against a stage micrometer ("calibrate from a known length").
 *  Both boil down to a single number, µm per pixel at some reference image width; everything here
 *  works in µm once that scale has been applied by the caller, except `umPerPixelFromStageCalibration`
 *  and `niceScaleBarLength`, which do the pixel <-> µm conversion itself. */

export interface Pt { x: number; y: number }

/** Straight-line distance between two points (same units in, same units out). */
export function distance(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Perimeter of an open polyline (sum of consecutive segment lengths). */
export function polylineLength(pts: Pt[]): number {
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += distance(pts[i - 1], pts[i])
  return sum
}

/** Signed polygon area via the shoelace formula; caller takes abs() for a magnitude. Needs >= 3 points. */
export function polygonArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** Perimeter of a closed polygon (the polyline plus the closing segment). */
export function polygonPerimeter(pts: Pt[]): number {
  if (pts.length < 2) return 0
  return polylineLength(pts) + distance(pts[pts.length - 1], pts[0])
}

/** Interior angle at `b`, in degrees, for the sequence a -> b -> c (0..180). */
export function angleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y }
  const dot = v1.x * v2.x + v1.y * v2.y
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)
  if (mag === 0) return 0
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI
}

/** µm per image pixel from the CSM calibration: for each stage axis, the calibration already measured
 *  image pixels moved per stage step (`pixelsPerStep`, a 2-vector since axes are not perfectly aligned
 *  with image rows/columns); dividing the stage's documented µm/step by the magnitude of that vector
 *  gives µm/px along that axis. The two axes are averaged for a single isotropic scale, which is a fair
 *  approximation since the stage moves are close to orthogonal and the two results normally agree to a
 *  few percent. Returns null if either axis measured zero pixel motion (no calibration signal). */
export function umPerPixelFromStageCalibration(
  pixelsPerStepX: [number, number], pixelsPerStepY: [number, number],
  umPerStepX: number, umPerStepY: number,
): number | null {
  const mx = Math.hypot(pixelsPerStepX[0], pixelsPerStepX[1])
  const my = Math.hypot(pixelsPerStepY[0], pixelsPerStepY[1])
  if (!mx || !my) return null
  return (umPerStepX / mx + umPerStepY / my) / 2
}

/** Rescale a µm/px figure measured at one image width to another (e.g. stream -> full resolution). */
export function scaleForWidth(umPerPxAtRef: number, refWidth: number, targetWidth: number): number {
  return (umPerPxAtRef * refWidth) / targetWidth
}

export interface ScaleBarLength { um: number; px: number; label: string }

/** Pick a "nice" scale bar length (1, 2 or 5 x 10^n µm) that fits under `maxWidthPx` (in the same
 *  pixel grid as `umPerPx`, i.e. natural/full-resolution pixels, not displayed/zoomed pixels). */
export function niceScaleBarLength(umPerPx: number, maxWidthPx: number): ScaleBarLength | null {
  const maxUm = umPerPx * maxWidthPx
  if (!(umPerPx > 0) || !(maxUm > 0) || !isFinite(maxUm)) return null
  const exp = Math.floor(Math.log10(maxUm))
  const candidates = [exp - 1, exp, exp + 1].flatMap((e) => [1, 2, 5].map((m) => m * 10 ** e))
  const fitting = candidates.filter((v) => v <= maxUm + 1e-9)
  const um = fitting.length ? Math.max(...fitting) : Math.min(...candidates)
  return { um, px: um / umPerPx, label: formatUm(um) }
}

export function formatUm(um: number): string {
  if (um >= 1000) { const mm = um / 1000; return `${mm % 1 === 0 ? mm.toFixed(0) : mm.toFixed(1)} mm` }
  return `${um % 1 === 0 ? um.toFixed(0) : um.toFixed(1)} µm`
}
