<script lang="ts">
  /** Zoomable image viewer (OpenSeadragon) for a Blob. */
  import { onMount } from 'svelte'
  import OpenSeadragon from 'openseadragon'

  let { blob, onclose }: { blob: Blob; onclose: () => void } = $props()
  let el: HTMLDivElement
  onMount(() => {
    const url = URL.createObjectURL(blob)
    const viewer = OpenSeadragon({
      element: el, prefixUrl: '', showNavigationControl: false, showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
      tileSources: { type: 'image', url, buildPyramid: true } as any, maxZoomPixelRatio: 4, animationTime: 0.4, gestureSettingsMouse: { clickToZoom: false },
    })
    return () => { viewer.destroy(); URL.revokeObjectURL(url) }
  })
</script>

<div class="overlay">
  <button class="close" onclick={onclose}>✕ close</button>
  <div class="osd" bind:this={el}></div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: #000; z-index: 50; }
  .osd { width: 100%; height: 100%; }
  .close { position: absolute; top: 12px; right: 12px; z-index: 51; }
</style>
