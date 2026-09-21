<script lang="ts">
  /** Scan page. The picture is the plan: a map of the tiles in mosaic space with the live field of
   *  view where the stage is, filling in with captured tiles as the run progresses. Settings are
   *  grouped by the question they answer — where (area), how sharp (focus), what pixels (capture),
   *  how to join (stitching) — and the run itself lives in `services/scan.svelte.ts`, so switching
   *  tabs (e.g. to drive the stage to a corner on Live) loses nothing. */
  import { device } from '../lib/store/device.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { scan, fmtTime } from '../lib/services/scan.svelte'
  import ScanMap from '../components/ScanMap.svelte'

  // persist the configuration on every change (reads cfg, writes localStorage: no state written)
  $effect(() => { JSON.stringify(scan.cfg); scan.persist() })

  const cfg = $derived(scan.cfg)
  const plan = $derived(scan.plan)
  const n = $derived(plan?.tiles.length ?? 0)
  const flat = $derived(calibration.flat)
  const polygonMode = $derived(cfg.polygon.length >= 3)
  // the region select is the switch; leaving polygon mode drops the points
  let shape = $state<'rect' | 'polygon'>(scan.cfg.polygon.length ? 'polygon' : 'rect')
  function setShape(e: Event) {
    shape = (e.currentTarget as HTMLSelectElement).value as 'rect' | 'polygon'
    if (shape === 'rect') scan.setPolygon([])
  }
  const liveSrc = $derived(device.connected ? device.url('/stream.mjpg') : null)
  const percent = $derived(scan.total ? Math.round((scan.done / scan.total) * 100) : 0)
  const busy = $derived(scan.running)
  const fmtPos = (p: { x: number; y: number } | null) => (p ? `${p.x}, ${p.y}` : '—')
  const openInGallery = () => { location.hash = '#/gallery' }
</script>

<div class="scan">
  <section class="map-col">
    <ScanMap {plan} states={scan.tileStates} here={scan.here} live={busy && scan.phase !== 'capturing' ? null : liveSrc} underlay={scan.underlay}
             polygon={cfg.polygon} editable={shape === 'polygon' && !busy} onpolygon={(p) => scan.setPolygon(p)} />
    <div class="legend muted">
      <span><i class="sw here"></i>current view</span>
      <span><i class="sw planned"></i>planned</span>
      <span><i class="sw done"></i>captured</span>
      <span><i class="sw failed"></i>focus failed</span>
      {#if cfg.focusMode !== 'none'}<span class="mono">● measured ◐ refined ○ predicted</span>{/if}
    </div>

    <div class="panel run">
      {#if busy}
        <div class="row between">
          <span class="status-line busy" style="margin:0">{scan.message}</span>
          <button class="danger" onclick={() => scan.cancel()} disabled={scan.phase !== 'capturing'}>Cancel</button>
        </div>
        {#if scan.phase === 'capturing'}
          <progress max={scan.total} value={scan.done}></progress>
          <div class="row between muted mono small">
            <span>{scan.done}/{scan.total} tiles · {percent}%</span>
            <span>{fmtTime(scan.elapsedS)} elapsed · about {fmtTime(scan.remainingS)} left</span>
          </div>
        {/if}
      {:else if scan.phase === 'cancelled' && scan.captured >= 2}
        <div class="row between">
          <span class="status-line" style="margin:0">{scan.message}</span>
          <div class="row">
            <button class="primary" onclick={() => scan.stitchCaptured()}>Stitch {scan.captured} tiles</button>
            <button onclick={() => scan.discardCaptured()}>Discard</button>
          </div>
        </div>
      {:else}
        <div class="row between">
          <div class="row">
            <button class="primary" onclick={() => scan.start()} disabled={!scan.ready || !device.connected || !n}>Start scan</button>
            <button onclick={() => scan.start({ overview: true })} disabled={!scan.ready || !device.connected || !n}
                    title="quick pass with stream frames and no focusing; its mosaic then sits under the map so you can draw a region on it">Quick overview</button>
          </div>
          <span class="muted mono small">
            {#if plan}{n} tiles of {plan.fov.w}×{plan.fov.h} px · est. {fmtTime(scan.estimateS)}{/if}
            {#if cfg.focusMode === 'interpolate' && n}· {scan.subgridCount} autofocused, rest interpolated{cfg.localRefine ? ' + refined' : ''}{/if}
          </span>
        </div>
        {#if scan.message}
          <div class="status-line" class:ok={scan.phase === 'done'} class:err={scan.phase === 'error'}>{scan.message}</div>
        {/if}
      {/if}
    </div>

    {#if scan.result}
      <div class="panel result">
        <h3>Result</h3>
        <img src={scan.result.url} alt="stitched scan" />
        <div class="row between">
          <span class="muted mono small">{scan.result.summary}</span>
          <button onclick={openInGallery}>Open gallery{#if scan.result.item.scan?.focus?.mode !== 'none'} · height map{/if}</button>
        </div>
      </div>
    {/if}
  </section>

  <aside>
    {#if !scan.ready}
      <div class="panel warn">
        <strong>Calibrate first.</strong>
        <p class="muted small">Run "Calibrate XY" on the Calibrate page: the scan needs the camera-to-stage mapping to know how far to move between tiles.</p>
      </div>
    {/if}

    <div class="panel">
      <h3>Area</h3>
      <div class="seg" role="group" aria-label="extent">
        <button class:on={cfg.extent === 'centre'} onclick={() => (scan.cfg.extent = 'centre')} disabled={busy}>Around here</button>
        <button class:on={cfg.extent === 'corners'} onclick={() => (scan.cfg.extent = 'corners')} disabled={busy}>Between two corners</button>
      </div>
      {#if cfg.extent === 'centre'}
        <div class="row" style="margin-top:8px">
          <div><div class="label">columns</div><input type="number" min="1" max="30" bind:value={scan.cfg.cols} disabled={busy} /></div>
          <div><div class="label">rows</div><input type="number" min="1" max="30" bind:value={scan.cfg.rows} disabled={busy} /></div>
          <div><div class="label">overlap</div>
            <select bind:value={scan.cfg.overlap} disabled={busy}><option value={0.2}>20 %</option><option value={0.3}>30 %</option><option value={0.4}>40 %</option><option value={0.5}>50 %</option></select></div>
        </div>
        <p class="muted small">Fields of view around the current stage position. Move the stage on the Live tab to re-centre.</p>
      {:else}
        <div class="corners">
          {#each ['A', 'B'] as const as which}
            {@const p = which === 'A' ? cfg.cornerA : cfg.cornerB}
            <div class="corner">
              <span class="label">corner {which}</span>
              <span class="mono small" class:muted={!p}>{fmtPos(p)}</span>
              <button onclick={() => scan.markCorner(which)} disabled={busy}>Mark here</button>
              <button onclick={() => scan.goToCorner(which)} disabled={busy || !p} title="drive the stage to this corner">Go</button>
            </div>
          {/each}
        </div>
        <div class="row" style="margin-top:8px">
          <div><div class="label">overlap</div>
            <select bind:value={scan.cfg.overlap} disabled={busy}><option value={0.2}>20 %</option><option value={0.3}>30 %</option><option value={0.4}>40 %</option><option value={0.5}>50 %</option></select></div>
          <span class="muted small" style="align-self:end">
            {#if scan.cornersReady && plan}→ {plan.cols} × {plan.rows} fields{:else}drive to two opposite corners on the Live tab and mark each{/if}
          </span>
        </div>
      {/if}
      <div class="row" style="margin-top:8px">
        <div><div class="label">region</div>
          <select value={shape} onchange={setShape} disabled={busy}><option value="rect">all tiles</option><option value="polygon">polygon</option></select></div>
        <div><div class="label">order</div>
          <select value={cfg.order} onchange={(e) => scan.setOrder((e.currentTarget as HTMLSelectElement).value as typeof cfg.order)} disabled={busy}>
            <option value="snake">snake</option>
            <option value="raster">raster</option>
            <option value="spiral">spiral (centre outward)</option>
          </select></div>
      </div>
      {#if shape === 'polygon'}
        <div class="row" style="margin-top:8px">
          <button onclick={() => scan.setPolygon(cfg.polygon.slice(0, -1))} disabled={!cfg.polygon.length || busy}>Undo point</button>
          <button onclick={() => scan.setPolygon([])} disabled={!cfg.polygon.length || busy}>Clear</button>
          <span class="muted small">{cfg.polygon.length} point{cfg.polygon.length === 1 ? '' : 's'}{polygonMode ? '' : ' — click the map, 3 close a region'}</span>
        </div>
        {#if !scan.underlay}<p class="muted small">Tip: run a Quick overview first, then draw on its mosaic.</p>{/if}
      {/if}
    </div>

    <div class="panel">
      <h3>Focus</h3>
      <div class="row">
        <div><div class="label">focus</div>
          <select bind:value={scan.cfg.focusMode} disabled={busy}>
            <option value="none">none (keep current z)</option>
            <option value="every">autofocus every tile</option>
            <option value="interpolate">height map: every Nth tile</option>
          </select></div>
        {#if cfg.focusMode !== 'none'}
          <div><div class="label">sweep</div>
            <select bind:value={scan.cfg.afRange} disabled={busy}><option value={300}>±150 steps</option><option value={600}>±300 steps</option><option value={1200}>±600 steps</option></select></div>
        {/if}
      </div>
      {#if cfg.focusMode === 'interpolate'}
        <div class="row" style="margin-top:8px">
          <div><div class="label">N</div><input type="number" min="1" max="10" bind:value={scan.cfg.afStep} disabled={busy} /></div>
          <label class="check" title="after moving to the height-map z, a 5-point Laplacian sweep over this range picks the sharpest z">
            <input type="checkbox" bind:checked={scan.cfg.localRefine} disabled={busy} /> refine ±<input type="number" min="5" max="500" step="5" bind:value={scan.cfg.localRange} disabled={!cfg.localRefine || busy} /> steps
          </label>
        </div>
        <p class="muted small">Autofocus on a coarse sub-grid (plus the corners), fit a height map, move the other tiles to the predicted z.</p>
      {:else if cfg.focusMode === 'every'}
        <p class="muted small">Sharpest result on tilted or uneven samples; adds a few seconds per tile.</p>
      {/if}
    </div>

    <div class="panel">
      <h3>Capture</h3>
      <div class="row">
        <div><div class="label">tile source</div>
          <div class="seg">
            <button class:on={cfg.fullRes} onclick={() => (scan.cfg.fullRes = true)} disabled={busy} title="3280×2464 still per tile, ~1.3 s each">Full-res still</button>
            <button class:on={!cfg.fullRes} onclick={() => (scan.cfg.fullRes = false)} disabled={busy} title="the live stream frame, fast">Stream frame</button>
          </div></div>
        <div><div class="label">settle (min)</div>
          <div class="row" style="gap:4px"><input type="number" min="0" max="2000" step="50" bind:value={scan.cfg.settleMs} disabled={busy} style="width:80px"
               title="minimum settle after each move; longer moves settle longer (0.05 ms per step, up to 1.5 s)" /><span class="muted small">ms</span></div></div>
      </div>
    </div>

    <details class="panel adv">
      <summary>Stitching</summary>
      <label class="check"><input type="checkbox" bind:checked={scan.cfg.refine} /> refine positions by correlation</label>
      <label class="check" title="solve per-tile brightness gains from the overlaps so exposure differences do not show as seams"><input type="checkbox" bind:checked={scan.cfg.gainEq} /> equalise tile brightness</label>
      <label class="check" title="3-level Laplacian blend: smoother large-scale transitions, sharp detail; limits the mosaic to 4096 px"><input type="checkbox" bind:checked={scan.cfg.multiband} /> multi-band blend</label>
      <label class="check" title={flat ? `divide tiles by the blank-field map captured ${flat.when}` : 'no flat-field map captured yet (Calibrate page)'}><input type="checkbox" bind:checked={scan.cfg.useFlat} disabled={!flat} /> flat-field correction</label>
    </details>
  </aside>
</div>

<style>
  .scan { display: grid; grid-template-columns: minmax(0, 1fr) 340px; height: 100%; }
  .map-col { display: flex; flex-direction: column; gap: 10px; padding: 12px; min-width: 0; overflow: auto; }
  aside { display: flex; flex-direction: column; gap: 10px; padding: 10px; overflow: auto; border-left: 1px solid var(--border); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px; justify-content: center; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .sw { display: inline-block; width: 12px; height: 9px; border: 1px solid rgba(139, 147, 167, .55); background: rgba(139, 147, 167, .07); }
  .sw.here { border: 2px dashed #fff; background: transparent; }
  .sw.done { border-color: rgba(60, 207, 122, .7); background: rgba(60, 207, 122, .10); }
  .sw.failed { border-color: var(--warn); background: rgba(245, 185, 66, .12); }
  .between { justify-content: space-between; }
  .small { font-size: 12px; }
  p.small { margin: 8px 0 0; line-height: 1.4; }
  .run progress { width: 100%; margin-top: 8px; }
  .result img { max-width: 100%; max-height: 40vh; display: block; margin: 0 auto 8px; border-radius: 6px; }
  .panel.warn { border-color: var(--warn); }
  .panel.warn p { margin: 4px 0 0; }
  input[type=number] { width: 72px; }
  .check { display: flex; gap: 6px; align-items: center; margin: 0; color: var(--text); font-size: 13px; }
  .check input[type=number] { width: 64px; }
  .adv summary { cursor: pointer; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .adv[open] summary { margin-bottom: 8px; }
  .adv .check { margin-top: 6px; }
  .corners { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .corner { display: grid; grid-template-columns: 62px 1fr auto auto; gap: 6px; align-items: center; }
  .corner .label { margin: 0; }

  @media (max-width: 720px) {
    .scan { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: auto; }
    .map-col { padding: 10px; overflow: visible; }
    aside { border-left: 0; padding-bottom: calc(10px + var(--tabbar-h, 0px)); overflow: visible; }
  }
</style>
