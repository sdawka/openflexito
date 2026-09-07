<script lang="ts">
  import { onMount } from 'svelte'
  import { device } from '../lib/store/device.svelte'
  import { settings } from '../lib/store/settings.svelte'
  import { JogController } from '../lib/input/jog'
  import { attachKeyboard } from '../lib/input/keyboard'
  import { attachGamepad } from '../lib/input/gamepad'
  import StreamView, { type Pan } from '../components/StreamView.svelte'
  import { PanController } from '../lib/input/pan'
  import { wb, pickNeutral } from '../lib/services/whiteBalance.svelte'
  import StagePad from '../components/StagePad.svelte'
  import CameraControls from '../components/CameraControls.svelte'
  import LightControl from '../components/LightControl.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { pixelsToStage } from '../lib/algo/csm'
  import { runAutofocus, cancelAutofocus } from '../lib/services/autofocusService'
  import { ai, type Detection } from '../lib/services/aiService.svelte'
  import { follow } from '../lib/services/followService.svelte'
  import { searchByImage, type SearchHit } from '../lib/services/searchService'
  import { getBlob } from '../lib/store/gallery'
  import Viewer from '../components/Viewer.svelte'
  import type { Box } from '../components/StreamView.svelte'

  // ---- click-hold-drag panning (like a map): the picture follows the cursor, the stage follows the picture ----
  let panner: PanController | null = null
  let panOffset = $state<[number, number] | null>(null)
  let panScale = 1   // calibration-frame px per natural px of the current stream
  function onPan(p: Pan) {
    const csm = calibration.csm
    if (!csm) {
      lastClick = 'drag-to-move needs the stage ↔ camera calibration: run "Calibrate XY" on the Calibrate page'
      return
    }
    if (!panner || panner.matrixRef !== csm.matrix) {
      panner = new PanController({
        matrix: csm.matrix,
        move: (d) => device.moveRel(d, false),
        onchange: refreshPanOffset,
      })
      panner.matrixRef = csm.matrix
    }
    panScale = csm.imageWidth / p.w
    if (!panner.active && !p.done) panner.begin()
    // dragging the picture right means the scene must move right by that many pixels
    panner.update([p.dx * panScale, p.dy * panScale])
    if (p.done) panner.end()
    refreshPanOffset()
    lastClick = null
  }
  /** Translate the picture by what the stage still owes the cursor; nothing once the pan is idle
   *  (the integer-step rounding leaves a sub-pixel remainder that must not stick). */
  function refreshPanOffset() {
    if (!panner || !(panner.active || panner.busy)) { panOffset = null; return }
    const [dx, dy] = panner.pendingPx()
    panOffset = Math.hypot(dx, dy) < panScale ? null : [dx / panScale, dy / panScale]
  }

  // ---- intelligence: detection, following, region search ----
  let detecting = $state(false)
  let detections = $state<Detection[]>([])
  let detectTimer: ReturnType<typeof setTimeout> | undefined
  let hits = $state<SearchHit[]>([])
  let hitThumbs = $state<Record<string, string>>({})
  let searching = $state(false)
  let viewing = $state<Blob | null>(null)

  async function detectLoop() {
    if (!detecting) return
    try {
      const res = await fetch(device.url('/snapshot.jpg') + '?t=' + Date.now(), { cache: 'no-store' })
      const bmp = await createImageBitmap(await res.blob())
      detections = await ai.detect(bmp, settings.detectThreshold)
    } catch (e) { afLog = `detection: ${(e as Error).message}` }
    if (detecting) detectTimer = setTimeout(detectLoop, settings.detectIntervalMs)
  }
  function toggleDetect() {
    detecting = !detecting
    clearTimeout(detectTimer)
    if (detecting) detectLoop(); else detections = []
  }
  const boxes = $derived<Box[]>([
    ...detections.map((d) => ({ x: d.box.xmin, y: d.box.ymin, w: d.box.xmax - d.box.xmin, h: d.box.ymax - d.box.ymin, label: d.label, score: d.score, kind: 'detect' as const })),
    ...(follow.active && follow.region ? [{ ...follow.region, label: 'following', kind: 'follow' as const }] : []),
  ])
  function followBox(b: Box) { follow.start({ x: b.x, y: b.y, w: b.w, h: b.h }) }
  async function onSelectRegion(r: { x: number; y: number; w: number; h: number }) {
    // Shift-drag: search the gallery for similar regions (alt: hold ctrl/cmd to follow instead)
    searching = true
    try {
      const res = await fetch(device.url('/snapshot.jpg') + '?t=' + Date.now(), { cache: 'no-store' })
      hits = await searchByImage(await res.blob(), r, 8)
      for (const h of hits) {
        const key = `${h.item.id}/${h.blob}`
        if (!hitThumbs[key]) {
          const b = await getBlob(h.item.id, h.blob === 'image' && h.item.blobs.includes('thumb') ? 'thumb' : h.blob)
          if (b) hitThumbs = { ...hitThumbs, [key]: URL.createObjectURL(b) }
        }
      }
      if (!hits.length) afLog = 'no indexed images in the gallery yet (Gallery → Index)'
    } catch (e) { afLog = `search: ${(e as Error).message}` } finally { searching = false }
  }
  async function openHit(h: SearchHit) { const b = await getBlob(h.item.id, h.blob); if (b) viewing = b }

  let lastClick = $state<string | null>(null)
  let focusing = $state(false)
  let afMode = $state<'fast' | 'looping' | 'step'>('fast')
  let afRange = $state(2000)
  let afLog = $state('')

  async function autofocus() {
    if (focusing) { cancelAutofocus(); return }
    focusing = true
    afLog = 'autofocus…'
    try {
      const r = await runAutofocus({ mode: afMode, dz: afRange, metric: 'jpeg', onProgress: (m) => (afLog = m) })
      afLog = `focused at z=${r.peakZ} (${r.samples.length} samples)`
    } catch (e) {
      afLog = (e as Error).message
    } finally {
      focusing = false
    }
  }

  onMount(() => {
    const jog = new JogController(
      (d) => device.jog(d),
      () => device.stop(),
      () => ({ xy: settings.stepXY, z: settings.stepZ }),
    )
    const offKeys = attachKeyboard(jog, { invertY: () => settings.invertYKeys, enabled: () => device.connected })
    const offPad = attachGamepad(jog, { stop: () => device.stop(), autofocus }, () => settings.gamepad && device.connected)
    return () => { offKeys(); offPad(); jog.dispose(); detecting = false; clearTimeout(detectTimer); follow.stop() }
  })

  function onClickImage(p: { x: number; y: number; w: number; h: number }) {
    if (wb.picking) { lastClick = null; void pickNeutral({ x: p.x, y: p.y }); return }
    const csm = calibration.csm
    if (!csm) {
      lastClick = `(${(p.x * p.w).toFixed(0)}, ${(p.y * p.h).toFixed(0)}) px — run "Calibrate XY" on the Calibrate page to enable drag-to-move and click-to-centre`
      return
    }
    // displacement of the clicked point from the centre, in the calibration's reference frame size
    const dx = (p.x - 0.5) * csm.imageWidth, dy = (p.y - 0.5) * csm.imageHeight
    // to bring the clicked feature to the centre the scene must move by (-dx, -dy)
    const move = pixelsToStage(csm.matrix, [-dx, -dy])
    lastClick = `click-to-move: ${move.x}, ${move.y} steps`
    device.moveRel(move, false).catch(() => {})
  }
</script>

<div class="live">
  <section class="stream">
    <StreamView {boxes} {panOffset} onpan={onPan} onclickimage={onClickImage} onselectregion={onSelectRegion} onclickbox={followBox} picking={wb.picking} />
    {#if wb.picking}<div class="hint mono" style="top:12px;bottom:auto">click a spot that should be neutral grey or white</div>{/if}
    {#if follow.active || follow.status}<div class="hint mono" style="right:12px;left:auto">{follow.status}{#if follow.active} <button onclick={() => follow.stop()}>stop</button>{/if}</div>{/if}
    {#if ai.status}<div class="hint mono" style="top:12px;bottom:auto">{ai.status}</div>{/if}
    {#if lastClick}<div class="hint mono">{lastClick}</div>{/if}
    {#if device.error}<div class="hint err">{device.error} <button onclick={() => (device.error = null)}>×</button></div>{/if}
  </section>
  <aside>
    <div class="panel">
      <h3>Focus</h3>
      <div class="row">
        <button class="primary" onclick={autofocus} disabled={!device.connected}>{focusing ? 'Cancel' : 'Autofocus'}</button>
        <select bind:value={afMode} disabled={focusing}>
          <option value="fast">fast (JPEG size)</option>
          <option value="looping">looping</option>
          <option value="step">step (Laplacian)</option>
        </select>
        <select bind:value={afRange} disabled={focusing}>
          <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option><option value={4000}>±2000</option>
        </select>
      </div>
      {#if afLog}<div class="muted mono" style="font-size:12px;margin-top:6px">{afLog}</div>{/if}
    </div>
    <div class="panel">
      <h3>Intelligence</h3>
      <div class="row">
        <button class:primary={detecting} onclick={toggleDetect} disabled={!device.connected}>{detecting ? 'Stop detection' : 'Detect objects'}</button>
        {#if follow.active}<button class="danger" onclick={() => follow.stop()}>Stop following</button>{/if}
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Click a detected box to follow it with the stage. Shift-drag a region to find similar images in the gallery.
        {#if !calibration.csm}<b>Following needs the camera-stage calibration.</b>{/if}</p>
      {#if searching}<div class="muted" style="font-size:12px">searching…</div>{/if}
      {#if hits.length}
        <div class="hits">
          {#each hits as h}
            <button class="hit" onclick={() => openHit(h)} title="{h.item.name} {h.blob}">
              {#if hitThumbs[`${h.item.id}/${h.blob}`]}<img src={hitThumbs[`${h.item.id}/${h.blob}`]} alt="" />{/if}
              <span class="mono">{(h.score * 100).toFixed(0)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <StagePad />
    <LightControl />
    <CameraControls />
    <div class="panel muted" style="font-size:12px">
      Mouse: click-hold-drag the image to pan the stage (like a map), click to centre a point, shift-drag to select a region.
      Keys: WASD / arrows move XY, PgUp/PgDn or Q/E move Z, hold for continuous jog.
      Gamepad: left stick XY, right stick or triggers Z, B stops.
    </div>
  </aside>
</div>
{#if viewing}<Viewer blob={viewing} onclose={() => (viewing = null)} />{/if}

<style>
  .live { display: grid; grid-template-columns: 1fr 320px; height: 100%; }
  .stream { position: relative; min-width: 0; }
  aside { display: flex; flex-direction: column; gap: 10px; padding: 10px; overflow: auto; border-left: 1px solid var(--border); }
  .hint { position: absolute; bottom: 12px; left: 12px; background: rgba(0,0,0,.6); padding: 6px 10px; border-radius: 6px; font-size: 12px; }
  .hint.err { color: var(--err); }
  .hits { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 8px; }
  .hit { position: relative; padding: 0; aspect-ratio: 1; overflow: hidden; background: #000; }
  .hit img { width: 100%; height: 100%; object-fit: cover; }
  .hit span { position: absolute; right: 2px; bottom: 2px; font-size: 10px; background: rgba(0,0,0,.6); padding: 0 3px; border-radius: 3px; }
  @media (max-width: 800px) { .live { grid-template-columns: 1fr; grid-template-rows: 55vh 1fr; } aside { border-left: 0; } }
</style>
