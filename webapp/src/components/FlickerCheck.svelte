<script lang="ts">
  /** Samples the live view as the browser shows it (about 200 times a second for 3 s) and runs the
   *  flicker analysis: tearing, rolling horizontal bands, brightness pulsing. Shows the numbers and
   *  the rows × frames residual picture (bands appear as diagonal stripes). */
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { device } from '../lib/store/device.svelte'
  import { analyseFlicker, describeFlicker, type FlickerReport } from '../lib/algo/flicker'

  let running = $state(false)
  let lines = $state<string[]>([])
  let report = $state<FlickerReport | null>(null)
  let canvas: HTMLCanvasElement | undefined = $state()

  async function run() {
    const img = liveStack.source
    if (!img || !img.naturalWidth) { lines = ['no live image']; return }
    running = true; lines = []; report = null
    const w = img.naturalWidth, h = img.naturalHeight
    const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true })!
    const samples: Float32Array[] = []
    const t0 = performance.now(), t1 = t0 + 3000
    let frames = 0
    while (performance.now() < t1) {
      try { ctx.drawImage(img, 0, 0) } catch { break }
      const d = ctx.getImageData(0, 0, w, h).data, p = new Float32Array(h)
      for (let y = 0; y < h; y++) { let s = 0; const o = y * w * 4; for (let x = 0; x < w; x++) s += d[o + x * 4 + 1]; p[y] = s / w }
      samples.push(p); frames++
      await new Promise((r) => setTimeout(r, 4))
    }
    const r = analyseFlicker(samples)
    const fps = device.fps || r.frames / 3
    report = r
    lines = describeFlicker(r, fps)
    running = false
  }
  $effect(() => {
    const r = report, c = canvas
    if (!r || !c || !r.residual.width) return
    c.width = r.residual.width; c.height = r.residual.height
    c.getContext('2d')!.putImageData(new ImageData(r.residual.data as Uint8ClampedArray<ArrayBuffer>, r.residual.width, r.residual.height), 0, 0)
  })
</script>

<details class="help">
  <summary>Flicker check</summary>
  <p>Measures what this browser is showing for 3 s: torn frames, rolling horizontal bands (a light
    source or supply ripple beating with the rolling shutter) and brightness pulsing. Run it while the
    waves are visible.</p>
  <div class="row" style="margin-top:6px"><button onclick={run} disabled={running}>{running ? 'Sampling…' : 'Check for flicker (3 s)'}</button></div>
  {#if lines.length}
    <ul class="res">{#each lines as l}<li>{l}</li>{/each}</ul>
    {#if report?.residual.width}
      <canvas bind:this={canvas} class="resid" title="rows (down) × frames (across); band residual ×{report.residual.gain}"></canvas>
      <div class="muted small">rows ↓ × frames →, residual ×{report.residual.gain}: a rolling band shows as diagonal stripes</div>
    {/if}
  {/if}
</details>

<style>
  .res { margin: 6px 0 0; padding-left: 16px; color: var(--text); }
  .res li { margin: 2px 0; }
  .resid { width: 100%; height: 90px; image-rendering: pixelated; border: 1px solid var(--border); border-radius: 4px; margin-top: 6px; background: #808080; }
  .small { font-size: 11px; }
</style>
