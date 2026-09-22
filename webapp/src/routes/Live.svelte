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
  import { liveStack } from '../lib/services/liveStack.svelte'
  import StagePad from '../components/StagePad.svelte'
  import FocusPanel from '../components/FocusPanel.svelte'
  import CameraControls from '../components/CameraControls.svelte'
  import PhotoPanel from '../components/PhotoPanel.svelte'
  import TimelapsePanel from '../components/TimelapsePanel.svelte'
  import TrackingPanel from '../components/TrackingPanel.svelte'
  import { tracking } from '../lib/services/tracking.svelte'
  import LightControl from '../components/LightControl.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { pixelsToStage } from '../lib/algo/csm'
  import { follow } from '../lib/services/followService.svelte'
  import type { Detection } from '../lib/services/aiService.svelte'
  import IntelligencePanel from '../components/IntelligencePanel.svelte'
  import Viewer from '../components/Viewer.svelte'
  import type { Box } from '../components/StreamView.svelte'
  import MeasurePanel from '../components/MeasurePanel.svelte'
  import { measure } from '../lib/services/measureService.svelte'
  import { umPerPxAt, currentScale } from '../lib/store/scaleCal.svelte'
  import SamplePanel from '../components/SamplePanel.svelte'
  import MacroPanel from '../components/MacroPanel.svelte'
  import LookPanel from '../components/LookPanel.svelte'
  import ToolRail from '../components/ToolRail.svelte'
  import LiveHud from '../components/LiveHud.svelte'
  import { ui } from '../lib/store/ui.svelte'
  import { focusCtl } from '../lib/store/focusCtl.svelte'

  // ---- measurement tool: M toggles, Escape leaves; clicks are intercepted by StreamView while active ----
  let measureImgW = 0
  function onMeasureClick(p: { x: number; y: number; w: number; h: number }) {
    measureImgW = p.w
    measure.addPoint({ x: p.x, y: p.y }, p.w, p.h, umPerPxAt(p.w))
  }
  function onMeasureDblClick() { measure.closePolygon(umPerPxAt(measureImgW)) }

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

  // ---- intelligence: detection boxes are owned by IntelligencePanel and bound up here so the stream
  // overlay (which also needs the global `follow` region) can combine them ----
  let intel: ReturnType<typeof IntelligencePanel>
  let detections = $state<Detection[]>([])
  // Rendered outside `.drawer` (see the Viewer usage below) so a search-hit overlay isn't hidden
  // along with the Intelligence panel when another drawer tool is active.
  let viewing = $state<Blob | null>(null)
  const viewerOpen = $derived(viewing != null)
  const boxes = $derived<Box[]>([
    ...detections.map((d) => ({ x: d.box.xmin, y: d.box.ymin, w: d.box.xmax - d.box.xmin, h: d.box.ymax - d.box.ymin, label: d.label, score: d.score, kind: 'detect' as const })),
    ...(follow.active && follow.region ? [{ ...follow.region, label: 'following', kind: 'follow' as const }] : []),
  ])
  const trackPaths = $derived(tracking.active && tracking.frameWidth
    ? tracking.tracks.filter((t) => t.points.length > 1).map((t) => ({ points: t.points.map((p) => ({ x: p.x / tracking.frameWidth, y: p.y / tracking.frameHeight })) }))
    : [])
  function followBox(b: Box) { follow.start({ x: b.x, y: b.y, w: b.w, h: b.h }) }
  async function onSelectRegion(r: { x: number; y: number; w: number; h: number }) { await intel?.search(r) }

  let lastClick = $state<string | null>(null)

  // Shared with LiveHud's D-pad/Z buttons, which jog through the same controller the keyboard uses.
  let jog = $state<JogController | null>(null)

  onMount(() => {
    const j = new JogController(
      (d) => device.jog(d),
      () => device.stop(),
      () => ({ xy: settings.stepXY, z: settings.stepZ }),
    )
    jog = j
    const offKeys = attachKeyboard(j, { invertY: () => settings.invertYKeys, enabled: () => device.connected })
    const offPad = attachGamepad(j, { stop: () => device.stop(), autofocus: () => focusCtl.run() }, () => settings.gamepad && device.connected)
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || viewerOpen) return   // Viewer.svelte owns M/Escape while open
      if (e.key === 'm' || e.key === 'M') measure.toggle()
      else if (e.key === 'Escape' && measure.active) measure.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => { offKeys(); offPad(); window.removeEventListener('keydown', onKey); j.dispose(); follow.stop(); liveStack.stop(); tracking.stop() }
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

<div class="live" class:immersive={ui.immersive}>
  <section class="stream">
    <StreamView {boxes} paths={trackPaths} {panOffset} onpan={onPan} onclickimage={onClickImage} onselectregion={onSelectRegion} onclickbox={followBox} picking={wb.picking}
      scaleInfo={settings.showScaleBar ? currentScale() : null} measuring={measure.active} measurePoints={measure.points} measureClosed={measure.mode === 'polygon'}
      onmeasureclick={onMeasureClick} onmeasuredblclick={onMeasureDblClick} />
    <!-- hints stack top-left so they never sit on the HUD corners -->
    <div class="hints">
      {#if wb.picking}<div class="hint mono">click a spot that should be neutral grey or white</div>{/if}
      {#if follow.active || follow.status}<div class="hint mono">{follow.status}{#if follow.active} <button onclick={() => follow.stop()}>stop</button>{/if}</div>{/if}
      {#if lastClick}<div class="hint mono">{lastClick}</div>{/if}
      {#if device.error}<div class="hint err">{device.error} <button onclick={() => (device.error = null)}>×</button></div>{/if}
    </div>
    {#if jog}<LiveHud {jog} />{/if}
  </section>
  <div class="drawer" hidden={!ui.open}>
    <div class="tool" hidden={ui.tool !== 'stage'}><StagePad /></div>
    <div class="tool" hidden={ui.tool !== 'focus'}><FocusPanel /></div>
    <div class="tool" hidden={ui.tool !== 'camera'}><CameraControls /><LightControl /></div>
    <div class="tool" hidden={ui.tool !== 'look'}><LookPanel /></div>
    <div class="tool" hidden={ui.tool !== 'photo'}><PhotoPanel /></div>
    <div class="tool" hidden={ui.tool !== 'measure'}><MeasurePanel /></div>
    <div class="tool" hidden={ui.tool !== 'timelapse'}><TimelapsePanel /></div>
    <div class="tool" hidden={ui.tool !== 'tracking'}><TrackingPanel /></div>
    <div class="tool" hidden={ui.tool !== 'ai'}><IntelligencePanel bind:this={intel} bind:detections bind:viewing /></div>
    <div class="tool" hidden={ui.tool !== 'sample'}><SamplePanel /></div>
    <div class="tool" hidden={ui.tool !== 'macro'}><MacroPanel /></div>
    <div class="tool" hidden={ui.tool !== 'help'}>
      <div class="panel">
        <details class="help">
          <summary>Mouse, keys and gamepad</summary>
          <p><b>Mouse</b>: click-hold-drag the image to pan the stage like a map · click to centre a point · <kbd>⇧</kbd>-drag to select a region for image search.</p>
          <p><b>Keys</b>: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows move XY · <kbd>Q</kbd>/<kbd>E</kbd> or <kbd>PgUp</kbd>/<kbd>PgDn</kbd> move Z · hold for continuous motion.</p>
          <p><b>Gamepad</b>: left stick XY · right stick or triggers Z · <kbd>B</kbd> stops.</p>
        </details>
      </div>
    </div>
  </div>
  <ToolRail />
  {#if viewing}<Viewer blob={viewing} onclose={() => (viewing = null)} />{/if}
</div>

<style>
  /* `auto` columns: a closed drawer (`display: none`) or immersive mode contributes no width, so the
     stream takes everything the rail and drawer don't. */
  .live { display: grid; grid-template-columns: 1fr auto auto; height: 100%; }
  .live.immersive { grid-template-columns: 1fr; }
  .live.immersive .drawer, .live.immersive :global(.tool-rail) { display: none; }
  .stream { position: relative; min-width: 0; }
  .drawer { display: flex; flex-direction: column; gap: 10px; padding: 10px; overflow: auto; border-left: 1px solid var(--border); width: 340px; }
  .drawer[hidden] { display: none; }
  .tool[hidden] { display: none; }
  .hints { position: absolute; top: 12px; left: 12px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; pointer-events: none; }
  .hint { background: rgba(0,0,0,.6); padding: 6px 10px; border-radius: 6px; font-size: 12px; pointer-events: auto; }
  .hint.err { color: var(--err); }
  @media (max-width: 720px) {
    /* the stream sizes to the (4:3, whatever stream_size is picked in Settings) frame itself
       instead of a viewport fraction, so there's no dead letterbox space above/below it; capped
       so a future portrait sensor can't push the controls off-screen */
    .live { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; }
    .stream { width: 100%; aspect-ratio: 4 / 3; max-height: 60vh; }
    .drawer { border-left: 0; width: auto; padding-bottom: calc(10px + var(--tabbar-h, 0px)); order: 3; }
    :global(.tool-rail) { order: 2; }
  }
</style>
