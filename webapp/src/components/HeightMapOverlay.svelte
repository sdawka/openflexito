<script lang="ts">
  /** Small colour-mapped grid + legend of a scan's per-tile focused z (steps), toggled in the
   *  Viewer. Not zoom-linked to the OpenSeadragon image below it — it is a mini-map, not a tracing
   *  overlay — which keeps it simple and independent of the zoom/pan state. */
  import type { GalleryItem } from '../lib/store/gallery'
  import { heightColor } from '../lib/algo/heightMap'

  let { item }: { item: GalleryItem } = $props()
  let show = $state(false)

  const cols = $derived(item.scan?.cols ?? 0)
  const rows = $derived(item.scan?.rows ?? 0)
  const tiles = $derived(item.scan?.tiles ?? [])
  const zs = $derived(tiles.map((t) => t.z).filter((z): z is number => z !== undefined))
  const zMin = $derived(zs.length ? Math.min(...zs) : 0)
  const zMax = $derived(zs.length ? Math.max(...zs) : 0)
  const cellOf = $derived((col: number, row: number) => tiles.find((t) => t.col === col && t.row === row))
</script>

{#if zs.length}
  <button class="hm-toggle" onclick={() => (show = !show)}>{show ? 'hide' : 'show'} height map</button>
  {#if show}
    <div class="hm-panel">
      <div class="hm-grid" style="grid-template-columns: repeat({cols}, 1fr); grid-template-rows: repeat({rows}, 1fr)">
        {#each Array.from({ length: rows }) as _, row}
          {#each Array.from({ length: cols }) as __, col}
            {@const t = cellOf(col, row)}
            <div class="hm-cell" title={t?.z !== undefined ? `col ${col} row ${row}: z ${t.z} steps${t.zMeasured ? ' (measured)' : ' (predicted)'}` : 'no focus data'}
                 style="background:{t?.z !== undefined ? heightColor(t.z, zMin, zMax) : 'transparent'}"></div>
          {/each}
        {/each}
      </div>
      <div class="hm-legend">
        <span>{zMin} steps</span>
        <span class="hm-bar"></span>
        <span>{zMax} steps</span>
      </div>
    </div>
  {/if}
{/if}

<style>
  .hm-toggle { position: absolute; bottom: 12px; left: 12px; z-index: 52; }
  .hm-panel { position: absolute; bottom: 48px; left: 12px; z-index: 52; background: rgba(20, 20, 20, .85); padding: 8px; border-radius: 6px; }
  .hm-grid { display: grid; width: 160px; height: 120px; gap: 1px; }
  .hm-cell { border-radius: 2px; }
  .hm-legend { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: #ddd; }
  .hm-bar { flex: 1; height: 8px; border-radius: 4px; background: linear-gradient(to right, hsl(220 80% 50%), hsl(0 80% 50%)); }
</style>
