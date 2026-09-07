<script lang="ts">
  /** Measurement toolbar + results list, used by both the live view and the gallery viewer. Toggling a
   *  mode button (or pressing M) enters/leaves measurement mode on whichever view embeds this panel;
   *  Escape also leaves it (bound by the parent, since key handling differs live vs. in the Viewer
   *  overlay). Clicks that build a measurement are reported by the view itself via `measure.addPoint`. */
  import { measure, resultsToCsv, type MeasureMode, type MeasureResult } from '../lib/services/measureService.svelte'
  import { setManualFromLength, scaleCal, clearManualScale, currentScale } from '../lib/store/scaleCal.svelte'

  let { compact = false }: { compact?: boolean } = $props()

  const modes: { id: MeasureMode; label: string; hint: string }[] = [
    { id: 'distance', label: 'Distance', hint: 'click, click' },
    { id: 'polygon', label: 'Area', hint: 'click each corner, double-click to close' },
    { id: 'angle', label: 'Angle', hint: 'click three points' },
  ]

  function pick(m: MeasureMode) {
    if (measure.active && measure.mode === m) { measure.cancel(); return }
    measure.start(m)
  }

  let copied = $state(false)
  async function copyCsv() {
    try { await navigator.clipboard.writeText(resultsToCsv(measure.results)); copied = true; setTimeout(() => (copied = false), 1500) }
    catch { /* clipboard unavailable (insecure context, permissions) */ }
  }

  /** "Calibrate from a known length": measure a segment on a stage micrometer with the Distance tool,
   *  then use its raw pixel length here with the real length you read off the micrometer. */
  function calibrateFrom(r: MeasureResult) {
    if (!r.pixelLength) return
    const real = prompt('Real length of that segment, in micrometres (e.g. from a stage micrometer):')
    const um = real ? parseFloat(real) : NaN
    if (!(um > 0)) return
    setManualFromLength(r.pixelLength, um, r.referenceWidth)
  }

  function fmt(r: (typeof measure.results)[number]): string {
    if (r.mode === 'distance') return r.distanceUm !== undefined ? `${r.distanceUm.toFixed(2)} µm` : `${r.pixelLength?.toFixed(1)} px (no scale)`
    if (r.mode === 'angle') return `${r.angleDeg?.toFixed(1)}°`
    return r.areaUm2 !== undefined ? `${r.areaUm2.toFixed(1)} µm² · ${r.perimeterUm?.toFixed(1)} µm` : 'no scale calibrated'
  }
</script>

<div class="panel" class:compact>
  <h3>Measure</h3>
  <div class="row">
    {#each modes as m}
      <button class:primary={measure.active && measure.mode === m.id} onclick={() => pick(m.id)} title="{m.hint} (M toggles)">{m.label}</button>
    {/each}
    {#if measure.active}<button onclick={() => measure.cancel()} title="Escape">Done</button>{/if}
  </div>
  {#if measure.active}
    <div class="muted mono" style="font-size:12px;margin-top:6px">
      {modes.find((m) => m.id === measure.mode)?.hint} · {measure.points.length} point{measure.points.length === 1 ? '' : 's'} so far · Esc to stop
    </div>
  {/if}
  {#if measure.results.length}
    <ul class="results">
      {#each measure.results as r (r.id)}
        <li>
          <span class="mono">{fmt(r)}</span>
          <span class="row" style="gap:4px">
            {#if r.mode === 'distance' && r.distanceUm === undefined && r.pixelLength}
              <button class="small" onclick={() => calibrateFrom(r)} title="use this segment's pixel length to calibrate µm/px">Calibrate from this</button>
            {/if}
            <button class="small danger" onclick={() => measure.removeResult(r.id)} title="remove">✕</button>
          </span>
        </li>
      {/each}
    </ul>
    <div class="row" style="margin-top:6px">
      <button onclick={copyCsv}>{copied ? 'Copied!' : 'Copy CSV'}</button>
      <button onclick={() => measure.clearResults()}>Clear all</button>
    </div>
  {/if}
  {#if scaleCal.manual}
    <div class="muted mono" style="font-size:11px;margin-top:6px">manual scale: {scaleCal.manual.umPerPx.toFixed(4)} µm/px @ {scaleCal.manual.referenceWidth}px
      <button class="small" onclick={() => clearManualScale()} title="fall back to the stage calibration, if any">clear</button>
    </div>
  {:else if !currentScale()}
    <div class="muted" style="font-size:11px;margin-top:6px">no scale yet — run "Calibrate XY" or measure a distance and calibrate from it.</div>
  {/if}
</div>

<style>
  .results { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
  .results li { display: flex; justify-content: space-between; align-items: center; font-size: 12px; background: var(--panel2); border-radius: 4px; padding: 3px 6px; }
  .small { padding: 0 6px; font-size: 11px; line-height: 1.6; }
  .compact { padding: 8px; }
</style>
