<script lang="ts">
  /** Time-lapse capture: interval, duration or frame count, source, optional autofocus every N
   *  frames and LED-off between frames, optional drift correction. */
  import { timelapse } from '../lib/services/timelapse.svelte'
  import { calibration } from '../lib/store/calibration.svelte'
  import { device } from '../lib/store/device.svelte'
  import Viewer from './Viewer.svelte'

  const unitMs = { s: 1000, min: 60_000, h: 3_600_000 }

  let intervalValue = $state(5)
  let intervalUnit = $state<'s' | 'min' | 'h'>('s')
  const intervalMs = $derived(Math.max(1000, Math.round(intervalValue * unitMs[intervalUnit])))

  let lengthMode = $state<'count' | 'duration'>('count')
  let frameCount = $state(10)
  let durationValue = $state(5)
  let durationUnit = $state<'min' | 'h'>('min')
  const frames = $derived(lengthMode === 'count'
    ? Math.max(2, Math.round(frameCount))
    : Math.max(2, Math.round((durationValue * unitMs[durationUnit]) / intervalMs)))

  let source = $state<'stream' | 'full'>('stream')
  let afEveryN = $state(0)
  let ledOff = $state(false)
  let driftCorrect = $state(true)
  let driftThresholdPx = $state(30)

  let viewing = $state(false)

  function start(): void {
    viewing = false
    void timelapse.start({ intervalMs, frames, source, autofocusEveryN: afEveryN, ledOff, driftCorrect, driftThresholdPx })
  }
</script>

<div class="panel">
  <h3>Time-lapse</h3>
  <div class="row">
    <label>Every
      <input type="number" min="1" bind:value={intervalValue} disabled={timelapse.active} style="width:4.5em" />
      <select bind:value={intervalUnit} disabled={timelapse.active}>
        <option value="s">s</option><option value="min">min</option><option value="h">h</option>
      </select>
    </label>
  </div>
  <div class="row" style="margin-top:6px">
    <div class="seg">
      <button class:on={lengthMode === 'count'} onclick={() => (lengthMode = 'count')} disabled={timelapse.active}>Frames</button>
      <button class:on={lengthMode === 'duration'} onclick={() => (lengthMode = 'duration')} disabled={timelapse.active}>Duration</button>
    </div>
    {#if lengthMode === 'count'}
      <input type="number" min="2" bind:value={frameCount} disabled={timelapse.active} style="width:5em" />
    {:else}
      <input type="number" min="1" bind:value={durationValue} disabled={timelapse.active} style="width:4.5em" />
      <select bind:value={durationUnit} disabled={timelapse.active}><option value="min">min</option><option value="h">h</option></select>
    {/if}
    <span class="muted small">→ {frames} frames</span>
  </div>
  <div class="row" style="margin-top:6px">
    <select bind:value={source} disabled={timelapse.active}>
      <option value="stream">stream frame</option><option value="full">full-resolution still</option>
    </select>
    <label class="chk">AF every <input type="number" min="0" bind:value={afEveryN} disabled={timelapse.active} style="width:3.5em" /> frames (0 = off)</label>
  </div>
  <div class="row" style="margin-top:6px">
    <label class="chk"><input type="checkbox" bind:checked={ledOff} disabled={timelapse.active} /> LED off between frames</label>
    <label class="chk" title={calibration.csm ? '' : 'needs the stage ↔ camera calibration'}>
      <input type="checkbox" bind:checked={driftCorrect} disabled={timelapse.active || !calibration.csm} /> drift correction
    </label>
    {#if driftCorrect}<label class="chk">threshold <input type="number" min="5" bind:value={driftThresholdPx} disabled={timelapse.active} style="width:3.5em" /> px</label>{/if}
  </div>
  <div class="row" style="margin-top:8px">
    <button class="primary" onclick={start} disabled={timelapse.active || !device.connected}>Start time-lapse</button>
    {#if timelapse.active}<button class="danger" onclick={() => timelapse.stop()}>Stop</button>{/if}
  </div>
  {#if timelapse.active}
    <div class="status-line busy">{timelapse.status} ({timelapse.captured}/{timelapse.total}){timelapse.corrections ? ` · ${timelapse.corrections} drift correction(s)` : ''}</div>
  {:else if timelapse.status}
    <div class="status-line ok">{timelapse.status}</div>
  {/if}
  {#if timelapse.lastItem && !timelapse.active}
    <div class="row" style="margin-top:6px"><button onclick={() => (viewing = true)}>Open in viewer</button></div>
  {/if}
</div>
{#if viewing && timelapse.lastItem}<Viewer item={timelapse.lastItem} onclose={() => (viewing = false)} />{/if}

<style>
  .chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
</style>
