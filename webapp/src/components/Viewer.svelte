<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for an image Blob; a plain player for video Blobs.
   *  Optionally shows the item's sample metadata with an inline editor (Gallery passes `item` and
   *  `onSampleChange`; other callers, e.g. Live's search-hit preview, omit them). */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'
  import type { GalleryItem } from '../lib/store/gallery'
  import type { SampleRecord } from '../lib/store/sample.svelte'

  let { blob, item, onclose, onSampleChange }: { blob: Blob; item?: GalleryItem; onclose: () => void; onSampleChange?: (s: SampleRecord) => void } = $props()
  let el: HTMLDivElement | undefined = $state()
  const isVideo = $derived(blob.type.startsWith('video/'))
  let videoUrl = $state('')
  const emptySample = (): SampleRecord => ({ name: '', specimen: '', stain: '', slideId: '', magnification: '', operator: '', notes: '' })
  let editing = $state(false)
  let draft = $state<SampleRecord>(emptySample())
  $effect(() => { draft = item?.sample ? { ...item.sample } : emptySample() })
  function save() { onSampleChange?.({ ...draft }); editing = false }
  onMount(() => {
    const url = URL.createObjectURL(blob)
    if (isVideo) { videoUrl = url; return () => URL.revokeObjectURL(url) }
    const viewer = OpenSeadragon({
      element: el!, prefixUrl: '', showNavigationControl: false, showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
      tileSources: { type: 'image', url, buildPyramid: true } as any, maxZoomPixelRatio: 4, animationTime: 0.4, gestureSettingsMouse: { clickToZoom: false },
    })
    return () => { viewer.destroy(); URL.revokeObjectURL(url) }
  })
</script>

<div class="overlay">
  <button class="close" onclick={onclose}>✕ close</button>
  {#if item && onSampleChange}
    <button class="sample-toggle" onclick={() => (editing = !editing)}>{editing ? '✕' : '🏷'} sample{item.sample?.name ? `: ${item.sample.name}` : ''}</button>
  {/if}
  {#if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="video" src={videoUrl} controls autoplay loop></video>
  {:else}
    <div class="osd" bind:this={el}></div>
  {/if}
  {#if editing && item && onSampleChange}
    <div class="sample-edit panel">
      <label>Name <input bind:value={draft.name} /></label>
      <label>Specimen <input bind:value={draft.specimen} /></label>
      <label>Stain / prep <input bind:value={draft.stain} /></label>
      <label>Slide id <input bind:value={draft.slideId} /></label>
      <label>Magnification <input bind:value={draft.magnification} /></label>
      <label>Operator <input bind:value={draft.operator} /></label>
      <label>Notes <textarea rows="2" bind:value={draft.notes}></textarea></label>
      <div class="row"><button class="primary" onclick={save}>Save</button><button onclick={() => (editing = false)}>Cancel</button></div>
    </div>
  {/if}
</div>

<style>
  .overlay { position: fixed; inset: 0; background: #000; z-index: 50; }
  .osd { width: 100%; height: 100%; }
  .video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .close { position: absolute; top: 12px; right: 12px; z-index: 51; }
  .sample-toggle { position: absolute; top: 12px; left: 12px; z-index: 51; }
  .sample-edit { position: absolute; top: 52px; left: 12px; z-index: 51; width: 260px; display: flex; flex-direction: column; gap: 6px; }
  .sample-edit label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
</style>
