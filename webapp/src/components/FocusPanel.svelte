<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  import { liveStack } from '../lib/services/liveStack.svelte'
  import { focusCtl } from '../lib/store/focusCtl.svelte'
</script>

<div class="panel">
  <h3>Focus</h3>
  <div class="row">
    <button class="primary" onclick={() => focusCtl.run()} disabled={!device.connected}>{focusCtl.focusing ? 'Cancel' : 'Autofocus'}</button>
    <select bind:value={focusCtl.mode} disabled={focusCtl.focusing}>
      <option value="fast">fast (JPEG size)</option>
      <option value="looping">looping</option>
      <option value="step">step (Laplacian)</option>
      <option value="twopass" title="coarse JPEG-size sweep locates the plane, then a short fine Laplacian sweep sub-pixel-fits the peak">two-pass (fine sub-pixel)</option>
    </select>
    <select bind:value={focusCtl.range} disabled={focusCtl.focusing}>
      <option value={500}>±250</option><option value={1000}>±500</option><option value={2000}>±1000</option><option value={4000}>±2000</option>
    </select>
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
  <details class="help">
    <summary>What these do</summary>
    <p><b>Smooth</b> averages recent frames (the sensor's noise is already reduced by the Pi's ISP as far as it goes; averaging
    4 frames halves what is left). <b>Stack</b> uses small z vibrations: it keeps, block by block, the sharpest content seen so
    far (aligned for xy jitter, feathered, slowly forgetting), which builds an extended-depth-of-field view without moving the
    stage. Both reset whenever the stage moves. Save stores the processed frame; Record in the Photo panel records whatever is shown.</p>
  </details>
</div>
