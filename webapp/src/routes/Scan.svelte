<script lang="ts">
  /** Tile scan: plan a grid (rectangle or polygon region, raster/snake/spiral order), lock AE/AWB for
   *  the whole run, visit every tile with an adaptive settle (∝ move length, min the configured value)
   *  and a stage-still check, focus it (none / autofocus every tile / coarse autofocus grid + height map
   *  with an optional short local sweep around the predicted z), capture a stream frame or full-res
   *  still, then stitch in a worker (robust position solve, gain equalisation, optional flat field and
   *  multi-band blend). Per-tile focus status is recorded in the gallery item; autofocus failures are
   *  counted and shown, never swallowed. The stage returns to the start position (x, y and z). */
  import { fetchSnapshot } from '../lib/api/snapshot'
  import { device } from '../lib/store/device.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { planScan, filterByPolygon, spiralOrder, settleForMove, type TilePlan, type Point } from '../lib/algo/scanPlan'
  import type { Mat2 } from '../lib/algo/csm'
  import { waitForFrames, grabGray } from '../lib/api/sampler'
  import { runAutofocus } from '../lib/services/autofocusService'
  import { stepAutofocus } from '../lib/algo/autofocus'
  import { laplacianVariance } from '../lib/algo/sharpness'
  import { lockCamera, type CameraLock } from '../lib/services/cameraLock'
  import { stitchInWorker } from '../lib/services/stitchService'
  import { predictHeightMap, rejectOutliers, isSubGridCell, type HeightSample } from '../lib/algo/heightMap'
  import { newId, putBlob, putItem, makeThumb, type GalleryItem } from '../lib/store/gallery'
  import PolygonOverview from '../components/PolygonOverview.svelte'

  type TileFocus = NonNullable<NonNullable<GalleryItem['scan']>['tiles'][number]['focus']>

  let cols = $state(3), rows = $state(3), overlap = $state(0.3)
  // full-resolution stills are the default tile source whenever the CSM calibration exists (4× the pixels of a stream frame)
  let afRange = $state(600), settleMs = $state(150), fullRes = $state(!!calibration.csm), refine = $state(true)
  let focusMode = $state<'none' | 'every' | 'interpolate'>('none')
  let afStep = $state(3)   // interpolate mode: autofocus every Nth tile (plus the grid corners)
  let localRefine = $state(true), localRange = $state(40)   // interpolate mode: short Laplacian sweep ±localRange steps around the predicted z
  let gainEq = $state(true), multiband = $state(false), useFlat = $state(true)
  let regionMode = $state<'rect' | 'polygon'>('rect')
  let orderMode = $state<'raster' | 'snake' | 'spiral'>('snake')
  let polygon = $state<Point[]>([])
  let running = $state(false), cancel = false
  let progress = $state(''), done = $state(0), total = $state(0)
  let preview = $state<string | null>(null)
  let lastItem = $state<GalleryItem | null>(null)

  const streamSize = $derived(device.status?.camera?.stream_size ?? [1640, 1232])
  const fov = $derived(fullRes ? [3280, 2464] : streamSize)
  const csm = $derived(calibration.csm)
  const flat = $derived(calibration.flat)

  /** Calibration matrix expressed for the tile pixel size (it was measured on a downsampled frame). */
  function matrixFor(width: number): Mat2 {
    const k = csm!.imageWidth / width
    const m = csm!.matrix
    return [[m[0][0] * k, m[0][1] * k], [m[1][0] * k, m[1][1] * k]]
  }

  const snapshotBlob = () => fetchSnapshot({ full: fullRes })

  /** Full planned tile list: grid -> optional polygon clip -> visiting order (spiral reorders; snake
   *  is baked into the raster generation; raster is the base). */
  const plannedTiles = $derived.by((): TilePlan[] => {
    if (!csm) return []
    const [fw, fh] = fov
    let tiles = planScan({ cols, rows, overlap }, fw, fh, matrixFor(fw), orderMode === 'raster' || orderMode === 'spiral' ? 'raster' : 'snake')
    if (regionMode === 'polygon' && polygon.length >= 3) tiles = filterByPolygon(tiles, polygon, fw, fh)
    if (orderMode === 'spiral') tiles = spiralOrder(tiles)
    return tiles
  })

  const subgridStep = $derived(Math.max(1, afStep))
  const subgridCount = $derived(
    focusMode === 'interpolate' ? plannedTiles.filter((t) => isSubGridCell(t.col, t.row, cols, rows, subgridStep)).length : 0,
  )
  /** Rough, live-updating estimate: capture + settle for every tile, plus one autofocus sweep for
   *  each tile that gets one (all of them in 'every' mode, just the coarse sub-grid in 'interpolate'),
   *  plus the short local sweep (5 snapshots) for the interpolated tiles when enabled. */
  const AF_TIME_S = 3.5, LOCAL_AF_TIME_S = 2.5
  const timeEstimateS = $derived.by(() => {
    const n = plannedTiles.length
    if (!n) return 0
    const captureS = fullRes ? 1.4 : 0.4
    const perTile = settleMs / 1000 + captureS + 0.3
    const afCount = focusMode === 'every' ? n : focusMode === 'interpolate' ? subgridCount : 0
    const localCount = focusMode === 'interpolate' && localRefine ? n - subgridCount : 0
    return n * perTile + afCount * AF_TIME_S + localCount * LOCAL_AF_TIME_S
  })
  const fmtTime = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`)

  const overviewSrc = $derived(preview ?? device.url('/stream.mjpg'))

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** Wait until the stage reports it is not moving (position events), with a timeout. */
  async function waitStageStill(timeoutMs = 5000): Promise<void> {
    const t0 = performance.now()
    while (device.moving && performance.now() - t0 < timeoutMs) await sleep(40)
    if (device.moving) {
      // the event stream may have missed the final position event: ask the device directly
      try { const s = await device.stageStatus(); if (!s.moving) return } catch { /* fall through */ }
      throw new Error('stage still moving after the settle time')
    }
  }

  async function run() {
    if (!csm) return
    running = true; cancel = false; preview = null; lastItem = null
    const [fw, fh] = fov
    const tiles = plannedTiles
    total = tiles.length; done = 0
    const id = newId()
    const origin = { ...device.position }
    const item: GalleryItem = {
      id, kind: 'scan', name: `Scan ${cols}×${rows} ${new Date().toLocaleString()}`, when: new Date().toISOString(),
      position: origin, controls: device.controls ?? undefined, blobs: [],
      scan: {
        cols, rows, overlap, tiles: [],
        focus: { mode: focusMode, step: focusMode === 'interpolate' ? subgridStep : undefined, method: focusMode === 'interpolate' ? 'bilinear' : undefined },
        region: { mode: regionMode, order: orderMode },
        focusFailures: 0,
      },
    }
    const blobs: { blob: Blob; x: number; y: number; width: number; height: number }[] = []
    const heightSamples: HeightSample[] = []
    let lock: CameraLock | null = null

    /** Move to the tile, settle (∝ move length), make sure the stage is still, optionally run
     *  something (autofocus, or a move to a predicted z plus a local sweep) that returns the z to
     *  record and how it was found, then capture and store. */
    async function captureTile(t: TilePlan, afterSettle?: () => Promise<{ z?: number; zMeasured?: boolean; focus: TileFocus }>) {
      const tag = `tile ${done + 1}/${total}`
      progress = `${tag}: moving`
      const target = { x: origin.x + t.stage.x, y: origin.y + t.stage.y }
      const dist = Math.hypot(target.x - device.position.x, target.y - device.position.y)
      await device.moveTo(target, 'xy')   // v3 scans use XY_ONLY backlash compensation
      const settle = settleForMove(dist, settleMs)
      progress = `${tag}: settling ${settle} ms`
      await sleep(settle)
      await waitStageStill()
      let z: number | undefined, zMeasured: boolean | undefined, focus: TileFocus = { status: 'none' }
      if (afterSettle) {
        progress = `${tag}: focusing`
        const r = await afterSettle()
        z = r.z; zMeasured = r.zMeasured; focus = r.focus
        if (focus.status === 'failed') { item.scan!.focusFailures = (item.scan!.focusFailures ?? 0) + 1; progress = `${tag}: autofocus failed (${focus.error}), capturing anyway` }
        await waitStageStill()
      }
      progress = `${tag}: waiting for a fresh frame`
      await waitForFrames(2)
      progress = `${tag}: capturing`
      const blob = await snapshotBlob()
      progress = `${tag}: storing`
      const key = `tile/${t.index}`
      await putBlob(id, key, blob)
      item.blobs.push(key)
      item.scan!.tiles.push({ ...t, x: t.pixel.x, y: t.pixel.y, width: fw, height: fh, blob: key, z: z ?? device.position.z, zMeasured, focus, settleMs: settle })
      blobs.push({ blob, x: t.pixel.x, y: t.pixel.y, width: fw, height: fh })
      done++
    }
    const autofocusHere = async (): Promise<{ z?: number; zMeasured?: boolean; focus: TileFocus }> => {
      try {
        const r = await runAutofocus({ mode: 'fast', dz: afRange, metric: 'jpeg' })
        return { z: r.peakZ, zMeasured: true, focus: { status: 'measured' } }
      } catch (e) {
        return { focus: { status: 'failed', error: (e as Error).message } }
      }
    }
    /** Height-map focus: move to the predicted z (Z_ONLY backlash correction, as v3's final approach),
     *  then optionally a 5-point Laplacian sweep over ±localRange steps to catch what the plane/bilinear
     *  model missed (tilt within the cell, a thick specimen). */
    const predictedFocus = (zTarget: number) => async (): Promise<{ z?: number; zMeasured?: boolean; focus: TileFocus }> => {
      await device.moveRel({ z: zTarget - device.position.z }, 'z')
      if (!localRefine || localRange <= 0) return { z: zTarget, zMeasured: false, focus: { status: 'predicted' } }
      try {
        await waitStageStill()
        const r = await stepAutofocus({
          moveZ: (dz) => device.moveRel({ z: dz }, false),
          currentZ: () => device.position.z,
          measure: async () => laplacianVariance(await grabGray(410, 60)),
        }, 2 * localRange, 5)
        return { z: r.peakZ, zMeasured: true, focus: { status: 'refined' } }
      } catch (e) {
        return { z: zTarget, zMeasured: false, focus: { status: 'failed', error: `local refine: ${(e as Error).message}` } }
      }
    }

    try {
      progress = 'locking exposure and white balance'
      try { lock = await lockCamera(); item.scan!.locked = lock.locked } catch (e) { progress = `could not lock the camera: ${(e as Error).message}` }
      if (focusMode === 'interpolate') {
        const subgrid = tiles.filter((t) => isSubGridCell(t.col, t.row, cols, rows, subgridStep))
        const rest = tiles.filter((t) => !isSubGridCell(t.col, t.row, cols, rows, subgridStep))
        for (const t of subgrid) {
          if (cancel) break
          await captureTile(t, async () => {
            const r = await autofocusHere()
            if (r.z !== undefined) heightSamples.push({ col: t.col, row: t.row, z: r.z })
            return r
          })
        }
        const grid = !cancel && heightSamples.length >= 3 ? predictHeightMap(cols, rows, rejectOutliers(heightSamples), 'bilinear', subgridStep) : null
        for (const t of rest) {
          if (cancel) break
          if (grid) await captureTile(t, predictedFocus(Math.round(grid[t.row][t.col])))
          else await captureTile(t, async () => ({ focus: { status: 'failed', error: 'height map needs at least 3 focused tiles' } }))
        }
      } else {
        for (const t of tiles) {
          if (cancel) break
          await captureTile(t, focusMode === 'every' ? autofocusHere : undefined)
        }
      }
      if (cancel || !blobs.length) { progress = 'cancelled'; return }
      progress = 'stitching…'
      const analysisWidth = fullRes ? 512 : 256
      const flatMap = useFlat && flat ? $state.snapshot(flat) : null
      const res = await stitchInWorker({
        tiles: blobs, maxDim: 8192, analysisWidth, refine, robust: true, gainEqualise: gainEq, multiband: multiband ? 3 : 0,
        flatField: flatMap ? { width: flatMap.width, height: flatMap.height, channels: flatMap.channels, data: flatMap.data } : null,
      }, (m) => (progress = m))
      item.scan!.positions = res.positions
      item.scan!.stitch = { pairs: res.pairs, dropped: res.dropped, gains: res.gains.map((g) => Math.round(g * 1000) / 1000), blend: res.blend, flatField: res.flatField, analysisWidth }
      item.width = res.width; item.height = res.height
      await putBlob(id, 'image', res.mosaic); item.blobs.push('image')
      await putBlob(id, 'thumb', await makeThumb(res.mosaic)); item.blobs.push('thumb')
      await putItem(item)
      preview = URL.createObjectURL(res.mosaic)
      lastItem = item
      const fails = item.scan!.focusFailures ?? 0
      progress = `done: ${res.width}×${res.height} px mosaic (${res.pairs} overlaps refined${res.dropped ? `, ${res.dropped} rejected` : ''}, ${res.blend} blend, scale ${res.scale.toFixed(2)})${fails ? ` · ${fails} tile(s) with failed autofocus` : ''}, saved to gallery`
    } catch (e) {
      progress = `error: ${(e as Error).message}`
    } finally {
      // also on error: the stage must not stay wherever the scan died, and z goes back too (autofocus
      // and the height map leave it elsewhere); the camera lock is released whatever happened
      const msg = progress
      progress = 'returning to start'
      try { await device.moveTo(origin, 'all'); progress = msg } catch (e) { progress = `${msg} · could not return to the start: ${(e as Error).message}` }
      await lock?.release((m) => (progress = `${progress} · ${m}`))
      running = false
    }
  }
</script>

<div class="wrap">
  <div class="panel">
    <h3>Tile scan</h3>
    {#if !csm}
      <p class="muted">Run "Calibrate XY" on the Calibrate page first: the scan needs the camera-to-stage mapping to know how far to move between tiles.</p>
    {/if}
    <div class="row">
      <div><div class="label">columns</div><input type="number" min="1" max="20" style="width:70px" bind:value={cols} /></div>
      <div><div class="label">rows</div><input type="number" min="1" max="20" style="width:70px" bind:value={rows} /></div>
      <div><div class="label">overlap</div>
        <select bind:value={overlap}><option value={0.2}>20 %</option><option value={0.3}>30 %</option><option value={0.4}>40 %</option><option value={0.5}>50 %</option></select></div>
      <div><div class="label">settle (min)</div><input type="number" min="0" max="2000" step="50" style="width:80px" bind:value={settleMs} title="minimum settle after each move; longer moves settle longer (0.05 ms per step, up to 1.5 s)" /> ms</div>
    </div>
    <div class="row" style="margin-top:8px">
      <div><div class="label">focus</div>
        <select bind:value={focusMode}>
          <option value="none">none</option>
          <option value="every">every tile</option>
          <option value="interpolate">every Nth tile, interpolated</option>
        </select>
      </div>
      {#if focusMode === 'interpolate'}
        <div><div class="label">N</div><input type="number" min="1" max="10" style="width:60px" bind:value={afStep} /></div>
        <label style="display:flex;gap:6px;align-items:center;margin:0" title="after moving to the height-map z, a 5-point Laplacian sweep over this range picks the sharpest z">
          <input type="checkbox" bind:checked={localRefine} /> local refine ±<input type="number" min="5" max="500" step="5" style="width:60px" bind:value={localRange} disabled={!localRefine} /> steps
        </label>
      {/if}
      <select bind:value={afRange} disabled={focusMode === 'none'}><option value={300}>±150</option><option value={600}>±300</option><option value={1200}>±600</option></select>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={fullRes} /> full-resolution tiles (slower)</label>
    </div>
    <div class="row" style="margin-top:8px">
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={refine} /> refine positions by correlation</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0" title="solve per-tile brightness gains from the overlaps so exposure differences do not show as seams"><input type="checkbox" bind:checked={gainEq} /> equalise tile brightness</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0" title="3-level Laplacian blend: smoother large-scale transitions, sharp detail; limits the mosaic to 4096 px"><input type="checkbox" bind:checked={multiband} /> multi-band blend</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0" title={flat ? `divide tiles by the blank-field map captured ${flat.when}` : 'no flat-field map captured yet'}><input type="checkbox" bind:checked={useFlat} disabled={!flat} /> flat-field correction</label>
    </div>
    <div class="row" style="margin-top:8px">
      <div><div class="label">region</div>
        <select bind:value={regionMode}><option value="rect">rectangle</option><option value="polygon">polygon</option></select>
      </div>
      <div><div class="label">order</div>
        <select bind:value={orderMode}>
          <option value="snake">snake</option>
          <option value="raster">raster</option>
          <option value="spiral">spiral (centre outward)</option>
        </select>
      </div>
      <span class="muted mono" style="font-size:12px">
        {plannedTiles.length} tiles of {fov[0]}×{fov[1]} px · est. {fmtTime(timeEstimateS)}
        {#if focusMode === 'interpolate'}· {subgridCount} autofocused, rest interpolated{localRefine ? ' + refined' : ''}{/if}
      </span>
    </div>
    {#if regionMode === 'polygon'}
      <div style="margin-top:10px">
        <p class="muted" style="font-size:12px;margin:0 0 6px">
          Click points on the overview below to draw the region (the stitched preview of a previous scan, or the live view if none yet). Tile centres inside the polygon are kept.
        </p>
        <PolygonOverview src={overviewSrc} points={polygon} onchange={(p) => (polygon = p)} />
      </div>
    {/if}
    <div class="row" style="margin-top:10px">
      {#if running}
        <button class="danger" onclick={() => { cancel = true; device.stop() }}>Cancel</button>
      {:else}
        <button class="primary" onclick={run} disabled={!csm || !device.connected || !plannedTiles.length}>Start scan</button>
      {/if}
      <span class="muted mono" style="font-size:12px">{progress}</span>
    </div>
    {#if running}<progress max={total} value={done} style="width:100%;margin-top:8px"></progress>{/if}
  </div>
  {#if preview}
    <div class="panel">
      <h3>Result</h3>
      <img src={preview} alt="stitched scan" style="max-width:100%;border-radius:6px" />
      <p class="muted" style="font-size:12px">Saved to the gallery as "{lastItem?.name}". Open it there to zoom{#if lastItem?.scan?.focus?.mode !== 'none'} or see the height map{/if}.</p>
    </div>
  {/if}
</div>

<style>
  .wrap { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 1000px; }
</style>
