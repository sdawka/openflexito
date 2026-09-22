<script lang="ts">
  /** Photo capture: one big button, a mode chooser, mode-specific parameters, a status line. */
  import { device } from '../lib/store/device.svelte'
import { fetchSnapshot, fetchSnapshotBitmap } from '../lib/api/snapshot'
  import { saveSnapshot } from '../lib/store/gallery'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import { takePhoto, type PhotoMode } from '../lib/services/photoService'
  import type { BracketKind } from '../lib/services/photo/exposureStack'
  import { recorder, Recorder, type VideoCodec, type VideoContainer, type VideoQuality } from '../lib/services/recorder.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { macroService } from '../lib/services/macro.svelte'
  import { VIDEO_MODES, DEFAULT_VIDEO_PARAMS, createVideoMode, modeParamsRecord, videoModeInfo, type VideoModeId, type VideoModeParams } from '../lib/services/video/videoModes'
  import { BURN_IN_KINDS, type BurnInKind } from '../lib/services/video/burnIn'
  import { calibration } from '../lib/store/calibration.svelte'
  import { listColormaps } from '../lib/algo/colormaps'
  import { measure } from '../lib/services/measureService.svelte'

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
  let vidCodec = $state<VideoCodec>(settings.videoCodecPref as VideoCodec)
  let vidContainer = $state<VideoContainer>(settings.videoContainer)
  let vidQuality = $state<Exclude<VideoQuality, object>>(settings.videoQuality)
  let vidKeyframeS = $state(settings.videoKeyframeS)
  let vidStabilise = $state(settings.videoStabilise)
  let vidDeflicker = $state(settings.videoDeflicker)
  const codecSupport = Recorder.codecSupport()
  // ---- video mode (services/video/videoModes.ts): the recording counterpart of the photo modes ----
  let vidMode = $state<VideoModeId>((VIDEO_MODES.some((m) => m.id === settings.videoMode) ? settings.videoMode : 'plain') as VideoModeId)
  let vidParams = $state<VideoModeParams>(mergeParams(settings.videoModeParams))
  let vidBurnIn = $state<BurnInKind[]>((settings.videoBurnIn ?? []).filter((k) => BURN_IN_KINDS.some((b) => b.id === k)) as BurnInKind[])
  const vidInfo = $derived(videoModeInfo(vidMode))
  const colormaps = listColormaps()
  function mergeParams(saved: Record<string, Record<string, unknown>> | undefined): VideoModeParams {
    const out = structuredClone(DEFAULT_VIDEO_PARAMS) as unknown as Record<string, Record<string, unknown>>
    for (const [k, v] of Object.entries(saved ?? {})) if (out[k] && v && typeof v === 'object') out[k] = { ...out[k], ...v }
    return out as unknown as VideoModeParams
  }
  function saveVideoMode() {
    settings.videoMode = vidMode
    settings.videoModeParams = $state.snapshot(vidParams) as unknown as Record<string, Record<string, unknown>>
    settings.videoBurnIn = [...vidBurnIn]
    saveSettings()
  }
  function toggleBurnIn(k: BurnInKind, on: boolean) {
    vidBurnIn = on ? [...new Set([...vidBurnIn, k])] : vidBurnIn.filter((x) => x !== k)
    saveVideoMode()
  }
  /** Why the chosen video mode cannot start right now, or null. */
  const vidBlock = $derived.by(() => {
    if (vidInfo.drivesStage && device.moving) return 'the stage is moving'
    if (vidInfo.needsLed && !(device.light.cc > 0)) return 'the main LED is off'
    if (vidMode === 'superres' && !calibration.csm) return null   // allowed: falls back to a 1-step dither
    return null
  })

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
    if (vidBlock) { status = { kind: 'err', text: `cannot start ${vidInfo.label}: ${vidBlock}` }; return }
    const useStack = liveStack.active && !!liveStack.composite
    let mode
    try { mode = createVideoMode(vidMode, $state.snapshot(vidParams) as VideoModeParams) } catch (e) { status = { kind: 'err', text: (e as Error).message }; return }
    const opts = {
      container: vidContainer, codec: vidCodec, quality: vidQuality, keyframeS: vidKeyframeS, stabilize: vidStabilise, deflicker: vidDeflicker,
      mode, modeInfo: { label: vidInfo.label, params: modeParamsRecord(vidMode, $state.snapshot(vidParams) as VideoModeParams) }, burnIn: [...vidBurnIn],
    }
    // "Video extended depth of field 5 s" but "Video HDR (LED alternation) 5 s": only a leading capital before lowercase is lowered
    const label = vidMode === 'plain' ? 'live view' : vidInfo.label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())
    if (useStack) {
      // the live stack is already a temporally smoothed composite (not a raw <img>), so it keeps
      // using the polled FrameSource path; stabilisation is for the raw stream's jitter.
      recorder.start(() => {
        const b = liveStack.composite
        return b ? { image: b, width: b.width, height: b.height } : null
      }, vidMode === 'plain' ? (liveStack.mode === 'average' ? 'smoothed view' : 'live stack') : label, { ...opts, stabilize: false })
    } else {
      recorder.startStream(label, opts)
    }
    if (recorder.status) status = { kind: 'err', text: recorder.status }
  }
  async function download() {
    const blob = await fetchSnapshot({ full: true })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
  function saveVideoDefaults() {
    settings.videoCodecPref = vidCodec; settings.videoContainer = vidContainer; settings.videoQuality = vidQuality
    settings.videoKeyframeS = vidKeyframeS; settings.videoStabilise = vidStabilise; settings.videoDeflicker = vidDeflicker
    saveSettings()
  }
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
    <button class="rec" class:on={recorder.recording} onclick={toggleRecord} disabled={!device.connected} title="record the live view (or the live focus stack when it is on) into the gallery">
      <span class="dot"></span>{recorder.recording ? `Stop · ${recorder.seconds} s` : 'Record video'}
    </button>
    {#if recorder.recording}<span class="muted small">recording {vidMode === 'plain' ? (liveStack.active && liveStack.composite ? (liveStack.mode === 'average' ? 'the smoothed view' : 'the live stack') : 'the live view') : vidInfo.label} · {recorder.frames} frames{#if recorder.modeStatus} · {recorder.modeStatus}{/if}</span>{/if}
    {#if recorder.status && !recorder.recording}<span class="muted small">{recorder.status}</span>{/if}
  </div>
  {#if !recorder.recording}
    <div class="kv" style="margin-top:8px"><span>Video mode</span><span class="v muted" style="color:var(--muted)">{vidInfo.cost}</span></div>
    <select bind:value={vidMode} disabled={busy} style="width:100%" aria-label="video mode" onchange={saveVideoMode}>
      {#each ['quality', 'tone', 'stage', 'motion', 'analysis', 'time'] as g}
        <optgroup label={g === 'quality' ? 'Signal quality' : g === 'tone' ? 'Tone & structure' : g === 'stage' ? 'Stage & illumination' : g === 'motion' ? 'Motion' : g === 'analysis' ? 'Analysis' : 'Time'}>
          {#each VIDEO_MODES.filter((m) => m.group === g) as m}<option value={m.id}>{m.label}</option>{/each}
        </optgroup>
      {/each}
    </select>
    <p class="blurb">{vidInfo.blurb}</p>
    {#if vidBlock}<p class="blurb" style="color:var(--warn)">Cannot start: {vidBlock}.</p>{/if}
    {#if vidMode === 'superres' && !calibration.csm}<p class="blurb" style="color:var(--warn)">No stage↔camera calibration: the dither falls back to one raw step per axis (the frames are still registered, but the sub-pixel phases are luck).</p>{/if}
    {#if vidMode === 'denoise'}
      <div class="params">
        <label title="the longest effective average a steady pixel reaches (the strength)">Strength (frames) <input type="number" min="2" max="32" bind:value={vidParams.denoise.frames} onchange={saveVideoMode} /></label>
        <label title="motion robustness: 2 cautious (movers stay crisp), 8 smooth">Robustness <select bind:value={vidParams.denoise.c} onchange={saveVideoMode}><option value={2}>2 · cautious</option><option value={4}>4</option><option value={8}>8 · smooth</option></select></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="lock AE/AWB for the recording so every frame shares one gain"><input type="checkbox" bind:checked={vidParams.denoise.lockExposure} onchange={saveVideoMode} /> Lock exposure</label>
      </div>
    {:else if vidMode === 'integrate'}
      <div class="params">
        <label title={vidParams.integrate.kind === 'exp' ? 'memory in frames (1/α)' : 'frames in the sliding window'}>{vidParams.integrate.kind === 'exp' ? 'Memory (frames)' : 'Frames'} <input type="number" min="2" max="64" bind:value={vidParams.integrate.frames} onchange={saveVideoMode} /></label>
        <label>Window
          <select bind:value={vidParams.integrate.kind} onchange={saveVideoMode}><option value="mean">Sliding mean</option><option value="exp">Exponential (persistence)</option></select>
        </label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" bind:checked={vidParams.integrate.lockExposure} onchange={saveVideoMode} /> Lock exposure</label>
      </div>
    {:else if vidMode === 'median'}
      <div class="params">
        <label>Frames <select bind:value={vidParams.median.frames} onchange={saveVideoMode}><option value={3}>3</option><option value={5}>5</option></select></label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" bind:checked={vidParams.median.lockExposure} onchange={saveVideoMode} /> Lock exposure</label>
      </div>
    {:else if vidMode === 'bin'}
      <div class="params">
        <label>Factor <select bind:value={vidParams.bin.factor} onchange={saveVideoMode} aria-label="bin factor"><option value={2}>2×2</option><option value={3}>3×3</option><option value={4}>4×4</option></select></label>
        <label>Kernel <select bind:value={vidParams.bin.kernel} onchange={saveVideoMode}><option value="mean">Mean</option><option value="edge">Edge-aware</option></select></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="upscale back to the source size so scale bars and calibrations stay valid (larger file)"><input type="checkbox" bind:checked={vidParams.bin.keepSize} onchange={saveVideoMode} /> Keep size</label>
      </div>
    {:else if vidMode === 'lucky'}
      <div class="params">
        <label title="fraction of frames kept, by sharpness rank over the last 200">Keep <input type="range" min="0.1" max="0.9" step="0.1" bind:value={vidParams.lucky.keep} onchange={saveVideoMode} /> <span class="mono small">{Math.round(vidParams.lucky.keep * 100)} %</span></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="repeat the last kept frame for a dropped one (constant-rate playback) instead of keeping true frame times"><input type="checkbox" bind:checked={vidParams.lucky.fill} onchange={saveVideoMode} /> Fill gaps</label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" bind:checked={vidParams.lucky.lockExposure} onchange={saveVideoMode} /> Lock exposure</label>
      </div>
    {:else if vidMode === 'edof'}
      <div class="params">
        <label>Δz (steps) <input type="number" min="5" max="500" bind:value={vidParams.edof.dz} onchange={saveVideoMode} /></label>
        <label>Dwell (ms) <input type="number" min="50" max="2000" step="50" bind:value={vidParams.edof.dwellMs} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'sweep'}
      <div class="params">
        <label>Range ± (steps) <input type="number" min="20" max="5000" bind:value={vidParams.sweep.range} onchange={saveVideoMode} /></label>
        <label>Stops <input type="number" min="2" max="200" bind:value={vidParams.sweep.steps} onchange={saveVideoMode} /></label>
        <label>Dwell (ms) <input type="number" min="100" max="5000" step="100" bind:value={vidParams.sweep.dwellMs} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'superres'}
      <div class="params">
        <label>Scale <select bind:value={vidParams.superres.scale} onchange={saveVideoMode}><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
        <label title="frames drizzled per output frame">Window <input type="number" min="2" max="12" bind:value={vidParams.superres.window} onchange={saveVideoMode} /></label>
        <label title="drizzle drop size (0.4 sharp … 1 plain average)">Pixfrac <input type="number" min="0.3" max="1" step="0.1" bind:value={vidParams.superres.pixfrac} onchange={saveVideoMode} /></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="move the stage in a sub-pixel pattern (needs a still specimen); off = lucky drizzle from the specimen's own jitter with a sharpness gate"><input type="checkbox" bind:checked={vidParams.superres.dither} onchange={saveVideoMode} /> Stage dither</label>
        {#if !vidParams.superres.dither}<label title="fraction of frames kept by sharpness">Keep <input type="range" min="0.2" max="1" step="0.1" bind:value={vidParams.superres.keep} onchange={saveVideoMode} /> <span class="mono small">{Math.round(vidParams.superres.keep * 100)} %</span></label>{/if}
      </div>
    {:else if vidMode === 'hdr'}
      <div class="params">
        <label title="bright ÷ dim LED level">Ratio <select bind:value={vidParams.hdr.ratio} onchange={saveVideoMode}><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option></select></label>
        <label title="frames per LED level; 1 alternates every frame">Period <input type="number" min="1" max="6" bind:value={vidParams.hdr.period} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'illum'}
      <div class="params">
        <label>Preset A <select bind:value={vidParams.illum.presetA} onchange={saveVideoMode}>{#each Object.keys(settings.lightPresets) as name}<option value={name}>{name}</option>{/each}</select></label>
        <label>Preset B <select bind:value={vidParams.illum.presetB} onchange={saveVideoMode}>{#each Object.keys(settings.lightPresets) as name}<option value={name}>{name}</option>{/each}</select></label>
        <label>Output <select bind:value={vidParams.illum.output} onchange={saveVideoMode}><option value="dpc">Pseudo-DPC (A − B)</option><option value="rheinberg">Rheinberg colour</option><option value="split">Split view</option></select></label>
        <label title="frames each preset is held; the last frame of a hold is used (camera pipeline delay)">Hold <input type="number" min="1" max="6" bind:value={vidParams.illum.hold} onchange={saveVideoMode} /></label>
        {#if vidParams.illum.output === 'dpc'}<label>Gain <input type="number" min="1" max="16" bind:value={vidParams.illum.gain} onchange={saveVideoMode} /></label>{/if}
        {#if vidParams.illum.output === 'rheinberg'}
          <label>Tint A <input type="color" bind:value={vidParams.illum.tintA} onchange={saveVideoMode} /></label>
          <label>Tint B <input type="color" bind:value={vidParams.illum.tintB} onchange={saveVideoMode} /></label>
        {/if}
      </div>
    {:else if vidMode === 'servo'}
      <div class="params">
        <label>Every (s) <input type="number" min="5" max="600" bind:value={vidParams.servo.periodS} onchange={saveVideoMode} /></label>
        <label title="probe amplitude in z steps (about half the depth of field)">δ (steps) <input type="number" min="1" max="50" bind:value={vidParams.servo.delta} onchange={saveVideoMode} /></label>
        <label title="stop correcting beyond this total z offset">Max offset <input type="number" min="5" max="1000" bind:value={vidParams.servo.maxExcursion} onchange={saveVideoMode} /></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="replace the frames taken during a probe by the last good frame"><input type="checkbox" bind:checked={vidParams.servo.hideProbe} onchange={saveVideoMode} /> Hide probe</label>
      </div>
    {:else if vidMode === 'motion'}
      <div class="params">
        <label title="difference threshold in noise σ; lower = more sensitive">Threshold σ <input type="number" min="2" max="10" step="0.5" bind:value={vidParams.motion.sensitivity} onchange={saveVideoMode} /></label>
        <label>Background <select bind:value={vidParams.motion.background} onchange={saveVideoMode}><option value="median">Running median</option><option value="mean">Exponential mean</option></select></label>
        <label title="how fast the background learns (per frame)">Learn <input type="number" min="0.005" max="0.2" step="0.005" bind:value={vidParams.motion.learn} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'trails'}
      <div class="params">
        <label title="trail persistence per frame (0.9 ≈ 10 frames)">Decay <input type="number" min="0.5" max="0.99" step="0.01" bind:value={vidParams.trails.decay} onchange={saveVideoMode} /></label>
        <label>Threshold σ <input type="number" min="2" max="10" step="0.5" bind:value={vidParams.trails.sensitivity} onchange={saveVideoMode} /></label>
        <label title="frame difference (fast movers) or difference to a running-median background (also slow movers)">Source <select bind:value={vidParams.trails.source} onchange={saveVideoMode}><option value="frame">Frame difference</option><option value="background">Background difference</option></select></label>
      </div>
    {:else if vidMode === 'project'}
      <div class="params">
        <label>Kind <select bind:value={vidParams.project.kind} onchange={saveVideoMode}><option value="max">Max (bright tracks)</option><option value="min">Min (dark tracks)</option><option value="range">Range (activity)</option></select></label>
        <label title="1 = never fade; 0.99 ≈ 100-frame memory">Fade <input type="number" min="0.9" max="1" step="0.005" bind:value={vidParams.project.decay} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'flow'}
      <div class="params">
        <label title="analysis cell size (on a 205-px copy)">Cell <select bind:value={vidParams.flow.cell} onchange={saveVideoMode}><option value={6}>fine</option><option value={8}>medium</option><option value={12}>coarse</option></select></label>
        <label title="temporal smoothing of the vectors (1 = none)">Smoothing <input type="number" min="0.1" max="1" step="0.1" bind:value={vidParams.flow.alpha} onchange={saveVideoMode} /></label>
        <label title="speed at full brightness in analysis px/frame; 0 = auto (95th percentile)">Full speed <input type="number" min="0" max="20" step="0.5" bind:value={vidParams.flow.vMax} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'kymograph'}
      <div class="params">
        <label title="perpendicular averaging width in px">Band <input type="number" min="1" max="15" step="2" bind:value={vidParams.kymograph.band} onchange={saveVideoMode} /></label>
        <label title="rows (frames) kept in the space–time image">Rows <input type="number" min="100" max="2000" step="50" bind:value={vidParams.kymograph.rows} onchange={saveVideoMode} /></label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" bind:checked={vidParams.kymograph.sideBySide} onchange={saveVideoMode} /> Side by side</label>
        <span class="muted small">{measure.points.length >= 2 ? 'line: the Distance measurement' : 'line: centre (draw a Distance measurement first to choose one)'}</span>
      </div>
    {:else if vidMode === 'trigger'}
      <div class="params">
        <label title="fraction of the field that must move">Trigger (%) <input type="number" min="0.05" max="20" step="0.05" bind:value={vidParams.trigger.sensitivity} onchange={saveVideoMode} /></label>
        <label>Post-roll (s) <input type="number" min="0.5" max="60" step="0.5" bind:value={vidParams.trigger.postRollS} onchange={saveVideoMode} /></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="cut the idle stretches from the timeline (off = true times, gaps visible in the player)"><input type="checkbox" bind:checked={vidParams.trigger.compressGaps} onchange={saveVideoMode} /> Compress gaps</label>
      </div>
    {:else if vidMode === 'timecode'}
      <div class="params">
        <label>Hue cycle (frames) <input type="number" min="10" max="2000" bind:value={vidParams.timecode.period} onchange={saveVideoMode} /></label>
        <label title="0 = auto (a whole cycle stays visible), 1 = never fade (cumulative projection)">Fade <input type="number" min="0" max="1" step="0.005" bind:value={vidParams.timecode.decay} onchange={saveVideoMode} /></label>
        <label>Map <select bind:value={vidParams.timecode.map} onchange={saveVideoMode}>{#each colormaps.filter((c) => c.key !== 'grays') as c}<option value={c.key}>{c.name}</option>{/each}</select></label>
      </div>
    {:else if vidMode === 'magnify'}
      <div class="params">
        <label>Band (Hz) <span class="row" style="gap:4px"><input type="number" min="0.1" max="8" step="0.1" bind:value={vidParams.magnify.fLo} onchange={saveVideoMode} />–<input type="number" min="0.2" max="9" step="0.1" bind:value={vidParams.magnify.fHi} onchange={saveVideoMode} /></span></label>
        <label>Gain α <input type="number" min="2" max="100" bind:value={vidParams.magnify.alpha} onchange={saveVideoMode} /></label>
        <label title="spatial scale: coarser = amplifies larger structures, less noise">Scale <select bind:value={vidParams.magnify.factor} onchange={saveVideoMode}><option value={4}>fine</option><option value={8}>medium</option><option value={16}>coarse</option></select></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="paint the amplified signal warm/cool instead of adding it to the intensity"><input type="checkbox" bind:checked={vidParams.magnify.colour} onchange={saveVideoMode} /> Colour</label>
      </div>
    {:else if vidMode === 'enhance'}
      <div class="params">
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" bind:checked={vidParams.enhance.levels} onchange={saveVideoMode} /> Auto-levels</label>
        <label title="percentile clipped to black / white">Clip % <span class="row" style="gap:4px"><input type="number" min="0" max="5" step="0.1" bind:value={vidParams.enhance.lowPct} onchange={saveVideoMode} />–<input type="number" min="95" max="100" step="0.1" bind:value={vidParams.enhance.highPct} onchange={saveVideoMode} /></span></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="soft roll-off into white instead of a hard clip"><input type="checkbox" bind:checked={vidParams.enhance.knee} onchange={saveVideoMode} /> Soft knee</label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="per-channel gains that keep the bright background the colour it had on the first frame; lock the camera's AWB first or the two controllers fight"><input type="checkbox" bind:checked={vidParams.enhance.wb} onchange={saveVideoMode} /> Anchor WB</label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="divide out the slowly varying illumination (rolling estimate; a sample filling the whole field is partly flattened too)"><input type="checkbox" bind:checked={vidParams.enhance.flatten} onchange={saveVideoMode} /> Flatten background</label>
        <label title="local contrast amount (0 = off)">Clarity <input type="number" min="0" max="2" step="0.1" bind:value={vidParams.enhance.clarity} onchange={saveVideoMode} /></label>
        <label title="scale of the local contrast in pixels">Scale <select bind:value={vidParams.enhance.scale} onchange={saveVideoMode}><option value={8}>8 px</option><option value={16}>16 px</option><option value={32}>32 px</option><option value={64}>64 px</option></select></label>
      </div>
    {:else if vidMode === 'relief'}
      <div class="params">
        <label>Style <select bind:value={vidParams.relief.style} onchange={saveVideoMode}><option value="relief">Relief (DIC look)</option><option value="darkfield">Digital dark-field</option><option value="phase">Pseudo-phase</option></select></label>
        {#if vidParams.relief.style === 'relief'}
          <label>Light from (°) <input type="number" min="0" max="359" step="15" bind:value={vidParams.relief.angle} onchange={saveVideoMode} /></label>
          <label title="0 = pure grey relief, 1 = original picture with shading added">Mix <input type="range" min="0" max="1" step="0.1" bind:value={vidParams.relief.mix} onchange={saveVideoMode} /> <span class="mono small">{vidParams.relief.mix}</span></label>
        {:else}
          <label title="scale of the background the high-pass removes">Scale <select bind:value={vidParams.relief.scale} onchange={saveVideoMode}><option value={4}>4 px</option><option value={8}>8 px</option><option value={16}>16 px</option><option value={32}>32 px</option></select></label>
        {/if}
        <label>Strength <input type="number" min="0.5" max="8" step="0.5" bind:value={vidParams.relief.strength} onchange={saveVideoMode} /></label>
      </div>
    {:else if vidMode === 'timelapse'}
      <div class="params">
        <label>Every (s) <input type="number" min="0.2" max="3600" step="0.5" bind:value={vidParams.timelapse.intervalS} onchange={saveVideoMode} /></label>
        <label>Playback fps <input type="number" min="1" max="60" bind:value={vidParams.timelapse.fps} onchange={saveVideoMode} /></label>
        <label style="flex-direction:row;align-items:center;gap:6px" title="each kept frame is the mean of its whole interval (movers smear)"><input type="checkbox" bind:checked={vidParams.timelapse.average} onchange={saveVideoMode} /> Average interval</label>
        <span class="muted small">{vidParams.timelapse.intervalS * vidParams.timelapse.fps}× faster</span>
      </div>
    {/if}
    <div class="params burnin" style="margin-top:6px">
      <span class="muted small">Burn in:</span>
      {#each BURN_IN_KINDS as b}
        <label style="flex-direction:row;align-items:center;gap:4px" title={b.title}><input type="checkbox" checked={vidBurnIn.includes(b.id)} onchange={(e) => toggleBurnIn(b.id, (e.currentTarget as HTMLInputElement).checked)} /> {b.label}</label>
      {/each}
    </div>
    <div class="params" style="margin-top:6px">
      <label>Container
        <select bind:value={vidContainer} disabled={busy} onchange={saveVideoDefaults}>
          <option value="mp4">MP4</option>
          <option value="webm">WebM</option>
        </select>
      </label>
      <label>Codec
        <select bind:value={vidCodec} disabled={busy} onchange={saveVideoDefaults}>
          <option value="auto">Auto</option>
          <option value="h264" disabled={!codecSupport.h264}>H.264{codecSupport.h264 ? '' : ' (unsupported)'}</option>
          <option value="vp9" disabled={!codecSupport.vp9}>VP9{codecSupport.vp9 ? '' : ' (unsupported)'}</option>
          <option value="av1" disabled={!codecSupport.av1}>AV1{codecSupport.av1 ? '' : ' (unsupported)'}</option>
        </select>
      </label>
      <label>Quality
        <select bind:value={vidQuality} disabled={busy} onchange={saveVideoDefaults}>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
      <label>Keyframe (s) <input type="number" min="0.5" max="10" step="0.5" style="width:5em" bind:value={vidKeyframeS} disabled={busy} onchange={saveVideoDefaults} /></label>
      <label style="flex-direction:row;align-items:center;gap:6px" title="removes hand/vibration jitter from the live view with a small crop margin; not needed for the live stack, which is already smoothed">
        <input type="checkbox" bind:checked={vidStabilise} disabled={busy} onchange={saveVideoDefaults} /> Stabilise
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px" title="normalises per-frame brightness (LED driver / mains flicker) before encoding">
        <input type="checkbox" bind:checked={vidDeflicker} disabled={busy} onchange={saveVideoDefaults} /> Deflicker
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px" title="apply the Look panel's LUT, curves and levels (as shown on the live view) to the recorded frames, after the video mode; the look can be changed while recording">
        <input type="checkbox" bind:checked={settings.lookBakeIntoRecording} disabled={busy} onchange={saveSettings} /> Bake look
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
  .burnin { gap: 6px 10px; align-items: center; }
  .burnin label { font-size: 12px; }
  .params input[type=range] { width: 8em; }

  @media (max-width: 720px) {
    .params { flex-direction: column; align-items: stretch; gap: 6px; }
    .params label { flex-direction: row; align-items: center; gap: 8px; }
    .params input, .params select { min-width: 64px; flex: 1; }
  }
</style>
