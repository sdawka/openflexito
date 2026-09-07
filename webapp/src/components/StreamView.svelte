<script lang="ts">
  /** Live MJPEG view with an overlay for detections, the followed region and drag-selection.
   *  Coordinates handed out are fractions of the image (0..1, origin top-left).
   *
   *  Pointer gestures (like a map): click-hold-drag pans the stage so the picture follows the
   *  cursor (`onpan`, total displacement in natural image pixels, `done` on release); a plain
   *  click (no drag) centres that point (`onclickimage`); shift-drag selects a region
   *  (`onselectregion`). While a pan is in progress `panOffset` (natural px the stage has not yet
   *  caught up with) translates the image so it sticks to the cursor. */
  import { device } from '../lib/store/device.svelte'
  import { settings } from '../lib/store/settings.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'

  export interface Box { x: number; y: number; w: number; h: number; label?: string; score?: number; kind?: 'detect' | 'follow' | 'select' }
  export interface Pan { dx: number; dy: number; w: number; h: number; done: boolean }

  let { boxes = [], panOffset = null, picking = false, onclickimage, onselectregion, onclickbox, onpan }: {
    boxes?: Box[]
    panOffset?: [number, number] | null
    picking?: boolean            // eyedropper mode: show a crosshair cursor
    onclickimage?: (p: { x: number; y: number; w: number; h: number }) => void
    onselectregion?: (r: { x: number; y: number; w: number; h: number }) => void
    onclickbox?: (b: Box) => void
    onpan?: (p: Pan) => void
  } = $props()

  let img: HTMLImageElement | undefined = $state()
  let error = $state(false)
  let nonce = $state(0)
  let drag = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // pan gesture: client-pixel start point and whether the pointer moved past the click threshold
  let pan = $state<{ cx: number; cy: number; moved: boolean; frac: { x: number; y: number } } | null>(null)
  const CLICK_PX = 4
  const src = $derived(device.url(settings.showLores ? '/stream-lores.mjpg' : '/stream.mjpg') + '?n=' + nonce)

  // Re-arm the <img> whenever the device (re)connects. Only `device.connected` is a dependency:
  // `nonce` is written without being read, otherwise this effect would retrigger itself.
  $effect(() => { if (device.connected) { nonce = Date.now(); error = false } })

  // A detached <img> keeps downloading its MJPEG stream (Chrome never aborts it), which leaks a
  // connection per visit until the browser's per-host limit stalls every other request and the
  // Pi encodes for nobody. Clearing src on unmount aborts the stream.
  $effect(() => { const el = img; return () => { if (el) el.src = '' } })
  // the live focus stack and the recorder read frames from this element
  $effect(() => { liveStack.source = img ?? null; return () => { if (liveStack.source === img) liveStack.source = null } })
  let compCanvas: HTMLCanvasElement | undefined = $state()
  $effect(() => {
    const bmp = liveStack.composite, c = compCanvas
    if (!bmp || !c) return
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height }
    c.getContext('2d')!.drawImage(bmp, 0, 0)
  })

  /** Rectangle the image content occupies inside the element (object-fit: contain). */
  function geometry(): { ox: number; oy: number; w: number; h: number } | null {
    if (!img || !img.naturalWidth) return null
    const r = img.getBoundingClientRect()
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale
    return { ox: (r.width - w) / 2, oy: (r.height - h) / 2, w, h }
  }
  function toFrac(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
    const g = geometry(); if (!g || !img) return null
    const r = img.getBoundingClientRect()
    const x = (e.clientX - r.left - g.ox) / g.w, y = (e.clientY - r.top - g.oy) / g.h
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y }
  }
  let geo = $state<{ ox: number; oy: number; w: number; h: number } | null>(null)
  $effect(() => {
    const t = setInterval(() => { geo = geometry() }, 250)
    return () => clearInterval(t)
  })
  /** displayed px per natural px (the translate is measured against the unshifted layout box) */
  const scale = $derived(geo && img?.naturalWidth ? geo.w / img.naturalWidth : 1)
  const shift = $derived(panOffset && geo ? `translate(${panOffset[0] * scale}px, ${panOffset[1] * scale}px)` : '')

  function down(e: PointerEvent) {
    if (e.button !== 0) return
    const p = toFrac(e); if (!p) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (e.shiftKey) { drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return }
    pan = { cx: e.clientX, cy: e.clientY, moved: false, frac: p }
  }
  function panEvent(e: PointerEvent, done: boolean): Pan | null {
    if (!pan || !img || !geo) return null
    const k = img.naturalWidth / geo.w
    return { dx: (e.clientX - pan.cx) * k, dy: (e.clientY - pan.cy) * k, w: img.naturalWidth, h: img.naturalHeight, done }
  }
  function move(e: PointerEvent) {
    if (drag) { const p = toFrac(e); if (p) drag = { ...drag, x1: p.x, y1: p.y }; return }
    if (pan) {
      if (!pan.moved && Math.hypot(e.clientX - pan.cx, e.clientY - pan.cy) < CLICK_PX) return
      pan.moved = true
      const ev = panEvent(e, false); if (ev) onpan?.(ev)
    }
  }
  function up(e: PointerEvent) {
    if (drag) {
      const r = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
      drag = null
      if (r.w > 0.02 && r.h > 0.02) onselectregion?.(r)
      return
    }
    if (!pan) return
    const g = pan; pan = null
    if (g.moved) { const ev = panEvent(e, true); if (ev) onpan?.(ev); return }
    if (!img) return
    const p = g.frac
    const hit = boxes.find((b) => b.kind === 'detect' && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h)
    if (hit && onclickbox) { onclickbox(hit); return }
    onclickimage?.({ x: p.x, y: p.y, w: img.naturalWidth, h: img.naturalHeight })
  }
  function cancel(e: PointerEvent) {
    drag = null
    if (pan?.moved) { const ev = panEvent(e, true); if (ev) onpan?.(ev) }
    pan = null
  }
  const px = (v: number, size: number, off: number) => off + v * size
</script>

<div class="view" class:panning={pan?.moved} class:picking onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel} role="presentation">
  {#if error}
    <div class="err">stream unavailable <button onclick={() => { error = false; nonce++ }}>retry</button></div>
  {/if}
  <img bind:this={img} {src} alt="microscope live view" draggable="false" crossorigin="anonymous" style:transform={shift} class:ghost={liveStack.active && !!liveStack.composite} onerror={() => (error = true)} />
  {#if liveStack.active}<canvas bind:this={compCanvas} class="composite" style:transform={shift}></canvas>{/if}
  {#if geo}
    <svg class="overlay" style="left:{geo.ox}px;top:{geo.oy}px;width:{geo.w}px;height:{geo.h}px" viewBox="0 0 1 1" preserveAspectRatio="none">
      {#each boxes as b}
        <rect x={b.x} y={b.y} width={b.w} height={b.h} class={b.kind ?? 'detect'} vector-effect="non-scaling-stroke" />
      {/each}
      {#if drag}
        <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} class="select" vector-effect="non-scaling-stroke" />
      {/if}
    </svg>
    {#each boxes as b}
      {#if b.label}
        <div class="tag {b.kind ?? 'detect'}" style="left:{px(b.x, geo.w, geo.ox)}px;top:{px(b.y, geo.h, geo.oy)}px">{b.label}{b.score ? ` ${(b.score * 100).toFixed(0)}%` : ''}</div>
      {/if}
    {/each}
  {/if}
  <div class="crosshair"></div>
</div>

<style>
  .view { position: relative; width: 100%; height: 100%; background: #000; display: grid; place-items: center; overflow: hidden; cursor: grab; touch-action: none; }
  .view.panning { cursor: grabbing; }
  .view.picking { cursor: crosshair; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; pointer-events: none; will-change: transform; grid-area: 1 / 1; }
  img.ghost { opacity: 0; }
  .composite { max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; grid-area: 1 / 1; }
  .overlay { position: absolute; pointer-events: none; }
  .overlay rect { fill: none; stroke-width: 2px; }
  .overlay rect.detect { stroke: var(--warn); }
  .overlay rect.follow { stroke: var(--ok); stroke-dasharray: 6 4; }
  .overlay rect.select { stroke: var(--accent); fill: rgba(79,140,255,.15); }
  .tag { position: absolute; transform: translateY(-100%); font-size: 11px; padding: 1px 4px; border-radius: 3px 3px 0 0; pointer-events: none; color: #000; }
  .tag.detect { background: var(--warn); } .tag.follow { background: var(--ok); }
  .crosshair { position: absolute; left: 50%; top: 50%; width: 24px; height: 24px; transform: translate(-50%, -50%);
    pointer-events: none; opacity: .6; background:
      linear-gradient(var(--accent), var(--accent)) center/1px 100% no-repeat,
      linear-gradient(var(--accent), var(--accent)) center/100% 1px no-repeat; }
  .err { position: absolute; top: 12px; left: 12px; z-index: 1; color: var(--err); display: flex; gap: 8px; align-items: center; }
</style>
