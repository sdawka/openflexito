<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { saveSnapshot } from '../lib/store/gallery'
  let saved = $state('')

  const c = $derived(device.controls)
  let busy = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  function set(patch: Record<string, unknown>) {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      busy = true
      try { await device.setControls(patch) } finally { busy = false }
    }, 120)
  }
  // exposure slider is logarithmic: 50 µs .. 500 ms
  const expToSlider = (us: number) => Math.log10(Math.max(50, us))
  const sliderToExp = (v: number) => Math.round(10 ** v)

  async function grab(full: boolean): Promise<Blob> {
    const url = device.url('/snapshot.jpg') + (full ? '?full=1&' : '?') + 't=' + Date.now()
    return (await fetch(url, { cache: 'no-store' })).blob()
  }
  async function toGallery(full = false) {
    busy = true
    try {
      const item = await saveSnapshot(await grab(full), { position: { ...device.position }, controls: device.controls ?? undefined })
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
      <label style="margin:0"><input type="checkbox" checked={c.AeEnable} onchange={(e) => set({ AeEnable: e.currentTarget.checked })} /> auto exposure</label>
      <label style="margin:0"><input type="checkbox" checked={c.AwbEnable} onchange={(e) => set({ AwbEnable: e.currentTarget.checked })} /> auto white balance</label>
    </div>
    <div class="label">Exposure <span class="mono">{(c.ExposureTime / 1000).toFixed(2)} ms</span></div>
    <input type="range" min={Math.log10(50)} max={Math.log10(500000)} step="0.01" disabled={c.AeEnable}
           value={expToSlider(c.ExposureTime)} oninput={(e) => set({ ExposureTime: sliderToExp(+e.currentTarget.value) })} />
    <div class="label">Analogue gain <span class="mono">{c.AnalogueGain.toFixed(2)}×</span></div>
    <input type="range" min="1" max="10.67" step="0.01" disabled={c.AeEnable}
           value={c.AnalogueGain} oninput={(e) => set({ AnalogueGain: +e.currentTarget.value })} />
    <div class="row">
      <div style="flex:1">
        <div class="label">Red gain <span class="mono">{c.ColourGains[0].toFixed(2)}</span></div>
        <input type="range" min="0.5" max="4" step="0.01" disabled={c.AwbEnable} value={c.ColourGains[0]}
               oninput={(e) => set({ ColourGains: [+e.currentTarget.value, c.ColourGains[1]] })} />
      </div>
      <div style="flex:1">
        <div class="label">Blue gain <span class="mono">{c.ColourGains[1].toFixed(2)}</span></div>
        <input type="range" min="0.5" max="4" step="0.01" disabled={c.AwbEnable} value={c.ColourGains[1]}
               oninput={(e) => set({ ColourGains: [c.ColourGains[0], +e.currentTarget.value] })} />
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="primary" onclick={() => toGallery(false)} disabled={busy} title="save the current frame to the gallery">Snapshot</button>
      <button onclick={() => toGallery(true)} disabled={busy} title="full sensor resolution still, to the gallery">Full-res</button>
      <button onclick={() => snapshot(false)} disabled={busy} title="download the current frame">↓</button>
      {#if saved}<span class="muted" style="font-size:12px">{saved}</span>{/if}
      {#if device.frame}<span class="muted mono">{(device.frame.size / 1024).toFixed(0)} kB/frame</span>{/if}
    </div>
  {:else}
    <span class="muted">camera not available</span>
  {/if}
</div>
