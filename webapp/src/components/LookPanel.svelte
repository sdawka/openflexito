<script lang="ts">
  /** Live-view colour LUT / "look": pick a built-in colour map or an imported LUT, dial in strength and
   *  a few tone/colour adjustments, and choose whether the result is baked into recordings and/or shown
   *  in the gallery. The actual per-frame work happens in `services/lookProcessor.ts` (registered by
   *  importing it here); this panel only edits `store/look.svelte.ts`'s state and persists it. */
  import { onMount } from 'svelte'
  import '../lib/services/lookProcessor'
  import { look } from '../lib/store/look.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import { listColormaps, colormapPreview } from '../lib/algo/colormaps'

  onMount(() => { void look.refreshLuts() })

  const colormaps = listColormaps()
  const scientific = colormaps.filter((c) => c.group === 'scientific')
  const imagej = colormaps.filter((c) => c.group === 'imagej')
  const basic = colormaps.filter((c) => c.group === 'basic')

  function gradientFor(name: string): string {
    const bytes = colormapPreview(name, 8)
    const stops: string[] = []
    for (let i = 0; i < 8; i++) stops.push(`rgb(${bytes[i * 4]},${bytes[i * 4 + 1]},${bytes[i * 4 + 2]})`)
    return `linear-gradient(to right, ${stops.join(',')})`
  }
  const currentGradient = $derived(look.lutId.startsWith('cm:') ? gradientFor(look.lutId.slice(3)) : '')

  let importing = $state(false)
  let importError = $state('')
  async function onImport(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    importing = true; importError = ''
    try { await look.importFile(file) }
    catch (err) { importError = (err as Error).message }
    finally { importing = false }
  }

  function onChange(): void { look.save() }
</script>

<div class="panel">
  <h3>Look</h3>
  <div class="row">
    <label class="chk"><input type="checkbox" bind:checked={look.enabled} onchange={onChange} /> enabled</label>
  </div>
  <div class="row">
    <select bind:value={look.lutId} onchange={onChange} disabled={!look.enabled} aria-label="LUT" style="flex:1">
      <option value="none">None</option>
      {#if look.myLuts.length}
        <optgroup label="My LUTs">
          {#each look.myLuts as l}<option value={l.id}>{l.name}</option>{/each}
        </optgroup>
      {/if}
      <optgroup label="Scientific">
        {#each scientific as c}<option value={`cm:${c.key}`}>{c.name}</option>{/each}
      </optgroup>
      <optgroup label="ImageJ">
        {#each imagej as c}<option value={`cm:${c.key}`}>{c.name}</option>{/each}
      </optgroup>
      <optgroup label="Basic">
        {#each basic as c}<option value={`cm:${c.key}`}>{c.name}</option>{/each}
      </optgroup>
    </select>
  </div>
  {#if currentGradient}<div class="swatch" style="background:{currentGradient}"></div>{/if}
  {#if look.myLuts.length}
    <div class="mylist">
      {#each look.myLuts as l}
        <div class="myrow">
          <span class:on={look.lutId === l.id}>{l.name}</span>
          <button class="del" title="delete this LUT" onclick={() => look.deleteUserLut(l.id)}>✕</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="row">
    <label class="upload">Import LUT…
      <input type="file" accept=".cube,.3dl,.lut,.png,.csv,.txt" onchange={onImport} disabled={importing} />
    </label>
    <button onclick={() => look.exportCube()} disabled={!look.current} title="download the current look as a .cube file">Export .cube</button>
  </div>
  {#if importError}<div class="muted small" style="color:var(--err)">{importError}</div>{/if}

  <div class="row">
    <div class="label">strength</div>
    <input type="range" min="0" max="1" step="0.01" bind:value={look.strength} oninput={onChange} disabled={!look.enabled} style="flex:1" />
    <span class="mono small">{look.strength.toFixed(2)}</span>
  </div>
  <div class="row">
    <label class="chk"><input type="checkbox" bind:checked={look.pseudo} onchange={onChange} disabled={!look.enabled} /> pseudo-colour</label>
    <label class="chk"><input type="checkbox" bind:checked={look.invert} onchange={onChange} disabled={!look.enabled} /> invert</label>
    <select bind:value={look.input} onchange={onChange} disabled={!look.enabled} aria-label="input space">
      <option value="srgb">sRGB input</option>
      <option value="linear">linear input</option>
    </select>
  </div>

  <details class="adv">
    <summary>Adjustments</summary>
    <div class="row"><div class="label">black</div><input type="range" min="0" max="1" step="0.01" bind:value={look.levels.black} oninput={onChange} style="flex:1" /><span class="mono small">{look.levels.black.toFixed(2)}</span></div>
    <div class="row"><div class="label">white</div><input type="range" min="0" max="1" step="0.01" bind:value={look.levels.white} oninput={onChange} style="flex:1" /><span class="mono small">{look.levels.white.toFixed(2)}</span></div>
    <div class="row"><div class="label">gamma</div><input type="range" min="0.2" max="3" step="0.01" bind:value={look.levels.gamma} oninput={onChange} style="flex:1" /><span class="mono small">{look.levels.gamma.toFixed(2)}</span></div>
    <div class="row"><div class="label">saturation</div><input type="range" min="-1" max="1" step="0.01" bind:value={look.saturation} oninput={onChange} style="flex:1" /><span class="mono small">{look.saturation.toFixed(2)}</span></div>
    <div class="row"><div class="label">vibrance</div><input type="range" min="-1" max="1" step="0.01" bind:value={look.vibrance} oninput={onChange} style="flex:1" /><span class="mono small">{look.vibrance.toFixed(2)}</span></div>
    <div class="row"><div class="label">hue</div><input type="range" min="-180" max="180" step="1" bind:value={look.hue} oninput={onChange} style="flex:1" /><span class="mono small">{look.hue.toFixed(0)}°</span></div>
    <div class="row"><button onclick={() => look.reset()}>Reset adjustments</button></div>
  </details>

  <div class="row">
    <label class="chk"><input type="checkbox" bind:checked={settings.lookBakeIntoRecording} onchange={saveSettings} /> bake into recording</label>
    <label class="chk"><input type="checkbox" bind:checked={settings.lookApplyInGallery} onchange={saveSettings} /> apply in gallery</label>
  </div>
</div>

<style>
  .chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
  .label { font-size: 12px; color: var(--muted); min-width: 64px; }
  .small { font-size: 11px; }
  .swatch { height: 14px; border-radius: 3px; margin: 4px 0 8px; border: 1px solid var(--border); }
  .mylist { display: flex; flex-direction: column; gap: 2px; margin: 4px 0; max-height: 100px; overflow: auto; }
  .myrow { display: flex; align-items: center; justify-content: space-between; font-size: 12px; gap: 6px; }
  .myrow span.on { color: var(--accent); font-weight: 600; }
  .myrow .del { padding: 0 6px; line-height: 1; }
  .upload { position: relative; display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 12px; }
  .upload input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .adv { margin-top: 6px; }
  .adv summary { cursor: pointer; font-size: 12px; color: var(--muted); }

  @media (max-width: 720px) {
    input[type=range] { min-height: 28px; }
  }
  @media (pointer: coarse) {
    .upload, button, select { min-height: 32px; }
  }
</style>
