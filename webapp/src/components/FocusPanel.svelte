<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { settings, saveSettings } from '../lib/store/settings.svelte'
  import { focusCtl } from '../lib/store/focusCtl.svelte'
  import { liveEdof } from '../lib/services/liveEdof.svelte'
  import LiveEdof from './LiveEdof.svelte'
</script>

<div class="panel">
  <h3>Focus</h3>
  <div class="row">
    <button class="primary" onclick={() => focusCtl.run()} disabled={!device.connected || liveEdof.holdsStage}>{focusCtl.focusing ? 'Cancel' : 'Autofocus'}</button>
    <select bind:value={focusCtl.mode} disabled={focusCtl.focusing}>
      <option value="fast">fast (sweep)</option>
      <option value="looping">looping</option>
      <option value="step">step (Laplacian)</option>
      <option value="twopass" title="coarse FocusFoM sweep locates the plane, then a short fine stepped sweep (Laplacian on the stream frame) sub-pixel-fits the peak; the default, and the only mode with a usable fine metric on the Pi">two-pass (fine sub-pixel)</option>
    </select>
    <select bind:value={focusCtl.range} disabled={focusCtl.focusing}>
      <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option><option value={4000}>±2000</option>
    </select>
  </div>
  <div class="row" title="what scores the sweep: the ISP's FocusFoM is computed before the encoder; JPEG size is the fallback when the device sends none. The at-rest measure grades step / fine / local sweeps over a 4x4 tile grid on a stream-width grab (full-resolution stills are too noisy to score focus).">
    <label class="muted" style="font-size:12px">sweep
      <select bind:value={settings.focusSweepMetric} onchange={saveSettings} disabled={focusCtl.focusing}>
        <option value="fom">FocusFoM</option><option value="jpeg">JPEG size</option>
      </select>
    </label>
    <label class="muted" style="font-size:12px">fine
      <select bind:value={settings.focusMetric} onchange={saveSettings} disabled={focusCtl.focusing}>
        <option value="laplacian">Laplacian</option><option value="nv">normalised variance</option><option value="brenner">Brenner</option>
      </select>
    </label>
    <label class="muted" style="font-size:12px">grab
      <select bind:value={settings.focusGrabWidth} onchange={saveSettings} disabled={focusCtl.focusing}>
        <option value="native">stream width</option><option value={410}>410 px</option><option value={640}>640 px</option>
      </select>
    </label>
  </div>
  {#if focusCtl.log}<div class="muted mono" style="font-size:12px;margin-top:6px">{focusCtl.log}</div>{/if}
  <h4 class="sub">Live view processing</h4>
  <div class="row">
    <div class="seg">
      <button class:on={!liveStack.active} onclick={() => liveStack.stop()}>Off</button>
      <button class:on={liveStack.active && liveStack.mode === 'average'} onclick={() => liveStack.start('average')} disabled={!device.connected} title="average the last ~4 frames while the stage is still: halves the noise">Smooth</button>
      <button class:on={liveStack.active && liveStack.mode === 'stack'} onclick={() => liveStack.start('stack')} disabled={!device.connected} title="weight each block by sharpness over time: extended depth of field from z vibration, noise averaged where the focus is steady; restarts whenever the stage moves">Stack</button>
    </div>
    {#if liveStack.active}
      <button onclick={() => liveStack.reset()} title="start afresh">Reset</button>
      <button onclick={() => liveStack.save().then((i) => (focusCtl.log = `saved "${i.name}"`)).catch((e) => (focusCtl.log = e.message))} disabled={!liveStack.stats} title="save the processed frame to the gallery">Save</button>
    {/if}
  </div>
  {#if liveStack.active && liveStack.stats}
    <div class="status-line busy">{liveStack.stats.frames} frames{liveStack.mode === 'stack' ? ` · ${Math.round(liveStack.stats.replaced * 100)} % of blocks sharpened by the last frame` : ' averaged'}{liveStack.stats.shift.dx || liveStack.stats.shift.dy ? ` · aligned ${liveStack.stats.shift.dx}, ${liveStack.stats.shift.dy} px` : ''}</div>
  {/if}
  <LiveEdof />
  <details class="help">
    <summary>What these do</summary>
    <p><b>Smooth</b> averages recent frames (the sensor's noise is already reduced by the Pi's ISP as far as it goes; averaging
    4 frames halves what is left). <b>Stack</b> uses small z vibrations: it keeps, block by block, the sharpest content seen so
    far (aligned for xy jitter, feathered, slowly forgetting), which builds an extended-depth-of-field view without moving the
    stage. Both reset whenever the stage moves. Save stores the processed frame; Record in the Photo panel records whatever is shown.</p>
    <p><b>Live extended focus</b> sweeps z up and down continuously over <i>range</i> steps (plus the backlash dead band at
    each reversal) in a fast sensor mode and fuses each sweep into one sharp frame, block by block from the sharpest slice,
    so moving organisms stay crisp instead of ghosting: about 3 fused frames a second. Crop mode reads out the central ~39 % of
    the field at up to 200 fps; full field covers everything at up to 40 fps. Record saves the fused frames as a video.</p>
  </details>
</div>
