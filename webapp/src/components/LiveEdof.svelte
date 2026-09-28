<script lang="ts">
  /** "Live extended focus" section of the Focus panel: continuous z sweeps fused per leg
   *  (`services/liveEdof.svelte.ts`), shown on the live view and recordable as a video. */
  import { device } from '../lib/store/device.svelte'
  import { settings } from '../lib/store/settings.svelte'
  import { liveEdof, EDOF_MAX_FPS } from '../lib/services/liveEdof.svelte'
  import { recorder } from '../lib/services/recorder.svelte'

  const locked = $derived(liveEdof.active || liveEdof.starting || liveEdof.stopping)
  const deviceBacklash = $derived(Math.round(device.status?.stage?.backlash?.z ?? 0))
  const rangeUm = $derived(settings.stageStepUm.z > 0 ? liveEdof.opts.range * settings.stageStepUm.z : null)
  const s = $derived(liveEdof.stats)

  function setBacklash(e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value.trim()
    liveEdof.opts.backlash = v === '' ? null : Math.max(0, Math.round(+v))
    liveEdof.save()
  }
</script>

<h4 class="sub">Live extended focus</h4>
<div class="edof">
  <div class="grid2">
    <label>mode
      <select bind:value={liveEdof.opts.mode} onchange={() => { liveEdof.opts.fps = Math.min(liveEdof.opts.fps, EDOF_MAX_FPS[liveEdof.opts.mode]); liveEdof.save() }} disabled={locked} aria-label="edof mode">
        <option value="crop">Crop 640×480, up to 200 fps</option>
        <option value="full">Full field 820×616, up to 40 fps</option>
      </select>
    </label>
    <label>fps
      <input type="number" min="5" max={EDOF_MAX_FPS[liveEdof.opts.mode]} step="5" bind:value={liveEdof.opts.fps} onchange={() => liveEdof.save()} disabled={locked} aria-label="edof fps" />
    </label>
    <label>range (steps){#if rangeUm != null}<span class="muted"> ≈ {rangeUm.toFixed(1)} µm</span>{/if}
      <input type="number" min="4" max="5000" step="10" bind:value={liveEdof.opts.range} onchange={() => liveEdof.save()} disabled={locked} aria-label="edof range" />
    </label>
    <label title="dead band after each reversal, added to every leg; empty = the stage's own z backlash">backlash
      <input type="number" min="0" max="500" step="1" value={liveEdof.opts.backlash ?? ''} placeholder={String(deviceBacklash)} onchange={setBacklash} disabled={locked} aria-label="edof backlash" />
    </label>
  </div>
  <div class="row">
    {#if liveEdof.active}
      <button class="primary" onclick={() => liveEdof.stop()}>Stop extended focus</button>
      {#if liveEdof.recording}
        <button class="danger" onclick={() => liveEdof.stopRecording()}>Stop recording{recorder.recording ? ` · ${recorder.seconds} s` : ''}</button>
      {:else}
        <button onclick={() => liveEdof.record()} disabled={recorder.recording || !liveEdof.stats} title="record the fused composites as a video (one frame per sweep, at its real time)">Record extended focus</button>
      {/if}
    {:else if liveEdof.stopping}
      <button disabled>Returning z…</button>
    {:else}
      <button class="primary" onclick={() => liveEdof.start()} disabled={liveEdof.starting || !device.connected} title="sweep z continuously and fuse each sweep into one sharp frame">{liveEdof.starting ? 'Starting…' : 'Start extended focus'}</button>
    {/if}
  </div>
  {#if liveEdof.active && s}
    <div class="status-line busy mono" data-sweeps={s.sweeps}>{s.sweepsPerS.toFixed(1)} sweeps/s · {s.framesPerSweep} frames/sweep ({Math.round(s.usefulFraction * 100)}% useful) · {Math.round(s.windowMs)} ms window · dropped {s.deviceDropped + s.workerDropped}</div>
  {:else if liveEdof.active}
    <div class="status-line busy">sweeping…</div>
  {/if}
  {#if liveEdof.active && s?.backlashEstimate != null}
    <div class="row small"><span class="muted">backlash ≈ {Math.round(s.backlashEstimate)} steps (from the focus peaks; using {liveEdof.runBacklash})</span>
      <button onclick={() => liveEdof.adoptBacklashEstimate()} disabled={Math.abs(s.backlashEstimate - liveEdof.runBacklash) < 1 || liveEdof.opts.backlash === Math.round(s.backlashEstimate)} title="use this as the backlash override from the next start">Adopt</button></div>
  {/if}
  {#if liveEdof.active && liveEdof.sweepsStopped}<div class="status-line">sweeps stopped (stage stop or standby); Stop and start again to resume</div>{/if}
  {#if liveEdof.active}<div class="muted small">stage moves are refused while sweeping; stop to jog or autofocus</div>{/if}
  {#if liveEdof.error}<div class="status-line err">{liveEdof.error}</div>{/if}
  {#if liveEdof.recording && recorder.status}<div class="muted small">{recorder.status}</div>{/if}
  {#if !liveEdof.recording && recorder.status.startsWith('saved "Video extended focus')}<div class="status-line ok">{recorder.status}</div>{/if}
</div>

<style>
  .edof { display: flex; flex-direction: column; gap: 6px; }
  .edof label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  .edof input, .edof select { width: 100%; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; align-items: end; }
  .grid2 label:first-child { grid-column: 1 / -1; }
  .small { font-size: 12px; }
  @media (max-width: 720px) {
    .grid2 { grid-template-columns: 1fr; }
    .edof .row button { flex: 1 1 auto; }
  }
</style>
