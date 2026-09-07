<script lang="ts">
  /** The current sample: editable metadata copied onto every photo/video taken while it is filled in
   *  (see `saveSnapshot`/`saveVideo` in `lib/store/gallery.ts`). Collapsed by default. */
  import { sample, saveSample, clearSample, hasSample } from '../lib/store/sample.svelte'
  import { fetchSnapshotBitmap } from '../lib/api/snapshot'

  let scanning = $state(false)
  let scanMsg = $state('')
  const barcodeSupported = typeof (window as any).BarcodeDetector !== 'undefined'

  async function scanCode() {
    if (!barcodeSupported) {
      scanMsg = 'barcode scanning needs the browser BarcodeDetector API (available in Chrome/Edge on desktop and Android; not in Firefox or Safari)'
      return
    }
    scanning = true; scanMsg = ''
    try {
      const Detector = (window as any).BarcodeDetector
      const formats = await Detector.getSupportedFormats?.().catch(() => undefined)
      const detector = new Detector(formats ? { formats } : undefined)
      const bmp = await fetchSnapshotBitmap()
      try {
        const codes = await detector.detect(bmp)
        if (codes.length) { sample.slideId = codes[0].rawValue; saveSample(); scanMsg = `read "${codes[0].rawValue}" (${codes[0].format})` }
        else scanMsg = 'no barcode found in the current frame — centre it in view and try again'
      } finally { bmp.close?.() }
    } catch (e) { scanMsg = (e as Error).message } finally { scanning = false }
  }
</script>

<details class="panel">
  <summary><h3 style="display:inline-block">Sample{hasSample() ? ` · ${sample.name || sample.specimen || 'set'}` : ''}</h3></summary>
  <div class="grid" style="margin-top:8px">
    <label>Name <input bind:value={sample.name} onchange={saveSample} placeholder="e.g. Pond water A3" /></label>
    <label>Specimen <input bind:value={sample.specimen} onchange={saveSample} placeholder="organism / subject" /></label>
    <label>Stain / prep <input bind:value={sample.stain} onchange={saveSample} placeholder="e.g. unstained, wet mount" /></label>
    <label>Slide id / barcode
      <span class="row">
        <input style="flex:1" bind:value={sample.slideId} onchange={saveSample} />
        <button onclick={scanCode} disabled={scanning} title="read a QR/Data Matrix/1D barcode from the current live frame">{scanning ? '…' : '⌗ scan'}</button>
      </span>
    </label>
    <label>Magnification <input bind:value={sample.magnification} onchange={saveSample} placeholder="e.g. 40x" /></label>
    <label>Operator <input bind:value={sample.operator} onchange={saveSample} /></label>
    <label style="grid-column:1/-1">Notes <textarea rows="2" bind:value={sample.notes} onchange={saveSample}></textarea></label>
  </div>
  {#if scanMsg}<div class="muted small" style="margin-top:6px">{scanMsg}</div>{/if}
  <div class="row" style="margin-top:8px">
    <button onclick={clearSample} disabled={!hasSample()}>Clear</button>
  </div>
  <p class="blurb">Filled-in fields are copied onto every photo and video taken from here; edit a single item's sample data from its viewer in the gallery.</p>
</details>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
  .grid label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
  .grid input, .grid textarea { font-size: 13px; }
  .small { font-size: 11px; }
  .blurb { margin: 8px 0 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
</style>
