<script lang="ts">
  /** Click-to-add-points polygon editor over a reference image (a coarse scan's stitched preview,
   *  or the live view when no overview exists yet). Points are fractions of the image (0..1); the
   *  actual point-in-polygon test against tile centres lives in `lib/algo/scanPlan.ts`. */
  import type { Point } from '../lib/algo/scanPlan'

  let { src, points, onchange }: { src: string; points: Point[]; onchange: (p: Point[]) => void } = $props()

  function click(e: MouseEvent) {
    const el = e.currentTarget as HTMLDivElement
    const r = el.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    onchange([...points, { x, y }])
  }
  const undo = () => onchange(points.slice(0, -1))
  const clear = () => onchange([])
</script>

<div class="poly-wrap">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="poly-canvas" onclick={click} role="button" tabindex="0">
    <img {src} alt="scan overview" draggable="false" crossorigin="anonymous" />
    <svg viewBox="0 0 1 1" preserveAspectRatio="none">
      {#if points.length > 1}
        <polygon points={points.map((p) => `${p.x},${p.y}`).join(' ')} />
      {/if}
      {#each points as p}<circle cx={p.x} cy={p.y} r="0.012" />{/each}
    </svg>
  </div>
  <div class="row">
    <button onclick={undo} disabled={!points.length}>Undo point</button>
    <button onclick={clear} disabled={!points.length}>Clear</button>
    <span class="muted mono" style="font-size:12px">{points.length} point{points.length === 1 ? '' : 's'} — click to add, at least 3 closes a region</span>
  </div>
</div>

<style>
  .poly-wrap { display: flex; flex-direction: column; gap: 8px; }
  .poly-canvas { position: relative; width: 100%; max-width: 480px; aspect-ratio: 4 / 3; background: #000; cursor: crosshair; overflow: hidden; border-radius: 6px; }
  .poly-canvas img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; user-select: none; pointer-events: none; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  polygon { fill: rgba(79, 140, 255, .25); stroke: var(--accent); stroke-width: 0.004; vector-effect: non-scaling-stroke; }
  circle { fill: var(--accent); }
</style>
