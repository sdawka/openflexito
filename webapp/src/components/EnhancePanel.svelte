<script lang="ts">
  /** Gallery viewer's Enhance panel: pick a preset or dial in denoise/sharpen/deconvolve/local
   *  contrast/tone/illumination/colour/look sections, watch a debounced live preview, then "Apply" to
   *  save the full-resolution result as a new photo (`services/enhance.svelte.ts`). Shown by
   *  `Viewer.svelte` for `kind: 'snapshot'` items only (scans/videos/time-lapses get nothing - they
   *  have no single develop-pipeline source). */
  import { untrack } from 'svelte'
  import { enhance, PRESETS, type PresetName } from '../lib/services/enhance.svelte'
  import { look } from '../lib/store/look.svelte'
  import type { GalleryItem } from '../lib/store/gallery'
  import type { EnhanceParams } from '../lib/algo/pipeline'

  type ToggleKey = 'denoise' | 'sharpen' | 'deconvolve' | 'clahe' | 'autoLevels' | 'shadowsHighlights' | 'filmic' | 'colour' | 'flatField' | 'vignette' | 'ca'

  let { item, onApplied }: { item: GalleryItem; onApplied?: (saved: GalleryItem) => void } = $props()

  // Re-open for each item. `open()` reads and writes the service's own $state (preview, ready, params),
  // so it runs untracked: tracking those reads would re-run this effect on every preview and re-open
  // forever (the "loading source…" hang).
  $effect(() => { const it = item; untrack(() => void enhance.open(it)) })

  function preset(name: PresetName): void { enhance.selectPreset(name) }
  function changed(): void { enhance.paramsChanged() }

  function toggle<K extends ToggleKey>(key: K, on: boolean, make: () => NonNullable<EnhanceParams[K]>): void {
    enhance.params = { ...enhance.params, [key]: on ? make() : undefined }
    enhance.preset = 'Off' // any manual edit stops calling itself a named preset
    changed()
  }

  let comparing = $state(false) // hold to show the original instead of the preview
  let applyError = $state('')
  let applied = $state<GalleryItem | null>(null)
  let canvas: HTMLCanvasElement | undefined = $state()

  $effect(() => {
    const bmp = comparing ? enhance.originalPreview : enhance.preview
    if (!canvas || !bmp) return
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
    const ctx = canvas.getContext('2d')
    ctx?.drawImage(bmp, 0, 0)
  })

  async function doApply(): Promise<void> {
    applyError = ''
    try {
      const saved = await enhance.apply()
      applied = saved
      onApplied?.(saved)
    } catch (e) {
      applyError = (e as Error).message
    }
  }

  const p = $derived(enhance.params)
</script>

<div class="panel enhance-panel">
  <h3>Enhance</h3>

  <div class="row presets">
    {#each PRESETS as name}
      <button class:on={enhance.preset === name} onclick={() => preset(name)}>{name}</button>
    {/each}
  </div>

  {#if !enhance.ready}
    <div class="muted">loading source…</div>
  {:else}
    <div class="preview-wrap">
      <div class="preview-box" onpointerdown={() => (comparing = true)} onpointerup={() => (comparing = false)} onpointerleave={() => (comparing = false)} role="presentation">
        <canvas bind:this={canvas} class="preview-canvas"></canvas>
        <span class="hint">{comparing ? 'original' : 'hold to compare original'}</span>
      </div>
      {#if enhance.busy}<div class="muted small">rendering preview…{enhance.progress ? ` ${enhance.progress.stage}` : ''}</div>{/if}
      {#if enhance.estimatedFullResS != null}<div class="muted small">full resolution will take ~{enhance.estimatedFullResS.toFixed(1)}s</div>{/if}
    </div>

    <details open>
      <summary>Denoise</summary>
      <label class="chk"><input type="checkbox" checked={!!p.denoise} onchange={(e) => toggle('denoise', e.currentTarget.checked, () => ({ method: 'wavelet', strength: 0.8, chroma: 0.3 }))} /> enable</label>
      {#if p.denoise}
        <div class="row"><div class="label">method</div>
          <select bind:value={p.denoise.method} onchange={changed}>
            <option value="wavelet">wavelet</option><option value="nlm">NLM (quality, slow)</option>
            <option value="guided">guided</option><option value="bilateral">bilateral</option>
          </select>
        </div>
        <div class="row"><div class="label">strength</div><input type="range" min="0" max="2" step="0.05" bind:value={p.denoise.strength} oninput={changed} style="flex:1" /><span class="mono small">{p.denoise.strength.toFixed(2)}</span></div>
        <div class="row"><div class="label">chroma</div><input type="range" min="0" max="1" step="0.05" bind:value={p.denoise.chroma} oninput={changed} style="flex:1" /><span class="mono small">{p.denoise.chroma.toFixed(2)}</span></div>
        {#if p.denoise.method === 'nlm'}
          <div class="row"><div class="label">patch</div><input type="range" min="1" max="4" step="1" value={p.denoise.patch ?? 2} oninput={(e) => { p.denoise!.patch = +e.currentTarget.value; changed() }} style="flex:1" /><span class="mono small">{p.denoise.patch ?? 2}</span></div>
          <div class="row"><div class="label">search</div><input type="range" min="3" max="12" step="1" value={p.denoise.search ?? 6} oninput={(e) => { p.denoise!.search = +e.currentTarget.value; changed() }} style="flex:1" /><span class="mono small">{p.denoise.search ?? 6}</span></div>
        {/if}
      {/if}
    </details>

    <details>
      <summary>Sharpen</summary>
      <label class="chk"><input type="checkbox" checked={!!p.sharpen} onchange={(e) => toggle('sharpen', e.currentTarget.checked, () => ({ mode: 'unsharp', radius: 1.2, amount: 0.5, threshold: 0.02 }))} /> enable</label>
      {#if p.sharpen}
        <div class="row"><div class="label">mode</div>
          <select bind:value={p.sharpen.mode} onchange={changed}><option value="unsharp">unsharp mask</option><option value="edge">edge-aware</option></select>
        </div>
        <div class="row"><div class="label">radius</div><input type="range" min="0.3" max="6" step="0.1" bind:value={p.sharpen.radius} oninput={changed} style="flex:1" /><span class="mono small">{p.sharpen.radius.toFixed(1)}</span></div>
        <div class="row"><div class="label">amount</div><input type="range" min="0" max="2" step="0.05" bind:value={p.sharpen.amount} oninput={changed} style="flex:1" /><span class="mono small">{p.sharpen.amount.toFixed(2)}</span></div>
        <div class="row"><div class="label">threshold</div><input type="range" min="0" max="0.2" step="0.005" bind:value={p.sharpen.threshold} oninput={changed} style="flex:1" /><span class="mono small">{p.sharpen.threshold.toFixed(3)}</span></div>
      {/if}
    </details>

    <details>
      <summary>Deconvolve</summary>
      <label class="chk"><input type="checkbox" checked={!!p.deconvolve} onchange={(e) => toggle('deconvolve', e.currentTarget.checked, () => ({ method: 'rl', sigma: 1.0, iterations: 5 }))} /> enable</label>
      {#if p.deconvolve}
        <div class="row"><div class="label">method</div>
          <select bind:value={p.deconvolve.method} onchange={changed}><option value="rl">Richardson-Lucy</option><option value="wiener">Wiener</option></select>
        </div>
        <div class="row"><div class="label">σ (PSF)</div><input type="range" min="0.3" max="4" step="0.1" bind:value={p.deconvolve.sigma} oninput={changed} style="flex:1" /><span class="mono small">{p.deconvolve.sigma.toFixed(1)}</span></div>
        {#if p.deconvolve.method === 'rl'}
          <div class="row"><div class="label">iterations</div><input type="range" min="1" max="30" step="1" bind:value={p.deconvolve.iterations} oninput={changed} style="flex:1" /><span class="mono small">{p.deconvolve.iterations}</span></div>
        {:else}
          <div class="row"><div class="label">noise</div><input type="range" min="0.001" max="0.2" step="0.001" value={p.deconvolve.noise ?? 0.01} oninput={(e) => { p.deconvolve!.noise = +e.currentTarget.value; changed() }} style="flex:1" /><span class="mono small">{(p.deconvolve.noise ?? 0.01).toFixed(3)}</span></div>
        {/if}
      {/if}
    </details>

    <details>
      <summary>Local contrast</summary>
      <label class="chk"><input type="checkbox" checked={!!p.clahe} onchange={(e) => toggle('clahe', e.currentTarget.checked, () => ({ tiles: 8, clip: 0.02 }))} /> enable CLAHE</label>
      {#if p.clahe}
        <div class="row"><div class="label">tiles</div><input type="range" min="2" max="16" step="1" bind:value={p.clahe.tiles} oninput={changed} style="flex:1" /><span class="mono small">{p.clahe.tiles}</span></div>
        <div class="row"><div class="label">clip</div><input type="range" min="0.001" max="0.1" step="0.001" bind:value={p.clahe.clip} oninput={changed} style="flex:1" /><span class="mono small">{p.clahe.clip.toFixed(3)}</span></div>
      {/if}
    </details>

    <details>
      <summary>Tone</summary>
      <label class="chk"><input type="checkbox" checked={!!p.autoLevels} onchange={(e) => toggle('autoLevels', e.currentTarget.checked, () => ({ lowPct: 0.5, highPct: 99.5, perChannel: false }))} /> auto-levels</label>
      {#if p.autoLevels}
        <div class="row"><div class="label">low %</div><input type="range" min="0" max="5" step="0.1" bind:value={p.autoLevels.lowPct} oninput={changed} style="flex:1" /><span class="mono small">{p.autoLevels.lowPct.toFixed(1)}</span></div>
        <div class="row"><div class="label">high %</div><input type="range" min="95" max="100" step="0.1" bind:value={p.autoLevels.highPct} oninput={changed} style="flex:1" /><span class="mono small">{p.autoLevels.highPct.toFixed(1)}</span></div>
        <label class="chk"><input type="checkbox" bind:checked={p.autoLevels.perChannel} onchange={changed} /> per channel</label>
      {/if}
      <label class="chk"><input type="checkbox" checked={!!p.shadowsHighlights} onchange={(e) => toggle('shadowsHighlights', e.currentTarget.checked, () => ({ shadows: 0.3, highlights: -0.3, radius: 40 }))} /> shadows/highlights</label>
      {#if p.shadowsHighlights}
        <div class="row"><div class="label">shadows</div><input type="range" min="-1" max="1" step="0.05" bind:value={p.shadowsHighlights.shadows} oninput={changed} style="flex:1" /><span class="mono small">{p.shadowsHighlights.shadows.toFixed(2)}</span></div>
        <div class="row"><div class="label">highlights</div><input type="range" min="-1" max="1" step="0.05" bind:value={p.shadowsHighlights.highlights} oninput={changed} style="flex:1" /><span class="mono small">{p.shadowsHighlights.highlights.toFixed(2)}</span></div>
      {/if}
      <label class="chk"><input type="checkbox" checked={!!p.filmic} onchange={(e) => toggle('filmic', e.currentTarget.checked, () => ({ contrast: 1.1, white: 1.2 }))} /> filmic contrast</label>
      {#if p.filmic}
        <div class="row"><div class="label">contrast</div><input type="range" min="0.5" max="2" step="0.05" bind:value={p.filmic.contrast} oninput={changed} style="flex:1" /><span class="mono small">{p.filmic.contrast.toFixed(2)}</span></div>
        <div class="row"><div class="label">white</div><input type="range" min="0.8" max="3" step="0.05" bind:value={p.filmic.white} oninput={changed} style="flex:1" /><span class="mono small">{p.filmic.white.toFixed(2)}</span></div>
      {/if}
    </details>

    <details>
      <summary>Illumination</summary>
      <label class="chk"><input type="checkbox" checked={!!p.flatField} onchange={(e) => toggle('flatField', e.currentTarget.checked, () => ({ sigma: 40 }))} /> pseudo-flat-field</label>
      {#if p.flatField}
        <div class="row"><div class="label">σ</div><input type="range" min="4" max="200" step="1" bind:value={p.flatField.sigma} oninput={changed} style="flex:1" /><span class="mono small">{p.flatField.sigma}</span></div>
      {/if}
      <label class="chk"><input type="checkbox" checked={!!p.vignette} onchange={(e) => toggle('vignette', e.currentTarget.checked, () => ({ a: 0.2, b: 0, c: 0 }))} /> vignette correct</label>
      {#if p.vignette}
        <div class="row"><div class="label">a</div><input type="range" min="-1" max="1" step="0.01" bind:value={p.vignette.a} oninput={changed} style="flex:1" /><span class="mono small">{p.vignette.a.toFixed(2)}</span></div>
        <div class="row"><div class="label">b</div><input type="range" min="-1" max="1" step="0.01" bind:value={p.vignette.b} oninput={changed} style="flex:1" /><span class="mono small">{p.vignette.b.toFixed(2)}</span></div>
      {/if}
      <label class="chk"><input type="checkbox" checked={!!p.ca} onchange={(e) => toggle('ca', e.currentTarget.checked, () => ({ red: 0, blue: 0 }))} /> chromatic aberration</label>
      {#if p.ca}
        <div class="row"><div class="label">red</div><input type="range" min="-0.01" max="0.01" step="0.0005" bind:value={p.ca.red} oninput={changed} style="flex:1" /><span class="mono small">{p.ca.red.toFixed(4)}</span></div>
        <div class="row"><div class="label">blue</div><input type="range" min="-0.01" max="0.01" step="0.0005" bind:value={p.ca.blue} oninput={changed} style="flex:1" /><span class="mono small">{p.ca.blue.toFixed(4)}</span></div>
      {/if}
    </details>

    <details>
      <summary>Colour</summary>
      <label class="chk"><input type="checkbox" checked={!!p.colour} onchange={(e) => toggle('colour', e.currentTarget.checked, () => ({ saturation: 0, vibrance: 0.2 }))} /> enable</label>
      {#if p.colour}
        <div class="row"><div class="label">saturation</div><input type="range" min="-1" max="1" step="0.05" bind:value={p.colour.saturation} oninput={changed} style="flex:1" /><span class="mono small">{p.colour.saturation.toFixed(2)}</span></div>
        <div class="row"><div class="label">vibrance</div><input type="range" min="-1" max="1" step="0.05" bind:value={p.colour.vibrance} oninput={changed} style="flex:1" /><span class="mono small">{p.colour.vibrance.toFixed(2)}</span></div>
      {/if}
    </details>

    {#if look.current}
      <details>
        <summary>Look</summary>
        <label class="chk"><input type="checkbox" bind:checked={enhance.applyLook} onchange={changed} /> apply current look</label>
      </details>
    {/if}

    <div class="row actions">
      <button onclick={() => enhance.reset()}>Reset</button>
      <button class="primary" disabled={enhance.applyBusy} onclick={doApply}>
        {enhance.applyBusy ? `Applying…${enhance.applyProgress ? ` ${enhance.applyProgress.stage}` : ''}` : 'Apply → new photo'}
      </button>
    </div>
    {#if applyError}<div class="error">{applyError}</div>{/if}
    {#if applied}<div class="muted small">saved as "{applied.name}"</div>{/if}
  {/if}
</div>

<style>
  .enhance-panel { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
  .presets { flex-wrap: wrap; }
  .presets button.on { background: var(--accent); color: #fff; }
  .preview-wrap { position: relative; }
  .preview-box { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #111; border-radius: 4px; overflow: hidden; touch-action: none; }
  .preview-canvas { width: 100%; height: 100%; object-fit: contain; }
  .hint { position: absolute; bottom: 4px; left: 6px; font-size: 10px; color: #ccc; text-shadow: 0 0 3px #000; pointer-events: none; }
  details { border-top: 1px solid var(--border); padding-top: 4px; }
  details summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
  .chk { display: flex; gap: 6px; align-items: center; font-size: 12px; margin: 2px 0; }
  .row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .label { width: 70px; font-size: 11px; flex-shrink: 0; }
  .small { font-size: 11px; }
  .actions { justify-content: space-between; margin-top: 6px; }
  .error { color: var(--err); font-size: 12px; }

  @media (max-width: 720px) {
    .enhance-panel { max-height: 50vh; }
  }
</style>
