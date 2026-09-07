<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for an image Blob; a plain player for video Blobs.
   *  Items from a fine focus stack carry a depth map (`stack.depth`): a small toggle switches
   *  between the fused image, the colour-mapped depth map ('depth' blob) and a pseudo-3D relief
   *  shading of the image ('relief' blob), both precomputed alongside the stack. */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'
  import { getBlob, type GalleryItem } from '../lib/store/gallery'

  let { blob, item, onclose }: { blob: Blob; item?: GalleryItem; onclose: () => void } = $props()
  let el: HTMLDivElement | undefined = $state()
  const isVideo = $derived(blob.type.startsWith('video/'))
  let videoUrl = $state('')
  const hasDepth = $derived(!!item?.stack?.depth && !isVideo)
  let mode = $state<'image' | 'depth' | 'relief'>('image')
  // svelte-ignore state_referenced_locally -- intentional: seed the local copy once from the prop
  // (a fresh Viewer instance is mounted per opened item, `blob` itself never changes afterwards)
  let viewBlob = $state(blob)

  $effect(() => {
    if (!hasDepth || mode === 'image') { viewBlob = blob; return }
    const wanted = mode, id = item!.id
    getBlob(id, wanted).then((b) => { if (b) viewBlob = b })
  })

  onMount(() => {
    if (isVideo) { videoUrl = URL.createObjectURL(blob); return () => URL.revokeObjectURL(videoUrl) }
  })

  $effect(() => {
    if (isVideo || !el) return
    const url = URL.createObjectURL(viewBlob)
    const viewer = OpenSeadragon({
      element: el, prefixUrl: '', showNavigationControl: false, showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
      tileSources: { type: 'image', url, buildPyramid: true } as any, maxZoomPixelRatio: 4, animationTime: 0.4, gestureSettingsMouse: { clickToZoom: false },
    })
    return () => { viewer.destroy(); URL.revokeObjectURL(url) }
  })
</script>

<div class="overlay">
  <button class="close" onclick={onclose}>✕ close</button>
  {#if hasDepth}
    <div class="modes">
      <button class:on={mode === 'image'} onclick={() => (mode = 'image')}>Image</button>
      <button class:on={mode === 'depth'} onclick={() => (mode = 'depth')}>Depth map</button>
      <button class:on={mode === 'relief'} onclick={() => (mode = 'relief')}>Relief</button>
    </div>
  {/if}
  {#if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="video" src={videoUrl} controls autoplay loop></video>
  {:else}
    <div class="osd" bind:this={el}></div>
  {/if}
</div>

<style>
  .overlay { position: fixed; inset: 0; background: #000; z-index: 50; }
  .osd { width: 100%; height: 100%; }
  .video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .close { position: absolute; top: 12px; right: 12px; z-index: 51; }
  .modes { position: absolute; top: 12px; left: 12px; z-index: 51; display: flex; gap: 6px; }
  .modes button.on { background: var(--accent, #3a6df0); color: #fff; }
</style>
