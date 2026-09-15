<script lang="ts">
  /** Organism tracking on the live stream: start/stop, a table of per-track statistics, and a CSV
   *  export of per-frame positions and per-track stats. */
  import { tracking } from '../lib/services/tracking.svelte'
  import { trackStats, tracksToCsv } from '../lib/algo/tracking'

  function toggle(): void { tracking.active ? tracking.stop() : tracking.start() }

  function downloadCsv(): void {
    const csv = tracksToCsv(tracking.tracks)
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `tracks-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
  const stats = $derived(tracking.tracks.map((t) => trackStats(t)))
</script>

<div class="panel">
  <h3>Tracking</h3>
  <div class="row">
    <button class:primary={tracking.active} onclick={toggle}>{tracking.active ? 'Stop tracking' : 'Start tracking'}</button>
    <label class="chk"><input type="checkbox" bind:checked={tracking.useAi} disabled={tracking.active} /> use detector</label>
    <label class="chk">gate <input type="number" min="5" max="500" bind:value={tracking.maxDisplacementPx} disabled={tracking.active} style="width:4.5em" /> px</label>
  </div>
  {#if tracking.status}<div class="muted small" style="margin-top:6px">{tracking.status}</div>{/if}
  {#if tracking.tracks.length}
    <div class="tbl">
      <table>
        <thead><tr><th>id</th><th>pts</th><th>path px</th><th>net px</th><th>speed px/s</th><th>straight.</th></tr></thead>
        <tbody>
          {#each stats.slice(0, 12) as s}
            <tr><td>{s.id}</td><td>{s.points}</td><td>{s.pathLength.toFixed(0)}</td><td>{s.netDisplacement.toFixed(0)}</td><td>{s.meanSpeedPxS.toFixed(1)}</td><td>{s.straightness.toFixed(2)}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <div class="row" style="margin-top:6px"><button onclick={downloadCsv}>Export CSV</button></div>
  <details class="help">
    <summary>How this works</summary>
    <p>Samples the live view a few times a second, finds dark blobs on a bright field (or bright blobs
    on dark field), and links them frame to frame by nearest neighbour within the gate distance. A
    track survives a few missed frames before it is dropped. Enable <b>use detector</b> to link the AI
    object detector's boxes instead of the blob finder.</p>
  </details>
</div>

<style>
  .tbl { max-height: 160px; overflow: auto; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: right; padding: 2px 4px; }
  th:first-child, td:first-child { text-align: left; }
  .chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }

  @media (max-width: 720px) {
    .tbl { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { min-width: 100%; white-space: nowrap; }
  }
</style>
