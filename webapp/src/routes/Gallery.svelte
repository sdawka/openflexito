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
  let viewing = $state<{ blob: Blob; item: GalleryItem } | null>(null)
  let busy = $state(false)

  async function refresh() {
    items = await listItems()
    for (const it of items) if (!thumbs[it.id] && it.blobs.includes('thumb')) {
      const b = await getBlob(it.id, 'thumb'); if (b) thumbs = { ...thumbs, [it.id]: URL.createObjectURL(b) }
    }
  }
  onMount(() => { refresh(); return () => Object.values(thumbs).forEach((u) => URL.revokeObjectURL(u)) })

  async function open(it: GalleryItem) {
    const blob = await getBlob(it.id, 'image')
    if (blob) viewing = { blob, item: it }
  }
  async function remove(it: GalleryItem) {
    if (!confirm(`Delete "${it.name}"?`)) return
    await deleteItem(it); await refresh()
  }
  async function doExport(it: GalleryItem) { busy = true; try { await exportItem(it) } finally { busy = false } }
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
    <div class="panel muted">No items yet. Save snapshots from the Live page or run a scan.</div>
  {/if}
  <div class="grid">
    {#each items as it (it.id)}
      <div class="card">
        <button class="thumb" onclick={() => open(it)} title="open">
          {#if thumbs[it.id]}<img src={thumbs[it.id]} alt={it.name} />{:else}<span class="muted">no preview</span>{/if}
        </button>
        <div class="meta">
          <div><b>{it.name}</b></div>
          <div class="muted mono" style="font-size:11px">
            {it.kind}{it.width ? ` · ${it.width}×${it.height}` : ''}{it.position ? ` · z ${it.position.z}` : ''}
            {it.scan ? ` · ${it.scan.tiles.length} tiles` : ''}
            {#if it.stack}<div title="share of the picture taken from each slice">{it.stack.method === 'pyramid' ? `fine focus stack (pyramid${it.stack.source === 'raw' ? ', 16-bit from RAW' : ''})` : 'focus stack'} · {it.stack.slices} slices, Δz {it.stack.stepZ}{it.stack.centreZ !== undefined ? `, centred on z ${it.stack.centreZ}` : ''} · from each: {it.stack.contributions.map((c) => Math.round(c * 100) + '%').join(' ')}</div>{/if}
            {#if it.raw}<div>RAW {it.raw.bitDepth}-bit {it.raw.bayer} → 16-bit PNG{it.raw.applied ? ` (${it.raw.applied.demosaic}${it.raw.applied.lsc ? ', shading' : ''}${it.raw.applied.ccm ? ', colour matrix' : ''}${it.raw.applied.gammaCurve ? ', camera gamma' : ', sRGB'})` : ''} · DNG kept</div>{/if}
          </div>
          <div class="row" style="margin-top:6px">
            <button onclick={() => open(it)}>Open</button>
            <button onclick={() => doExport(it)} disabled={busy}>Export</button>
            <button class="danger" onclick={() => remove(it)}>Delete</button>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
{#if viewing}<Viewer blob={viewing.blob} onclose={() => (viewing = null)} />{/if}

<style>
  .wrap { padding: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .thumb { width: 100%; aspect-ratio: 4/3; background: #000; border: 0; border-radius: 0; padding: 0; display: grid; place-items: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .meta { padding: 10px; }
</style>
