<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  let timer: ReturnType<typeof setTimeout> | undefined
  function setCC(v: number) {
    clearTimeout(timer)
    timer = setTimeout(() => device.setLight(v).catch(() => {}), 80)
  }
  // The Sangaboard reports its illumination channels (CC: the main LED driver, PWM: spare outputs
  // on the board for extra LEDs such as side or oblique illumination). One slider per PWM output.
  const pwmCount = $derived(device.light.channels?.pwm ?? 0)
  let pwmTimer: ReturnType<typeof setTimeout> | undefined
  function setPwm(i: number, v: number) {
    clearTimeout(pwmTimer)
    const pwm = [...device.light.pwm]; while (pwm.length <= i) pwm.push(0); pwm[i] = v
    pwmTimer = setTimeout(() => device.setLight(undefined, pwm).catch(() => {}), 80)
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
  {#each Array.from({ length: pwmCount }, (_, i) => i) as i}
    <div class="label" style="margin-top:8px">Aux LED {i + 1} <span class="muted">(board PWM output {i})</span> <span class="mono">{Math.round((device.light.pwm[i] ?? 0) * 100)} %</span></div>
    <input type="range" min="0" max="1" step="0.01" value={device.light.pwm[i] ?? 0} oninput={(e) => setPwm(i, +e.currentTarget.value)} />
  {/each}
</div>
