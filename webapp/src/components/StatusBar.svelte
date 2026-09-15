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

  // Mobile (<=720px, see app.css breakpoint): the top bar has room for exactly one row, so only
  // the connection dot and position stay on the bar itself; fps, errors and the link badge move
  // behind this tap toggle (`.more`) instead of wrapping onto a second/third line. Desktop is
  // unaffected — `.more` has no `display:none` outside the mobile media query, so it (and fps)
  // render inline in their original spot, and the toggle stays hidden.
  let expanded = $state(false)
</script>

<div class="row status-row">
  <span class="badges">
    <span class="badge" title={device.status?.network?.ip ?? ''}>
      <span class="dot {cls}"></span><span class="lbl">{device.connected ? led : 'disconnected'}</span>
    </span>
    <span class="badge mono" title="stage position (steps)">
      x {device.position.x} &nbsp; y {device.position.y} &nbsp; z {device.position.z}
      {#if device.moving}<span class="muted lbl">moving</span>{/if}
    </span>
    <button type="button" class="more-toggle" aria-label="more status" aria-expanded={expanded} onclick={() => expanded = !expanded}>&hellip;</button>
  </span>
  <span class="more" class:show={expanded}>
    <span class="badge mono" title="stream frame rate">{device.fps.toFixed(0)} fps</span>
    {#each errors as [k, v]}<span class="badge" title={v}><span class="dot err"></span>{k} error</span>{/each}
    {#if linkLabel}
      <span class="badge mono" title={bitrateLabel ? `measured stream rate: ${bitrateLabel}` : 'link type'}>{linkLabel}{bitrateLabel ? ` · ${bitrateLabel}` : ''}</span>
    {/if}
  </span>
</div>

<style>
  .more-toggle {
    display: none; padding: 2px 8px; border-radius: 999px; background: var(--panel2); font-size: 12px; line-height: 1;
  }
  .more { display: inline-flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  @media (max-width: 720px) {
    /* `.status-row` itself must stay overflow: visible (default) so the opened `.more` overlay
     * below isn't clipped; the horizontal scroller is the narrower `.badges` wrapper instead.
     * `.more.show` is positioned absolute against `.topbar` (App.svelte sets position: relative
     * on it) rather than this narrow row, so the dropped-down badges get the full bar width
     * instead of wrapping/overflowing inside a sliver of leftover flex space. */
    .status-row { flex-wrap: nowrap; gap: 6px; min-width: 0; }
    .badges {
      display: flex; align-items: center; gap: 6px; min-width: 0; flex: none;
      overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;
    }
    .badges::-webkit-scrollbar { display: none; }
    .badges .badge { flex: none; padding: 2px 6px; white-space: nowrap; }   /* only the scrolling essentials; the dropped-down `.more` badges may wrap */
    .lbl { display: none; }   /* dot + title attribute carry the state; text would blow the one-row budget */
    .more-toggle { display: inline-flex; align-items: center; flex: none; }
    .more { display: none; }
    .more.show {
      display: flex; position: absolute; top: 100%; left: 0; right: 0; z-index: 21;
      background: var(--panel); border-bottom: 1px solid var(--border); padding: 8px 10px;
    }
  }
  @media (pointer: coarse) {
    .more-toggle { min-height: 44px; min-width: 44px; justify-content: center; }
  }
</style>
