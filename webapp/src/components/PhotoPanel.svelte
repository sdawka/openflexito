<script lang="ts">
  /** Photo capture: one big button, a mode chooser, mode-specific parameters, a status line. */
  import { device } from '../lib/store/device.svelte'
import { fetchSnapshot, fetchSnapshotBitmap } from '../lib/api/snapshot'
  import { saveSnapshot } from '../lib/store/gallery'
  import { takePhoto, type PhotoMode } from '../lib/services/photoService'
  import { recorder } from '../lib/services/recorder.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { macroService } from '../lib/services/macro.svelte'

  let mode = $state<PhotoMode>('single')
  let slices = $state(5)
  let stepZ = $state(50)
  let fineSlices = $state(9)
  let fineRange = $state(1000)
  let superresFrames = $state(9)
  let busy = $state(false)
  let status = $state<{ kind: 'busy' | 'ok' | 'err'; text: string } | null>(null)

  const modes: { id: PhotoMode; label: string; blurb: string; time: string }[] = [
    { id: 'single', label: 'Single', blurb: 'Full-resolution 8-bit JPEG.', time: '~2 s' },
    { id: 'raw', label: 'RAW', blurb: '10-bit sensor data developed in the browser (shading, colour matrix, camera gamma) to a 16-bit PNG, plus a DNG.', time: '~25 s' },
    { id: 'focus', label: 'Quick stack', blurb: 'Slices around the current z, aligned, merged by local sharpness.', time: '~4 s per slice' },
    { id: 'focusfine', label: 'Fine stack', blurb: 'Autofocus finds the focus plane and the depth of the sharpness peak; slices spread over it are aligned and fused in a Laplacian pyramid. Ends on the focus plane.', time: '~3 s per slice' },
    { id: 'focusfineraw', label: 'Fine stack from RAW', blurb: 'The fine stack with every slice developed from RAW and fused at 16 bits into a lossless PNG.', time: '~30 s per slice' },
    { id: 'exposure', label: 'LED exposure stack', blurb: 'The scene at several LED levels, fused so highlights and shadows both keep detail (exposure fusion). Auto exposure is locked meanwhile.', time: '~10 s' },
    { id: 'superres', label: 'Super-resolution', blurb: 'A 3×3 (or similar) pattern of full-resolution stills, shifted by half a pixel between shots (needs the stage↔camera calibration), registered by phase correlation and drizzled onto a 2× grid.', time: '~3 s per frame + fusing' },
  ]
  const current = $derived(modes.find((m) => m.id === mode)!)
  const isFine = $derived(mode === 'focusfine' || mode === 'focusfineraw')
  const isSuperres = $derived(mode === 'superres')
  const stackSpan = $derived(Math.floor((slices - 1) / 2) * stepZ)

  async function photo() {
    busy = true; status = { kind: 'busy', text: 'starting…' }
    try {
      const item = await takePhoto({ mode, slices: isFine ? fineSlices : slices, stepZ, range: fineRange, frames: superresFrames, onProgress: (m) => (status = { kind: 'busy', text: m }) })
      status = { kind: 'ok', text: `saved "${item.name}" to the gallery` }
      macroService.recordAction('photo', { mode, slices: isFine ? fineSlices : slices, stepZ, range: fineRange }, `photo (${mode})`)
      setTimeout(() => { if (status?.kind === 'ok') status = null }, 6000)
    } catch (e) { status = { kind: 'err', text: (e as Error).message } } finally { busy = false }
  }
  async function quickFrame() {
    busy = true
    try {
      const item = await saveSnapshot(await fetchSnapshot(), { position: { ...device.position }, controls: device.controls ?? undefined, name: 'Quick frame' })
      status = { kind: 'ok', text: `saved "${item.name}" (stream frame)` }
      setTimeout(() => { if (status?.kind === 'ok') status = null }, 4000)
    } catch (e) { status = { kind: 'err', text: (e as Error).message } } finally { busy = false }
  }
  function toggleRecord() {
    if (recorder.recording) { void recorder.stop().then((i) => { if (i) status = { kind: 'ok', text: `saved "${i.name}"` } }); return }
    const useStack = liveStack.active && !!liveStack.composite
    recorder.start(() => {
      if (useStack) { const b = liveStack.composite; return b ? { image: b, width: b.width, height: b.height } : null }
      const img = liveStack.source
      return img && img.naturalWidth ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : null
    }, useStack ? (liveStack.mode === 'average' ? 'smoothed view' : 'live stack') : 'live view')
    if (recorder.status) status = { kind: 'err', text: recorder.status }
  }
  async function download() {
    const blob = await fetchSnapshot({ full: true })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
</script>

<div class="panel">
  <h3>Photo</h3>
  <div class="row">
    <button class="primary big" onclick={photo} disabled={busy || !device.connected}>{busy ? 'Working…' : 'Take photo'}</button>
    <button onclick={quickFrame} disabled={busy} title="save the current stream frame as it is (fast, lower resolution)">Quick frame</button>
    <button onclick={download} disabled={busy} title="download a full-resolution JPEG without saving it to the gallery">↓</button>
  </div>
  <div class="row" style="margin-top:8px">
    <button class="rec" class:on={recorder.recording} onclick={toggleRecord} disabled={!device.connected} title="record the live view (or the live focus stack when it is on) as WebM into the gallery">
      <span class="dot"></span>{recorder.recording ? `Stop · ${recorder.seconds} s` : 'Record video'}
    </button>
    {#if recorder.recording}<span class="muted small">recording {liveStack.active && liveStack.composite ? (liveStack.mode === 'average' ? 'the smoothed view' : 'the live stack') : 'the live view'}</span>{/if}
    {#if recorder.status && !recorder.recording}<span class="muted small">{recorder.status}</span>{/if}
  </div>
  <div class="kv" style="margin-top:10px"><span>Mode</span><span class="v muted" style="color:var(--muted)">{current.time}</span></div>
  <select bind:value={mode} disabled={busy} style="width:100%">
    {#each modes as m}<option value={m.id}>{m.label}</option>{/each}
  </select>
  <p class="blurb">{current.blurb}</p>
  {#if mode === 'focus'}
    <div class="params">
      <label>Slices <input type="number" min="2" max="15" bind:value={slices} disabled={busy} /></label>
      <label>Δz (steps) <input type="number" min="1" max="2000" bind:value={stepZ} disabled={busy} /></label>
      <span class="muted small">covers z ±{stackSpan}</span>
    </div>
  {:else if isFine}
    <div class="params">
      <label>Slices <input type="number" min="3" max="31" bind:value={fineSlices} disabled={busy} /></label>
      <label>Search range
        <select bind:value={fineRange} disabled={busy}>
          <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option>
        </select>
      </label>
    </div>
  {:else if isSuperres}
    <div class="params">
      <label>Frames <input type="number" min="4" max="25" step="1" bind:value={superresFrames} disabled={busy} /></label>
      <span class="muted small">square pattern, rounded to the nearest side length</span>
    </div>
  {/if}
  {#if status}<div class="status-line {status.kind}">{status.text}</div>{/if}
  {#if device.frame}<div class="muted small" style="margin-top:6px">stream {(device.frame.size / 1024).toFixed(0)} kB/frame · {device.status?.camera?.stream_size?.join('×')}</div>{/if}
</div>

<style>
  button.big { padding: 8px 16px; font-weight: 600; }
  .rec .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--err); margin-right: 7px; vertical-align: -1px; }
  .rec.on { border-color: var(--err); background: #3a1f24; }
  .rec.on .dot { animation: blink 1s steps(2) infinite; }
  @keyframes blink { to { opacity: .2; } }
  .blurb { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
  .params { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px; }
  .params label { margin: 0; display: flex; flex-direction: column; gap: 3px; }
  .params input[type=number] { width: 5.5em; }
  .small { font-size: 11px; }
</style>
