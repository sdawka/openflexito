<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for an image Blob, a plain player for video Blobs, or the
   *  time-lapse player (`TimelapseViewer`) when `item` is a time-lapse gallery item.
   *  Also hosts the scale bar and measurement tool for gallery images: `width` (the item's natural
   *  pixel width, from the gallery record) lets `lib/store/scaleCal.svelte.ts` derive µm/px for
   *  whatever zoom level OSD is currently showing. Measurement here shares the same tool state as the
   *  live view (`lib/services/measureService.svelte.ts`) so both feed one results list / CSV export.
   *  Optionally shows the item's sample metadata with an inline editor (Gallery passes `item` and
   *  `onSampleChange`; other callers, e.g. Live's search-hit preview, omit them). */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'
  import { getBlob, type GalleryItem } from '../lib/store/gallery'
  import type { SampleRecord } from '../lib/store/sample.svelte'
  import TimelapseViewer from './TimelapseViewer.svelte'
  import { measure } from '../lib/services/measureService.svelte'
  import { currentScale, umPerPxAt } from '../lib/store/scaleCal.svelte'
  import { scaleForWidth, niceScaleBarLength, type Pt } from '../lib/algo/measure'
  import MeasurePanel from './MeasurePanel.svelte'
  import HeightMapOverlay from './HeightMapOverlay.svelte'
  import { settings } from '../lib/store/settings.svelte'
  import { stepsToUm, depthLegend } from '../lib/algo/depthMap'

  let { blob = null, width, item, onclose, onSampleChange }: { blob?: Blob | null; width?: number; item?: GalleryItem; onclose: () => void; onSampleChange?: (s: SampleRecord) => void } = $props()
  let el: HTMLDivElement | undefined = $state()
  let viewer: OpenSeadragon.Viewer | undefined
  const isTimelapse = $derived(item?.kind === 'timelapse')
  const isVideo = $derived(!!blob && blob.type.startsWith('video/'))
  let videoUrl = $state('')
  let imgPxPerScreenPx = $state(1)   // how many *image* pixels one screen pixel covers, at the current zoom

  function refreshZoom() {
    if (!viewer) return
    const p0 = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0))
    const p1 = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0))
    const screenPxPerImagePx = (p1.x - p0.x) / 1000
    imgPxPerScreenPx = screenPxPerImagePx > 0 ? 1 / screenPxPerImagePx : 1
  }

  const emptySample = (): SampleRecord => ({ name: '', specimen: '', stain: '', slideId: '', magnification: '', operator: '', notes: '' })
  let editing = $state(false)
  let draft = $state<SampleRecord>(emptySample())
  $effect(() => { draft = item?.sample ? { ...item.sample } : emptySample() })
  function save() { onSampleChange?.({ ...draft }); editing = false }
  // Fine-stack items carry a depth map: switch the shown blob between image / 'depth' / 'relief'.
  const hasDepth = $derived(!!item?.stack?.depth && !isVideo && !isTimelapse)
  let mode = $state<'image' | 'depth' | 'relief'>('image')
  /** Depth-map legend: convert the stored z-step min/max to µm at display time using Settings'
   *  current stage z µm/step (`algo/depthMap.ts#stepsToUm`/`depthLegend`), regardless of whether the
   *  item's own `stack.depth.unit` was persisted — the stored min/max are always z steps. */
  const depthLegendInfo = $derived.by(() => {
    const d = item?.stack?.depth
    if (!d) return null
    const umPerStep = settings.stageStepUm?.z
    const [min, max] = umPerStep && umPerStep > 0 ? stepsToUm([d.minZ, d.maxZ], umPerStep) : [d.minZ, d.maxZ]
    return depthLegend({ min, max }, umPerStep)
  })
  // Video: a very short clip silently restarting under `loop` can look like a glitch to a viewer.
  const videoShouldLoop = $derived((item?.video?.durationS ?? 0) > 3)
  let detailsOpen = $state(false)
  const captureMeta = $derived(item?.capture?.meta as Record<string, unknown> | null | undefined)
  const fmtNum = (v: unknown, digits = 2): string => typeof v === 'number' ? v.toFixed(digits) : '—'
  // svelte-ignore state_referenced_locally -- seed once from the prop (a fresh Viewer is mounted per item)
  let viewBlob = $state<Blob | null>(blob)
  $effect(() => {
    if (!hasDepth || mode === 'image') { viewBlob = blob; return }
    const wanted = mode, id = item!.id
    getBlob(id, wanted).then((b) => { if (b) viewBlob = b })
  })
  let shown: Blob | null = null
  $effect(() => {
    const b = viewBlob
    if (!viewer || !b || b === shown) return
    shown = b
    const url = URL.createObjectURL(b)
    viewer.open({ type: 'image', url, buildPyramid: true } as any)
    return () => URL.revokeObjectURL(url)
  })

  onMount(() => {
    shown = blob
    if (isTimelapse || !blob) return
    const url = URL.createObjectURL(blob)
    if (isVideo) { videoUrl = url; return () => URL.revokeObjectURL(url) }
    viewer = OpenSeadragon({
      element: el!, prefixUrl: '', showNavigationControl: false, showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
      tileSources: { type: 'image', url, buildPyramid: true } as any, maxZoomPixelRatio: 4, animationTime: 0.4, gestureSettingsMouse: { clickToZoom: false },
    })
    viewer.addHandler('open', refreshZoom)
    viewer.addHandler('animation', refreshZoom)
    viewer.addHandler('resize', refreshZoom)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') { measure.toggle(); syncGestures() }
      else if (e.key === 'Escape') { if (measure.active) { measure.cancel(); syncGestures() } else onclose() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); viewer?.destroy(); URL.revokeObjectURL(url); measure.cancel() }
  })

  /** Measurement mode must own clicks; OSD's own pan/zoom-on-click would otherwise fire underneath. */
  function syncGestures() {
    if (!viewer) return
    viewer.setMouseNavEnabled(!measure.active)
    const gestures = (viewer as unknown as { gestureSettingsMouse: { clickToZoom: boolean; dblClickToZoom: boolean } }).gestureSettingsMouse
    gestures.clickToZoom = false
    gestures.dblClickToZoom = !measure.active
  }
  $effect(syncGestures)

  function toImageFrac(e: MouseEvent): Pt | null {
    if (!viewer || !el) return null
    const r = el.getBoundingClientRect()
    const p = viewer.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(e.clientX - r.left, e.clientY - r.top))
    const size = viewer.world.getItemAt(0)?.getContentSize()
    if (!size) return null
    const x = p.x / size.x, y = p.y / size.y
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y }
  }
  function onOsdClick(e: MouseEvent) {
    if (!measure.active) return
    const p = toImageFrac(e)
    const size = viewer?.world.getItemAt(0)?.getContentSize()
    if (p && size) measure.addPoint(p, size.x, size.y, umPerPxAt(size.x))
  }
  function onOsdDblClick(e: MouseEvent) {
    if (!measure.active) return
    e.preventDefault()
    const size = viewer?.world.getItemAt(0)?.getContentSize()
    if (size) measure.closePolygon(umPerPxAt(size.x))
  }

  const naturalWidth = $derived(width ?? viewer?.world.getItemAt(0)?.getContentSize()?.x)
  const umPerPxHere = $derived.by(() => {
    const s = currentScale(); const w = naturalWidth
    return s && w ? scaleForWidth(s.umPerPx, s.referenceWidth, w) * imgPxPerScreenPx : null
  })
  const scaleBar = $derived(umPerPxHere ? niceScaleBarLength(umPerPxHere, (el?.clientWidth ?? 800) * 0.3) : null)

  /** Points/lines for the overlay, in on-screen pixels relative to `el`. */
  function toScreen(p: Pt): { x: number; y: number } | null {
    if (!viewer) return null
    const size = viewer.world.getItemAt(0)?.getContentSize(); if (!size) return null
    const v = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(p.x * size.x, p.y * size.y))
    return { x: v.x, y: v.y }
  }
</script>

<div class="overlay">
  <button class="close" onclick={onclose}>✕ close</button>
  {#if item && onSampleChange}
    <button class="sample-toggle" onclick={() => (editing = !editing)}>{editing ? '✕' : '🏷'} sample{item.sample?.name ? `: ${item.sample.name}` : ''}</button>
  {/if}
  {#if item && (item.capture || item.superres || item.stack || item.video)}
    <button class="details-toggle" style={item && onSampleChange ? 'left:140px' : ''} onclick={() => (detailsOpen = !detailsOpen)}>{detailsOpen ? '✕' : 'ℹ'} details</button>
  {/if}
  {#if hasDepth}
    <div class="modes">
      <button class:on={mode === 'image'} onclick={() => (mode = 'image')}>Image</button>
      <button class:on={mode === 'depth'} onclick={() => (mode = 'depth')}>Depth map</button>
      <button class:on={mode === 'relief'} onclick={() => (mode = 'relief')}>Relief</button>
    </div>
  {/if}
  {#if isTimelapse && item}
    <TimelapseViewer {item} />
  {:else if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="video" src={videoUrl} controls autoplay loop={videoShouldLoop}></video>
  {:else}
    <div class="osd" class:measuring={measure.active} bind:this={el} onclick={onOsdClick} ondblclick={onOsdDblClick} role="presentation">
      {#if measure.points.length}
        <svg class="measure-overlay">
          {#each measure.points as p, i}
            {@const s = toScreen(p)}
            {#if s}
              {#if i > 0}{@const prev = toScreen(measure.points[i - 1])}{#if prev}<line x1={prev.x} y1={prev.y} x2={s.x} y2={s.y} class="measure-line" />{/if}{/if}
              <circle cx={s.x} cy={s.y} r="4" class="measure-pt" />
            {/if}
          {/each}
          {#if measure.mode === 'polygon' && measure.points.length > 2}
            {@const a = toScreen(measure.points[measure.points.length - 1])}
            {@const b = toScreen(measure.points[0])}
            {#if a && b}<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="measure-line ghost" />{/if}
          {/if}
        </svg>
      {/if}
      {#if scaleBar}<div class="scalebar" style="width:{scaleBar.px / imgPxPerScreenPx}px"><span>{scaleBar.label}</span></div>{/if}
    </div>
    <div class="measure-dock"><MeasurePanel compact /></div>
    {#if item?.scan}<HeightMapOverlay {item} />{/if}
  {/if}
  {#if detailsOpen && item}
    <div class="details panel mono">
      {#if item.capture}
        <div class="d-title">Capture</div>
        {#if captureMeta}
          {#if typeof captureMeta.exposure === 'number'}<div>exposure {(captureMeta.exposure as number / 1000).toFixed(2)} ms</div>{/if}
          {#if typeof captureMeta.gain === 'number'}<div>gain {fmtNum(captureMeta.gain)}×{typeof captureMeta.digital_gain === 'number' ? ` (digital ${fmtNum(captureMeta.digital_gain)}×)` : ''}</div>{/if}
          {#if Array.isArray(captureMeta.colour_gains)}<div>colour gains r {fmtNum((captureMeta.colour_gains as number[])[0])} b {fmtNum((captureMeta.colour_gains as number[])[1])}</div>{/if}
          {#if typeof captureMeta.lux === 'number'}<div>lux {(captureMeta.lux as number).toFixed(0)}</div>{/if}
          {#if typeof captureMeta.colour_temperature === 'number'}<div>colour temp {(captureMeta.colour_temperature as number).toFixed(0)} K</div>{/if}
          {#if typeof captureMeta.ts === 'number'}<div>sensor ts {captureMeta.ts as number} ns</div>{/if}
          {#if captureMeta.matched === false}<div class="muted">⚠ not matched to a metadata frame</div>{/if}
        {/if}
        {#if item.capture.umPerPx}<div>{item.capture.umPerPx.toFixed(4)} µm/px ({item.capture.scaleSource ?? 'stage'})</div>{/if}
      {/if}
      {#if item.stack}
        <div class="d-title">Focus stack</div>
        <div>method {item.stack.method ?? 'blocks'}{item.stack.source ? `, ${item.stack.source}` : ''}</div>
        {#if depthLegendInfo}<div>depth {depthLegendInfo.min.toFixed(depthLegendInfo.unit === 'µm' ? 2 : 0)}–{depthLegendInfo.max.toFixed(depthLegendInfo.unit === 'µm' ? 2 : 0)} {depthLegendInfo.unit}</div>{/if}
      {/if}
      {#if item.superres}
        <div class="d-title">Super-resolution</div>
        <div>{item.superres.used ?? item.superres.frames}/{item.superres.frames} frames used · ×{item.superres.scale}{item.superres.sharpened ? ' · sharpened' : ''}{item.superres.pixfrac ? ` · pixfrac ${item.superres.pixfrac}` : ''}</div>
        {#if item.superres.used !== undefined && item.superres.used < item.superres.frames}<div class="muted">{item.superres.frames - item.superres.used} frame(s) rejected (registration or duplicate phase)</div>{/if}
      {/if}
      {#if item.video}
        <div class="d-title">Video</div>
        <div>{item.video.codec ?? '—'}{item.video.bitrateBps ? ` · ${(item.video.bitrateBps / 1e6).toFixed(1)} Mbit/s` : ''} · {item.video.fps.toFixed(1)} fps{item.video.stabilised ? ' · stabilised' : ''}</div>
      {/if}
    </div>
  {/if}
  {#if editing && item && onSampleChange}
    <div class="sample-edit panel">
      <label>Name <input bind:value={draft.name} /></label>
      <label>Specimen <input bind:value={draft.specimen} /></label>
      <label>Stain / prep <input bind:value={draft.stain} /></label>
      <label>Slide id <input bind:value={draft.slideId} /></label>
      <label>Magnification <input bind:value={draft.magnification} /></label>
      <label>Operator <input bind:value={draft.operator} /></label>
      <label>Notes <textarea rows="2" bind:value={draft.notes}></textarea></label>
      <div class="row"><button class="primary" onclick={save}>Save</button><button onclick={() => (editing = false)}>Cancel</button></div>
    </div>
  {/if}
</div>

<style>
  .overlay { position: fixed; inset: 0; background: #000; z-index: 50; }
  .osd { width: 100%; height: 100%; position: relative; }
  .osd.measuring { cursor: crosshair; }
  .video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .close { position: absolute; top: 12px; right: 12px; z-index: 51; }
  .measure-overlay { position: absolute; inset: 0; pointer-events: none; width: 100%; height: 100%; }
  .measure-line { stroke: var(--accent); stroke-width: 2px; }
  .measure-line.ghost { stroke-dasharray: 5 4; opacity: .7; }
  .measure-pt { fill: var(--accent); stroke: #fff; stroke-width: 1px; }
  .scalebar { position: absolute; left: 12px; bottom: 12px; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
  .scalebar::before { content: ''; display: block; width: 100%; height: 3px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
  .scalebar span { font-size: 11px; color: #fff; text-shadow: 0 0 3px #000, 0 0 3px #000; }
  .measure-dock { position: absolute; right: 12px; top: 52px; width: 260px; z-index: 51; max-height: calc(100vh - 80px); overflow: auto; }
  .sample-toggle { position: absolute; top: 12px; left: 12px; z-index: 51; }
  .details-toggle { position: absolute; top: 12px; left: 12px; z-index: 51; }
  .details { position: absolute; top: 52px; left: 12px; z-index: 51; width: 240px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; max-height: calc(100vh - 80px); overflow: auto; }
  .details .d-title { font-weight: 600; margin-top: 6px; }
  .details .d-title:first-child { margin-top: 0; }
  .sample-edit { position: absolute; top: 52px; left: 12px; z-index: 51; width: 260px; display: flex; flex-direction: column; gap: 6px; }
  .sample-edit label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  .modes { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 51; display: flex; gap: 6px; }
  .modes button.on { background: var(--accent); color: #fff; }
</style>
