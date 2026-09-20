/** Gallery Enhance panel service (`docs/image-pipeline/design.md` WP4): owns the live `EnhanceParams`
 *  for whichever gallery item the Viewer's Enhance panel is open on, runs `algo/pipeline.ts` in
 *  `workers/enhanceWorker.ts` for a debounced interactive preview and for the full-resolution "Apply"
 *  step, and writes the result as a new `snapshot` item via `store/gallery.ts#saveSnapshot`.
 *
 *  **Source selection** (`loadSource`): a RAW-derived item's `'image'` blob is already a 16-bit PNG
 *  from `rawdev.develop` (`encodeRgb16` applies the tuning's transfer curve — sRGB or gamma-corrected,
 *  see `algo/rawdev.ts`'s module doc), i.e. *display-referred*, not scene-linear, despite the 16-bit
 *  depth. It is still the best available source (more headroom than an 8-bit JPEG for aggressive
 *  tone/denoise stages), so it's preferred when present; `input.linear` is left `false` either way.
 *  A plain snapshot's `'image'` JPEG is decoded via `createImageBitmap` + canvas, matching every other
 *  read path in the codebase (`services/photo/common.ts#decode`).
 *
 *  **Noise model**: `GalleryItem['raw']` stores `blackLevel`, `bitDepth` and the *white-balance* gains
 *  (`raw.gains`, red/blue multipliers) — not the sensor's Poisson-Gaussian `NoiseModel` (`gain`,
 *  `readSigma`, `white`), which is never persisted per item. So `noise` is left `undefined` for RAW
 *  sources too; `developPipeline`'s denoise stage falls back to `estimateSigmaMad`'s blind estimate
 *  (see `algo/pipeline.ts#denoiseRgbPlanes`), same as an ordinary JPEG. A future item field carrying
 *  the RAW trailer's `noise` block would let this construct a real `NoiseModel` instead.
 *
 *  **Live preview** vs **Apply**: `refreshPreview()` is debounced 150 ms and always requests the
 *  worker's `preview: { maxWidth: settings.enhancePreviewWidth }` mode so a slider drag stays
 *  interactive regardless of source resolution (WP3 measured integral-image NLM, the heaviest stage,
 *  at ~6.7 s/MP full-res with patch 3/search 10 — a 1024px preview of a typical 4000px-wide source is
 *  roughly 15x fewer pixels). `apply()` runs the same worker without `preview`, at full resolution;
 *  `estimatedFullResS` extrapolates the wait from the last preview's timing and pixel count so the
 *  panel can show it before the user commits. */

import type { EnhanceParams } from '../algo/pipeline'
import type { DenoiseParams } from '../algo/denoise'
import type { NoiseModel } from '../algo/noise'
import { toRgba8 } from '../algo/rawdev'
import { decodePng16, encodePng16 } from '../algo/png16'
import type { Look } from '../algo/lut'
import { getBlob, putItem, saveSnapshot, type GalleryItem } from '../store/gallery'
import { settings } from '../store/settings.svelte'
import { look } from '../store/look.svelte'
import { encodeRgba8 } from './photo/common'
import type { EnhanceRequest, EnhanceResult } from '../workers/enhanceWorker'

export const PRESETS = ['Off', 'Clean', 'Crisp', 'Brightfield', 'Fluorescence'] as const
export type PresetName = typeof PRESETS[number]

const CLEAN_DENOISE: DenoiseParams = { method: 'wavelet', strength: 0.6, chroma: 0.3 }
// wavelet, not NLM: presets must finish in seconds on an 8 MP photo; NLM stays a user-selectable
// "quality" method (measured ~2.6 s/MP at patch 2 / search 6)
const CRISP_DENOISE: DenoiseParams = { method: 'wavelet', strength: 0.8, chroma: 0.4 }

/** `presets[name]()` builds a fresh `EnhanceParams` (never share the same sub-objects across calls -
 *  the panel binds sliders straight onto them). */
export const presets: Record<PresetName, () => EnhanceParams> = {
  Off: () => ({}),
  Clean: () => ({
    denoise: { ...CLEAN_DENOISE },
    sharpen: { mode: 'edge', radius: 1.2, amount: 0.4, threshold: 0.02 },
  }),
  Crisp: () => ({
    denoise: { ...CRISP_DENOISE },
    deconvolve: { method: 'rl', sigma: 1.0, iterations: 3 },
    clahe: { tiles: 8, clip: 0.02 },
  }),
  Brightfield: () => ({
    flatField: { sigma: 40 }, // ~image-width/8 default; the panel scales this to the actual image
    autoLevels: { lowPct: 0.1, highPct: 99.9, perChannel: false },
    sharpen: { mode: 'unsharp', radius: 1, amount: 0.25, threshold: 0.01 },
  }),
  Fluorescence: () => ({
    denoise: { method: 'wavelet', strength: 1.2, chroma: 0.6 },
    clahe: { tiles: 8, clip: 0.015 },
  }),
}

/** `Brightfield`'s pseudo-flat-field sigma is meant to be ~image width/8 (design doc); `presets.
 *  Brightfield()` above can't see the image size, so the panel calls this after picking the preset. */
export function scaleBrightfieldSigma(params: EnhanceParams, width: number): void {
  if (params.flatField) params.flatField = { sigma: Math.max(8, Math.round(width / 8)) }
}

interface Source {
  data: Uint8ClampedArray | Uint16Array
  width: number
  height: number
  linear: boolean
  noise?: NoiseModel
}

let worker: Worker | null = null
let requestSeq = 0
let previewInFlight = 0

function ensureWorker(): Worker {
  if (!worker) worker = new Worker(new URL('../workers/enhanceWorker.ts', import.meta.url), { type: 'module' })
  return worker
}

/** Runs one `develop` request and resolves with the final result, reporting progress via `onProgress`.
 *  Rejects on a worker-level `{ error }`. Does not correlate/drop stale requests itself - callers that
 *  care (the debounced preview) check `id` against the latest one they issued before applying a result. */
function runDevelop(req: EnhanceRequest, onProgress?: (stage: string, frac: number) => void): Promise<EnhanceResult> {
  return new Promise((resolve, reject) => {
    const w = ensureWorker()
    const onMessage = (ev: MessageEvent<any>) => {
      if (ev.data?.id !== req.id) return
      if (ev.data.error) { w.removeEventListener('message', onMessage); reject(new Error(ev.data.error)); return }
      if (ev.data.stage) { onProgress?.(ev.data.stage, ev.data.frac); return }
      if (ev.data.result) { w.removeEventListener('message', onMessage); resolve(ev.data.result as EnhanceResult) }
    }
    w.addEventListener('message', onMessage)
    w.postMessage(req, [req.input.data.buffer])
  })
}

function toRgbaBitmapData(r: EnhanceResult): { data: Uint8ClampedArray; width: number; height: number } {
  if (r.data instanceof Uint16Array) return toRgba8({ data: r.data, width: r.width, height: r.height }, 1)
  return { data: r.data, width: r.width, height: r.height }
}

class EnhanceService {
  params = $state<EnhanceParams>({})
  preset = $state<PresetName>('Off')
  preview: ImageBitmap | null = $state(null)
  /** The unenhanced source, downsampled the same way as `preview` (built once per `open()`), for the
   *  panel's before/after compare. `null` until the source has loaded. */
  originalPreview: ImageBitmap | null = $state(null)
  busy = $state(false)
  progress = $state<{ stage: string; frac: number } | null>(null)
  applyBusy = $state(false)
  applyProgress = $state<{ stage: string; frac: number } | null>(null)
  /** Estimated full-resolution "Apply" time (s), extrapolated from the last preview's ms/px. `null`
   *  until at least one preview has run. */
  estimatedFullResS: number | null = $state(null)
  /** Whether to compose the current global `look` (see `store/look.svelte.ts`) into the pipeline's
   *  final stage. Off by default: the look already shows live in the gallery display path when
   *  `settings.lookApplyInGallery` is set, so baking it here too is opt-in to avoid a double-apply
   *  surprising someone who just wants the enhance preview. */
  applyLook = $state(false)

  private item: GalleryItem | null = null
  private source: Source | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private lastPreviewMs = 0
  private lastPreviewPixels = 0

  /** True once a source has been loaded for the current item (the panel shows a spinner until then). */
  ready = $state(false)

  async open(item: GalleryItem): Promise<void> {
    this.item = item
    this.ready = false
    this.preview?.close(); this.preview = null
    this.originalPreview?.close(); this.originalPreview = null
    this.params = {}
    this.preset = 'Off'
    this.source = await this.loadSource(item)
    this.ready = true
    if (this.source) {
      // Same downsample target as the worker's preview mode, but done with the browser's own image
      // resizer (createImageBitmap's resizeWidth/Height) rather than duplicating the worker's box
      // filter - this bitmap is only ever shown, never fed back into the pipeline.
      const rgba = toRgbaBitmapData({ data: this.source.data, width: this.source.width, height: this.source.height })
      const targetW = Math.min(rgba.width, settings.enhancePreviewWidth)
      const targetH = Math.round(rgba.height * (targetW / rgba.width))
      this.originalPreview = await createImageBitmap(
        new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height),
        { resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high' },
      )
    }
    this.refreshPreview()
  }

  close(): void {
    this.item = null
    this.source = null
    this.preview?.close(); this.preview = null
    this.originalPreview?.close(); this.originalPreview = null
    this.progress = null
    clearTimeout(this.debounceTimer)
  }

  private async loadSource(item: GalleryItem): Promise<Source | null> {
    const blob = await getBlob(item.id, 'image')
    if (!blob) return null
    if (item.raw && blob.type === 'image/png') {
      const buf = new Uint8Array(await blob.arrayBuffer())
      const png = await decodePng16(buf)
      // rawdev.develop's output is display-referred (transfer curve already applied) despite the
      // 16-bit depth - see the module doc above.
      return { data: png.data, width: png.width, height: png.height, linear: false }
    }
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bmp, 0, 0); bmp.close()
    const id = ctx.getImageData(0, 0, c.width, c.height)
    return { data: id.data, width: id.width, height: id.height, linear: false }
  }

  selectPreset(name: PresetName): void {
    this.preset = name
    const p = presets[name]()
    if (this.source && p.flatField) scaleBrightfieldSigma(p, this.source.width)
    this.params = p
    this.refreshPreview()
  }

  /** Called by the panel any time a param changes; debounces so a slider drag doesn't flood the worker. */
  paramsChanged(): void {
    this.refreshPreview()
  }

  reset(): void {
    this.params = {}
    this.preset = 'Off'
    this.refreshPreview()
  }

  private effectiveParams(): EnhanceParams {
    // `$state.snapshot`: nested sections ({ denoise: {...} }) are state proxies, which structured
    // clone (worker postMessage, IndexedDB) rejects
    const p: EnhanceParams = { ...$state.snapshot(this.params) }
    if (this.applyLook && look.current) p.look = $state.snapshot(look.current) as Look
    else delete p.look
    return p
  }

  refreshPreview(): void {
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.runPreview(), 150)
  }

  private async runPreview(): Promise<void> {
    if (!this.source) return
    const id = ++requestSeq
    previewInFlight++
    this.busy = true
    this.progress = null
    const t0 = performance.now()
    try {
      const req: EnhanceRequest = {
        kind: 'develop', id,
        input: { data: this.source.data.slice(), width: this.source.width, height: this.source.height, linear: this.source.linear, noise: this.source.noise },
        params: this.effectiveParams(),
        preview: { maxWidth: settings.enhancePreviewWidth },
      }
      const result = await runDevelop(req, (stage, frac) => { if (id === requestSeq) this.progress = { stage, frac } })
      if (id !== requestSeq) return // superseded by a newer preview request; drop this one
      const elapsedMs = performance.now() - t0
      const previewPixels = result.width * result.height
      this.lastPreviewMs = elapsedMs
      this.lastPreviewPixels = previewPixels
      if (this.source && previewPixels > 0) {
        const fullPixels = this.source.width * this.source.height
        this.estimatedFullResS = (elapsedMs / 1000) * (fullPixels / previewPixels)
      }
      const rgba = toRgbaBitmapData(result)
      const bmp = await createImageBitmap(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height))
      this.preview?.close()
      this.preview = bmp
    } catch (e) {
      console.error('enhance preview:', (e as Error).message)
    } finally {
      previewInFlight--
      if (previewInFlight <= 0) { this.busy = false; this.progress = null }
    }
  }

  /** Runs the pipeline at full resolution and saves the result as a new gallery item. */
  async apply(): Promise<GalleryItem> {
    if (!this.item || !this.source) throw new Error('no item open for enhance')
    const item = this.item, source = this.source
    this.applyBusy = true
    this.applyProgress = null
    try {
      const id = ++requestSeq
      const req: EnhanceRequest = {
        kind: 'develop', id,
        input: { data: source.data.slice(), width: source.width, height: source.height, linear: source.linear, noise: source.noise },
        params: this.effectiveParams(),
      }
      const result = await runDevelop(req, (stage, frac) => { this.applyProgress = { stage, frac } })
      const as16 = result.data instanceof Uint16Array
      const imageBlob = as16
        ? await encodePng16(result.data as Uint16Array, result.width, result.height)
        : await encodeRgba8({ data: result.data as Uint8ClampedArray, width: result.width, height: result.height })
      const previewRgba = toRgbaBitmapData(result)
      const previewBlob = await encodeRgba8(previewRgba)
      const saved = await saveSnapshot(imageBlob, {
        position: item.position,
        controls: item.controls,
        name: `${item.name} (enhanced)`,
        thumbFrom: previewBlob,
        size: { width: result.width, height: result.height },
        extra: {
          capture: item.capture,
          enhance: { params: this.effectiveParams(), source: item.id },
        },
        extraBlobs: as16 ? { preview: previewBlob } : {},
      })
      // saveSnapshot's currentSample() call stamps the *editor's* current sample; copy the source
      // item's own sample onto the new one instead so "enhanced" items stay attributed correctly
      // (see integration-map.md §3b's "Enhance panel recipe" note).
      if (item.sample) { saved.sample = item.sample; await putItem(saved) }
      return saved
    } finally {
      this.applyBusy = false
      this.applyProgress = null
    }
  }
}

export const enhance = new EnhanceService()
