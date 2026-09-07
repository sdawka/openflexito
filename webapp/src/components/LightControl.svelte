<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  // Presets switch between illumination geometries wired to the board: the condenser LED (CC) for
  // brightfield, side/ring LEDs on the PWM outputs for darkfield or oblique light. "Save" stores the
  // current sliders under the selected name so the levels can be tuned for the actual LEDs.
  let presetName = $state('')
  const presets = $derived(Object.keys(settings.lightPresets))
  const isActive = (name: string) => {
    const p = settings.lightPresets[name]
    return Math.abs(p.cc - device.light.cc) < 0.015 && p.pwm.every((v, i) => Math.abs(v - (device.light.pwm[i] ?? 0)) < 0.015)
  }
  async function applyPreset(name: string) {
    const p = settings.lightPresets[name]
    presetName = name
    await device.setLight(p.cc, pwmCount ? p.pwm.slice(0, pwmCount) : undefined).catch(() => {})
  }
  function savePreset() {
    const name = presetName.trim(); if (!name) return
    settings.lightPresets = { ...settings.lightPresets, [name]: { cc: device.light.cc, pwm: [...device.light.pwm] } }
    saveSettings()
  }
  function deletePreset(name: string) {
    const { [name]: _, ...rest } = settings.lightPresets
    settings.lightPresets = rest; saveSettings(); presetName = ''
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  function setCC(v: number) {
    clearTimeout(timer)
    timer = setTimeout(() => device.setLight(v).catch(() => {}), 80)
  }
  // The Sangaboard reports its illumination channels (CC: the main LED driver, PWM: spare outputs
  // on the board for extra LEDs such as side or oblique illumination). One slider per PWM output.
  const pwmCount = $derived(device.light.channels?.pwm ?? 0)
  let pwmTimer: ReturnType<typeof setTimeout> | undefined
  function setPwm(i: number, v: number) {
    clearTimeout(pwmTimer)
    const pwm = [...device.light.pwm]; while (pwm.length <= i) pwm.push(0); pwm[i] = v
    pwmTimer = setTimeout(() => device.setLight(undefined, pwm).catch(() => {}), 80)
  }
</script>

<div class="panel">
  <h3>Illumination</h3>
  <div class="label">LED brightness <span class="mono">{Math.round(device.light.cc * 100)} %</span></div>
  <input type="range" min="0" max="1" step="0.01" value={device.light.cc} oninput={(e) => setCC(+e.currentTarget.value)} />
  <div class="row" style="margin-top:6px">
    <button onclick={() => device.setLight(0)}>Off</button>
    <button onclick={() => device.setLight(0.32)}>Default</button>
    <button onclick={() => device.setLight(1)}>Max</button>
  </div>
  {#each Array.from({ length: pwmCount }, (_, i) => i) as i}
    <div class="label" style="margin-top:8px">Aux LED {i + 1} <span class="muted">(board PWM output {i}{i === 0 ? ', e.g. darkfield ring' : ', e.g. oblique side LED'})</span> <span class="mono">{Math.round((device.light.pwm[i] ?? 0) * 100)} %</span></div>
    <input type="range" min="0" max="1" step="0.01" value={device.light.pwm[i] ?? 0} oninput={(e) => setPwm(i, +e.currentTarget.value)} />
  {/each}
  {#if pwmCount > 0}
    <div class="label" style="margin-top:10px">Illumination mode <span class="muted">presets of the sliders above</span></div>
    <div class="row presets">
      {#each presets as name}
        <button class:primary={isActive(name)} onclick={() => applyPreset(name)} title="cc {Math.round(settings.lightPresets[name].cc * 100)} %, pwm {settings.lightPresets[name].pwm.map((v) => Math.round(v * 100) + ' %').join(' / ')}">{name}</button>
      {/each}
    </div>
    <div class="row" style="margin-top:6px">
      <input type="text" bind:value={presetName} placeholder="preset name" style="flex:1;min-width:6em" list="light-presets" />
      <datalist id="light-presets">{#each presets as name}<option value={name}></option>{/each}</datalist>
      <button onclick={savePreset} disabled={!presetName.trim()} title="store the current slider levels under this name">Save</button>
      {#if presetName && settings.lightPresets[presetName]}<button class="danger" onclick={() => deletePreset(presetName)}>Delete</button>{/if}
    </div>
  {/if}
</div>

<style>
  .presets { flex-wrap: wrap; gap: 6px; }
</style>
