<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  const led = $derived(device.status?.led ?? (device.connected ? 'online' : 'off'))
  const cls = $derived(!device.connected ? 'err' : led === 'error' ? 'err' : led === 'hotspot' || led === 'offline' ? 'warn' : 'ok')
  const errors = $derived(Object.entries(device.status?.errors ?? {}))
</script>

<div class="row">
  {#if errors.length}
    {#each errors as [k, v]}<span class="badge" title={v}><span class="dot err"></span>{k} error</span>{/each}
  {/if}
  <span class="badge mono" title="stage position (steps)">
    x {device.position.x} &nbsp; y {device.position.y} &nbsp; z {device.position.z}
    {#if device.moving}<span class="muted">moving</span>{/if}
  </span>
  <span class="badge mono" title="stream frame rate">{device.fps.toFixed(0)} fps</span>
  <span class="badge" title={device.status?.network?.ip ?? ''}>
    <span class="dot {cls}"></span>{device.connected ? led : 'disconnected'}
  </span>
</div>
