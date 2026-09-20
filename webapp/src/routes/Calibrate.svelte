<script lang="ts">
  /** Guided calibration. Two independent procedures, each with its own prerequisites:
   *    1. illumination, exposure and colour  (needs an EMPTY, evenly lit field of view)
   *    2. stage <-> camera mapping           (needs a FOCUSED sample with visible detail)
   *  All maths runs in this browser; the device only supplies raw frames and moves the stage. */
  import { device } from '../lib/store/device.svelte'
  import { calibration, saveCsm } from '../lib/store/calibration.svelte'
  import { settings } from '../lib/store/settings.svelte'
  import { fetchRaw, grabGray } from '../lib/api/sampler'
  import { parseRaw, splitBayer, rawLevel } from '../lib/algo/raw'
  import { autoExpose } from '../lib/algo/exposure'
  import { flatLensShading, lensShadingFromPlanes, checkFlatField, type LensShading } from '../lib/algo/lst'
  import { setLensShading, setStaticGreenEqualisation, setContrastEnhancement, isLensShadingCalibrated, CT_CALIBRATED, CT_UNCALIBRATED, type Tuning } from '../lib/algo/tuning'
  import { calibrate1D, contrast, imageToStageMatrix, moveUntilMotionDetected } from '../lib/algo/csm'
  import LstView from '../components/LstView.svelte'
  import { captureFlatField } from '../lib/services/photo/rawPhoto'
  import { saveRawFlatField } from '../lib/store/calibration.svelte'

  // ---- shared state -------------------------------------------------------------------------
  let previewImg: HTMLImageElement | undefined = $state()
  // abort the preview stream when leaving the page (a detached <img> keeps downloading otherwise)
  $effect(() => { const el = previewImg; return () => { if (el) el.src = '' } })

  let log = $state<string[]>([])
  let busy = $state<string | null>(null)
  let progress = $state('')
  const say = (m: string) => { progress = m; log = [...log.slice(-200), `${new Date().toLocaleTimeString()}  ${m}`] }

  async function run(name: string, fn: () => Promise<void>) {
    if (busy) return
    busy = name; progress = ''
    try { await fn(); say(`${name}: done`) } catch (e) { say(`${name} FAILED: ${(e as Error).message}`) } finally { busy = null }
  }

  // ---- 1. illumination, exposure, colour ----------------------------------------------------
  let tuningCalibrated = $state<boolean | null>(null)
  let flatDone = $state(false)
  let lst = $state<LensShading | null>(null)
  let exposureResult = $state<{ exposure: number; gain: number; level: number; converged: boolean } | null>(null)

  $effect(() => {
    if (device.connected && tuningCalibrated === null) {
      device.client.call<Tuning>('camera.get_tuning').then((t) => { tuningCalibrated = isLensShadingCalibrated(t) }).catch(() => {})
    }
  })

  const controls = $derived(device.controls)
  const exposureFixed = $derived(!!controls && !controls.AeEnable)
  const colourFixed = $derived(!!controls && !controls.AwbEnable)
  const ledOn = $derived(device.light.cc > 0.02)
  const colourStatus = $derived<'done' | 'partial' | 'todo'>(
    tuningCalibrated && exposureFixed && colourFixed ? 'done' : (tuningCalibrated || exposureFixed) ? 'partial' : 'todo')

  async function currentTuning(): Promise<Tuning> { return device.client.call<Tuning>('camera.get_tuning') }
  async function pushTuning(t: Tuning) {
    say('uploading tuning file and restarting the camera (~2 s)…')
    await device.client.call('camera.set_tuning', { tuning: t })
    await new Promise((r) => setTimeout(r, 1500))
  }

  const ledDefault = () => run('LED to default', async () => { await device.setLight(0.32) })
  // LED brightness slider: the exposure step measures the light that is actually there, so the LED
  // must be set *before* running it and left alone afterwards (changing it later means redoing step 1).
  let ledTimer: ReturnType<typeof setTimeout> | undefined
  function ledSlider(v: number) {
    clearTimeout(ledTimer)
    ledTimer = setTimeout(() => device.setLight(v).catch((e) => say(`LED: ${(e as Error).message}`)), 120)
  }

  async function doFlat() {
    say('writing flat lens-shading tables so the raw frame is measured without correction…')
    let t = await currentTuning()
    t = setLensShading(t, flatLensShading(), CT_UNCALIBRATED)
    t = setStaticGreenEqualisation(t, 65535)
    t = setContrastEnhancement(t, false)
    await pushTuning(t)
    await device.setControls({ AwbEnable: false, AeEnable: false, ColourGains: [1, 1] })
    tuningCalibrated = false; flatDone = true; lst = null
  }
  async function doExpose() {
    say('searching for an exposure that puts the brightest pixels at ~40 % of full scale…')
    const r = await autoExpose({
      async setControls(c) {
        const applied = await device.client.call<any>('camera.set_controls', c)
        await new Promise((res) => setTimeout(res, 400))
        return { ExposureTime: applied.ExposureTime, AnalogueGain: applied.AnalogueGain }
      },
      async measureLevel() { return rawLevel(splitBayer(parseRaw(await fetchRaw()))) },
      log: say,
    }, { target: 400 })
    exposureResult = r
    device.controls = await device.client.call('camera.get_controls')
    if (!r.converged) say('exposure did not converge: is the LED on and the field of view empty?')
  }
  async function doLst() {
    say('capturing a raw flat field (~15 s over WiFi)…')
    const planes = splitBayer(parseRaw(await fetchRaw()))
    // The table is max(g)/g, so a frame that is not actually an empty field bakes the sample's own
    // dark regions in as a large gain and blows out every later RAW develop. Refuse rather than write.
    const check = checkFlatField(planes)
    say(`flat field: mean level ${check.level.toFixed(1)}, bright:dark ${check.ratio.toFixed(1)}x`)
    if (!check.ok) throw new Error(check.reason)
    const result = lensShadingFromPlanes(planes)
    lst = result
    let t = await currentTuning()
    t = setLensShading(t, result, CT_CALIBRATED)
    await pushTuning(t)
    await device.setControls({ AwbEnable: false, ColourGains: result.colourGains })
    tuningCalibrated = true
    say(`lens shading applied; white balance fixed at red ${result.colourGains[0].toFixed(3)}, blue ${result.colourGains[1].toFixed(3)}`)
  }
  const stepFlat = () => run('1b flat tables', doFlat)
  const stepExpose = () => run('1c exposure', doExpose)
  const stepLst = () => run('1d lens shading', doLst)
  const stepAll = () => run('colour calibration', async () => { await doFlat(); await doExpose(); await doLst() })
  const resetTuning = () => run('reset to factory tuning', async () => {
    await device.client.call('camera.reset_tuning'); tuningCalibrated = false; flatDone = false; lst = null; exposureResult = null
    await device.setControls({ AeEnable: true, AwbEnable: true })
  })
  const quickAuto = () => run('auto exposure and white balance', async () => { await device.setControls({ AeEnable: true, AwbEnable: true }) })

  // ---- 2. stage <-> camera mapping ----------------------------------------------------------
  const csm = $derived(calibration.csm)
  const calibrateCsm = () => run('stage-camera mapping', async () => {
    const io = {
      grab: () => grabGray(410, 80),
      moveRel: (d: { x?: number; y?: number; z?: number }) => device.moveRel(d, false),
      onProgress: (m: string) => say(m),
    }
    const ref = await grabGray(410, 0)
    const c = contrast(ref)
    if (c < 3) throw new Error(`the image is featureless (contrast ${c.toFixed(1)}); put a sample with visible detail in focus first`)
    say(`image contrast ${c.toFixed(1)}: ok`)
    say('x: finding a step size that visibly moves the image…')
    const stepX = await moveUntilMotionDetected(io, { x: 1, y: 0, z: 0 }, 10)
    say(`x: ${stepX} steps moves the image; measuring pixels per step and backlash…`)
    const calX = await calibrate1D(io, { x: 1, y: 0, z: 0 }, stepX * 2, 4)
    say('y: finding a step size that visibly moves the image…')
    const stepY = await moveUntilMotionDetected(io, { x: 0, y: 1, z: 0 }, 10)
    say(`y: ${stepY} steps moves the image; measuring pixels per step and backlash…`)
    const calY = await calibrate1D(io, { x: 0, y: 1, z: 0 }, stepY * 2, 4)
    const matrix = imageToStageMatrix(calX, calY)
    saveCsm({ matrix, imageWidth: ref.width, imageHeight: ref.height, calX, calY, when: new Date().toISOString() })
    say(`x ${calX.pixelsPerStep.map((v) => v.toFixed(4)).join(', ')} px/step, backlash ${calX.backlash} steps; ` +
        `y ${calY.pixelsPerStep.map((v) => v.toFixed(4)).join(', ')} px/step, backlash ${calY.backlash} steps`)
  })
  const applyBacklash = () => run('apply backlash to device', async () => {
    if (!csm) return
    await device.client.call('stage.set_backlash', { x: Math.round(csm.calX.backlash), y: Math.round(csm.calY.backlash) })
    await device.refreshStatus()
  })
  const pxPerStep = (v: [number, number] | number[]) => Math.hypot(v[0], v[1])

  // ---- RAW flat field (device.md §2 `/flat.bin`): per-channel gain maps that override the tuning's
  // ALSC tables in every RAW-family develop (algo/rawdev.ts#prepareMosaic prefers it when present) ----
  const rawFlat = $derived(calibration.rawFlatField)
  let flatFrames = $state(4)
  const captureFlat = () => run('flat field', async () => { await captureFlatField(say, flatFrames) })
  const clearFlat = () => saveRawFlatField(null)
</script>

<div class="wrap">
  <div class="panel overview">
    <h3>Calibration</h3>
    <div class="cards">
      <div class="card" data-status={colourStatus}>
        <div class="title"><span class="dot"></span>1 · Illumination, exposure and colour</div>
        <div class="muted">{colourStatus === 'done' ? 'Calibrated: exposure, gain, lens shading and white balance are fixed.'
          : colourStatus === 'partial' ? 'Partly done. Finish the steps below.'
          : 'Not calibrated. The camera is running on auto exposure and auto white balance.'}</div>
      </div>
      <div class="card" data-status={csm ? 'done' : 'todo'}>
        <div class="title"><span class="dot"></span>2 · Stage ↔ camera mapping</div>
        <div class="muted">{csm ? `Calibrated ${new Date(csm.when).toLocaleString()}. Click-to-move, follow and scans are enabled.`
          : 'Not calibrated. Click-to-move, follow and scanning need this.'}</div>
      </div>
    </div>
    <p class="muted small">Redo 1 after changing the LED, objective or camera; redo 2 after changing the objective or the stream size.
      Calibration 1 is stored on the microscope; calibration 2 is stored in this browser.</p>
  </div>

  <div class="panel">
    <h3>1 · Illumination, exposure and colour</h3>
    <div class="two">
      <div>
        <div class="callout">
          <b>Do this with the sample removed.</b> Take the slide out (or move to a completely blank area of it) so the
          whole field of view is empty and evenly lit: these steps measure the illumination itself. The live preview on
          the right must be a featureless, roughly uniform disc. If you can see cells or dust, the result will be wrong
          and the image will come out tinted (a green field is the usual sign).
        </div>
        <ol class="steps">
          <li class:ok={ledOn}>
            <div class="what"><b>Set the LED brightness</b> <span class="muted">— currently {ledOn ? `${Math.round(device.light.cc * 100)} %` : 'off'}.
              Choose the brightness you will image at; the exposure is matched to it. Brighter = shorter exposure and less
              noise, until the field saturates. Changing it later means redoing steps 2–4.</span></div>
            <div class="row">
              <input type="range" min="0" max="1" step="0.01" value={device.light.cc} disabled={!device.connected}
                     oninput={(e) => ledSlider(+e.currentTarget.value)} style="flex:1" aria-label="LED brightness" />
              <button onclick={ledDefault} disabled={!!busy || !device.connected}>Default (32 %)</button>
            </div>
          </li>
          <li class:ok={flatDone}>
            <div class="what"><b>Reset shading tables to flat</b> <span class="muted">— so the raw frame is measured without any correction, and auto exposure / white balance are switched off</span></div>
            <div class="row"><button onclick={stepFlat} disabled={!!busy || !device.connected}>Reset to flat</button></div>
          </li>
          <li class:ok={exposureFixed && !!exposureResult}>
            <div class="what"><b>Fix exposure and gain</b> <span class="muted">— brightest pixels at ~40 % of the sensor range, gain kept at 1× where possible</span>
              {#if exposureResult}<div class="mono small">exposure {(exposureResult.exposure / 1000).toFixed(2)} ms · gain {exposureResult.gain.toFixed(2)}× · level {exposureResult.level.toFixed(0)}/1023{exposureResult.converged ? '' : ' · NOT CONVERGED'}</div>
              {:else if controls}<div class="mono small">now: {controls.AeEnable ? 'auto exposure' : `${(controls.ExposureTime / 1000).toFixed(2)} ms, gain ${controls.AnalogueGain.toFixed(2)}×`}</div>{/if}
            </div>
            <div class="row"><button onclick={stepExpose} disabled={!!busy || !device.connected}>Fix exposure</button></div>
          </li>
          <li class:ok={!!tuningCalibrated && colourFixed}>
            <div class="what"><b>Measure lens shading and white balance</b> <span class="muted">— one raw frame gives the vignetting and colour cast per region; the correction is written into the camera's tuning file</span>
              {#if controls && !controls.AwbEnable && tuningCalibrated}<div class="mono small">white balance fixed: red {controls.ColourGains[0].toFixed(3)}, blue {controls.ColourGains[1].toFixed(3)}</div>{/if}
            </div>
            <div class="row"><button onclick={stepLst} disabled={!!busy || !device.connected}>Measure and apply</button></div>
          </li>
        </ol>
        <div class="row actions">
          <button class="primary" onclick={stepAll} disabled={!!busy || !device.connected}>Run steps 2–4</button>
          <button onclick={quickAuto} disabled={!!busy || !device.connected} title="Uncalibrated quick look: let the camera choose exposure and white balance">Auto exposure &amp; white balance</button>
          <button class="danger" onclick={resetTuning} disabled={!!busy || !device.connected}>Reset to factory tuning</button>
        </div>
        <p class="muted small">Takes 1–2 minutes: each raw capture is 16 MB and travels over WiFi. Keep the field of view empty and the LED untouched until it finishes.</p>
      </div>
      <div class="preview">
        {#if device.connected}<img bind:this={previewImg} src={device.url('/stream-lores.mjpg') + '?cal=1'} alt="live preview" />{/if}
        <div class="muted small">live preview (low resolution)</div>
        {#if lst}<LstView {lst} />{/if}
      </div>
    </div>
  </div>

  <div class="panel">
    <h3>2 · Stage ↔ camera mapping</h3>
    <p class="muted"><b>Before you start:</b> put a sample with visible detail under the objective and bring it into focus
      (use Autofocus on the Live page). The stage is then moved back and forth in x and y while the image is tracked,
      which gives the pixels per motor step, the direction of each axis and the backlash. This takes about a minute
      and moves the stage by a few hundred steps in each direction.</p>
    <div class="row">
      <button class="primary" onclick={calibrateCsm} disabled={!!busy || !device.connected}>Calibrate XY</button>
      {#if csm}<button onclick={applyBacklash} disabled={!!busy || !device.connected} title="Use the measured backlash for compensated moves">Apply measured backlash to the stage</button>
        <button onclick={() => saveCsm(null)} disabled={!!busy}>Clear</button>{/if}
    </div>
    {#if csm}
      <div class="scroll-x">
        <table class="mono small result">
          <thead><tr><th>axis</th><th>pixels / step</th><th>direction (px per step, x y)</th><th>backlash</th></tr></thead>
          <tbody>
            <tr><td>x</td><td>{pxPerStep(csm.calX.pixelsPerStep).toFixed(4)}</td><td>{csm.calX.pixelsPerStep.map((v) => v.toFixed(4)).join(', ')}</td><td>{csm.calX.backlash} steps</td></tr>
            <tr><td>y</td><td>{pxPerStep(csm.calY.pixelsPerStep).toFixed(4)}</td><td>{csm.calY.pixelsPerStep.map((v) => v.toFixed(4)).join(', ')}</td><td>{csm.calY.backlash} steps</td></tr>
          </tbody>
        </table>
      </div>
      <p class="muted small">Stored for {settings.deviceUrl || 'this device'} in this browser. Stage backlash currently used by the microscope:
        {device.status?.stage?.backlash ? `x ${device.status.stage.backlash.x}, y ${device.status.stage.backlash.y}, z ${device.status.stage.backlash.z}` : '…'}.</p>
    {/if}
  </div>

  <div class="panel">
    <h3>RAW flat field</h3>
    <p class="muted"><b>Do this with the sample removed</b> and the illumination as it will be used for RAW captures.
      Averages several raw blank-field frames on the device and derives a per-channel gain map that is applied
      instead of the tuning file's lens-shading tables for every RAW-family capture (RAW, RAW average, HDR RAW,
      fine stack from RAW) until cleared.</p>
    {#if rawFlat}
      <div class="callout" style="border-color:var(--accent)">
        <b>A flat field is active</b> — it overrides the tuning file's lens-shading correction for RAW-family
        captures.{#if rawFlat.when} Captured {new Date(rawFlat.when).toLocaleString()}.{/if}
      </div>
    {/if}
    <div class="row">
      <label>Frames <input class="mono" type="number" min="2" max="8" style="width:70px" bind:value={flatFrames} disabled={!!busy || !device.connected} /></label>
      <button class="primary" onclick={captureFlat} disabled={!!busy || !device.connected}>Capture flat field</button>
      {#if rawFlat}<button class="danger" onclick={clearFlat} disabled={!!busy}>Clear</button>{/if}
    </div>
  </div>

  <div class="panel">
    <h3>Progress</h3>
    {#if busy}<div class="badge">running: {busy}</div> <span class="mono small">{progress}</span>{/if}
    <pre class="log mono">{log.join('\n')}</pre>
  </div>
</div>

<style>
  .callout { border: 1px solid var(--warn); border-left-width: 4px; background: rgba(255, 190, 60, .08); padding: 10px 12px; border-radius: 6px; margin: 0 0 12px; font-size: 13px; line-height: 1.45; }

  .wrap { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 1100px; }
  .small { font-size: 12px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel2); }
  .card .title { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .card[data-status="done"] .dot { background: var(--ok, #3fb950); }
  .card[data-status="partial"] .dot { background: var(--warn, #d29922); }
  .two { display: grid; grid-template-columns: 1fr 300px; gap: 16px; }
  .preview img { width: 100%; border-radius: 6px; background: #000; aspect-ratio: 4/3; object-fit: contain; }
  .steps { list-style: none; counter-reset: step; padding: 0; margin: 8px 0; display: flex; flex-direction: column; gap: 8px; }
  .steps li { counter-increment: step; display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
  .steps li::before { content: counter(step); width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--panel2); font-size: 12px; color: var(--muted); }
  .steps li.ok::before { content: "✓"; background: var(--ok, #3fb950); color: #fff; }
  .actions { margin-top: 8px; }
  .result { border-collapse: collapse; margin-top: 10px; }
  .result th, .result td { text-align: left; padding: 3px 12px 3px 0; border-bottom: 1px solid var(--border); }
  .log { max-height: 220px; overflow: auto; font-size: 12px; margin: 8px 0 0; white-space: pre-wrap; }
  @media (max-width: 720px) {
    .two, .cards { grid-template-columns: 1fr; }
    .steps li { grid-template-columns: 24px 1fr; }
    .steps li > .row { grid-column: 1 / -1; }
    .preview img { aspect-ratio: 4/3; }
  }
</style>
