<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for an image Blob; a plain player for video Blobs. */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'
  import HeightMapOverlay from './HeightMapOverlay.svelte'
  import type { GalleryItem } from '../lib/store/gallery'

  let { blob, item, onclose }: { blob: Blob; item?: GalleryItem; onclose: () => void } = $props()
  let el: HTMLDivElement | undefined = $state()
  const isVideo = $derived(blob.type.startsWith('video/'))
  let videoUrl = $state('')
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
  {#if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="video" src={videoUrl} controls autoplay loop></video>
  {:else}
    <div class="osd" bind:this={el}></div>
    {#if item?.scan}<HeightMapOverlay {item} />{/if}
  {/if}
</div>

<style>
  .overlay { position: fixed; inset: 0; background: #000; z-index: 50; }
  .osd { width: 100%; height: 100%; }
  .video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .close { position: absolute; top: 12px; right: 12px; z-index: 51; }
</style>
