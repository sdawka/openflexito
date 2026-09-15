<script lang="ts">
  /** Time-lapse player: play/pause/scrub through the saved frames with the measured drift subtracted
   *  ("drift-free" checkbox), export the sequence as WebM, or run organism tracking over it and
   *  export the resulting trajectories as CSV.
   *
   *  Pinch-to-zoom and single-finger drag-to-pan the frame (plain `<canvas>`, so unlike `Viewer`'s
   *  OpenSeadragon image there is no gesture handling built in — the transform maths lives in
   *  `lib/input/zoomPan.ts`); mouse wheel zooms and mouse-drag pans on desktop; a double-click or
   *  double-tap resets to fit. */
  import { onMount } from 'svelte'
  import { getBlob, type GalleryItem } from '../lib/store/gallery'
  import { exportTimelapseWebm } from '../lib/services/timelapse.svelte'
  import { tracking } from '../lib/services/tracking.svelte'
  import { tracksToCsv } from '../lib/algo/tracking'
  import { playbackShift } from '../lib/algo/drift'
  import { IDENTITY, cssTransform, normalize, panBy, pinchDistance, pinchMidpoint, zoomAt, type ZoomPanState } from '../lib/input/zoomPan'

  let { item }: { item: GalleryItem } = $props()
  const meta = $derived(item.timelapse!)
  const n = $derived(meta.frames.length)

  let index = $state(0)
  let playing = $state(false)
  let stabilised = $state(true)
  let status = $state('')
  let canvas: HTMLCanvasElement | undefined = $state()
  let container: HTMLDivElement | undefined = $state()
  let timer: ReturnType<typeof setInterval> | undefined
  let tracked = $state(false)

  // pinch/drag-to-zoom-and-pan; see lib/input/zoomPan.ts for the pure maths
  let zp = $state<ZoomPanState>(IDENTITY)
  const activePointers = new Map<number, { x: number; y: number }>()
  let dragFrom: { x: number; y: number } | null = null
  let dragMoved = 0
  let pinchBaseline: ZoomPanState = IDENTITY
  let pinchStartDist = 0
  let lastTap: { t: number; x: number; y: number } | null = null

  function pointOf(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = container!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function zoomDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType !== 'touch') return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    activePointers.set(e.pointerId, pointOf(e))
    if (activePointers.size === 1) { dragFrom = pointOf(e); dragMoved = 0 }
    else if (activePointers.size === 2) {
      dragFrom = null
      const [a, b] = [...activePointers.values()]
      pinchBaseline = zp; pinchStartDist = pinchDistance(a, b)
    }
  }
  function zoomMove(e: PointerEvent): void {
    if (!activePointers.has(e.pointerId)) return
    activePointers.set(e.pointerId, pointOf(e))
    if (activePointers.size === 1 && dragFrom) {
      const p = pointOf(e)
      zp = panBy(zp, p.x - dragFrom.x, p.y - dragFrom.y)
      dragMoved += Math.hypot(p.x - dragFrom.x, p.y - dragFrom.y)
      dragFrom = p
    } else if (activePointers.size === 2 && pinchStartDist > 0) {
      const [a, b] = [...activePointers.values()]
      const mid = pinchMidpoint(a, b)
      zp = normalize(zoomAt(pinchBaseline, pinchDistance(a, b) / pinchStartDist, mid.x, mid.y))
    }
  }
  function zoomEnd(e: PointerEvent): void {
    const wasTap = activePointers.size === 1 && dragMoved < 8
    activePointers.delete(e.pointerId)
    if (activePointers.size === 0) {
      if (wasTap) {
        const p = pointOf(e), now = performance.now()
        if (lastTap && now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { zp = IDENTITY; lastTap = null }
        else lastTap = { t: now, x: p.x, y: p.y }
      }
      dragFrom = null
    } else if (activePointers.size === 1) {
      dragFrom = [...activePointers.values()][0]; dragMoved = 0
    }
  }
  function zoomCancel(e: PointerEvent): void { activePointers.delete(e.pointerId); dragFrom = null }
  function zoomWheel(e: WheelEvent): void {
    e.preventDefault()
    const p = pointOf(e)
    zp = normalize(zoomAt(zp, Math.exp(-e.deltaY * 0.0015), p.x, p.y))
  }

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
  <div class="stage" bind:this={container} onpointerdown={zoomDown} onpointermove={zoomMove} onpointerup={zoomEnd} onpointercancel={zoomCancel} onwheel={zoomWheel} role="presentation">
    <canvas bind:this={canvas} style:transform={cssTransform(zp)}></canvas>
  </div>
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
  .stage { width: 100%; flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; touch-action: none; }
  canvas { max-width: 92%; max-height: 92%; object-fit: contain; background: #000; transform-origin: 0 0; will-change: transform; }
  .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; padding: 0 12px; color: #fff; }
  .bar input[type=range] { width: 220px; }
  .bar label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
  .status { color: #fff; font-size: 12px; opacity: .85; }
</style>
