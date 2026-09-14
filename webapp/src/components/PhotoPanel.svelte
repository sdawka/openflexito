<script lang="ts">
  /** Photo capture: one big button, a mode chooser, mode-specific parameters, a status line. */
  import { device } from '../lib/store/device.svelte'
import { fetchSnapshot, fetchSnapshotBitmap } from '../lib/api/snapshot'
  import { saveSnapshot } from '../lib/store/gallery'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import { takePhoto, type PhotoMode } from '../lib/services/photoService'
  import type { BracketKind } from '../lib/services/photo/exposureStack'
  import { recorder, Recorder, type VideoCodec } from '../lib/services/recorder.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { macroService } from '../lib/services/macro.svelte'

  let mode = $state<PhotoMode>('single')
  let slices = $state(5)
  let stepZ = $state(50)
  let fineSlices = $state(9)
  let fineRange = $state(1000)
  let fineMethod = $state<'pyramid' | 'hybrid'>('pyramid')
  let rawavgFrames = $state(4)
  let bracket = $state<BracketKind>('led')
  let ledLevelsText = $state('0.4,0.7,1,1.5')
  let exposureFactorsText = $state('0.5,1,2')
  let hdrFactorsText = $state('0.25,1,4')
  let superresScale = $state<2 | 3>(settings.superresScale)
  let superresExtraFrames = $state(0)
  let superresPixfrac = $state(settings.superresPixfrac)
  let superresSharpen = $state(settings.superresSharpen)
  let superresRaw = $state(false)
  let busy = $state(false)
  let status = $state<{ kind: 'busy' | 'ok' | 'err'; text: string } | null>(null)
  let vidCodec = $state<VideoCodec>(settings.videoCodec as VideoCodec)
  let vidBitrate = $state(settings.videoBitrateMbps)
  let vidStabilise = $state(settings.videoStabilise)
  const codecSupport = Recorder.codecSupport()

  /** Parse a comma/space-separated list of positive numbers; falls back to `fallback` if empty/invalid. */
  function parseNums(text: string, fallback: number[]): number[] {
    const nums = text.split(/[,\s]+/).map((s) => +s).filter((n) => Number.isFinite(n) && n > 0)
    return nums.length ? nums : fallback
  }

  const modes: { id: PhotoMode; label: string; blurb: string; time: string }[] = [
    { id: 'single', label: 'Single', blurb: 'Full-resolution 8-bit JPEG.', time: '~2 s' },
    { id: 'raw', label: 'RAW', blurb: '10-bit sensor data developed in the browser (shading, colour matrix, camera gamma) to a 16-bit PNG, plus a DNG.', time: '~25 s' },
    { id: 'rawavg', label: 'RAW average', blurb: 'N raw frames averaged on the device in one mode switch (√N less shot noise), then developed like RAW.', time: '~25 s' },
    { id: 'focus', label: 'Quick stack', blurb: 'Slices around the current z, aligned, merged by local sharpness.', time: '~4 s per slice' },
    { id: 'focusfine', label: 'Fine stack', blurb: 'Autofocus finds the focus plane and the depth of the sharpness peak; slices spread over it are aligned and fused in a Laplacian pyramid. Ends on the focus plane.', time: '~3 s per slice' },
    { id: 'focusfineraw', label: 'Fine stack from RAW', blurb: 'The fine stack with every slice developed from RAW and fused at 16 bits into a lossless PNG.', time: '~30 s per slice' },
    { id: 'exposure', label: 'LED exposure stack', blurb: 'The scene at several LED and/or exposure levels, fused so highlights and shadows both keep detail (exposure fusion). Auto exposure/white balance are locked meanwhile.', time: '~10 s' },
    { id: 'hdrraw', label: 'HDR (RAW)', blurb: 'True HDR: a linear-RAW exposure bracket merged into one radiance image (Debevec) and tone-mapped to a 16-bit PNG — a real dynamic-range extension, not just fused-looking.', time: '~40 s' },
    { id: 'superres', label: 'Super-resolution', blurb: 'A 2×2 or 3×3 pattern of full-resolution stills, shifted by sub-pixel stage offsets (needs the stage↔camera calibration), registered and drizzled onto a finer grid.', time: '~3 s per frame + fusing' },
  ]
  const current = $derived(modes.find((m) => m.id === mode)!)
  const isRawFrameMode = $derived(mode === 'raw' || mode === 'rawavg' || mode === 'focusfineraw' || mode === 'hdrraw' || (mode === 'superres' && superresRaw))
  /** One-line advice when the link is slow: hotspot, or a measured stream rate under ~30 Mbit/s
   *  (README "Networking": that is roughly the WiFi 2.4 GHz / hotspot band, where a RAW frame's
   *  ~16 MB takes several seconds instead of the ~0.5 s an Ethernet cable gives). */
  const netAdvice = $derived.by(() => {
    if (!isRawFrameMode) return null
    const net = device.status?.network
    const mbps = device.streamKBs > 0 ? (device.streamKBs * 8) / 1000 : null
    const slow = net?.link === 'hotspot' || net?.state === 'hotspot' || (mbps != null && mbps < 30)
    if (!slow) return null
    const rawMB = 16
    const secPerFrame = mbps ? (rawMB * 8) / mbps : null
    const est = secPerFrame ? `~${secPerFrame < 10 ? secPerFrame.toFixed(1) : Math.round(secPerFrame)} s per RAW frame at the measured rate` : 'several seconds per RAW frame on this link'
    return `Slow link (${net?.link === 'hotspot' || net?.state === 'hotspot' ? 'hotspot' : 'WiFi'}): ${est} — plug in an Ethernet cable for ~0.5 s per RAW frame.`
  })
  const isFine = $derived(mode === 'focusfine' || mode === 'focusfineraw')
  const isSuperres = $derived(mode === 'superres')
  const isExposure = $derived(mode === 'exposure')
  const isHdrRaw = $derived(mode === 'hdrraw')
  const isRawavg = $derived(mode === 'rawavg')
  const stackSpan = $derived(Math.floor((slices - 1) / 2) * stepZ)

  async function photo() {
    busy = true; status = { kind: 'busy', text: 'starting…' }
    try {
      const item = await takePhoto({
        mode, slices: isFine ? fineSlices : slices, stepZ, range: fineRange,
        method: isFine ? fineMethod : undefined,
        frames: isRawavg ? rawavgFrames : undefined,
        bracket: isExposure ? bracket : undefined,
        levels: isExposure ? parseNums(ledLevelsText, [0.4, 0.7, 1, 1.5]) : isHdrRaw ? parseNums(hdrFactorsText, [0.25, 1, 4]) : undefined,
        factors: isExposure ? parseNums(exposureFactorsText, [0.5, 1, 2]) : undefined,
        superres: isSuperres ? { scale: superresScale, pixfrac: superresPixfrac, extraFrames: superresExtraFrames, sharpen: superresSharpen && !superresRaw, raw: superresRaw } : undefined,
        onProgress: (m) => (status = { kind: 'busy', text: m }),
      })
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
    const opts = { codec: vidCodec, bitrateMbps: vidBitrate, stabilize: vidStabilise }
    if (useStack) {
      // the live stack is already a temporally smoothed composite (not a raw <img>), so it keeps
      // using the polled FrameSource path; stabilisation is for the raw stream's jitter.
      recorder.start(() => {
        const b = liveStack.composite
        return b ? { image: b, width: b.width, height: b.height } : null
      }, liveStack.mode === 'average' ? 'smoothed view' : 'live stack', { ...opts, stabilize: false })
    } else {
      recorder.startStream('live view', opts)
    }
    if (recorder.status) status = { kind: 'err', text: recorder.status }
  }
  async function download() {
    const blob = await fetchSnapshot({ full: true })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
  function saveVideoDefaults() { settings.videoCodec = vidCodec; settings.videoBitrateMbps = vidBitrate; settings.videoStabilise = vidStabilise; saveSettings() }
  function saveSuperresDefaults() { settings.superresScale = superresScale; settings.superresPixfrac = superresPixfrac; settings.superresSharpen = superresSharpen; saveSettings() }
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
    {#if recorder.recording}<span class="muted small">recording {liveStack.active && liveStack.composite ? (liveStack.mode === 'average' ? 'the smoothed view' : 'the live stack') : 'the live view'} · {recorder.frames} frames</span>{/if}
    {#if recorder.status && !recorder.recording}<span class="muted small">{recorder.status}</span>{/if}
  </div>
  {#if !recorder.recording}
    <div class="params" style="margin-top:6px">
      <label>Codec
        <select bind:value={vidCodec} disabled={busy} onchange={saveVideoDefaults}>
          <option value="vp9">VP9</option>
          <option value="av1" disabled={!codecSupport.av1}>AV1{codecSupport.av1 ? '' : ' (unsupported)'}</option>
          <option value="vp8">VP8</option>
        </select>
      </label>
      <label>Bitrate (Mbit/s) <input type="number" min="1" max="50" step="1" style="width:5em" bind:value={vidBitrate} disabled={busy} onchange={saveVideoDefaults} /></label>
      <label style="flex-direction:row;align-items:center;gap:6px" title="removes hand/vibration jitter from the live view with a small crop margin; not needed for the live stack, which is already smoothed">
        <input type="checkbox" bind:checked={vidStabilise} disabled={busy} onchange={saveVideoDefaults} /> Stabilise
      </label>
    </div>
  {/if}
  <div class="kv" style="margin-top:10px"><span>Mode</span><span class="v muted" style="color:var(--muted)">{current.time}</span></div>
  <select bind:value={mode} disabled={busy} style="width:100%" aria-label="capture mode">
    {#each modes as m}<option value={m.id}>{m.label}</option>{/each}
  </select>
  <p class="blurb">{current.blurb}</p>
  {#if netAdvice}<p class="blurb" style="color:var(--warn)">{netAdvice}</p>{/if}
  {#if mode === 'focus'}
    <div class="params">
      <label>Slices <input type="number" min="2" max="15" aria-label="focus stack slices" bind:value={slices} disabled={busy} /></label>
      <label>Δz (steps) <input type="number" min="1" max="2000" bind:value={stepZ} disabled={busy} /></label>
      <span class="muted small">covers z ±{stackSpan}</span>
    </div>
  {:else if isFine}
    <div class="params">
      <label>Slices <input type="number" min="3" max="31" aria-label="focus stack slices" bind:value={fineSlices} disabled={busy} /></label>
      <label>Search range
        <select bind:value={fineRange} disabled={busy}>
          <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option>
        </select>
      </label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="params">
        <label title="pyramid: standard Laplacian-pyramid fusion. hybrid: additionally runs a Zerene DMap-style depth-guided refinement pass (more expensive).">Fusion method
          <select bind:value={fineMethod} disabled={busy}>
            <option value="pyramid">Pyramid</option>
            <option value="hybrid">Hybrid (DMap-style)</option>
          </select>
        </label>
      </div>
    </details>
  {:else if isRawavg}
    <div class="params">
      <label title="the device averages N raw frames in one mode switch before sending them (√N less shot noise)">Frames <input type="number" min="2" max="8" bind:value={rawavgFrames} disabled={busy} /></label>
    </div>
  {:else if isExposure}
    <div class="params">
      <label>Bracket
        <select bind:value={bracket} disabled={busy}>
          <option value="led">LED levels</option>
          <option value="exposure">Exposure time (device-locked)</option>
          <option value="both">LED + exposure</option>
        </select>
      </label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="params">
        {#if bracket === 'led' || bracket === 'both'}
          <label title="LED brightness factors relative to the current level, comma-separated">LED levels <input style="width:11em" bind:value={ledLevelsText} disabled={busy} /></label>
        {/if}
        {#if bracket === 'exposure' || bracket === 'both'}
          <label title="exposure-time multipliers relative to the metered exposure, comma-separated (device /bracket.bin, gain and colour gains frozen)">Exposure factors <input style="width:11em" bind:value={exposureFactorsText} disabled={busy} /></label>
        {/if}
      </div>
    </details>
  {:else if isHdrRaw}
    <div class="params">
      <label title="exposure-time multipliers for the linear-RAW bracket, comma-separated (at least two)">Exposure factors <input style="width:11em" bind:value={hdrFactorsText} disabled={busy} /></label>
    </div>
  {:else if isSuperres}
    <div class="params">
      <label>Scale
        <select bind:value={superresScale} disabled={busy} onchange={saveSuperresDefaults}>
          <option value={2}>2× (2×2 pattern)</option>
          <option value={3}>3× (3×3 pattern)</option>
        </select>
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px" title={superresRaw ? 'not implemented for RAW planes (linear 16-bit, not the JPEG pipeline the PSF model was derived for)' : 'post-drizzle Wiener deconvolution against the drizzle-drop + pixel-aperture PSF'}>
        <input type="checkbox" bind:checked={superresSharpen} disabled={busy || superresRaw} onchange={saveSuperresDefaults} /> Sharpen
      </label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="params">
        <label title="drizzle drop size relative to one input pixel (0, 1]; smaller = sharper but more holes at few frames">Pixfrac <input type="number" min="0.1" max="1" step="0.05" style="width:5em" bind:value={superresPixfrac} disabled={busy} onchange={saveSuperresDefaults} /></label>
        <label title="extra randomised sub-pixel frames beyond the grid, for redundancy against a rejected frame">Extra frames <input type="number" min="0" max="20" step="1" style="width:5em" bind:value={superresExtraFrames} disabled={busy} /></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="each grid frame is a whole /raw.bin record, drizzled directly as Bayer planes with no demosaic step — sharper but much slower over WiFi, and sharpen is not available">
          <input type="checkbox" bind:checked={superresRaw} disabled={busy} /> RAW planes (no demosaic, slow)
        </label>
      </div>
    </details>
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
  .adv { margin-top: 6px; }
  .adv summary { cursor: pointer; font-size: 12px; color: var(--muted); }
</style>
