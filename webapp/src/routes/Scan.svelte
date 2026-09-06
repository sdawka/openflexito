<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { planScan, relativeMoves, type TilePlan } from '../lib/algo/scanPlan'
  import type { Mat2 } from '../lib/algo/csm'
  import { waitForFrames } from '../lib/api/sampler'
  import { runAutofocus } from '../lib/services/autofocusService'
  import { stitchInWorker } from '../lib/services/stitchService'
  import { newId, putBlob, putItem, makeThumb, type GalleryItem } from '../lib/store/gallery'

  let cols = $state(3), rows = $state(3), overlap = $state(0.3)
  let autofocusEach = $state(false), afRange = $state(600), settleMs = $state(150), fullRes = $state(false), refine = $state(true)
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

  async function snapshotBlob(): Promise<Blob> {
    const res = await fetch(device.url('/snapshot.jpg') + (fullRes ? '?full=1&' : '?') + 't=' + Date.now(), { cache: 'no-store' })
    if (!res.ok) throw new Error(`snapshot failed ${res.status}`)
    return res.blob()
  }

  async function run() {
    if (!csm) return
    running = true; cancel = false; preview = null; lastItem = null
    const [fw, fh] = fov
    const tiles: TilePlan[] = planScan({ cols, rows, overlap }, fw, fh, matrixFor(fw), 'snake')
    const moves = relativeMoves(tiles)
    total = tiles.length; done = 0
    const id = newId()
    const origin = { ...device.position }
    const item: GalleryItem = {
      id, kind: 'scan', name: `Scan ${cols}×${rows} ${new Date().toLocaleString()}`, when: new Date().toISOString(),
      position: origin, controls: device.controls ?? undefined, blobs: [],
      scan: { cols, rows, overlap, tiles: [] },
    }
    const blobs: { blob: Blob; x: number; y: number; width: number; height: number }[] = []
    try {
      for (let i = 0; i < tiles.length && !cancel; i++) {
        const tag = `tile ${i + 1}/${tiles.length}`
        progress = `${tag}: moving`
        await device.moveRel(moves[i], true)
        progress = `${tag}: settling`
        await new Promise((r) => setTimeout(r, settleMs))
        if (autofocusEach) {
          progress = `${tag}: autofocus`
          try { await runAutofocus({ mode: 'fast', dz: afRange, metric: 'jpeg' }) } catch (e) { progress = `autofocus failed: ${(e as Error).message}` }
        }
        progress = `${tag}: waiting for a fresh frame`
        await waitForFrames(2)
        progress = `${tag}: capturing`
        const blob = await snapshotBlob()
        progress = `${tag}: storing`
        const key = `tile/${tiles[i].index}`
        await putBlob(id, key, blob)
        item.blobs.push(key)
        item.scan!.tiles.push({ ...tiles[i], x: tiles[i].pixel.x, y: tiles[i].pixel.y, width: fw, height: fh, blob: key })
        blobs.push({ blob, x: tiles[i].pixel.x, y: tiles[i].pixel.y, width: fw, height: fh })
        done = i + 1
      }
      progress = 'returning to start'
      await device.moveTo(origin, true)
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
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={autofocusEach} /> autofocus each tile</label>
      <select bind:value={afRange} disabled={!autofocusEach}><option value={300}>±150</option><option value={600}>±300</option><option value={1200}>±600</option></select>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={fullRes} /> full-resolution tiles (slower)</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={refine} /> refine positions by correlation</label>
    </div>
    <div class="row" style="margin-top:10px">
      {#if running}
        <button class="danger" onclick={() => { cancel = true; device.stop() }}>Cancel</button>
      {:else}
        <button class="primary" onclick={run} disabled={!csm || !device.connected}>Start scan</button>
      {/if}
      <span class="muted mono" style="font-size:12px">{cols * rows} tiles of {fov[0]}×{fov[1]} px · {progress}</span>
    </div>
    {#if running}<progress max={total} value={done} style="width:100%;margin-top:8px"></progress>{/if}
  </div>
  {#if preview}
    <div class="panel">
      <h3>Result</h3>
      <img src={preview} alt="stitched scan" style="max-width:100%;border-radius:6px" />
      <p class="muted" style="font-size:12px">Saved to the gallery as "{lastItem?.name}". Open it there to zoom.</p>
    </div>
  {/if}
</div>

<style>
  .wrap { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 1000px; }
</style>
