/** Burn-in overlays for recordings: text and a scale bar drawn straight onto the output canvas after
 *  all pixel processing, so they end up in the encoded frames (unlike the live view's DOM overlays).
 *  Layout maths only; the recorder owns the canvas and calls `drawBurnIn` once per encoded frame. */

import { niceScaleBarLength, formatUm } from '../../algo/measure'

export type BurnInKind = 'time' | 'position' | 'scalebar' | 'sample' | 'mode'
export const BURN_IN_KINDS: { id: BurnInKind; label: string; title: string }[] = [
  { id: 'time', label: 'Elapsed time', title: 'mm:ss.t since the recording started (recording time, after any time compression)' },
  { id: 'position', label: 'Stage position', title: 'x y z in steps, bottom-left' },
  { id: 'scalebar', label: 'Scale bar', title: 'needs a µm/px scale (stage calibration or a manual scale in Settings)' },
  { id: 'sample', label: 'Sample name', title: 'the current sample record\'s name, top-left' },
  { id: 'mode', label: 'Mode status', title: 'the video mode\'s own status line (frames fused, kept, ...)' },
]

export interface BurnInState {
  kinds: BurnInKind[]
  /** seconds of recording time this frame represents */
  elapsedS: number
  position: { x: number; y: number; z: number }
  /** µm per output pixel, or null when unknown (scale bar is then omitted) */
  umPerPx: number | null
  sampleName?: string
  modeStatus?: string
}

export function formatElapsed(s: number): string {
  const m = Math.floor(s / 60), r = s - m * 60
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function label(ctx: Ctx, text: string, x: number, y: number, align: CanvasTextAlign, font: number): void {
  ctx.font = `${font}px ui-monospace, Menlo, monospace`
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  const pad = Math.round(font * 0.35)
  const w = ctx.measureText(text).width
  const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(x0 - pad, y - font, w + 2 * pad, font + pad)
  ctx.fillStyle = '#fff'
  ctx.fillText(text, x, y)
}

/** Draw the requested overlays. Sizes scale with the frame height so a binned (half-size) recording
 *  keeps the same relative layout as a full-size one. */
export function drawBurnIn(ctx: Ctx, w: number, h: number, s: BurnInState): void {
  if (!s.kinds.length) return
  const font = Math.max(10, Math.round(h / 40))
  const m = Math.round(font * 0.8)
  const lineH = Math.round(font * 1.5)
  ctx.save()
  let topLeft = m + font
  if (s.kinds.includes('sample') && s.sampleName) { label(ctx, s.sampleName, m, topLeft, 'left', font); topLeft += lineH }
  if (s.kinds.includes('mode') && s.modeStatus) { label(ctx, s.modeStatus, m, topLeft, 'left', font); topLeft += lineH }
  if (s.kinds.includes('time')) label(ctx, formatElapsed(s.elapsedS), w - m, m + font, 'right', font)
  let bottomLeft = h - m
  if (s.kinds.includes('position')) { label(ctx, `x ${s.position.x}  y ${s.position.y}  z ${s.position.z}`, m, bottomLeft, 'left', font); bottomLeft -= lineH }
  if (s.kinds.includes('scalebar') && s.umPerPx) {
    const bar = niceScaleBarLength(s.umPerPx, w * 0.3)
    if (bar) {
      const x1 = w - m, x0 = x1 - bar.px, y = h - m
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(x0 - 6, y - font - 14, bar.px + 12, font + 18)
      ctx.fillStyle = '#fff'
      ctx.fillRect(x0, y - 6, bar.px, 4)
      ctx.font = `${font}px ui-monospace, Menlo, monospace`
      ctx.textAlign = 'center'
      ctx.fillText(bar.label ?? formatUm(bar.um), x0 + bar.px / 2, y - 12)
    }
  }
  ctx.restore()
}
