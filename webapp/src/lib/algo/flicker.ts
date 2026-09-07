/** Flicker / rolling-band analysis of what the browser actually displays.
 *
 *  Input: row-mean brightness profiles sampled from the live view at a high rate (several samples
 *  per stream frame). Consecutive identical samples are the same frame; the analysis works on the
 *  distinct frames and reports
 *   - whether frames are ever painted partially (a change confined to a top prefix of rows: the
 *     browser showing a half-received JPEG),
 *   - the dominant horizontal band (period in rows, amplitude in grey levels) after removing the
 *     static profile (vignetting) and per-frame brightness, and how fast it rolls (rows per frame:
 *     an LED / mains beat with the rolling shutter rolls steadily),
 *   - whole-frame brightness oscillation (period in frames, amplitude),
 *   - a rows × frames residual image for the eye (bands show as diagonal stripes).
 */
export interface FlickerReport {
  samples: number
  frames: number
  partialPaints: number
  /** dominant band: period in rows, amplitude (levels), phase drift in rows per frame */
  band: { periodRows: number; amp: number; driftRowsPerFrame: number }
  /** residual band energy overall, rms grey levels */
  bandRms: number
  /** whole-frame brightness: rms and dominant period (frames, 0 if none) */
  mean: { rms: number; periodFrames: number; amp: number }
  /** residual image, `frames` columns × `rows` rows, 128 = 0, ±gain levels per step */
  residual: { data: Uint8ClampedArray; width: number; height: number; gain: number }
}

const EPS = 0.05

/** Collapse a high-rate sample list into distinct frames; count partial paints. */
export function distinctFrames(samples: Float32Array[]): { frames: Float32Array[]; partialPaints: number } {
  const frames: Float32Array[] = []
  let partial = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = frames[frames.length - 1]
    if (!prev) { frames.push(s); continue }
    const h = s.length
    let first = -1, last = -1
    for (let y = 0; y < h; y++) if (Math.abs(s[y] - prev[y]) > EPS) { if (first < 0) first = y; last = y }
    if (first < 0) continue
    if (first < h * 0.1 && last < h * 0.9) partial++
    frames.push(s)
  }
  return { frames, partialPaints: partial }
}

function dft1(x: Float32Array | number[]): { re: Float64Array; im: Float64Array } {
  const n = x.length, re = new Float64Array(n >> 1), im = new Float64Array(n >> 1)
  for (let k = 0; k < re.length; k++) {
    let a = 0, b = 0
    for (let t = 0; t < n; t++) { const w = (-2 * Math.PI * k * t) / n; a += x[t] * Math.cos(w); b += x[t] * Math.sin(w) }
    re[k] = a; im[k] = b
  }
  return { re, im }
}

export function analyseFlicker(samples: Float32Array[], gain = 20): FlickerReport {
  const { frames, partialPaints } = distinctFrames(samples)
  const n = frames.length, h = frames[0]?.length ?? 0
  const empty: FlickerReport = { samples: samples.length, frames: n, partialPaints, band: { periodRows: 0, amp: 0, driftRowsPerFrame: 0 }, bandRms: 0, mean: { rms: 0, periodFrames: 0, amp: 0 }, residual: { data: new Uint8ClampedArray(0), width: 0, height: 0, gain } }
  if (n < 4 || h < 8) return empty
  // static profile and per-frame mean
  const stat = new Float64Array(h), means = new Float64Array(n)
  for (const f of frames) for (let y = 0; y < h; y++) stat[y] += f[y] / n
  const res: Float64Array[] = frames.map((f, i) => {
    const r = new Float64Array(h); let m = 0
    for (let y = 0; y < h; y++) { r[y] = f[y] - stat[y]; m += r[y] }
    m /= h; means[i] = m
    for (let y = 0; y < h; y++) r[y] -= m
    return r
  })
  let ss = 0
  for (const r of res) for (let y = 0; y < h; y++) ss += r[y] * r[y]
  const bandRms = Math.sqrt(ss / (n * h))
  // spatial spectrum averaged over frames (downsample rows to keep the DFT cheap)
  const step = Math.max(1, Math.floor(h / 256)), hh = Math.floor(h / step)
  const spec = new Float64Array(hh >> 1), phases: number[][] = []
  const perFrame = res.map((r) => {
    const d = new Float32Array(hh)
    for (let y = 0; y < hh; y++) { let s = 0; for (let k = 0; k < step; k++) s += r[y * step + k]; d[y] = s / step }
    const { re, im } = dft1(d)
    for (let k = 2; k < spec.length; k++) spec[k] += Math.hypot(re[k], im[k]) / n
    phases.push(Array.from(re, (v, k) => Math.atan2(im[k], v)))
    return d
  })
  void perFrame
  let kb = 2
  for (let k = 3; k < spec.length; k++) if (spec[k] > spec[kb]) kb = k
  const periodRows = (hh / kb) * step
  const amp = (spec[kb] / (hh / 2)) || 0
  let drift = 0
  for (let i = 1; i < n; i++) { let d = phases[i][kb] - phases[i - 1][kb]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; drift += d }
  drift /= n - 1
  const driftRowsPerFrame = -(drift / (2 * Math.PI)) * periodRows   // e^{-iωy}: a band moving +y lowers the phase
  // whole-frame brightness oscillation
  const mm = means.reduce((a, b) => a + b, 0) / n
  const mc = Array.from(means, (v) => v - mm)
  const meanRms = Math.sqrt(mc.reduce((a, b) => a + b * b, 0) / n)
  const { re, im } = dft1(mc)
  let km = 1
  for (let k = 2; k < re.length; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[km], im[km])) km = k
  const meanAmp = re.length > 1 ? (Math.hypot(re[km], im[km]) / (n / 2)) : 0
  // residual image: frames across, rows down
  const data = new Uint8ClampedArray(n * h * 4)
  for (let i = 0; i < n; i++) for (let y = 0; y < h; y++) {
    const v = 128 + gain * res[i][y], o = (y * n + i) * 4
    data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255
  }
  return {
    samples: samples.length, frames: n, partialPaints, bandRms,
    band: { periodRows, amp, driftRowsPerFrame },
    mean: { rms: meanRms, periodFrames: meanAmp > 3 * meanRms / Math.sqrt(n) && km > 0 ? n / km : 0, amp: meanAmp },
    residual: { data, width: n, height: h, gain },
  }
}

/** Plain-language verdict for the report. */
export function describeFlicker(r: FlickerReport, fps: number): string[] {
  const out: string[] = []
  if (r.frames < 4) return ['not enough distinct frames were captured; is the stream running?']
  out.push(`${r.frames} distinct frames in ${r.samples} samples`)
  out.push(r.partialPaints ? `${r.partialPaints} frames were painted partially (browser showing half-received frames: tearing)` : 'no partially painted frames (no tearing)')
  if (r.band.amp > 0.5) {
    const hz = r.band.driftRowsPerFrame && fps ? Math.abs(r.band.driftRowsPerFrame / r.band.periodRows) * fps : 0
    out.push(`horizontal band, period ${r.band.periodRows.toFixed(0)} rows, amplitude ${r.band.amp.toFixed(1)} levels, rolling ${r.band.driftRowsPerFrame.toFixed(1)} rows per frame${hz ? ` (${hz.toFixed(2)} Hz beat: light source or supply ripple beating with the rolling shutter)` : ''}`)
  } else out.push(`no horizontal banding (band residual ${r.bandRms.toFixed(2)} levels rms)`)
  if (r.mean.amp > 0.5 && r.mean.periodFrames) out.push(`whole-frame brightness pulses every ${r.mean.periodFrames.toFixed(1)} frames (±${r.mean.amp.toFixed(1)} levels)`)
  else out.push(`frame brightness steady (${r.mean.rms.toFixed(2)} levels rms)`)
  return out
}
