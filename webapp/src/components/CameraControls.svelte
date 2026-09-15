<script lang="ts">
  /** Exposure and colour: auto toggles, exposure/gain (live values shown while auto), white balance
   *  with a neutral picker and temperature/tint sliders. */
  import { device } from '../lib/store/device.svelte'
  import { wb, gainsToTempTint, tempTintToGains, neutralWholeField } from '../lib/services/whiteBalance.svelte'
  import FlickerCheck from './FlickerCheck.svelte'
  import Histogram from './Histogram.svelte'

  const c = $derived(device.controls)
  const live = $derived(device.frame)
  const exposure = $derived(c?.AeEnable && live?.exposure ? live.exposure : c?.ExposureTime ?? 0)
  const gain = $derived(c?.AeEnable && live?.gain ? live.gain : c?.AnalogueGain ?? 1)
  const gains = $derived<[number, number]>(c?.AwbEnable && live?.colour_gains?.length === 2 ? [live.colour_gains[0], live.colour_gains[1]] : c?.ColourGains ?? [1, 1])
  const tt = $derived(gainsToTempTint(gains[0], gains[1]))
  let busy = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Record<string, unknown> = {}

  // One debounce for every control here, so patches are MERGED: clearing the timer used to drop the
  // previous patch outright (temperature then tint within 120 ms reverted the temperature; "auto
  // exposure off" then a slider drag left AE on).
  function set(patch: Record<string, unknown>) {
    pending = { ...pending, ...patch }
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const p = pending; pending = {}
      busy = true; try { await device.setControls(p) } finally { busy = false }
    }, 120)
  }
  // Switching an auto mode off freezes what the camera is doing right now instead of jumping back
  // to the last stored manual values (that is what turned the field green before).
  function toggleAe(on: boolean) {
    set(on || !live?.exposure ? { AeEnable: on } : { AeEnable: false, ExposureTime: Math.round(live.exposure), AnalogueGain: +(live.gain ?? 1).toFixed(3) })
  }
  function toggleAwb(on: boolean) {
    set(on || live?.colour_gains?.length !== 2 ? { AwbEnable: on } : { AwbEnable: false, ColourGains: [+live.colour_gains[0].toFixed(3), +live.colour_gains[1].toFixed(3)] })
  }
  function setTempTint(temp: number, tint: number) {
    const [r, b] = tempTintToGains(temp, tint)
    set({ AwbEnable: false, ColourGains: [+r.toFixed(3), +b.toFixed(3)] })
  }
  const expToSlider = (us: number) => Math.log10(Math.max(50, us))
  const sliderToExp = (v: number) => Math.round(10 ** v)
  const fmtExp = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(us >= 10000 ? 0 : 2)} ms` : `${Math.round(us)} µs`)
</script>

<div class="panel">
  <h3>Camera</h3>
  {#if c}
    <h4 class="sub">Exposure</h4>
    <div class="kv"><span>Shutter</span><span class="v">{fmtExp(exposure)}{#if c.AeEnable}<span class="auto">auto</span>{/if}</span></div>
    <input type="range" min={Math.log10(50)} max={Math.log10(500000)} step="0.01" disabled={c.AeEnable} title={c.AeEnable ? 'set by auto exposure (live value)' : 'exposure time'}
           value={expToSlider(exposure)} oninput={(e) => set({ ExposureTime: sliderToExp(+e.currentTarget.value) })} />
    <div class="kv"><span>Gain</span><span class="v">{gain.toFixed(2)}×{#if c.AeEnable}<span class="auto">auto</span>{/if}</span></div>
    <input type="range" min="1" max="10.67" step="0.01" disabled={c.AeEnable} title={c.AeEnable ? 'set by auto exposure (live value)' : 'analogue gain'}
           value={gain} oninput={(e) => set({ AnalogueGain: +e.currentTarget.value })} />
    <label class="check"><input type="checkbox" checked={c.AeEnable} onchange={(e) => toggleAe(e.currentTarget.checked)} /> auto exposure</label>

    <h4 class="sub">White balance</h4>
    <div class="kv"><span>Gains</span><span class="v">R {gains[0].toFixed(2)} · B {gains[1].toFixed(2)}{#if c.AwbEnable}<span class="auto">auto</span>{/if}</span></div>
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
    <div class="row" style="margin-top:6px">
      <button class:primary={wb.picking} onclick={() => (wb.picking = !wb.picking)} disabled={busy} title="then click a spot in the live image that should be neutral grey or white">{wb.picking ? 'Click a neutral spot…' : 'Pick neutral'}</button>
      <button onclick={() => { busy = true; neutralWholeField().finally(() => (busy = false)) }} disabled={busy} title="grey-world over the whole frame: use with an empty, evenly lit field">Whole field</button>
      <label class="check" style="margin-left:auto"><input type="checkbox" checked={c.AwbEnable} onchange={(e) => toggleAwb(e.currentTarget.checked)} /> auto</label>
    </div>
    {#if wb.status}<div class="status-line {wb.status.startsWith('white balance: red') ? 'ok' : wb.status.includes('…') ? 'busy' : 'err'}">{wb.status}</div>{/if}
    <FlickerCheck />
    <Histogram />
  {:else}
    <span class="muted">camera not available</span>
  {/if}
</div>

<style>
  .check { display: inline-flex; align-items: center; gap: 6px; margin: 6px 0 0; font-size: 12px; color: var(--muted); }
  .wbrow { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .wbrow input { flex: 1; }
  .wbrow .end { font-size: 11px; width: 3.6em; text-align: center; }
  .wbrow .temp { background: linear-gradient(90deg, #6fa8ff, #777 50%, #ffb84d); height: 6px; border-radius: 3px; }
  .wbrow .tint { background: linear-gradient(90deg, #7ed37e, #777 50%, #e57ad8); height: 6px; border-radius: 3px; }

  @media (max-width: 720px) {
    .wbrow .end { font-size: 10px; width: 2.8em; }
  }
</style>
