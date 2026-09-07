<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for an image Blob; a plain player for video Blobs.
   *  Also hosts the scale bar and measurement tool for gallery images: `width` (the item's natural
   *  pixel width, from the gallery record) lets `lib/store/scaleCal.svelte.ts` derive µm/px for
   *  whatever zoom level OSD is currently showing. Measurement here shares the same tool state as the
   *  live view (`lib/services/measureService.svelte.ts`) so both feed one results list / CSV export. */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'
  import { measure } from '../lib/services/measureService.svelte'
  import { currentScale, umPerPxAt } from '../lib/store/scaleCal.svelte'
  import { scaleForWidth, niceScaleBarLength, type Pt } from '../lib/algo/measure'
  import MeasurePanel from './MeasurePanel.svelte'

  let { blob, width, onclose }: { blob: Blob; width?: number; onclose: () => void } = $props()
  let el: HTMLDivElement | undefined = $state()
  let viewer: OpenSeadragon.Viewer | undefined
  const isVideo = $derived(blob.type.startsWith('video/'))
  let videoUrl = $state('')
  let imgPxPerScreenPx = $state(1)   // how many *image* pixels one screen pixel covers, at the current zoom

  function refreshZoom() {
    if (!viewer) return
    const p0 = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0))
    const p1 = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0))
    const screenPxPerImagePx = (p1.x - p0.x) / 1000
    imgPxPerScreenPx = screenPxPerImagePx > 0 ? 1 / screenPxPerImagePx : 1
  }

  onMount(() => {
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
  {#if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="video" src={videoUrl} controls autoplay loop></video>
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
</style>
