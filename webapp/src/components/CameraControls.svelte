<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { saveSnapshot } from '../lib/store/gallery'
  import { takePhoto, type PhotoMode } from '../lib/services/photoService'
  import { wb, gainsToTempTint, tempTintToGains, neutralWholeField } from '../lib/services/whiteBalance.svelte'
  let saved = $state('')
  let mode = $state<PhotoMode>('single')
  let slices = $state(5)
  let stepZ = $state(50)
  let fineSlices = $state(9)
  let fineRange = $state(1000)
  let progress = $state('')

  const c = $derived(device.controls)
  // Under auto exposure / auto white balance the sliders are disabled but follow what the camera
  // is actually doing, taken from the per-frame metadata, so the values can be read off live.
  const live = $derived(device.frame)
  const exposure = $derived(c?.AeEnable && live?.exposure ? live.exposure : c?.ExposureTime ?? 0)
  const gain = $derived(c?.AeEnable && live?.gain ? live.gain : c?.AnalogueGain ?? 1)
  const gains = $derived<[number, number]>(c?.AwbEnable && live?.colour_gains?.length === 2 ? [live.colour_gains[0], live.colour_gains[1]] : c?.ColourGains ?? [1, 1])
  // white balance is edited along temperature (blue ↔ amber) and tint (green ↔ magenta), as raw editors do
  const tt = $derived(gainsToTempTint(gains[0], gains[1]))
  function setTempTint(temp: number, tint: number) {
    const [r, b] = tempTintToGains(temp, tint)
    set({ AwbEnable: false, ColourGains: [+r.toFixed(3), +b.toFixed(3)] })
  }
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
      const item = await takePhoto({ mode, slices: mode === 'focusfine' || mode === 'focusfineraw' ? fineSlices : slices, stepZ, range: fineRange, onProgress: (m) => (progress = m) })
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
    <div class="label" style="margin-top:6px">White balance <span class="mono">R {gains[0].toFixed(2)} · B {gains[1].toFixed(2)}{#if c.AwbEnable} <span class="muted">auto</span>{/if}</span></div>
    <div class="row">
      <button class:primary={wb.picking} onclick={() => (wb.picking = !wb.picking)} disabled={busy} title="then click a spot in the live image that should be neutral grey or white">{wb.picking ? 'click a neutral spot…' : 'Pick neutral'}</button>
      <button onclick={() => { busy = true; neutralWholeField().finally(() => (busy = false)) }} disabled={busy} title="grey-world over the whole frame: use with an empty, evenly lit field">Whole field neutral</button>
    </div>
    <div class="wbrow">
      <span class="end" style="color:#6fa8ff">cool</span>
      <input type="range" min="-2" max="2" step="0.01" value={tt.temp} disabled={c.AwbEnable} title="temperature: blue ↔ amber" class="temp"
             oninput={(e) => setTempTint(+e.currentTarget.value, tt.tint)} />
      <span class="end" style="color:#ffb84d">warm</span>
    </div>
    <div class="wbrow">
      <span class="end" style="color:#7ed37e">green</span>
      <input type="range" min="-1.5" max="1.5" step="0.01" value={tt.tint} disabled={c.AwbEnable} title="tint: green ↔ magenta" class="tint"
             oninput={(e) => setTempTint(tt.temp, +e.currentTarget.value)} />
      <span class="end" style="color:#e57ad8">magenta</span>
    </div>
    {#if wb.status}<div class="muted mono" style="font-size:12px">{wb.status}</div>{/if}
    <div class="label" style="margin-top:10px">Photo <span class="muted">full sensor resolution, to the gallery</span></div>
    <div class="row">
      <select bind:value={mode} disabled={busy} title="single still, or a stack merged in the browser">
        <option value="single">single (JPEG)</option>
        <option value="raw">RAW 10-bit → 16-bit PNG (slow)</option>
        <option value="focus">quick focus stack</option>
        <option value="focusfine">fine focus stack (autofocus-centred, pyramid)</option>
        <option value="focusfineraw">fine focus stack from RAW (16-bit, very slow)</option>
        <option value="exposure">LED exposure stack</option>
      </select>
      {#if mode === 'focus'}
        <input type="number" min="2" max="15" bind:value={slices} disabled={busy} style="width:4.5em" title="slices" /> ×
        <input type="number" min="1" max="2000" bind:value={stepZ} disabled={busy} style="width:5.5em" title="z steps between slices" />
      {/if}
      {#if mode === 'focusfine' || mode === 'focusfineraw'}
        <input type="number" min="3" max="31" bind:value={fineSlices} disabled={busy} style="width:4.5em" title="slices" /> slices
        <select bind:value={fineRange} disabled={busy} title="autofocus sweep used to find the focus plane">
          <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option>
        </select>
      {/if}
    </div>
    <div class="row" style="margin-top:6px">
      <button class="primary" onclick={photo} disabled={busy || !device.connected}>Photo</button>
      <button onclick={toGallery} disabled={busy} title="save the current stream frame as it is (fast, lower resolution)">Quick frame</button>
      <button onclick={() => snapshot(true)} disabled={busy} title="download a full-resolution still">↓</button>
      {#if device.frame}<span class="muted mono">{(device.frame.size / 1024).toFixed(0)} kB/frame</span>{/if}
    </div>
    {#if mode === 'focusfineraw'}<div class="muted" style="font-size:11px;margin-top:4px">The fine stack, but every slice is the sensor's 10-bit RAW frame developed in the browser (16 MB and ~20 s each) and fused at 16-bit precision into a lossless PNG: nothing is quantised to 8 bits or JPEG-compressed before the merge. Budget ~30 s per slice.</div>{/if}
    {#if mode === 'focusfine'}<div class="muted" style="font-size:11px;margin-top:4px">Slow but thorough: an autofocus sweep finds the focus plane and the width of its sharpness peak; the slices are spread symmetrically over 1.5× that width, aligned to each other, and merged scale by scale (Laplacian pyramid) so fine hairs come from the slice where they are sharp. Ends back on the focus plane. Expect ~3 s per slice plus fusion.</div>{/if}
    {#if mode === 'focus'}<div class="muted" style="font-size:11px;margin-top:4px">Slices are taken from {Math.floor((slices - 1) / 2) * stepZ} steps below to above the current focus; use a z step close to the depth of field (try 20–50 at 40×, 100–300 at 10×). The result lists how much came from each slice; the slices are kept in the gallery item.</div>{/if}
    {#if mode === 'raw'}<div class="muted" style="font-size:11px;margin-top:4px">The sensor's 10-bit Bayer frame (16 MB) is developed in the browser like the camera's ISP but losslessly: black level, the tuning file's lens shading tables, the current white balance, Malvar 5×5 demosaic, the colour matrix and the camera's gamma curve, into a 16-bit PNG. The untouched mosaic is kept as a DNG (opens in RawTherapee, darktable, Lightroom).</div>{/if}
    {#if progress || saved}<div class="muted mono" style="font-size:12px;margin-top:6px">{progress || saved}</div>{/if}
  {:else}
    <span class="muted">camera not available</span>
  {/if}
</div>

<style>
  .wbrow { display: flex; align-items: center; gap: 6px; }
  .wbrow input { flex: 1; }
  .wbrow .end { font-size: 11px; width: 3.6em; text-align: center; }
  .wbrow .temp { background: linear-gradient(90deg, #6fa8ff, #bbb 50%, #ffb84d); height: 6px; border-radius: 3px; }
  .wbrow .tint { background: linear-gradient(90deg, #7ed37e, #bbb 50%, #e57ad8); height: 6px; border-radius: 3px; }
</style>
