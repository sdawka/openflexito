<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  let timer: ReturnType<typeof setTimeout> | undefined
  function setCC(v: number) {
    clearTimeout(timer)
    timer = setTimeout(() => device.setLight(v).catch(() => {}), 80)
  }
</script>

<div class="panel">
  <h3>Illumination</h3>
  <div class="label">LED brightness <span class="mono">{Math.round(device.light.cc * 100)} %</span></div>
  <input type="range" min="0" max="1" step="0.01" value={device.light.cc} oninput={(e) => setCC(+e.currentTarget.value)} />
  <div class="row" style="margin-top:6px">
    <button onclick={() => device.setLight(0)}>Off</button>
    <button onclick={() => device.setLight(0.32)}>Default</button>
    <button onclick={() => device.setLight(1)}>Max</button>
  </div>
</div>
