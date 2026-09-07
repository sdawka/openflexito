<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import type { StageStatus } from '../lib/api/types'

  let stage = $state<StageStatus | null>(null)
  let schema = $state<{ name: string; doc: string; params: { name: string; type: string; required: boolean }[] }[]>([])
  let streamW = $state(1640), streamH = $state(1232)

  // ---- device logs (persistent journal on the Pi, or in-memory app records) ----
  let logSource = $state<'journal' | 'app'>('journal')
  let logLevel = $state('INFO')
  let logLines = $state(200)
  let logText = $state('')
  let logUsage = $state('')
  let logAuto = $state(false)
  let logBusy = $state(false)
  async function loadLogs() {
    if (!device.connected || logBusy) return
    logBusy = true
    try {
      const r = await device.client.call<any>('system.logs', { lines: logLines, level: logLevel, source: logSource })
      if (r.source === 'app') {
        logText = (r.records as any[]).map((x) => `${new Date(x.t * 1000).toISOString().replace('T', ' ').slice(0, 19)} ${x.level} ${x.logger}: ${x.msg}`).join('\n')
        logUsage = `${r.records.length} records in memory`
      } else {
        logText = (r.lines as string[]).join('\n')
        logUsage = r.disk_usage
      }
    } catch (e) { logText = `failed to load logs: ${(e as Error).message}` } finally { logBusy = false }
  }
  async function clearLogs() {
    if (!confirm('Delete all stored logs on the microscope?')) return
    try { await device.client.call('system.clear_logs'); await loadLogs() } catch (e) { logText = `clear failed: ${(e as Error).message}` }
  }
  function downloadLogs() {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([logText], { type: 'text/plain' }))
    a.download = `openflexito-${logSource}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  $effect(() => {
    if (!logAuto) return
    loadLogs()
    const t = setInterval(loadLogs, 5000)
    return () => clearInterval(t)
  })

  $effect(() => {
    if (device.connected) {
      device.stageStatus().then((s) => { stage = s }).catch(() => {})
      device.client.call('system.schema').then((s) => { schema = s.methods }).catch(() => {})
      const size = device.status?.camera?.stream_size
      if (size) { streamW = size[0]; streamH = size[1] }
    }
  })

  async function applyStage() {
    if (!stage) return
    await device.client.call('stage.set_backlash', stage.backlash)
    await device.client.call('stage.set_inverted', stage.inverted)
    if (stage.release_after !== undefined) await device.client.call('stage.set_release_after', { seconds: stage.release_after })
  }
  async function applyStream() {
    await device.client.call('camera.set_stream_size', { width: streamW, height: streamH })
  }
  function applyDevice() {
    saveSettings()
    location.reload()
  }
</script>

<div class="wrap">
  <div class="panel">
    <h3>Connection</h3>
    <div class="label">Device URL (empty = same origin as this page)</div>
    <div class="row">
      <input style="flex:1" bind:value={settings.deviceUrl} placeholder="http://microscope.local" />
      <button onclick={applyDevice}>Apply &amp; reload</button>
    </div>
    {#if device.status}
      <p class="muted mono" style="font-size:12px">
        device v{device.status.version} · network {device.status.network.state} {device.status.network.ip ?? ''} ·
        camera {device.status.camera?.sensor?.model ?? 'none'}{device.status.camera?.fake ? ' (fake)' : ''} ·
        stage {device.status.stage?.board ?? 'none'} {device.status.stage?.firmware ?? ''} on {device.status.stage?.port ?? ''}
      </p>
    {/if}
  </div>

  <div class="panel">
    <h3>Input</h3>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" bind:checked={settings.gamepad} onchange={saveSettings} /> enable gamepad</label>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" bind:checked={settings.invertYKeys} onchange={saveSettings} /> invert Y for keyboard</label>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" bind:checked={settings.showLores} onchange={saveSettings} /> show low-resolution stream (saves bandwidth)</label>
  </div>

  {#if stage}
    <div class="panel">
      <h3>Stage</h3>
      <div class="row">
        {#each ['x', 'y', 'z'] as const as a}
          <div>
            <div class="label">backlash {a}</div>
            <input class="mono" type="number" style="width:90px" bind:value={stage.backlash[a]} />
          </div>
        {/each}
      </div>
      <div class="row" style="margin-top:8px">
        {#each ['x', 'y', 'z'] as const as a}
          <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={stage.inverted[a]} /> invert {a}</label>
        {/each}
      </div>
      <div class="row" style="margin-top:10px">
        <div class="row" style="margin-top:8px">
          <label style="margin:0">release motor coils after <input class="mono" type="number" min="0" step="0.5" style="width:70px" bind:value={stage.release_after} /> s idle
            <span class="muted">(0 = hold for ever, motors stay hot; the actuators hold position without current)</span></label>
        </div>
        <button class="primary" onclick={applyStage}>Apply to device</button>
        <span class="muted mono" style="font-size:12px">step time {stage.step_time_us} µs</span>
      </div>
    </div>
  {/if}

  <div class="panel">
    <h3>Intelligence (runs in this browser)</h3>
    <div class="row">
      <div style="flex:1"><div class="label">detection model (Hugging Face id)</div><input style="width:100%" bind:value={settings.detectModel} onchange={saveSettings} /></div>
      <div style="flex:1"><div class="label">CLIP model for image search</div><input style="width:100%" bind:value={settings.clipModel} onchange={saveSettings} /></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div><div class="label">detection threshold</div><input type="number" min="0.1" max="0.95" step="0.05" style="width:80px" bind:value={settings.detectThreshold} onchange={saveSettings} /></div>
      <div><div class="label">detection interval (ms)</div><input type="number" min="200" step="100" style="width:90px" bind:value={settings.detectIntervalMs} onchange={saveSettings} /></div>
      <div><div class="label">follow deadband (px)</div><input type="number" min="2" step="1" style="width:80px" bind:value={settings.followDeadbandPx} onchange={saveSettings} /></div>
      <div><div class="label">follow interval (ms)</div><input type="number" min="100" step="50" style="width:90px" bind:value={settings.followIntervalMs} onchange={saveSettings} /></div>
    </div>
    <p class="muted" style="font-size:12px">Models download from huggingface.co on first use (needs internet on this computer) and are cached by the browser. WebGPU is used when available.</p>
  </div>

  <div class="panel">
    <h3>Stream</h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px">The Pi's hardware JPEG encoder produces ~100 kB frames whatever the
      resolution, so a smaller stream means more quality per pixel. <b>820 × 616</b> (the OpenFlexure default) is the cleanest:
      4× the JPEG quality per pixel, half the flicker and a third of the CPU of 1640 × 1232, which in turn resolves twice the
      detail but looks blockier. Every size covers the full field of view. Redo "Calibrate XY" after changing it.</p>
    <div class="row">
      <select bind:value={streamW} onchange={(e) => { streamH = { 1640: 1232, 820: 616, 1280: 960, 640: 480 }[+e.currentTarget.value] ?? streamH }}>
        <option value={820}>820 × 616 (cleanest, recommended)</option>
        <option value={1280}>1280 × 960</option>
        <option value={1640}>1640 × 1232 (most detail, blockier)</option>
        <option value={640}>640 × 480</option>
      </select>
      <button onclick={applyStream}>Apply (restarts camera)</button>
      <button class="danger" onclick={() => device.client.call('camera.reset_tuning')}>Reset tuning file</button>
    </div>
  </div>

  <div class="panel">
    <h3>Device logs</h3>
    <p class="muted" style="font-size:12px;margin-top:0">The microscope keeps its service log on the SD card (size-capped, survives reboots) including
      crashes of camera or stage threads. Fetch the tail here, download it for a bug report, or clear it.</p>
    <div class="row">
      <select bind:value={logSource}><option value="journal">system journal (persistent)</option><option value="app">app records (in memory)</option></select>
      <select bind:value={logLevel}>{#each ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as l}<option value={l}>{l} and above</option>{/each}</select>
      <select bind:value={logLines}><option value={100}>100 lines</option><option value={200}>200 lines</option><option value={1000}>1000 lines</option><option value={5000}>5000 lines</option></select>
      <button class="primary" onclick={loadLogs} disabled={!device.connected || logBusy}>Fetch</button>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" bind:checked={logAuto} /> auto-refresh</label>
      <button onclick={downloadLogs} disabled={!logText}>Download</button>
      <button class="danger" onclick={clearLogs} disabled={!device.connected}>Clear stored logs</button>
      {#if logUsage}<span class="muted mono" style="font-size:12px">{logUsage}</span>{/if}
    </div>
    {#if logText}<pre class="logs mono">{logText}</pre>{/if}
  </div>

  <div class="panel">
    <h3>RPC methods</h3>
    <div class="methods mono">
      {#each schema as m}
        <div><b>{m.name}</b>({m.params.map((p) => p.name + (p.required ? '' : '?') + ': ' + p.type).join(', ')}) <span class="muted">— {m.doc}</span></div>
      {/each}
    </div>
  </div>
</div>

<style>
  .logs { max-height: 360px; overflow: auto; font-size: 11px; white-space: pre-wrap; margin: 8px 0 0; background: var(--panel2); padding: 8px; border-radius: 6px; }
  .wrap { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 900px; }
  .methods { font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
</style>
