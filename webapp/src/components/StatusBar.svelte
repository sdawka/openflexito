<script lang="ts">
  import { device } from '../lib/store/device.svelte'
  const led = $derived(device.status?.led ?? (device.connected ? 'online' : 'off'))
  const cls = $derived(!device.connected ? 'err' : led === 'error' ? 'err' : led === 'hotspot' || led === 'offline' ? 'warn' : 'ok')
  const errors = $derived(Object.entries(device.status?.errors ?? {}))

  const net = $derived(device.status?.network)
  /** "Wired 1000 Mbit/s 192.168.1.50" / "WiFi <ssid>" / "Hotspot 10.42.0.1" / "direct cable" for a
   *  link-local Ethernet address with no router. Falls back to the plain state string when the
   *  device hasn't reported the newer `link` field yet. */
  const linkLabel = $derived.by(() => {
    if (!net) return null
    if (net.link_local) return 'direct cable'
    if (net.link === 'ethernet') return `Wired${net.speed_mbit ? ` ${net.speed_mbit} Mbit/s` : ''}${net.ip ? ` ${net.ip}` : ''}`
    if (net.link === 'wifi') return `WiFi${net.connections[0] ? ` ${net.connections[0]}` : ''}`
    if (net.link === 'hotspot' || net.state === 'hotspot') return `Hotspot${net.ip ? ` ${net.ip}` : ''}`
    if (net.link === 'none') return 'no link'
    return null
  })
  const bitrateLabel = $derived(device.streamKBs > 0 ? `${device.streamKBs.toFixed(0)} kB/s (${(device.streamKBs * 8 / 1000).toFixed(1)} Mbit/s)` : null)
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
  {#if linkLabel}
    <span class="badge mono" title={bitrateLabel ? `measured stream rate: ${bitrateLabel}` : 'link type'}>{linkLabel}{bitrateLabel ? ` · ${bitrateLabel}` : ''}</span>
  {/if}
  <span class="badge" title={device.status?.network?.ip ?? ''}>
    <span class="dot {cls}"></span>{device.connected ? led : 'disconnected'}
  </span>
</div>
