<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { saveSnapshot } from '../lib/store/gallery'
  import { takePhoto, type PhotoMode } from '../lib/services/photoService'
  let saved = $state('')
  let mode = $state<PhotoMode>('single')
  let slices = $state(5)
  let stepZ = $state(50)
  let progress = $state('')

  const c = $derived(device.controls)
  // Under auto exposure / auto white balance the sliders are disabled but follow what the camera
  // is actually doing, taken from the per-frame metadata, so the values can be read off live.
  const live = $derived(device.frame)
  const exposure = $derived(c?.AeEnable && live?.exposure ? live.exposure : c?.ExposureTime ?? 0)
  const gain = $derived(c?.AeEnable && live?.gain ? live.gain : c?.AnalogueGain ?? 1)
  const gains = $derived<[number, number]>(c?.AwbEnable && live?.colour_gains?.length === 2 ? [live.colour_gains[0], live.colour_gains[1]] : c?.ColourGains ?? [1, 1])
  let busy = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function set(patch: Record<string, unknown>) {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      busy = true
      try { await device.setControls(patch) } finally { busy = false }
    }, 120)
  }
  // Switching an auto mode off freezes what the camera is doing right now (from the frame
  // metadata) instead of jumping back to the last stored manual values, which is what made the
  // field turn green when AWB was toggled off with colour gains still at 1,1.
  function toggleAe(on: boolean) {
    set(on || !live?.exposure ? { AeEnable: on } : { AeEnable: false, ExposureTime: Math.round(live.exposure), AnalogueGain: +(live.gain ?? 1).toFixed(3) })
  }
  function toggleAwb(on: boolean) {
    set(on || live?.colour_gains?.length !== 2 ? { AwbEnable: on } : { AwbEnable: false, ColourGains: [+live.colour_gains[0].toFixed(3), +live.colour_gains[1].toFixed(3)] })
  }
  // exposure slider is logarithmic: 50 µs .. 500 ms
  const expToSlider = (us: number) => Math.log10(Math.max(50, us))
  const sliderToExp = (v: number) => Math.round(10 ** v)

  async function grab(full: boolean): Promise<Blob> {
    const url = device.url('/snapshot.jpg') + (full ? '?full=1&' : '?') + 't=' + Date.now()
    return (await fetch(url, { cache: 'no-store' })).blob()
  }
  /** The photo button: a full-resolution still (the stage is not moving), optionally focus- or LED-stacked. */
  async function photo() {
    busy = true; progress = ''
    try {
      const item = await takePhoto({ mode, slices, stepZ, onProgress: (m) => (progress = m) })
      saved = `saved "${item.name}"`; progress = ''
      setTimeout(() => (saved = ''), 4000)
    } catch (e) { progress = (e as Error).message } finally { busy = false }
  }
  /** Quick: the current stream frame, no mode switch. */
  async function toGallery() {
    busy = true
    try {
      const item = await saveSnapshot(await grab(false), { position: { ...device.position }, controls: device.controls ?? undefined })
      saved = `saved "${item.name}"`
      setTimeout(() => (saved = ''), 3000)
    } finally { busy = false }
  }
  async function snapshot(full = false) {
    const blob = await grab(full)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
</script>

<div class="panel">
  <h3>Camera</h3>
  {#if c}
    <div class="row" style="justify-content:space-between">
      <label style="margin:0"><input type="checkbox" checked={c.AeEnable} onchange={(e) => toggleAe(e.currentTarget.checked)} /> auto exposure</label>
      <label style="margin:0"><input type="checkbox" checked={c.AwbEnable} onchange={(e) => toggleAwb(e.currentTarget.checked)} /> auto white balance</label>
    </div>
    <div class="label">Exposure <span class="mono">{(exposure / 1000).toFixed(2)} ms{#if c.AeEnable} <span class="muted">auto</span>{/if}</span></div>
    <input type="range" min={Math.log10(50)} max={Math.log10(500000)} step="0.01" disabled={c.AeEnable} title={c.AeEnable ? 'set by auto exposure (live value)' : ''}
           value={expToSlider(exposure)} oninput={(e) => set({ ExposureTime: sliderToExp(+e.currentTarget.value) })} />
    <div class="label">Analogue gain <span class="mono">{gain.toFixed(2)}×{#if c.AeEnable} <span class="muted">auto</span>{/if}</span></div>
    <input type="range" min="1" max="10.67" step="0.01" disabled={c.AeEnable} title={c.AeEnable ? 'set by auto exposure (live value)' : ''}
           value={gain} oninput={(e) => set({ AnalogueGain: +e.currentTarget.value })} />
    <div class="row">
      <div style="flex:1">
        <div class="label">Red gain <span class="mono">{gains[0].toFixed(2)}{#if c.AwbEnable} <span class="muted">auto</span>{/if}</span></div>
        <input type="range" min="0.5" max="4" step="0.01" disabled={c.AwbEnable} value={gains[0]}
               oninput={(e) => set({ ColourGains: [+e.currentTarget.value, gains[1]] })} />
      </div>
      <div style="flex:1">
        <div class="label">Blue gain <span class="mono">{gains[1].toFixed(2)}{#if c.AwbEnable} <span class="muted">auto</span>{/if}</span></div>
        <input type="range" min="0.5" max="4" step="0.01" disabled={c.AwbEnable} value={gains[1]}
               oninput={(e) => set({ ColourGains: [gains[0], +e.currentTarget.value] })} />
      </div>
    </div>
    <div class="label" style="margin-top:10px">Photo <span class="muted">full sensor resolution, to the gallery</span></div>
    <div class="row">
      <select bind:value={mode} disabled={busy} title="single still, or a stack merged in the browser">
        <option value="single">single (JPEG)</option>
        <option value="raw">RAW 10-bit → 16-bit PNG (slow)</option>
        <option value="focus">focus stack</option>
        <option value="exposure">LED exposure stack</option>
      </select>
      {#if mode === 'focus'}
        <input type="number" min="2" max="15" bind:value={slices} disabled={busy} style="width:4.5em" title="slices" /> ×
        <input type="number" min="1" max="2000" bind:value={stepZ} disabled={busy} style="width:5.5em" title="z steps between slices" />
      {/if}
    </div>
    <div class="row" style="margin-top:6px">
      <button class="primary" onclick={photo} disabled={busy || !device.connected}>Photo</button>
      <button onclick={toGallery} disabled={busy} title="save the current stream frame as it is (fast, lower resolution)">Quick frame</button>
      <button onclick={() => snapshot(true)} disabled={busy} title="download a full-resolution still">↓</button>
      {#if device.frame}<span class="muted mono">{(device.frame.size / 1024).toFixed(0)} kB/frame</span>{/if}
    </div>
    {#if mode === 'focus'}<div class="muted" style="font-size:11px;margin-top:4px">Slices are taken from {Math.floor((slices - 1) / 2) * stepZ} steps below to above the current focus; use a z step close to the depth of field (try 20–50 at 40×, 100–300 at 10×). The result lists how much came from each slice; the slices are kept in the gallery item.</div>{/if}
    {#if mode === 'raw'}<div class="muted" style="font-size:11px;margin-top:4px">The sensor's 10-bit Bayer frame (16 MB) is developed in the browser (black level, white balance, demosaic, sRGB) into a lossless 16-bit PNG; the raw data is stored too. No lens shading or colour matrix is applied.</div>{/if}
    {#if progress || saved}<div class="muted mono" style="font-size:12px;margin-top:6px">{progress || saved}</div>{/if}
  {:else}
    <span class="muted">camera not available</span>
  {/if}
</div>
