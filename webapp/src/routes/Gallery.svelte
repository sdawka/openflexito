<script lang="ts">
  import { onMount } from 'svelte'
  import { listItems, getBlob, deleteItem, exportItem, type GalleryItem } from '../lib/store/gallery'
  import Viewer from '../components/Viewer.svelte'
  import { indexGallery, searchByText, type SearchHit } from '../lib/services/searchService'
  import { ai } from '../lib/services/aiService.svelte'

  let query = $state('')
  let hits = $state<SearchHit[] | null>(null)
  let indexing = $state('')
  async function search() {
    if (!query.trim()) { hits = null; return }
    busy = true
    try { hits = await searchByText(query.trim(), 24) } catch (e) { indexing = (e as Error).message } finally { busy = false }
  }
  async function index() {
    busy = true
    try { await indexGallery((m) => (indexing = m)) } catch (e) { indexing = (e as Error).message } finally { busy = false }
  }
  async function openHit(h: SearchHit) { const blob = await getBlob(h.item.id, h.blob); if (blob) viewing = { blob, item: h.item } }

  let items = $state<GalleryItem[]>([])
  let thumbs = $state<Record<string, string>>({})
  let viewing = $state<{ blob: Blob | null; item: GalleryItem } | null>(null)
  let busy = $state(false)

  async function refresh() {
    items = await listItems()
    for (const it of items) if (!thumbs[it.id] && it.blobs.includes('thumb')) {
      const b = await getBlob(it.id, 'thumb'); if (b) thumbs = { ...thumbs, [it.id]: URL.createObjectURL(b) }
    }
  }
  onMount(() => { refresh(); return () => Object.values(thumbs).forEach((u) => URL.revokeObjectURL(u)) })

  async function open(it: GalleryItem) {
    if (it.kind === 'timelapse') { viewing = { blob: null, item: it }; return }
    const blob = await getBlob(it.id, it.kind === 'video' ? 'video' : 'image')
    if (blob) viewing = { blob, item: it }
  }
  async function remove(it: GalleryItem) {
    if (!confirm(`Delete "${it.name}"?`)) return
    await deleteItem(it); await refresh()
  }
  async function doExport(it: GalleryItem) { busy = true; try { await exportItem(it) } finally { busy = false } }
  const fmtWhen = (iso: string) => {
    const d = new Date(iso), today = new Date().toDateString() === d.toDateString()
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
</script>

<div class="wrap">
  <div class="panel" style="margin-bottom:12px">
    <div class="row">
      <input style="flex:1" placeholder="describe what to find, e.g. 'round dark cell with a nucleus'" bind:value={query} onkeydown={(e) => e.key === 'Enter' && search()} />
      <button class="primary" onclick={search} disabled={busy}>Search</button>
      <button onclick={index} disabled={busy} title="compute CLIP embeddings for every image and scan tile">Index gallery</button>
      {#if hits}<button onclick={() => { hits = null; query = '' }}>Clear</button>{/if}
    </div>
    {#if indexing || ai.status}<div class="muted mono" style="font-size:12px;margin-top:6px">{ai.status || indexing}</div>{/if}
  </div>
  {#if hits}
    <div class="grid" style="margin-bottom:12px">
      {#each hits as h}
        <div class="card">
          <button class="thumb" onclick={() => openHit(h)}>
            {#if thumbs[h.item.id]}<img src={thumbs[h.item.id]} alt="" />{/if}
          </button>
          <div class="meta"><b>{h.item.name}</b><div class="muted mono" style="font-size:11px">{h.blob} · similarity {(h.score * 100).toFixed(1)}</div></div>
        </div>
      {/each}
      {#if !hits.length}<div class="muted">No matches. Index the gallery first.</div>{/if}
    </div>
  {/if}
  {#if !items.length}
    <div class="panel muted">No items yet. Take a photo from the Live page or run a scan.</div>
  {/if}
  <div class="grid">
    {#each items as it (it.id)}
      <div class="card">
        <button class="thumb" onclick={() => open(it)} title="open">
          {#if thumbs[it.id]}<img src={thumbs[it.id]} alt={it.name} />{:else}<span class="muted">no preview</span>{/if}
        </button>
        <div class="meta">
          <div class="title"><b>{it.name}</b><span class="when" title={it.when}>{fmtWhen(it.when)}</span></div>
          <div class="chips">
            {#if it.video}<span class="chip accent">video · {it.video.durationS.toFixed(0)} s · {it.video.source}</span>{/if}
            {#if it.width}<span class="chip">{it.width}×{it.height}</span>{/if}
            {#if it.position}<span class="chip" title="stage position x {it.position.x} y {it.position.y}">z {it.position.z}</span>{/if}
            {#if it.scan}<span class="chip">{it.scan.cols}×{it.scan.rows} scan · {it.scan.tiles.length} tiles</span>{/if}
            {#if it.timelapse}<span class="chip accent">time-lapse · {it.timelapse.frames.length} frames · {(it.timelapse.intervalMs / 1000).toFixed(0)} s{it.timelapse.driftCorrected ? ' · drift-corrected' : ''}</span>{/if}
            {#if it.raw}<span class="chip accent">RAW {it.raw.bitDepth}-bit {it.raw.bayer} → 16-bit PNG</span><span class="chip ok">DNG kept</span>{/if}
            {#if it.stack}<span class="chip accent">{it.stack.method === 'pyramid' ? `fine focus stack (pyramid${it.stack.source === 'raw' ? ', 16-bit from RAW' : ''})` : 'quick focus stack'}</span>{/if}
          </div>
          {#if it.stack}
            <div class="sharebar" title="share of the picture taken from each slice, bottom to top">
              {#each it.stack.contributions as c, i}<span style="width:{c * 100}%;background:hsl({200 + (i / Math.max(1, it.stack.contributions.length - 1)) * 120} 70% 60%)"></span>{/each}
            </div>
            <div class="muted small">{it.stack.slices} slices · Δz {it.stack.stepZ}{it.stack.centreZ !== undefined ? ` · centred on z ${it.stack.centreZ}` : ''} · from each: {it.stack.contributions.map((c) => Math.round(c * 100) + '%').join(' ')}</div>
          {/if}
          {#if it.raw?.applied}<div class="muted small">developed: {it.raw.applied.demosaic}{it.raw.applied.lsc ? ', shading' : ''}{it.raw.applied.ccm ? ', colour matrix' : ''}{it.raw.applied.gammaCurve ? ', camera gamma' : ', sRGB'}</div>{/if}
          <div class="row actions">
            <button onclick={() => open(it)}>Open</button>
            <button onclick={() => doExport(it)} disabled={busy} title="export image, slices, DNG and metadata to a folder">Export</button>
            <button class="danger" onclick={() => remove(it)}>Delete</button>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
{#if viewing}<Viewer blob={viewing.blob} width={viewing.item.width} item={viewing.item} onclose={() => (viewing = null)} />{/if}

<style>
  .wrap { padding: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .thumb { width: 100%; aspect-ratio: 4/3; background: #000; border: 0; border-radius: 0; padding: 0; display: grid; place-items: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .meta { padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  .title { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .title b { font-size: 13px; }
  .when { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .small { font-size: 11px; }
  .actions { margin-top: 4px; }
</style>
