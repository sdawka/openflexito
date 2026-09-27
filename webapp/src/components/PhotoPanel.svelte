<script lang="ts">
  /** Capture: photos (one button, five modes with their parameters) and video recording of what the
   *  live view shows (the stream, or the live focus stack when it is on). Live processing (denoise,
   *  deflicker, look) is set up in the Camera and Look panels; recording only adds stabilisation,
   *  burn-in and the encoder choice. */
  import { device } from '../lib/store/device.svelte'
  import { fetchSnapshot } from '../lib/api/snapshot'
  import { saveSnapshot } from '../lib/store/gallery'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import { takePhoto, type PhotoMode } from '../lib/services/photoService'
  import { recorder, Recorder, type VideoCodec, type VideoContainer, type VideoQuality } from '../lib/services/recorder.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { macroService } from '../lib/services/macro.svelte'
  import { BURN_IN_KINDS, type BurnInKind } from '../lib/services/burnIn'

  /** What the panel offers; each maps onto one or more `PhotoMode`s of `photoService` (see `photoMode`). */
  type Choice = 'single' | 'raw' | 'stack' | 'hdr' | 'superres'
  const choices: { id: Choice; label: string; blurb: string; time: string }[] = [
    { id: 'single', label: 'Photo', blurb: 'Full-resolution 8-bit JPEG.', time: '~2 s' },
    { id: 'raw', label: 'RAW', blurb: '10-bit sensor data developed in the browser (shading, colour matrix, camera gamma) to a 16-bit PNG, plus a DNG. With more than one frame the device averages them first (√N less shot noise).', time: '~25 s' },
    { id: 'stack', label: 'Focus stack', blurb: 'Autofocus finds the focus plane and the depth of the sharpness peak; slices spread over it are aligned and fused in a Laplacian pyramid. Ends on the focus plane.', time: '~3 s per slice (~30 s from RAW)' },
    { id: 'hdr', label: 'HDR', blurb: 'Highlights and shadows both keep detail. JPEG: the scene at several LED levels, fused (AE/AWB locked meanwhile). RAW: a linear exposure bracket merged into one radiance image and tone-mapped to a 16-bit PNG.', time: '~10 s (JPEG) · ~40 s (RAW)' },
    { id: 'superres', label: 'Super-resolution', blurb: 'A 2×2 or 3×3 pattern of full-resolution stills, shifted by sub-pixel stage offsets (needs the stage↔camera calibration), registered and drizzled onto a finer grid.', time: '~3 s per frame + fusing' },
  ]

  let choice = $state<Choice>('single')
  let rawFrames = $state(1)
  let stackSlices = $state(9)
  let stackRange = $state(1000)
  let stackRaw = $state(false)
  let stackMethod = $state<'pyramid' | 'hybrid'>('pyramid')
  let hdrSource = $state<'jpeg' | 'raw'>('jpeg')
  let ledLevelsText = $state('0.4,0.7,1,1.5')
  let hdrFactorsText = $state('0.25,1,4')
  let superresScale = $state<2 | 3>(settings.superresScale)
  let superresExtraFrames = $state(0)
  let superresPixfrac = $state(settings.superresPixfrac)
  let superresSharpen = $state(settings.superresSharpen)
  let superresRaw = $state(false)
  let busy = $state(false)
  let status = $state<{ kind: 'busy' | 'ok' | 'err'; text: string } | null>(null)

  const current = $derived(choices.find((c) => c.id === choice)!)
  const photoMode = $derived.by((): PhotoMode => {
    switch (choice) {
      case 'raw': return rawFrames > 1 ? 'rawavg' : 'raw'
      case 'stack': return stackRaw ? 'focusfineraw' : 'focusfine'
      case 'hdr': return hdrSource === 'raw' ? 'hdrraw' : 'exposure'
      default: return choice
    }
  })
  const usesRawFrames = $derived(photoMode === 'raw' || photoMode === 'rawavg' || photoMode === 'focusfineraw' || photoMode === 'hdrraw' || (photoMode === 'superres' && superresRaw))
  /** One-line advice when the link is slow: hotspot, or a measured stream rate under ~30 Mbit/s
   *  (README "Networking": that is roughly the WiFi 2.4 GHz / hotspot band, where a RAW frame's
   *  ~16 MB takes several seconds instead of the ~0.5 s an Ethernet cable gives). */
  const netAdvice = $derived.by(() => {
    if (!usesRawFrames) return null
    const net = device.status?.network
    const mbps = device.streamKBs > 0 ? (device.streamKBs * 8) / 1000 : null
    const slow = net?.link === 'hotspot' || net?.state === 'hotspot' || (mbps != null && mbps < 30)
    if (!slow) return null
    const rawMB = 16
    const secPerFrame = mbps ? (rawMB * 8) / mbps : null
    const est = secPerFrame ? `~${secPerFrame < 10 ? secPerFrame.toFixed(1) : Math.round(secPerFrame)} s per RAW frame at the measured rate` : 'several seconds per RAW frame on this link'
    return `Slow link (${net?.link === 'hotspot' || net?.state === 'hotspot' ? 'hotspot' : 'WiFi'}): ${est} — plug in an Ethernet cable for ~0.5 s per RAW frame.`
  })

  /** Parse a comma/space-separated list of positive numbers; falls back to `fallback` if empty/invalid. */
  function parseNums(text: string, fallback: number[]): number[] {
    const nums = text.split(/[,\s]+/).map((s) => +s).filter((n) => Number.isFinite(n) && n > 0)
    return nums.length ? nums : fallback
  }

  async function photo() {
    busy = true; status = { kind: 'busy', text: 'starting…' }
    const mode = photoMode
    const isStack = choice === 'stack'
    try {
      const item = await takePhoto({
        mode, slices: isStack ? stackSlices : undefined, range: isStack ? stackRange : undefined,
        method: isStack ? stackMethod : undefined,
        frames: mode === 'rawavg' ? rawFrames : undefined,
        bracket: mode === 'exposure' ? 'led' : undefined,
        levels: mode === 'exposure' ? parseNums(ledLevelsText, [0.4, 0.7, 1, 1.5]) : mode === 'hdrraw' ? parseNums(hdrFactorsText, [0.25, 1, 4]) : undefined,
        superres: mode === 'superres' ? { scale: superresScale, pixfrac: superresPixfrac, extraFrames: superresExtraFrames, sharpen: superresSharpen && !superresRaw, raw: superresRaw } : undefined,
        onProgress: (m) => (status = { kind: 'busy', text: m }),
      })
      status = { kind: 'ok', text: `saved "${item.name}" to the gallery` }
      macroService.recordAction('photo', { mode, slices: isStack ? stackSlices : undefined, range: isStack ? stackRange : undefined, frames: mode === 'rawavg' ? rawFrames : undefined }, `photo (${mode})`)
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
  async function download() {
    const blob = await fetchSnapshot({ full: true })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
  function saveSuperresDefaults() { settings.superresScale = superresScale; settings.superresPixfrac = superresPixfrac; settings.superresSharpen = superresSharpen; saveSettings() }

  // ---- video: records what the live view shows ----
  let vidCodec = $state<VideoCodec>(settings.videoCodecPref as VideoCodec)
  let vidContainer = $state<VideoContainer>(settings.videoContainer)
  let vidQuality = $state<Exclude<VideoQuality, object>>(settings.videoQuality)
  let vidStabilise = $state(settings.videoStabilise)
  let vidDeflicker = $state(settings.videoDeflicker)
  let vidRetime = $state(settings.videoRetime)
  let vidRetimeFps = $state(settings.videoRetimeFps)
  let vidBurnIn = $state<BurnInKind[]>((settings.videoBurnIn ?? []).filter((k) => BURN_IN_KINDS.some((b) => b.id === k)) as BurnInKind[])
  const codecSupport = Recorder.codecSupport()
  const recordingStack = $derived(liveStack.active && !!liveStack.composite)
  const sourceLabel = $derived(recordingStack ? (liveStack.mode === 'average' ? 'smoothed view' : 'live stack') : 'live view')

  function saveVideoDefaults() {
    settings.videoCodecPref = vidCodec; settings.videoContainer = vidContainer; settings.videoQuality = vidQuality
    settings.videoStabilise = vidStabilise; settings.videoDeflicker = vidDeflicker
    settings.videoRetime = vidRetime; settings.videoRetimeFps = vidRetimeFps
    settings.videoBurnIn = [...vidBurnIn]
    saveSettings()
  }
  function toggleBurnIn(k: BurnInKind, on: boolean) {
    vidBurnIn = on ? [...new Set([...vidBurnIn, k])] : vidBurnIn.filter((x) => x !== k)
    saveVideoDefaults()
  }
  function toggleRecord() {
    if (recorder.recording) { void recorder.stop().then((i) => { if (i) status = { kind: 'ok', text: `saved "${i.name}"` } }); return }
    const opts = {
      container: vidContainer, codec: vidCodec, quality: vidQuality, keyframeS: settings.videoKeyframeS,
      stabilize: vidStabilise, deflicker: vidDeflicker, retime: vidRetime, retimeFps: vidRetimeFps, burnIn: [...vidBurnIn],
    }
    if (recordingStack) {
      // the live stack is already a temporally smoothed composite (not a raw <img>), so it keeps
      // using the polled FrameSource path; stabilisation is for the raw stream's jitter.
      recorder.start(() => {
        const b = liveStack.composite
        return b ? { image: b, width: b.width, height: b.height } : null
      }, sourceLabel, { ...opts, stabilize: false })
    } else {
      recorder.startStream(sourceLabel, opts)
    }
    if (recorder.status) status = { kind: 'err', text: recorder.status }
  }
</script>

<div class="panel">
  <h3>Photo</h3>
  <div class="row">
    <button class="primary big" onclick={photo} disabled={busy || !device.connected}>{busy ? 'Working…' : 'Take photo'}</button>
    <button onclick={quickFrame} disabled={busy} title="save the current stream frame as it is (fast, lower resolution)">Quick frame</button>
    <button onclick={download} disabled={busy} title="download a full-resolution JPEG without saving it to the gallery">↓</button>
  </div>
  <div class="kv" style="margin-top:10px"><span>Mode</span><span class="v muted" style="color:var(--muted)">{current.time}</span></div>
  <select bind:value={choice} disabled={busy} style="width:100%" aria-label="capture mode">
    {#each choices as c}<option value={c.id}>{c.label}</option>{/each}
  </select>
  <p class="blurb">{current.blurb}</p>
  {#if netAdvice}<p class="blurb" style="color:var(--warn)">{netAdvice}</p>{/if}
  {#if choice === 'raw'}
    <div class="params">
      <label title="1 = a single raw frame; more are averaged on the device in one mode switch (√N less shot noise)">Frames <input type="number" min="1" max="8" aria-label="raw frames" bind:value={rawFrames} disabled={busy} /></label>
    </div>
  {:else if choice === 'stack'}
    <div class="params">
      <label>Slices <input type="number" min="3" max="31" aria-label="focus stack slices" bind:value={stackSlices} disabled={busy} /></label>
      <label>Search range
        <select bind:value={stackRange} disabled={busy}>
          <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option>
        </select>
      </label>
      <label class="chk" title="every slice developed from RAW and fused at 16 bits into a lossless PNG (much slower)"><input type="checkbox" aria-label="stack from raw" bind:checked={stackRaw} disabled={busy} /> From RAW</label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="params">
        <label title="pyramid: standard Laplacian-pyramid fusion. hybrid: additionally runs a Zerene DMap-style depth-guided refinement pass (more expensive).">Fusion method
          <select bind:value={stackMethod} disabled={busy}>
            <option value="pyramid">Pyramid</option>
            <option value="hybrid">Hybrid (DMap-style)</option>
          </select>
        </label>
      </div>
    </details>
  {:else if choice === 'hdr'}
    <div class="params">
      <label>Source
        <select bind:value={hdrSource} disabled={busy} aria-label="hdr source">
          <option value="jpeg">JPEG, LED levels (fused)</option>
          <option value="raw">RAW, exposure bracket</option>
        </select>
      </label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="params">
        {#if hdrSource === 'jpeg'}
          <label title="LED brightness factors relative to the current level, comma-separated">LED levels <input style="width:11em" bind:value={ledLevelsText} disabled={busy} /></label>
        {:else}
          <label title="exposure-time multipliers for the linear-RAW bracket, comma-separated (at least two)">Exposure factors <input style="width:11em" bind:value={hdrFactorsText} disabled={busy} /></label>
        {/if}
      </div>
    </details>
  {:else if choice === 'superres'}
    <div class="params">
      <label>Scale
        <select bind:value={superresScale} disabled={busy} onchange={saveSuperresDefaults}>
          <option value={2}>2× (2×2 pattern)</option>
          <option value={3}>3× (3×3 pattern)</option>
        </select>
      </label>
      <label class="chk" title={superresRaw ? 'not implemented for RAW planes (linear 16-bit, not the JPEG pipeline the PSF model was derived for)' : 'post-drizzle Wiener deconvolution against the drizzle-drop + pixel-aperture PSF'}>
        <input type="checkbox" bind:checked={superresSharpen} disabled={busy || superresRaw} onchange={saveSuperresDefaults} /> Sharpen
      </label>
    </div>
    <details class="adv">
      <summary>Advanced</summary>
      <div class="params">
        <label title="drizzle drop size relative to one input pixel (0, 1]; smaller = sharper but more holes at few frames">Pixfrac <input type="number" min="0.1" max="1" step="0.05" style="width:5em" bind:value={superresPixfrac} disabled={busy} onchange={saveSuperresDefaults} /></label>
        <label title="extra randomised sub-pixel frames beyond the grid, for redundancy against a rejected frame">Extra frames <input type="number" min="0" max="20" step="1" style="width:5em" bind:value={superresExtraFrames} disabled={busy} /></label>
        <label class="chk" title="each grid frame is a whole /raw.bin record, drizzled directly as Bayer planes with no demosaic step — sharper but much slower over WiFi, and sharpen is not available">
          <input type="checkbox" bind:checked={superresRaw} disabled={busy} /> RAW planes (no demosaic, slow)
        </label>
      </div>
    </details>
  {/if}

  <h4>Video</h4>
  <div class="row">
    <button class="rec" class:on={recorder.recording} onclick={toggleRecord} disabled={!device.connected} title="record what the live view shows (the live focus stack when it is on) into the gallery">
      <span class="dot"></span>{recorder.recording ? `Stop · ${recorder.seconds} s` : 'Record video'}
    </button>
    {#if recorder.recording}<span class="muted small">recording the {sourceLabel} · {recorder.frames} frames{#if recorder.detail} · {recorder.detail}{/if}</span>{/if}
    {#if recorder.status && !recorder.recording}<span class="muted small">{recorder.status}</span>{/if}
  </div>
  {#if !recorder.recording}
    <p class="blurb">Records what the live view shows, including live denoise (Camera panel, "also apply while recording") and, if baked, the look. For slow processes use the Time-lapse tool.</p>
    <div class="params">
      <label class="chk" title="removes vibration jitter from the live view with a small crop margin; suspended while the stage moves"><input type="checkbox" bind:checked={vidStabilise} onchange={saveVideoDefaults} /> Stabilise</label>
      <label class="chk" title="normalises per-frame brightness (LED driver / mains flicker) before encoding"><input type="checkbox" bind:checked={vidDeflicker} onchange={saveVideoDefaults} /> Deflicker</label>
      <label class="chk" title="apply the Look panel's LUT, curves and levels (as shown on the live view) to the recorded frames"><input type="checkbox" bind:checked={settings.lookBakeIntoRecording} onchange={saveSettings} /> Bake look</label>
    </div>
    <details class="adv">
      <summary>Encoding and overlays</summary>
      <div class="params">
        <label>Container
          <select bind:value={vidContainer} onchange={saveVideoDefaults}>
            <option value="mp4">MP4</option>
            <option value="webm">WebM</option>
          </select>
        </label>
        <label>Codec
          <select bind:value={vidCodec} onchange={saveVideoDefaults}>
            <option value="auto">Auto</option>
            <option value="h264" disabled={!codecSupport.h264}>H.264{codecSupport.h264 ? '' : ' (unsupported)'}</option>
            <option value="vp9" disabled={!codecSupport.vp9}>VP9{codecSupport.vp9 ? '' : ' (unsupported)'}</option>
            <option value="av1" disabled={!codecSupport.av1}>AV1{codecSupport.av1 ? '' : ' (unsupported)'}</option>
          </select>
        </label>
        <label>Quality
          <select bind:value={vidQuality} onchange={saveVideoDefaults}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label title="variable: every frame at its true device time (scientifically honest); constant: re-timed to a fixed rate, the current frame repeated into skipped slots and early frames dropped (what editors and slides expect)">Timing <select bind:value={vidRetime} onchange={saveVideoDefaults}><option value="vfr">Variable (true times)</option><option value="cfr">Constant rate</option></select></label>
        {#if vidRetime === 'cfr'}<label>fps <input type="number" min="1" max="60" style="width:4.5em" bind:value={vidRetimeFps} onchange={saveVideoDefaults} /></label>{/if}
      </div>
      <div class="params burnin">
        <span class="muted small">Burn in:</span>
        {#each BURN_IN_KINDS as b}
          <label class="chk" title={b.title}><input type="checkbox" checked={vidBurnIn.includes(b.id)} onchange={(e) => toggleBurnIn(b.id, (e.currentTarget as HTMLInputElement).checked)} /> {b.label}</label>
        {/each}
      </div>
    </details>
  {/if}
  {#if status}<div class="status-line {status.kind}">{status.text}</div>{/if}
  {#if device.frame}<div class="muted small" style="margin-top:6px">stream {(device.frame.size / 1024).toFixed(0)} kB/frame · {device.status?.camera?.stream_size?.join('×')}</div>{/if}
</div>

<style>
  button.big { padding: 8px 16px; font-weight: 600; }
  h4 { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .rec .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--err); margin-right: 7px; vertical-align: -1px; }
  .rec.on { border-color: var(--err); background: #3a1f24; }
  .rec.on .dot { animation: blink 1s steps(2) infinite; }
  @keyframes blink { to { opacity: .2; } }
  .blurb { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
  .params { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px; }
  .params label { margin: 0; display: flex; flex-direction: column; gap: 3px; }
  .params label.chk { flex-direction: row; align-items: center; gap: 6px; }
  .params input[type=number] { width: 5.5em; }
  .small { font-size: 11px; }
  .adv { margin-top: 6px; }
  .adv summary { cursor: pointer; font-size: 12px; color: var(--muted); }
  .burnin { gap: 6px 10px; align-items: center; }
  .burnin label { font-size: 12px; }

  @media (max-width: 720px) {
    .params { flex-direction: column; align-items: stretch; gap: 6px; }
    .params label { flex-direction: row; align-items: center; gap: 8px; }
    .params input, .params select { min-width: 64px; flex: 1; }
  }
</style>
