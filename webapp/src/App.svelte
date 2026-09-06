<script lang="ts">
  import { onMount } from 'svelte'
  import { device } from './lib/store/device.svelte'
  import StatusBar from './components/StatusBar.svelte'
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
</script>

<div class="shell">
  <nav>
    <div class="brand">openflexito</div>
    {#each Object.entries(routes) as [key, r]}
      <a href={'#/' + key} class:active={route === key}>{r.label}</a>
    {/each}
    <div class="spacer"></div>
    <StatusBar />
  </nav>
  <main>
    <Current />
  </main>
</div>

<style>
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100%; }
  nav { display: flex; align-items: center; gap: 4px; padding: 6px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .brand { font-weight: 700; margin-right: 12px; letter-spacing: .02em; }
  nav a { color: var(--muted); text-decoration: none; padding: 6px 10px; border-radius: 6px; }
  nav a.active, nav a:hover { color: var(--text); background: var(--panel2); }
  .spacer { flex: 1; }
  main { min-height: 0; overflow: auto; }
</style>
