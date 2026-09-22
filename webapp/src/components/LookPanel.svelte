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
  import { FILMIC_PRESETS, FILMIC_DEFAULT_EXPOSURE, type ChannelMixer, type FilmicPreset } from '../lib/algo/curves'
  import type { Cdl } from '../lib/algo/cdl'
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
  const okabe = colormaps.filter((c) => c.group === 'okabe')

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
  /** Two-channel merge / channel-isolation presets, all expressed through the channel mixer (research
   *  colour.md proposal 8): rows are output R/G/B as weights of input R/G/B. Green/Magenta shows the
   *  red channel as magenta (B' = R), the colour-blind-safe replacement for red/green overlays. */
  const MIXER_PRESETS: Array<{ name: string; title: string; m: ChannelMixer }> = [
    { name: 'Green/Magenta', title: 'red channel shown as magenta, green stays green', m: [[1, 0, 0], [0, 1, 0], [1, 0, 0]] },
    { name: 'Cyan/Red', title: 'green channel shown as cyan, red stays red', m: [[1, 0, 0], [0, 1, 0], [0, 1, 0]] },
    { name: 'Yellow/Blue', title: 'green channel shown as yellow, red channel shown as blue', m: [[0, 1, 0], [0, 1, 0], [1, 0, 0]] },
    { name: 'Isolate R', title: 'red channel only, as grey', m: [[1, 0, 0], [1, 0, 0], [1, 0, 0]] },
    { name: 'Isolate G', title: 'green channel only, as grey', m: [[0, 1, 0], [0, 1, 0], [0, 1, 0]] },
    { name: 'Isolate B', title: 'blue channel only, as grey', m: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] },
  ]
  function applyMixerPreset(m: ChannelMixer): void {
    look.channelMixer = m.map((row) => [...row]) as ChannelMixer
    look.save()
  }
  function mixerIs(m: ChannelMixer): boolean {
    const cur = look.channelMixer
    if (!cur) return false
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (cur[i][j] !== m[i][j]) return false
    return true
  }

  // --- CDL grade node ---
  type SopKey = 'slope' | 'offset' | 'power'
  const SOP_ROWS: Array<{ key: SopKey; min: number; max: number; step: number; neutral: number }> = [
    { key: 'slope', min: 0, max: 4, step: 0.01, neutral: 1 },
    { key: 'offset', min: -1, max: 1, step: 0.005, neutral: 0 },
    { key: 'power', min: 0.1, max: 4, step: 0.01, neutral: 1 },
  ]
  function sopMaster(key: SopKey): number {
    const v = look.cdl[key]
    return (v[0] + v[1] + v[2]) / 3
  }
  function setSopMaster(key: SopKey, v: number): void {
    if (!Number.isFinite(v)) return
    const cur = look.cdl[key]
    const delta = v - sopMaster(key)
    look.cdl[key] = [cur[0] + delta, cur[1] + delta, cur[2] + delta]
    look.save()
  }
  function setSopChannel(key: SopKey, i: number, v: number): void {
    if (!Number.isFinite(v)) return
    look.cdl[key][i] = v
    look.save()
  }
  function setCdlSat(v: number): void { look.cdl.saturation = v; look.save() }
  let cdlError = $state('')
  async function onImportCdl(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    cdlError = ''
    try { await look.importCdl(file) } catch (err) { cdlError = (err as Error).message }
  }
  const cdlActive = $derived(look.cdl.saturation !== 1 || look.cdl.slope.some((v) => v !== 1) || look.cdl.offset.some((v) => v !== 0) || look.cdl.power.some((v) => v !== 1))

  // --- filmic ---
  function setFilmicPreset(p: FilmicPreset): void { look.filmic.preset = p; look.save() }
  function setFilmicExposure(v: number): void { if (Number.isFinite(v) && v > 0) { look.filmic.exposure = v; look.save() } }

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
        <optgroup label="Okabe-Ito (colour-blind safe)">
          {#each okabe as c}<option value={`cm:${c.key}`}>{c.name}</option>{/each}
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
    <summary>Grade (CDL){#if cdlActive}<span class="dot" title="grade active"></span>{/if}</summary>
    <div class="muted small">ASC CDL: out = (in × slope + offset) ^ power, then saturation. Slope 0 on a channel isolates the others.</div>
    {#each SOP_ROWS as row (row.key)}
      <div class="row">
        <div class="label">{row.key}</div>
        <input type="range" min={row.min} max={row.max} step={row.step} value={sopMaster(row.key)}
          oninput={(e) => setSopMaster(row.key, parseFloat((e.currentTarget as HTMLInputElement).value))}
          disabled={!look.enabled} style="flex:1" aria-label={`CDL ${row.key} master`} />
        <span class="mono small">{sopMaster(row.key).toFixed(2)}</span>
      </div>
      <div class="row sop-channels">
        <div class="label"></div>
        {#each ['R', 'G', 'B'] as ch, i (ch)}
          <label class="sop-cell"><span class="ch ch-{ch}">{ch}</span>
            <input type="number" step={row.step} value={look.cdl[row.key][i]}
              oninput={(e) => setSopChannel(row.key, i, parseFloat((e.currentTarget as HTMLInputElement).value))}
              disabled={!look.enabled} aria-label={`CDL ${row.key} ${ch}`} />
          </label>
        {/each}
      </div>
    {/each}
    <div class="row">
      <div class="label">saturation</div>
      <input type="range" min="0" max="3" step="0.01" value={look.cdl.saturation}
        oninput={(e) => setCdlSat(parseFloat((e.currentTarget as HTMLInputElement).value))}
        disabled={!look.enabled} style="flex:1" aria-label="CDL saturation" />
      <span class="mono small">{look.cdl.saturation.toFixed(2)}</span>
    </div>
    <div class="row">
      <button onclick={() => look.resetCdl()}>Reset grade</button>
      <button onclick={() => look.exportCdl()} title="download the grade as an ASC .cdl file">Export .cdl</button>
      <label class="upload">Import .cdl…
        <input type="file" accept=".cdl,.ccc,.cc,.xml" onchange={onImportCdl} />
      </label>
    </div>
    {#if cdlError}<div class="muted small" style="color:var(--err)">{cdlError}</div>{/if}

    <div class="row" style="margin-top:8px">
      <div class="label">filmic</div>
      <select value={look.filmic.preset} onchange={(e) => setFilmicPreset((e.currentTarget as HTMLSelectElement).value as FilmicPreset)} disabled={!look.enabled} aria-label="filmic preset">
        {#each FILMIC_PRESETS as p (p)}<option value={p}>{p === 'neutral' ? 'Neutral (off)' : p === 'soft' ? 'Soft (ACES fit)' : 'Flat (log)'}</option>{/each}
      </select>
      <span class="label" style="min-width:auto">exposure</span>
      <input type="number" min="0.1" max="8" step="0.05" value={look.filmic.exposure}
        oninput={(e) => setFilmicExposure(parseFloat((e.currentTarget as HTMLInputElement).value))}
        disabled={!look.enabled || look.filmic.preset === 'neutral'} class="mixer-cell" aria-label="filmic exposure" />
      <button class="icon" title="reset exposure to {FILMIC_DEFAULT_EXPOSURE}" onclick={() => setFilmicExposure(FILMIC_DEFAULT_EXPOSURE)}>↺</button>
    </div>
    {#if look.filmic.preset === 'flat'}
      <div class="muted small">Flat lifts shadows hard; on the 8-bit stream that posterises. Best with the camera ~0.5 EV under.</div>
    {:else if look.filmic.preset === 'soft'}
      <div class="muted small">Soft rolls off the top gently; shoot ~0.3–0.5 EV under so highlights have room.</div>
    {/if}
  </details>

  <details class="adv">
    <summary>Adjustments</summary>
    <div class="row"><div class="label">black</div><input type="range" min="0" max="1" step="0.01" bind:value={look.levels.black} oninput={onChange} style="flex:1" /><span class="mono small">{look.levels.black.toFixed(2)}</span></div>
    <div class="row"><div class="label">white</div><input type="range" min="0" max="1" step="0.01" bind:value={look.levels.white} oninput={onChange} style="flex:1" /><span class="mono small">{look.levels.white.toFixed(2)}</span></div>
    <div class="row"><div class="label">gamma</div><input type="range" min="0.2" max="3" step="0.01" bind:value={look.levels.gamma} oninput={onChange} style="flex:1" /><span class="mono small">{look.levels.gamma.toFixed(2)}</span></div>
    <div class="row"><div class="label">saturation</div><input type="range" min="-1" max="1" step="0.01" bind:value={look.saturation} oninput={onChange} style="flex:1" /><span class="mono small">{look.saturation.toFixed(2)}</span></div>
    <div class="row"><div class="label">vibrance</div><input type="range" min="-1" max="1" step="0.01" bind:value={look.vibrance} oninput={onChange} style="flex:1" /><span class="mono small">{look.vibrance.toFixed(2)}</span></div>
    <div class="row"><div class="label">hue</div><input type="range" min="-180" max="180" step="1" bind:value={look.hue} oninput={onChange} style="flex:1" /><span class="mono small">{look.hue.toFixed(0)}°</span></div>

    <div class="mixer">
      <div class="label">presets</div>
      <div class="presets">
        {#each MIXER_PRESETS as p (p.name)}
          <button class:on={mixerIs(p.m)} title={p.title} onclick={() => applyMixerPreset(p.m)}>{p.name}</button>
        {/each}
      </div>
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
  .presets { display: flex; flex-wrap: wrap; gap: 4px; }
  .presets button { font-size: 11px; padding: 2px 8px; }
  .presets button.on { color: var(--accent); border-color: var(--accent); }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-left: 6px; vertical-align: middle; }
  .sop-channels { gap: 6px; margin-top: -2px; }
  .sop-cell { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; }
  .sop-cell input { width: 56px; font-size: 11px; padding: 2px 4px; }
  .ch { font-weight: 600; width: 1em; }
  .ch-R { color: #e05050; } .ch-G { color: #40b050; } .ch-B { color: #5080ff; }
  .icon { padding: 0 4px; line-height: 1; background: transparent; border: none; cursor: pointer; color: var(--muted); }
  .icon:hover { color: var(--fg); }

  @media (max-width: 720px) {
    input[type=range] { min-height: 28px; }
  }
  @media (pointer: coarse) {
    .upload, button, select { min-height: 32px; }
    .mixer-cell { min-height: 28px; }
  }
</style>
