<script lang="ts">
  /** Live luminance + RGB histogram sampled from the stream <img> (`liveStack.source`, the same element
   *  the live focus stack reads from), ~4 times a second, only while this panel is actually visible
   *  (an IntersectionObserver pauses sampling when the Camera panel is scrolled out of view or the tab
   *  is hidden). Sampling downsizes to ~205 px wide first — the histogram doesn't need full resolution
   *  and this keeps it cheap enough to run continuously. Maths in `lib/algo/histogram.ts`. */
  import { onMount } from 'svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { device } from '../lib/store/device.svelte'
  import { computeHistogram, suggestExposureStep, type Histogram } from '../lib/algo/histogram'

  const SAMPLE_W = 205
  let host: HTMLDivElement | undefined = $state()
  let visible = $state(false)
  let hist = $state<Histogram | null>(null)
  let canvas: OffscreenCanvas | null = null
  let exposing = $state(false)
  let exposeMsg = $state('')

  function sample(): void {
    const img = liveStack.source
    if (!img || !img.naturalWidth) return
    const h = Math.max(1, Math.round((SAMPLE_W * img.naturalHeight) / img.naturalWidth))
    if (!canvas) canvas = new OffscreenCanvas(SAMPLE_W, h)
    if (canvas.width !== SAMPLE_W || canvas.height !== h) { canvas.width = SAMPLE_W; canvas.height = h }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    try { ctx.drawImage(img, 0, 0, SAMPLE_W, h) } catch { return }
    hist = computeHistogram(ctx.getImageData(0, 0, SAMPLE_W, h).data)
  }

  onMount(() => {
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.1 })
    if (host) io.observe(host)
    const onVis = () => { if (document.hidden) visible = false }
    document.addEventListener('visibilitychange', onVis)
    const t = setInterval(() => { if (visible && !document.hidden) sample() }, 250)
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVis); clearInterval(t) }
  })

  const barPath = (bins: number[]) => {
    const max = Math.max(1, ...bins)
    return bins.map((v, i) => `${i},${100 - (v / max) * 100}`).join(' ')
  }

  /** "Expose to 60% grey" (153/255): with AE off, iterate suggestExposureStep against fresh samples. */
  async function exposeToGrey() {
    const c = device.controls
    if (!c) return
    if (c.AeEnable) { exposeMsg = 'auto exposure is on and already controls the mean level — turn it off to use this.'; return }
    exposing = true
    exposeMsg = 'adjusting…'
    try {
      const limits = { exposureUs: [50, 500000] as [number, number], gain: [1, 10.67] as [number, number] }
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 300))
        sample()
        if (!hist) continue
        const step = suggestExposureStep(hist.mean, 153, { exposureUs: c.ExposureTime, gain: c.AnalogueGain }, limits)
        if (!step) { exposeMsg = `done: mean ${hist.mean.toFixed(0)}/255`; break }
        await device.setControls({ ExposureTime: step.exposureUs, AnalogueGain: step.gain })
        exposeMsg = `${step.exposureUs} µs × ${step.gain.toFixed(2)} gain…`
        await new Promise((r) => setTimeout(r, 250))
      }
    } catch (e) {
      exposeMsg = (e as Error).message
    } finally {
      exposing = false
    }
  }
</script>

<div class="hist" bind:this={host}>
  <h4 class="sub">Histogram</h4>
  {#if hist}
    <svg viewBox="0 0 205 100" preserveAspectRatio="none" class="plot">
      <polyline points={barPath(hist.r)} class="ch r" />
      <polyline points={barPath(hist.g)} class="ch g" />
      <polyline points={barPath(hist.b)} class="ch b" />
      <polyline points={barPath(hist.lum)} class="ch lum" />
    </svg>
    <div class="row" style="font-size:11px;gap:10px" class:warn={hist.clippedHigh > 0.01}>
      <span>mean {hist.mean.toFixed(0)}/255</span>
      <span class:warn-text={hist.clippedHigh > 0.01}>highlights clipped {(hist.clippedHigh * 100).toFixed(1)}%</span>
      <span class:warn-text={hist.clippedLow > 0.01}>shadows clipped {(hist.clippedLow * 100).toFixed(1)}%</span>
    </div>
    <div class="row" style="margin-top:6px">
      <button onclick={exposeToGrey} disabled={exposing || !device.controls} title="adjust exposure (then gain) so the frame mean lands near 60% grey">
        {exposing ? 'Adjusting…' : 'Expose to 60% grey'}
      </button>
    </div>
    {#if exposeMsg}<div class="muted mono" style="font-size:11px;margin-top:4px">{exposeMsg}</div>{/if}
  {:else}
    <span class="muted" style="font-size:12px">waiting for a frame…</span>
  {/if}
</div>

<style>
  .hist { margin-top: 10px; }
  .plot { width: 100%; height: 70px; background: var(--panel2); border-radius: 4px; }
  .ch { fill: none; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .ch.r { stroke: #ff6b6b; }
  .ch.g { stroke: #6bff8a; }
  .ch.b { stroke: #6ba8ff; }
  .ch.lum { stroke: #ddd; stroke-width: 1.5; }
  .warn-text { color: var(--warn); }
</style>
