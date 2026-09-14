<script lang="ts">
  /** Time-lapse capture: interval, duration or frame count, source, autofocus every N frames and/or on a
   *  sharpness drop, LED-off between frames, drift correction, AE/AWB lock with periodic re-metering,
   *  frame format and a storage cap. Frames are scheduled on an absolute clock (see the service). */
  import { timelapse, estimateFrameBytes, fmtBytes } from '../lib/services/timelapse.svelte'
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
  let format = $state<'jpeg' | 'png'>('jpeg')
  let afEveryN = $state(0)
  let refocusDropPct = $state(0)
  let ledOff = $state(false)
  let driftCorrect = $state(true)
  let driftThresholdPx = $state(30)
  let lockCam = $state(true)
  let remeterEveryN = $state(0)
  let maxMb = $state(500)

  const estimate = $derived(estimateFrameBytes(source, format) * frames)
  const capBytes = $derived(Math.max(0, Math.round(maxMb)) * 1e6)
  const overCap = $derived(capBytes > 0 && estimate > capBytes)

  let viewing = $state(false)

  function start(): void {
    viewing = false
    void timelapse.start({
      intervalMs, frames, source, autofocusEveryN: afEveryN, refocusDropPct, ledOff, driftCorrect, driftThresholdPx,
      lockCamera: lockCam, remeterEveryN, format, maxBytes: capBytes,
    })
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
    <span class="muted small">→ {frames} frames · ≈{fmtBytes(estimate)}</span>
  </div>
  <div class="row" style="margin-top:6px">
    <select bind:value={source} disabled={timelapse.active}>
      <option value="stream">stream frame</option><option value="full">full-resolution still</option>
    </select>
    <select bind:value={format} disabled={timelapse.active} title="PNG re-encodes the device frame losslessly (about 4× larger); the device frame itself is a JPEG">
      <option value="jpeg">JPEG</option><option value="png">PNG (lossless re-encode)</option>
    </select>
    <label class="chk">cap <input type="number" min="0" step="50" bind:value={maxMb} disabled={timelapse.active} style="width:4.5em" /> MB (0 = none)</label>
  </div>
  <div class="row" style="margin-top:6px">
    <label class="chk">AF every <input type="number" min="0" bind:value={afEveryN} disabled={timelapse.active} style="width:3.5em" /> frames (0 = off)</label>
    <label class="chk" title="autofocus when the frame's sharpness (mean |Laplacian|) falls this far below the best seen so far">AF when sharpness drops <input type="number" min="0" max="90" step="5" bind:value={refocusDropPct} disabled={timelapse.active} style="width:3.5em" /> % (0 = off)</label>
  </div>
  <div class="row" style="margin-top:6px">
    <label class="chk" title="freeze exposure, gain and white balance for the whole run"><input type="checkbox" bind:checked={lockCam} disabled={timelapse.active} /> lock AE/AWB</label>
    {#if lockCam}<label class="chk" title="release the lock every N frames, let the camera meter again, lock again">re-meter every <input type="number" min="0" bind:value={remeterEveryN} disabled={timelapse.active} style="width:3.5em" /> frames (0 = never)</label>{/if}
    <label class="chk"><input type="checkbox" bind:checked={ledOff} disabled={timelapse.active} /> LED off between frames</label>
  </div>
  <div class="row" style="margin-top:6px">
    <label class="chk" title={calibration.csm ? '' : 'needs the stage ↔ camera calibration'}>
      <input type="checkbox" bind:checked={driftCorrect} disabled={timelapse.active || !calibration.csm} /> drift correction
    </label>
    {#if driftCorrect}<label class="chk">threshold <input type="number" min="5" bind:value={driftThresholdPx} disabled={timelapse.active} style="width:3.5em" /> px</label>{/if}
  </div>
  {#if overCap && !timelapse.active}
    <div class="status-line warn">≈{fmtBytes(estimate)} estimated: the run will stop at the {fmtBytes(capBytes)} cap (about {Math.floor(capBytes / estimateFrameBytes(source, format))} frames). Raise the cap, shorten the run or use JPEG stream frames.</div>
  {/if}
  <div class="row" style="margin-top:8px">
    <button class="primary" onclick={start} disabled={timelapse.active || !device.connected}>Start time-lapse</button>
    {#if timelapse.active}<button class="danger" onclick={() => timelapse.stop()}>Stop</button>{/if}
  </div>
  {#if timelapse.active}
    <div class="status-line busy">{timelapse.status} ({timelapse.captured}/{timelapse.total}){timelapse.corrections ? ` · ${timelapse.corrections} drift correction(s)` : ''}{timelapse.refocuses ? ` · ${timelapse.refocuses} refocus` : ''}{timelapse.skipped ? ` · ${timelapse.skipped} skipped` : ''}</div>
  {:else if timelapse.status}
    <div class="status-line ok">{timelapse.status}</div>
  {/if}
  {#if timelapse.warning}<div class="status-line warn">{timelapse.warning}</div>{/if}
  {#if timelapse.lastItem && !timelapse.active}
    <div class="row" style="margin-top:6px"><button onclick={() => (viewing = true)}>Open in viewer</button></div>
  {/if}
</div>
{#if viewing && timelapse.lastItem}<Viewer item={timelapse.lastItem} onclose={() => (viewing = false)} />{/if}

<style>
  .chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
  .warn { color: #e0a030; }
</style>
