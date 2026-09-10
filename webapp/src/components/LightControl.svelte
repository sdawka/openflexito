<script lang="ts">
  /** Illumination: the condenser LED, the board's spare PWM outputs (extra LEDs) and one-click
   *  presets that switch between lighting geometries. */
  import { device } from '../lib/store/device.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'

  let timer: ReturnType<typeof setTimeout> | undefined
  function setCC(v: number) { clearTimeout(timer); timer = setTimeout(() => device.setLight(v).catch(() => {}), 80) }
  const pwmCount = $derived(device.light.channels?.pwm ?? 0)
  let pwmTimer: ReturnType<typeof setTimeout> | undefined
  let pendingPwm: number[] | null = null
  // all channels share one debounce, so keep the pending array across calls: rebuilding it from
  // device.light.pwm on every call re-sent the previous channel's OLD value and reverted it
  function setPwm(i: number, v: number) {
    clearTimeout(pwmTimer)
    const pwm = pendingPwm ?? [...device.light.pwm]; while (pwm.length <= i) pwm.push(0); pwm[i] = v
    pendingPwm = pwm
    pwmTimer = setTimeout(() => { pendingPwm = null; device.setLight(undefined, pwm).catch(() => {}) }, 80)
  }
  const auxNames = ['darkfield ring', 'side LED']
  let presetName = $state('')
  let editing = $state(false)
  const presets = $derived(Object.keys(settings.lightPresets))
  const isActive = (name: string) => {
    const p = settings.lightPresets[name]
    return Math.abs(p.cc - device.light.cc) < 0.015 && p.pwm.every((v, i) => Math.abs(v - (device.light.pwm[i] ?? 0)) < 0.015)
  }
  async function applyPreset(name: string) {
    const p = settings.lightPresets[name]
    await device.setLight(p.cc, pwmCount ? p.pwm.slice(0, pwmCount) : undefined).catch(() => {})
  }
  function savePreset() {
    const name = presetName.trim(); if (!name) return
    settings.lightPresets = { ...settings.lightPresets, [name]: { cc: device.light.cc, pwm: [...device.light.pwm] } }
    saveSettings(); presetName = ''; editing = false
  }
  function deletePreset(name: string) {
    const { [name]: _, ...rest } = settings.lightPresets
    settings.lightPresets = rest; saveSettings()
  }
  const pct = (v: number) => `${Math.round(v * 100)} %`
</script>

<div class="panel">
  <h3>Illumination</h3>
  <div class="kv"><span>Condenser LED</span><span class="v">{pct(device.light.cc)}</span></div>
  <input type="range" min="0" max="1" step="0.01" value={device.light.cc} oninput={(e) => setCC(+e.currentTarget.value)} />
  <div class="seg" style="margin-top:6px">
    <button class:on={device.light.cc < 0.01} onclick={() => device.setLight(0)}>Off</button>
    <button class:on={Math.abs(device.light.cc - 0.32) < 0.01} onclick={() => device.setLight(0.32)}>32 %</button>
    <button class:on={device.light.cc > 0.99} onclick={() => device.setLight(1)}>Max</button>
  </div>
  {#each Array.from({ length: pwmCount }, (_, i) => i) as i}
    <div class="kv" style="margin-top:8px"><span>Aux LED {i + 1} <span class="dim">· PWM {i}{auxNames[i] ? `, e.g. ${auxNames[i]}` : ''}</span></span><span class="v">{pct(device.light.pwm[i] ?? 0)}</span></div>
    <input type="range" min="0" max="1" step="0.01" value={device.light.pwm[i] ?? 0} oninput={(e) => setPwm(i, +e.currentTarget.value)} />
  {/each}
  {#if pwmCount > 0}
    <h4 class="sub">Lighting mode</h4>
    <div class="chips presets">
      {#each presets as name}
        <button class="chip preset" class:on={isActive(name)} onclick={() => applyPreset(name)} title="LED {pct(settings.lightPresets[name].cc)}, aux {settings.lightPresets[name].pwm.map(pct).join(' / ')}">
          {name}{#if editing}<span class="x" role="button" tabindex="-1" title="delete preset" onclick={(e) => { e.stopPropagation(); deletePreset(name) }} onkeydown={() => {}}>×</span>{/if}
        </button>
      {/each}
      <button class="chip ghost" onclick={() => (editing = !editing)} title="save the current levels as a preset, or delete presets">{editing ? 'done' : 'edit…'}</button>
    </div>
    {#if editing}
      <div class="row" style="margin-top:6px">
        <input type="text" bind:value={presetName} placeholder="name for the current levels" style="flex:1;min-width:6em" onkeydown={(e) => e.key === 'Enter' && savePreset()} />
        <button onclick={savePreset} disabled={!presetName.trim()}>Save</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .dim { color: var(--muted); opacity: .75; }
  .presets { margin-top: 2px; }
  .chip.preset { cursor: pointer; color: var(--text); padding: 3px 10px; font-size: 12px; }
  .chip.preset:hover { border-color: var(--accent); }
  .chip.preset.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chip.ghost { cursor: pointer; border-style: dashed; padding: 3px 10px; font-size: 12px; }
  .x { margin-left: 4px; opacity: .8; }
  .x:hover { color: var(--err); opacity: 1; }
</style>
