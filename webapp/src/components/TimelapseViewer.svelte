<script lang="ts">
  /** Time-lapse player: play/pause/scrub through the saved frames with the measured drift subtracted
   *  ("drift-free" checkbox), export the sequence as WebM, or run organism tracking over it and
   *  export the resulting trajectories as CSV. */
  import { onMount } from 'svelte'
  import { getBlob, type GalleryItem } from '../lib/store/gallery'
  import { exportTimelapseWebm } from '../lib/services/timelapse.svelte'
  import { tracking } from '../lib/services/tracking.svelte'
  import { tracksToCsv } from '../lib/algo/tracking'
  import { playbackShift } from '../lib/algo/drift'

  let { item }: { item: GalleryItem } = $props()
  const meta = $derived(item.timelapse!)
  const n = $derived(meta.frames.length)

  let index = $state(0)
  let playing = $state(false)
  let stabilised = $state(true)
  let status = $state('')
  let canvas: HTMLCanvasElement | undefined = $state()
  let timer: ReturnType<typeof setInterval> | undefined
  let tracked = $state(false)

  async function draw(i: number): Promise<void> {
    const blob = await getBlob(item.id, `f${String(i).padStart(4, '0')}`)
    if (!blob || !canvas) return
    const bmp = await createImageBitmap(blob)
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // full-frame px (legacy items measured on a 410 px downsample are rescaled by playbackShift)
    const shift = stabilised ? playbackShift(meta.frames[i], bmp.width) : { dx: 0, dy: 0 }
    ctx.drawImage(bmp, -shift.dx, -shift.dy)
    bmp.close()
  }
  $effect(() => { void draw(index) })

  function togglePlay(): void {
    if (playing) { clearInterval(timer); playing = false; return }
    playing = true
    timer = setInterval(() => { index = (index + 1) % n }, Math.max(80, Math.min(500, meta.intervalMs / 10)))
  }
  onMount(() => () => clearInterval(timer))

  async function exportVideo(): Promise<void> {
    status = 'exporting…'
    try { const v = await exportTimelapseWebm(item, { stabilised }); status = `saved "${v.name}"` }
    catch (e) { status = (e as Error).message }
  }

  async function trackThis(): Promise<void> {
    status = 'tracking…'; tracked = false
    try { await tracking.runOnTimelapse(item); tracked = true; status = `${tracking.tracks.length} track(s) found` }
    catch (e) { status = (e as Error).message }
  }
  function downloadCsv(): void {
    const csv = tracksToCsv(tracking.tracks)
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `tracks-${item.id}.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
</script>

<div class="tl">
  <canvas bind:this={canvas}></canvas>
  <div class="bar">
    <button onclick={togglePlay}>{playing ? 'Pause' : 'Play'}</button>
    <input type="range" min="0" max={n - 1} bind:value={index} disabled={playing} />
    <span class="mono" title={meta.frames[index]?.t}>{index + 1}/{n}{meta.frames[index]?.refocused ? ' · refocused' : ''}{meta.frames[index]?.remetered ? ' · re-metered' : ''}</span>
    <label><input type="checkbox" bind:checked={stabilised} /> drift-free</label>
    <button onclick={exportVideo}>Export WebM</button>
    <button onclick={trackThis}>Track organisms</button>
    {#if tracked}<button onclick={downloadCsv}>Export CSV</button>{/if}
  </div>
  {#if status}<div class="status mono">{status}</div>{/if}
</div>

<style>
  .tl { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
  canvas { max-width: 92%; max-height: 78%; object-fit: contain; background: #000; }
  .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; padding: 0 12px; color: #fff; }
  .bar input[type=range] { width: 220px; }
  .bar label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
  .status { color: #fff; font-size: 12px; opacity: .85; }
</style>
