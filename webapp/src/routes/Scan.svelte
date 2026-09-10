<script lang="ts">
  import { fetchSnapshot } from '../lib/api/snapshot'
  import { device } from '../lib/store/device.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { planScan, filterByPolygon, spiralOrder, type TilePlan, type Point } from '../lib/algo/scanPlan'
  import type { Mat2 } from '../lib/algo/csm'
  import { waitForFrames } from '../lib/api/sampler'
  import { runAutofocus } from '../lib/services/autofocusService'
  import { stitchInWorker } from '../lib/services/stitchService'
  import { predictHeightMap, rejectOutliers, isSubGridCell, type HeightSample } from '../lib/algo/heightMap'
  import { newId, putBlob, putItem, makeThumb, type GalleryItem } from '../lib/store/gallery'
  import PolygonOverview from '../components/PolygonOverview.svelte'

  let cols = $state(3), rows = $state(3), overlap = $state(0.3)
  let afRange = $state(600), settleMs = $state(150), fullRes = $state(false), refine = $state(true)
  let focusMode = $state<'none' | 'every' | 'interpolate'>('none')
  let afStep = $state(3)   // interpolate mode: autofocus every Nth tile (plus the grid corners)
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
   *  each tile that gets one (all of them in 'every' mode, just the coarse sub-grid in 'interpolate'). */
  const AF_TIME_S = 3.5
  const timeEstimateS = $derived.by(() => {
    const n = plannedTiles.length
    if (!n) return 0
    const captureS = fullRes ? 1.4 : 0.4
    const perTile = settleMs / 1000 + captureS + 0.3
    const afCount = focusMode === 'every' ? n : focusMode === 'interpolate' ? subgridCount : 0
    return n * perTile + afCount * AF_TIME_S
  })
  const fmtTime = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`)

  const overviewSrc = $derived(preview ?? device.url('/stream.mjpg'))

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
      },
    }
    const blobs: { blob: Blob; x: number; y: number; width: number; height: number }[] = []
    const heightSamples: HeightSample[] = []

    /** Move to the tile, settle, optionally run something (autofocus, or a move to a predicted z)
     *  that returns the z to record, then capture and store. */
    async function captureTile(t: TilePlan, afterSettle?: () => Promise<{ z?: number; zMeasured?: boolean }>) {
      const tag = `tile ${done + 1}/${total}`
      progress = `${tag}: moving`
      await device.moveTo({ x: origin.x + t.stage.x, y: origin.y + t.stage.y }, 'xy')   // v3 scans use XY_ONLY backlash compensation
      progress = `${tag}: settling`
      await new Promise((r) => setTimeout(r, settleMs))
      let z: number | undefined, zMeasured: boolean | undefined
      if (afterSettle) {
        progress = `${tag}: focusing`
        const r = await afterSettle()
        z = r.z; zMeasured = r.zMeasured
      }
      progress = `${tag}: waiting for a fresh frame`
      await waitForFrames(2)
      progress = `${tag}: capturing`
      const blob = await snapshotBlob()
      progress = `${tag}: storing`
      const key = `tile/${t.index}`
      await putBlob(id, key, blob)
      item.blobs.push(key)
      item.scan!.tiles.push({ ...t, x: t.pixel.x, y: t.pixel.y, width: fw, height: fh, blob: key, z, zMeasured })
      blobs.push({ blob, x: t.pixel.x, y: t.pixel.y, width: fw, height: fh })
      done++
    }
    const autofocusHere = async (): Promise<{ z?: number; zMeasured?: boolean }> => {
      try {
        const r = await runAutofocus({ mode: 'fast', dz: afRange, metric: 'jpeg' })
        return { z: r.peakZ, zMeasured: true }
      } catch (e) {
        progress = `autofocus failed: ${(e as Error).message}`
        return {}
      }
    }

    try {
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
          if (grid) {
            await captureTile(t, async () => {
              const zTarget = Math.round(grid[t.row][t.col])
              await device.moveRel({ z: zTarget - device.position.z }, 'z')   // v3: Z_ONLY backlash correction for the final approach
              return { z: zTarget, zMeasured: false }
            })
          } else {
            await captureTile(t)
          }
        }
      } else {
        for (const t of tiles) {
          if (cancel) break
          await captureTile(t, focusMode === 'every' ? autofocusHere : undefined)
        }
      }
      if (cancel || !blobs.length) { progress = 'cancelled'; return }
      progress = 'stitching…'
      const res = await stitchInWorker({ tiles: blobs, maxDim: 8192, analysisWidth: 256, refine }, (m) => (progress = m))
      item.scan!.positions = res.positions
      item.width = res.width; item.height = res.height
      await putBlob(id, 'image', res.mosaic); item.blobs.push('image')
      await putBlob(id, 'thumb', await makeThumb(res.mosaic)); item.blobs.push('thumb')
      await putItem(item)
      preview = URL.createObjectURL(res.mosaic)
      lastItem = item
      progress = `done: ${res.width}×${res.height} px mosaic (${res.pairs} overlaps refined, scale ${res.scale.toFixed(2)}), saved to gallery`
    } catch (e) {
      progress = `error: ${(e as Error).message}`
    } finally {
      // also on error: the stage must not stay wherever the scan died (z is left where autofocus put it)
      const msg = progress
      progress = 'returning to start'
      try { await device.moveTo(origin, 'xy'); progress = msg } catch (e) { progress = `${msg} · could not return to the start: ${(e as Error).message}` }
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
      <div><div class="label">settle</div><input type="number" min="0" max="2000" step="50" style="width:80px" bind:value={settleMs} /> ms</div>
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
      {/if}
      <select bind:value={afRange} disabled={focusMode === 'none'}><option value={300}>±150</option><option value={600}>±300</option><option value={1200}>±600</option></select>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={fullRes} /> full-resolution tiles (slower)</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={refine} /> refine positions by correlation</label>
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
        {#if focusMode === 'interpolate'}· {subgridCount} autofocused, rest interpolated{/if}
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
