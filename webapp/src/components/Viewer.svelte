<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for an image Blob, a plain player for video Blobs, or the
   *  time-lapse player (`TimelapseViewer`) when `item` is a time-lapse gallery item. */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'
  import type { GalleryItem } from '../lib/store/gallery'
  import TimelapseViewer from './TimelapseViewer.svelte'

  let { blob = null, item, onclose }: { blob?: Blob | null; item?: GalleryItem; onclose: () => void } = $props()
  let el: HTMLDivElement | undefined = $state()
  const isTimelapse = $derived(item?.kind === 'timelapse')
  const isVideo = $derived(!!blob && blob.type.startsWith('video/'))
  let videoUrl = $state('')
  onMount(() => {
    if (isTimelapse || !blob) return
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
  {#if isTimelapse && item}
    <TimelapseViewer {item} />
  {:else if isVideo}
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
</style>
