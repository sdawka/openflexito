<script lang="ts">
  import { onMount } from 'svelte'
  import { device } from './lib/store/device.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import PowerButton from './components/PowerButton.svelte'
  import Live from './routes/Live.svelte'
  import Calibrate from './routes/Calibrate.svelte'
  import Scan from './routes/Scan.svelte'
  import Gallery from './routes/Gallery.svelte'
  import Settings from './routes/Settings.svelte'

  const routes = {
    live: { label: 'Live', component: Live },
    calibrate: { label: 'Calibrate', component: Calibrate },
    scan: { label: 'Scan', component: Scan },
    gallery: { label: 'Gallery', component: Gallery },
    settings: { label: 'Settings', component: Settings },
  } as const
  type RouteKey = keyof typeof routes

  let route = $state<RouteKey>(parse(location.hash))
  function parse(h: string): RouteKey {
    const k = h.replace(/^#\/?/, '') as RouteKey
    return k in routes ? k : 'live'
  }
  onMount(() => {
    device.connect()
    const onHash = () => { route = parse(location.hash) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  })
  const Current = $derived(routes[route].component)

  // Explicit `power.on === false` only; a missing key (older device) or "not connected yet" both
  // fall through to the normal UI so the standby screen never flashes before status.power arrives.
  const standby = $derived(device.status?.power != null && device.status.power.on === false)
</script>

<div class="shell">
  <nav>
    <div class="topbar">
      <div class="brand"><span class="full">openflexito</span><span class="mark" aria-hidden="true">OF</span></div>
      <PowerButton />
      <div class="spacer"></div>
      <StatusBar />
    </div>
    <div class="tabs">
      {#each Object.entries(routes) as [key, r]}
        <a href={'#/' + key} class:active={route === key}>{r.label}</a>
      {/each}
    </div>
  </nav>
  <main>
    {#if standby}
      <div class="standby">
        <p>Standby</p>
        <p class="muted">Camera, stage and lighting are off. The microscope stays reachable.</p>
        <button class="primary wake" onclick={() => device.setPower(true)}>Tap to wake</button>
      </div>
    {:else}
      <Current />
    {/if}
  </main>
</div>

<style>
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100%; }
  nav { display: flex; align-items: center; gap: 4px; padding: 6px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
  /* .topbar/.tabs are pure grouping wrappers on desktop (`display: contents`) so their children
   * become flex items of `nav` directly; `order` puts them back in the original brand/links/spacer
   * /status sequence regardless of the brand/power/spacer/status vs. tabs DOM split below. */
  .topbar { display: contents; }
  .brand { font-weight: 700; margin-right: 12px; letter-spacing: .02em; order: 1; flex: none; }
  .brand .mark { display: none; }
  :global(nav .power-btn) { order: 2; }
  .tabs { display: contents; }
  .tabs a { color: var(--muted); text-decoration: none; padding: 6px 10px; border-radius: 6px; order: 3; }
  .tabs a.active, .tabs a:hover { color: var(--text); background: var(--panel2); }
  .spacer { flex: 1; order: 4; }
  :global(nav .status-row) { order: 5; }
  main { min-height: 0; overflow: auto; }

  .standby { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 24px; }
  .standby p { margin: 0; font-size: 18px; }
  .standby .wake { margin-top: 10px; padding: 16px 28px; font-size: 16px; min-height: 44px; }

  /* Phone/small-Android portrait shell: a compact top bar (brand, power, essential status) plus a
   * fixed bottom tab bar for the 5 routes, clear of the iPhone home indicator. Desktop (>720px)
   * keeps the single top row (`.topbar`/`.tabs` stay `display: contents` above, so their children
   * are laid out directly by `nav`'s own flex row, in source order). */
  @media (max-width: 720px) {
    nav { flex-direction: column; align-items: stretch; padding: 0; }
    .topbar {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex-wrap: nowrap; min-height: 44px;
      position: relative;   /* anchors StatusBar's opened `.more` overlay to the full bar width */
    }
    .brand { margin-right: 0; }
    .brand .full { display: none; }
    .brand .mark { display: inline; font-size: 13px; }
    .spacer { flex: 0 1 8px; }   /* on mobile the status cluster hugs the power button; no need to push it to the far edge */
    :global(nav .status-row) { flex: 1 1 auto; min-width: 0; }   /* lets `.badges` scroll internally instead of forcing the bar wider than the viewport */
    .tabs {
      display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
      background: var(--panel); border-top: 1px solid var(--border);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .tabs a {
      flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
      border-radius: 0; padding: 10px 4px; min-height: 44px;
    }
    main { padding-bottom: var(--tabbar-h); }
  }
</style>
