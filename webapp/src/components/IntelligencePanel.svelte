<script lang="ts">
  import { onDestroy } from 'svelte'
  import { fetchSnapshot, fetchSnapshotBitmap } from '../lib/api/snapshot'
  import { device } from '../lib/store/device.svelte'
  import { settings } from '../lib/store/settings.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { ai, type Detection } from '../lib/services/aiService.svelte'
  import { follow } from '../lib/services/followService.svelte'
  import { searchByImage, type SearchHit } from '../lib/services/searchService'
  import { getBlob } from '../lib/store/gallery'

  // `detections` is the one piece of state Live.svelte's boxes overlay needs; it is a $bindable
  // rather than a service (aiService.svelte.ts stays a stateless worker wrapper). `viewing` is the
  // blob for a search-hit Viewer overlay: it is bound up to Live.svelte too and rendered there
  // (outside `.drawer`), because this panel itself sits inside a `div.tool[hidden]` when another
  // tool is open and a hidden ancestor would hide the full-screen Viewer along with it.
  let { detections = $bindable([]), viewing = $bindable<Blob | null>(null) }: { detections?: Detection[]; viewing?: Blob | null } = $props()

  let detecting = $state(false)
  let detectTimer: ReturnType<typeof setTimeout> | undefined
  let hits = $state<SearchHit[]>([])
  let hitThumbs = $state<Record<string, string>>({})
  let searching = $state(false)
  let note = $state('')

  async function detectLoop() {
    if (!detecting) return
    try {
      const bmp = await fetchSnapshotBitmap()
      detections = await ai.detect(bmp, settings.detectThreshold)
    } catch (e) { note = `detection: ${(e as Error).message}` }
    if (detecting) detectTimer = setTimeout(detectLoop, settings.detectIntervalMs)
  }
  function toggleDetect() {
    detecting = !detecting
    clearTimeout(detectTimer)
    if (detecting) detectLoop(); else detections = []
  }

  /** Shift-drag region search, called from Live.svelte's StreamView `onselectregion` via `bind:this`. */
  export async function search(r: { x: number; y: number; w: number; h: number }): Promise<void> {
    searching = true
    try {
      hits = await searchByImage(await fetchSnapshot(), r, 8)
      for (const h of hits) {
        const key = `${h.item.id}/${h.blob}`
        if (!hitThumbs[key]) {
          const b = await getBlob(h.item.id, h.blob === 'image' && h.item.blobs.includes('thumb') ? 'thumb' : h.blob)
          if (b) hitThumbs = { ...hitThumbs, [key]: URL.createObjectURL(b) }
        }
      }
      if (!hits.length) note = 'no indexed images in the gallery yet (Gallery → Index)'
    } catch (e) { note = `search: ${(e as Error).message}` } finally { searching = false }
  }
  async function openHit(h: SearchHit) { const b = await getBlob(h.item.id, h.blob); if (b) viewing = b }

  onDestroy(() => { detecting = false; clearTimeout(detectTimer); follow.stop() })
</script>

<div class="panel">
  <h3>Intelligence</h3>
  <div class="row">
    <button class:primary={detecting} onclick={toggleDetect} disabled={!device.connected}>{detecting ? 'Stop detection' : 'Detect objects'}</button>
    {#if follow.active}<button class="danger" onclick={() => follow.stop()}>Stop following</button>{/if}
  </div>
  <details class="help">
    <summary>How to use</summary>
    <p>Click a detected box to follow it with the stage. <kbd>⇧</kbd>-drag a region to find similar images in the gallery.
    {#if !calibration.csm}<b>Following needs the stage ↔ camera calibration.</b>{/if}</p>
  </details>
  {#if note}<div class="muted mono" style="font-size:12px">{note}</div>{/if}
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

<style>
  .hits { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 8px; }
  .hit { position: relative; padding: 0; aspect-ratio: 1; overflow: hidden; background: #000; }
  .hit img { width: 100%; height: 100%; object-fit: cover; }
  .hit span { position: absolute; right: 2px; bottom: 2px; font-size: 10px; background: rgba(0,0,0,.6); padding: 0 3px; border-radius: 3px; }
</style>
