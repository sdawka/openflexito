<script lang="ts">
  /** The scan map: the plan's tile grid drawn in mosaic space, with the current field of view
   *  (live MJPEG frame) sitting where the stage is, captured tiles filling in as thumbnails, focus
   *  status per tile, an optional mosaic underlay (the last scan of this same footprint) and the
   *  polygon region editor (points are fractions of the full grid's box; the point-in-polygon test
   *  itself lives in `lib/algo/scanPlan.ts`). One picture for planning, running and reviewing. */
  import { tileRectNorm, type NormRect, type Point, type ScanPlan } from '../lib/algo/scanPlan'
  import type { TileState } from '../lib/services/scan.svelte'

  let {
    plan, states = [], here = null, live = null, underlay = null, polygon = [], editable = false, onpolygon,
  }: {
    plan: ScanPlan | null
    states?: TileState[]                  // by position in plan.tiles
    here?: NormRect | null                // current field of view in the box
    live?: string | null                  // MJPEG src drawn inside `here`
    underlay?: string | null              // mosaic image covering the whole box
    polygon?: Point[]
    editable?: boolean                    // clicks add polygon points
    onpolygon?: (p: Point[]) => void
  } = $props()

  let liveImg: HTMLImageElement | undefined = $state()
  // a detached <img> keeps streaming: drop the source on unmount
  $effect(() => { const el = liveImg; return () => { if (el) el.src = '' } })

  const ratio = $derived(plan ? plan.mosaic.width / Math.max(1, plan.mosaic.height) : 4 / 3)
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`
  const rectStyle = (r: NormRect) => `left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)}`
  const hereVisible = $derived(!!here && here.x < 1 && here.y < 1 && here.x + here.w > 0 && here.y + here.h > 0)
  const hereOutside = $derived(!!here && !hereVisible)

  function click(e: MouseEvent) {
    if (!editable || !onpolygon) return
    const el = e.currentTarget as HTMLDivElement
    const r = el.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    onpolygon([...polygon, { x, y }])
  }
  const focusMark = (s: TileState) => s.focus === 'measured' ? '●' : s.focus === 'refined' ? '◐' : s.focus === 'predicted' ? '○' : s.status === 'failed' ? '!' : ''
  const title = (t: { col: number; row: number }, s: TileState | undefined) => {
    const base = `col ${t.col} row ${t.row}`
    if (!s || s.status === 'pending') return `${base}: planned`
    const z = s.z !== undefined ? ` · z ${s.z}` : ''
    const f = s.focus && s.focus !== 'none' ? ` · focus ${s.focus}` : ''
    return `${base}: ${s.status}${z}${f}${s.error ? ` · ${s.error}` : ''}`
  }
</script>

<div class="map-wrap">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
  <div class="poly-canvas map" class:editable style="aspect-ratio: {ratio}; --ratio: {ratio}" onclick={click} role={editable ? 'button' : undefined} tabindex={editable ? 0 : undefined}>
    {#if underlay}<img class="underlay" src={underlay} alt="previous scan of this area" draggable="false" />{/if}
    {#if plan}
      {#each plan.tiles as t, i (t.index)}
        {@const s = states[i]}
        <div class="tile {s?.status ?? 'pending'}" style={rectStyle(tileRectNorm(plan, t))} title={title(t, s)}>
          {#if s?.thumb}<img src={s.thumb} alt="" draggable="false" />{/if}
          {#if s && s.status !== 'pending' && s.status !== 'done' && s.status !== 'failed'}<span class="pulse"></span>{/if}
          {#if s && focusMark(s)}<span class="mark" class:bad={s.status === 'failed'}>{focusMark(s)}</span>{/if}
        </div>
      {/each}
    {/if}
    {#if here && hereVisible}
      <div class="here" style={rectStyle(here)}>
        {#if live}<img bind:this={liveImg} src={live} alt="live view" draggable="false" />{/if}
      </div>
    {/if}
    <svg viewBox="0 0 1 1" preserveAspectRatio="none">
      {#if polygon.length > 1}<polygon points={polygon.map((p) => `${p.x},${p.y}`).join(' ')} />{/if}
      {#each polygon as p}<circle cx={p.x} cy={p.y} r="0.012" />{/each}
    </svg>
    {#if !plan}
      <div class="empty muted">No camera-to-stage calibration yet</div>
    {:else if hereOutside}
      <div class="corner-hint mono">stage is outside the planned area</div>
    {/if}
  </div>
</div>

<style>
  .map-wrap { display: flex; flex-direction: column; gap: 6px; }
  /* the whole map is one box in mosaic proportions, as large as the column allows without the
     (variable-aspect) grid pushing the controls below it off screen */
  .map { position: relative; width: min(100%, calc((100vh - 260px) * var(--ratio))); min-width: min(100%, 320px); margin: 0 auto; background: #0a0c10; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .map.editable { cursor: crosshair; }
  .underlay { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; user-select: none; pointer-events: none; opacity: .9; }
  .tile { position: absolute; box-sizing: border-box; border: 1px solid rgba(139, 147, 167, .55); background: rgba(139, 147, 167, .07); overflow: hidden; pointer-events: auto; }
  .tile img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
  .tile.moving, .tile.focusing, .tile.capturing { border-color: var(--accent); background: rgba(79, 140, 255, .18); z-index: 2; }
  .tile.done { border-color: rgba(60, 207, 122, .7); background: rgba(60, 207, 122, .10); }
  .tile.failed { border-color: var(--warn); background: rgba(245, 185, 66, .12); }
  .pulse { position: absolute; inset: 0; border: 2px solid var(--accent); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
  .mark { position: absolute; right: 3px; bottom: 1px; font-size: 11px; color: #cfe0ff; text-shadow: 0 0 3px #000; }
  .mark.bad { color: var(--warn); font-weight: 700; }
  .here { position: absolute; box-sizing: border-box; border: 2px dashed #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6); z-index: 3; pointer-events: none; transition: left .15s, top .15s; }
  .here img { width: 100%; height: 100%; object-fit: fill; display: block; opacity: .95; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 4; pointer-events: none; }
  polygon { fill: rgba(79, 140, 255, .22); stroke: var(--accent); stroke-width: 0.004; vector-effect: non-scaling-stroke; }
  circle { fill: var(--accent); }
  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; }
  .corner-hint { position: absolute; left: 8px; bottom: 6px; font-size: 11px; color: var(--warn); background: rgba(0,0,0,.6); padding: 2px 6px; border-radius: 4px; z-index: 5; }

  @media (max-width: 720px) {
    .map { width: 100%; }
  }
</style>
