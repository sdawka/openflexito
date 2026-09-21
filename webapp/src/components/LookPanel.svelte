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
  import { identityCurveChannels, type CurveChannels } from '../lib/algo/curvePoints'
  import type { ChannelMixer } from '../lib/algo/curves'
  import type { Stop } from '../lib/algo/gradientStops'
  import type { StoredLut } from '../lib/store/lutDb'
  import CurveEditor from './CurveEditor.svelte'
  import GradientEditor from './GradientEditor.svelte'

  onMount(() => { void look.refreshLuts() })

  const IDENTITY_MIXER: ChannelMixer = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

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
  const is1DSelectable = $derived(
    look.lutId !== 'none' && (look.lutId.startsWith('cm:') || look.myLuts.find((l) => l.id === look.lutId)?.kind === '1d'),
  )

  let editingGradient = $state(false)
  function beginGradientEdit(): void { look.startGradientEdit(); editingGradient = true }
  function doneGradientEdit(): void { editingGradient = false }
  function discardGradientEdit(): void { look.discardGradientEdit(); editingGradient = false }
  function clearGradient(): void { look.gradientStops = null; look.save() }
  function onGradientChange(stops: Stop[]): void { look.gradientStops = stops; look.save() }

  function onCurvesChange(ch: CurveChannels): void { look.curves = ch; look.save() }

  function mixerCell(i: number, j: number): number { return (look.channelMixer ?? IDENTITY_MIXER)[i][j] }
  function setMixerCell(i: number, j: number, v: number): void {
    const m = (look.channelMixer ?? IDENTITY_MIXER).map((row) => [...row]) as ChannelMixer
    m[i][j] = Number.isFinite(v) ? v : 0
    look.channelMixer = m
    look.save()
  }
  function resetMixer(): void { look.channelMixer = null; look.save() }

  let savingName = $state(false)
  let saveName = $state('')
  function beginSave(): void { saveName = `${look.currentSourceName()} edited`; savingName = true }
  async function confirmSave(): Promise<void> {
    const name = saveName.trim() || 'Look'
    await look.saveAsLut(name)
    savingName = false
  }
  function cancelSave(): void { savingName = false }

  let renamingId = $state<string | null>(null)
  let renameValue = $state('')
  function beginRename(l: StoredLut): void { renamingId = l.id; renameValue = l.name }
  async function confirmRename(): Promise<void> {
    if (renamingId) await look.renameLut(renamingId, renameValue.trim() || 'LUT')
    renamingId = null
  }

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
  {#if editingGradient && look.gradientStops}
    <div class="row"><div class="label">editing gradient</div></div>
    <GradientEditor value={look.gradientStops} onChange={onGradientChange} />
    <div class="row">
      <button onclick={doneGradientEdit}>Done</button>
      <button onclick={discardGradientEdit}>Discard</button>
    </div>
  {:else}
    <div class="row">
      <select bind:value={look.lutId} onchange={onChange} disabled={!look.enabled || !!look.gradientStops} aria-label="LUT" style="flex:1">
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
    {#if look.gradientStops}
      <div class="row">
        <span class="muted small" style="flex:1">Gradient (custom)</span>
        <button onclick={beginGradientEdit}>Edit gradient</button>
        <button onclick={clearGradient}>Clear</button>
      </div>
    {:else}
      {#if currentGradient}<div class="swatch" style="background:{currentGradient}"></div>{/if}
      {#if is1DSelectable}
        <div class="row"><button onclick={beginGradientEdit}>Edit as gradient</button></div>
      {/if}
    {/if}
    {#if look.myLuts.length}
      <div class="mylist">
        {#each look.myLuts as l}
          <div class="myrow">
            {#if renamingId === l.id}
              <input class="rename-input" bind:value={renameValue} onkeydown={(e) => { if (e.key === 'Enter') confirmRename() }} />
              <button class="icon" title="save name" onclick={confirmRename}>✓</button>
              <button class="icon" title="cancel" onclick={() => { renamingId = null }}>✕</button>
            {:else}
              <span class:on={look.lutId === l.id && !look.gradientStops}>{l.name}</span>
              <button class="icon" title="rename this LUT" onclick={() => beginRename(l)}>✎</button>
              <button class="del" title="delete this LUT" onclick={() => look.deleteUserLut(l.id)}>✕</button>
            {/if}
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
    {#if savingName}
      <div class="row">
        <input class="rename-input" style="flex:1" bind:value={saveName} onkeydown={(e) => { if (e.key === 'Enter') confirmSave() }} />
        <button onclick={confirmSave}>Save</button>
        <button onclick={cancelSave}>Cancel</button>
      </div>
    {:else}
      <div class="row"><button onclick={beginSave} disabled={!look.current} title="bake the whole current look into a new user LUT">Save as LUT…</button></div>
    {/if}
  {/if}

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

    <div class="mixer">
      <div class="label">channel mixer</div>
      {#each [0, 1, 2] as i (i)}
        <div class="mixer-row">
          {#each [0, 1, 2] as j (j)}
            <input
              type="number" step="0.05" class="mixer-cell"
              value={mixerCell(i, j)}
              oninput={(e) => setMixerCell(i, j, parseFloat((e.currentTarget as HTMLInputElement).value))}
            />
          {/each}
          <span class="mono small">sum {(mixerCell(i, 0) + mixerCell(i, 1) + mixerCell(i, 2)).toFixed(2)}</span>
        </div>
      {/each}
      <div class="row"><button onclick={resetMixer}>Reset mixer</button></div>
    </div>

    <div class="row"><button onclick={() => look.reset()}>Reset adjustments</button></div>
  </details>

  <details class="adv">
    <summary>Curves</summary>
    <CurveEditor value={look.curves ?? identityCurveChannels()} onChange={onCurvesChange} />
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
  .myrow .icon { padding: 0 4px; line-height: 1; background: transparent; border: none; cursor: pointer; color: var(--muted); }
  .myrow .icon:hover { color: var(--fg); }
  .rename-input { font-size: 12px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: inherit; }
  .upload { position: relative; display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 12px; }
  .upload input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .adv { margin-top: 6px; }
  .adv summary { cursor: pointer; font-size: 12px; color: var(--muted); }
  .mixer { margin: 6px 0; display: flex; flex-direction: column; gap: 3px; }
  .mixer-row { display: flex; align-items: center; gap: 4px; }
  .mixer-cell { width: 52px; font-size: 11px; padding: 2px 4px; }

  @media (max-width: 720px) {
    input[type=range] { min-height: 28px; }
  }
  @media (pointer: coarse) {
    .upload, button, select { min-height: 32px; }
    .mixer-cell { min-height: 28px; }
  }
</style>
